import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config';
import { prisma } from '../db/prisma';
import { logger } from '../lib/logger';
import { hub } from '../realtime/hub';
import type { BroadcastPayload, ChatMessage, RoomType } from '../shared/protocol';
import { startRestStop } from '../features/restStop';
import { clearSeat, muteSeat, removeSeat } from '../features/moderationService';
import { CARD_SURVEY_DONE, CARD_VOTE_PREFIX, S2C } from '../shared/protocol';

/**
 * Trip Rooms platform bridge. This app keeps its own chat; the platform adds the Console, the
 * support desk and Ops tooling on top, through the public partner API (/v1) and signed webhooks.
 *
 *   App → Platform   journey ↔ room (matched by bus number, else created), seat ↔ member,
 *                    every passenger text message mirrored (so Ops see the conversation),
 *                    @care / @support / @customer / @AbhiBus Care → support ticket, SOS → Ops inbox.
 *   Platform → App   support agent replies → private message to that seat only;
 *                    everything Ops / Marketing / crew post in the Console (alerts, trip updates,
 *                    campaigns, polls, surveys, vouchers, rest-stop timers) → native in the bus chat;
 *                    a passenger removed in the Console → removed here too.
 *   Ad taps in the app are counted on the campaign and return the coupon.
 *
 * Never blocks the chat: work is queued per journey (keeps message order), retried with backoff,
 * and failures are logged, not thrown. Unconfigured = disabled, and the app runs standalone.
 */
const enabled = !!(config.PLATFORM_API_URL && config.PLATFORM_CLIENT_ID && config.PLATFORM_CLIENT_SECRET);
const BASE = (config.PLATFORM_API_URL ?? '').replace(/\/$/, '');
const CALLBACK = config.PLATFORM_CALLBACK_URL ?? `http://localhost:${config.PORT}/v1/platform/webhook`;
const EXT = 'abhibus-app:';
const extId = (journeyId: string, seat: string) => `${EXT}${seat}@${journeyId}`;
const parseExt = (id: string | null | undefined) => {
  if (!id?.startsWith(EXT)) return null;
  const rest = id.slice(EXT.length), at = rest.indexOf('@');
  return at > 0 ? { seat: rest.slice(0, at), journeyId: rest.slice(at + 1) } : null;
};
const norm = (s: unknown) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

class BridgeError extends Error { constructor(public status: number, msg: string) { super(msg); } }

const state = { webhook: 'pending' as 'pending' | 'ready' | 'off', lastError: null as string | null, mirrored: 0, tickets: 0, delivered: 0 };
let token: { value: string; exp: number } | null = null;
let webhookSecret: string | null = null;
const roomByJourney = new Map<string, string>();
const memberBySeat = new Map<string, string>();
const seenEvents = new Set<string>();

// ------------------------------------------------------------------ http ---
async function accessToken() {
  if (token && token.exp > Date.now() + 60_000) return token.value;
  const r = await fetch(`${BASE}/v1/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'client_credentials', client_id: config.PLATFORM_CLIENT_ID, client_secret: config.PLATFORM_CLIENT_SECRET }), signal: AbortSignal.timeout(6000) });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new BridgeError(r.status, `oauth: ${b?.error?.message ?? r.status}`);
  token = { value: b.access_token, exp: Date.now() + b.expires_in * 1000 };
  return token.value;
}
async function api<T = any>(method: string, path: string, body?: unknown, again = true): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${await accessToken()}` }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(6000) });
  if (r.status === 401 && again) { token = null; return api(method, path, body, false); }
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new BridgeError(r.status, `${method} ${path}: ${b?.error?.message ?? r.status}`);
  return b as T;
}

/** Per-journey queue: keeps order, retries transient failures (network / 5xx / 429), drops 4xx. */
const chains = new Map<string, Promise<void>>();
function enqueue(journeyId: string, label: string, job: () => Promise<void>) {
  if (!enabled) return;
  const run = async () => {
    for (let i = 0; i < 4; i++) {
      try { await job(); state.lastError = null; return; } catch (err) {
        const status = err instanceof BridgeError ? err.status : 0;
        state.lastError = `${label}: ${(err as Error).message}`;
        if (status >= 400 && status < 500 && status !== 429 && status !== 401) { logger.warn({ err: (err as Error).message, journeyId }, `platform bridge: ${label} rejected`); return; }
        await new Promise((r) => setTimeout(r, [1000, 3000, 9000, 20000][i]));
      }
    }
    logger.error({ journeyId, label, err: state.lastError }, 'platform bridge: gave up');
  };
  const next = (chains.get(journeyId) ?? Promise.resolve()).then(run, run);
  chains.set(journeyId, next);
  void next.finally(() => { if (chains.get(journeyId) === next) chains.delete(journeyId); });
}

// --------------------------------------------------------- room & member ---
/** The platform room for a journey: remembered; else the live room for the same bus; else created. */
async function roomFor(journeyId: string): Promise<string> {
  const cached = roomByJourney.get(journeyId);
  if (cached) return cached;
  const j = await prisma.busJourney.findUniqueOrThrow({ where: { journeyId } });
  let roomId = j.platformRoomId;
  if (!roomId) {
    // Same bus, same night = same room, so the app's passengers join the trip Ops already manage.
    const live = await api<{ data: any[] }>('GET', '/v1/rooms?vertical=bus&state=scheduled,dormant,open,onboard');
    const match = live.data.find((r) => norm(r.scope?.vehicle_no) === norm(j.busNumber) && Math.abs(+new Date(r.schedule.departs_at) - +j.startTime) < 24 * 3600_000);
    if (match) roomId = match.id;
    else {
      const created = await api('PUT', `/v1/rooms/by-key/${encodeURIComponent(`abhibus-app:${journeyId}`)}`, {
        vertical: 'bus', title: `${j.sourceCity} → ${j.destinationCity}`, subtitle: `${j.operatorName} · ${j.busNumber}`,
        scope: { operator_name: j.operatorName, service_id: j.serviceId, vehicle_no: j.busNumber, source: 'abhibus-app' },
        schedule: { departs_at: j.startTime.toISOString(), arrives_at: j.estimatedEndTime.toISOString() },
        route: { stops: [{ code: 'SRC', name: j.sourceCity, sched_dep: j.startTime.toISOString(), type: 'boarding' }, { code: 'DST', name: j.destinationCity, sched_arr: j.estimatedEndTime.toISOString(), type: 'dropping' }] },
      });
      roomId = created.id as string;
    }
    await prisma.busJourney.update({ where: { journeyId }, data: { platformRoomId: roomId } });
    logger.info({ journeyId, roomId, matched: !!match }, '🔗 journey linked to Trip Rooms');
  }
  roomByJourney.set(journeyId, roomId!);
  return roomId!;
}

async function memberFor(journeyId: string, seat: string): Promise<{ roomId: string; memberId: string }> {
  const roomId = await roomFor(journeyId);
  const key = `${journeyId}|${seat}`;
  const cached = memberBySeat.get(key);
  if (cached) return { roomId, memberId: cached };
  const b = await prisma.passengerBooking.findUnique({ where: { journeyId_seatNumber: { journeyId, seatNumber: seat } } });
  const name = b?.displayName?.trim();
  const out = await api<{ added: { member_id: string }[] }>('POST', `/v1/rooms/${roomId}/members`, {
    members: [{ external_user_id: extId(journeyId, seat), booking_ref: b?.pnrNumber ?? 'APP', seat_refs: [seat], gender: b?.gender ?? 'U', ...(name ? { profile: { name } } : {}) }],
  });
  memberBySeat.set(key, out.added[0].member_id);
  return { roomId, memberId: out.added[0].member_id };
}

// ------------------------------------------------------------ app → platform
export const platformBridge = {
  enabled,
  status: () => ({ enabled, api: BASE || null, callback: CALLBACK, ...state, linkedJourneys: roomByJourney.size }),

  /** A passenger posted in the bus chat. Text is mirrored; care tags become tickets on the platform. */
  mirrorMessage(journeyId: string, seat: string, roomType: RoomType, m: ChatMessage) {
    if (m.contentType !== 'TEXT') return;
    const text = (m.payload as { text?: string }).text;
    if (!text) return;
    enqueue(journeyId, 'mirror message', async () => {
      const { roomId, memberId } = await memberFor(journeyId, seat);
      const r = await api<{ care_ticket: { ref: string } | null }>('POST', `/v1/rooms/${roomId}/members/${memberId}/messages`, { text, client_msg_id: m.id.slice(0, 64), channel: roomType === 'WOMEN_ONLY' ? 'WOMEN' : 'MAIN' });
      state.mirrored++;
      if (r.care_ticket) { state.tickets++; logger.info({ journeyId, seat, ticket: r.care_ticket.ref }, '🛎️ support ticket raised on Trip Rooms'); }
    });
  },

  /** SOS: urgent item in the Ops inbox, with the bus position. */
  sos(journeyId: string, seat: string, coords: { lat: number; lng: number } | null, incidentId: string) {
    enqueue(journeyId, 'sos', async () => {
      const { roomId, memberId } = await memberFor(journeyId, seat);
      const r = await api<{ ref: string }>('POST', `/v1/rooms/${roomId}/members/${memberId}/sos`, { reason: 'SOS from the AbhiBus app', coords, external_incident_id: incidentId });
      logger.warn({ journeyId, seat, ref: r.ref }, '🚨 SOS forwarded to Trip Rooms Ops');
    });
  },

  /** Register (or re-register) our webhook. Secrets are shown once, so each boot replaces ours. */
  async start() {
    if (!enabled) { state.webhook = 'off'; logger.info('Trip Rooms bridge off (set PLATFORM_API_URL / PLATFORM_CLIENT_ID / PLATFORM_CLIENT_SECRET to connect)'); return; }
    for (let i = 0; ; i++) {
      try {
        const hooks = await api<{ data: { id: string; url: string }[] }>('GET', '/v1/webhooks');
        for (const h of hooks.data.filter((x) => x.url === CALLBACK)) await api('DELETE', `/v1/webhooks/${h.id}`);
        const h = await api<{ secret: string }>('POST', '/v1/webhooks', { url: CALLBACK, events: ['action.updated', 'room.message_posted', 'member.left', 'member.muted', 'member.unmuted', 'member.restored', 'room.state_changed', 'room.deleted'] });
        webhookSecret = h.secret; state.webhook = 'ready'; state.lastError = null;
        logger.info({ api: BASE, callback: CALLBACK }, '🔗 Trip Rooms bridge connected');
        void linkActiveJourneys();
        return;
      } catch (err) {
        state.lastError = `webhook setup: ${(err as Error).message}`;
        if (i === 0) logger.warn({ err: state.lastError }, 'Trip Rooms bridge: platform not reachable yet, retrying every 30 s');
        await new Promise((r) => setTimeout(r, 30_000));
      }
    }
  },

  /** Vote in a console poll shown in the app. Records the seat's vote here too, so the card remembers it. */
  async vote(journeyId: string, seat: string, appMessageId: string, option: number) {
    const msg = await prisma.message.findUniqueOrThrow({ where: { messageId: appMessageId }, include: { room: true } });
    const p = msg.payload as Extract<BroadcastPayload, { kind: 'POLL_CARD' }>;
    if (p.kind !== 'POLL_CARD' || msg.room.journeyId !== journeyId) throw new BridgeError(404, 'not a poll');
    const { roomId, memberId } = await memberFor(journeyId, seat);
    const out = await api<{ results: { option: string; votes: number }[] }>('POST', `/v1/rooms/${roomId}/members/${memberId}/polls/${p.platformMessageId}/vote`, { options: [option] });
    await prisma.$transaction([
      prisma.messageReaction.deleteMany({ where: { messageId: appMessageId, seatNumber: seat, emoji: { startsWith: CARD_VOTE_PREFIX } } }),
      prisma.messageReaction.create({ data: { messageId: appMessageId, seatNumber: seat, emoji: `${CARD_VOTE_PREFIX}${option}` } }),
    ]);
    await hub.emitReactions(journeyId, msg.room.roomType as RoomType, appMessageId);
    return out;
  },
  /** Answer a console survey shown in the app. Counted as a campaign response on the platform. */
  async answer(journeyId: string, seat: string, appMessageId: string, answers: (string | number)[]) {
    const msg = await prisma.message.findUniqueOrThrow({ where: { messageId: appMessageId }, include: { room: true } });
    const p = msg.payload as Extract<BroadcastPayload, { kind: 'SURVEY_CARD' }>;
    if (p.kind !== 'SURVEY_CARD' || msg.room.journeyId !== journeyId) throw new BridgeError(404, 'not a survey');
    const { roomId, memberId } = await memberFor(journeyId, seat);
    await api('POST', `/v1/rooms/${roomId}/members/${memberId}/surveys/${p.platformMessageId}/answers`, { answers });
    await prisma.messageReaction.upsert({ where: { messageId_seatNumber_emoji: { messageId: appMessageId, seatNumber: seat, emoji: CARD_SURVEY_DONE } }, create: { messageId: appMessageId, seatNumber: seat, emoji: CARD_SURVEY_DONE }, update: {} });
    await hub.emitReactions(journeyId, msg.room.roomType as RoomType, appMessageId);
    return { recorded: true };
  },

  /** A passenger tapped a sponsored card: count it on the campaign, return the coupon. */
  async adClick(journeyId: string, seat: string, platformMessageId: string) {
    if (!enabled) return { coupon: null };
    const { roomId, memberId } = await memberFor(journeyId, seat);
    return api<{ coupon: string | null }>('POST', `/v1/rooms/${roomId}/members/${memberId}/ad-click`, { message_id: platformMessageId });
  },

  // ---------------------------------------------------------- platform → app
  /** Verify `X-TripRooms-Signature: t=<unix>,v1=<hmac>` (5-minute window) and apply the event. */
  async handleWebhook(raw: Buffer | undefined, signature: string | undefined): Promise<{ status: number; body: object }> {
    if (!enabled || !webhookSecret) return { status: 503, body: { error: 'bridge not ready' } };
    const parts = Object.fromEntries((signature ?? '').split(',').map((p) => p.split('=') as [string, string]));
    const body = raw?.toString('utf8') ?? '';
    const expected = createHmac('sha256', webhookSecret).update(`${parts.t}.${body}`).digest('hex');
    const ok = !!parts.v1 && parts.v1.length === expected.length && timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected)) && Math.abs(Date.now() / 1000 - Number(parts.t)) < 300;
    if (!ok) return { status: 401, body: { error: 'bad signature' } };
    const e = JSON.parse(body) as { id: string; type: string; data: any };
    if (seenEvents.has(e.id)) return { status: 200, body: { duplicate: true } };
    seenEvents.add(e.id); if (seenEvents.size > 2000) seenEvents.delete(seenEvents.values().next().value!);

    if (e.type === 'action.updated' && e.data?.reply) {
      const who = parseExt(e.data.external_user_id);
      if (!who) return { status: 200, body: { ignored: 'not an app passenger' } };
      // Private: stored with visibleToSeat, pushed only to that seat's phones.
      await hub.createMessage(who.journeyId, 'MAIN_COMMON', {
        senderSeat: null, senderHandle: e.data.reply.from, contentType: 'BROADCAST', visibleToSeat: who.seat,
        payload: { kind: 'CARE_REPLY', text: e.data.reply.text, from: e.data.reply.from, ticketRef: e.data.ref } satisfies BroadcastPayload,
      });
      state.delivered++;
      logger.info({ journeyId: who.journeyId, seat: who.seat, ticket: e.data.ref }, '💬 support reply delivered to passenger');
      return { status: 200, body: { delivered: true } };
    }
    if (e.type === 'room.message_posted') {
      let j = await prisma.busJourney.findFirst({ where: { platformRoomId: e.data.room_id, status: { not: 'PURGED' } } });
      if (!j) { await linkActiveJourneys(); j = await prisma.busJourney.findFirst({ where: { platformRoomId: e.data.room_id, status: { not: 'PURGED' } } }); }
      if (!j) return { status: 200, body: { ignored: 'room not linked to a journey' } };
      const shown = await renderInApp(j.journeyId, e.data);
      if (shown) state.delivered++;
      return { status: 200, body: { shown } };
    }
    // An admin ended / closed / reopened / deleted the room in the console: the app's chat follows.
    // Only people's actions (actor = an email); the platform's own timetable never overrides the app's.
    if ((e.type === 'room.state_changed' || e.type === 'room.deleted') && /@/.test(e.data?.actor ?? '')) {
      const j = await prisma.busJourney.findFirst({ where: { platformRoomId: e.data.room_id } });
      if (!j) return { status: 200, body: { ignored: 'room not linked to a journey' } };
      const to = e.type === 'room.deleted' ? 'deleted' : e.data.to;
      if (to === 'read_only') {
        const purgeAt = new Date(Date.now() + config.PURGE_AFTER_ARRIVAL_MIN * 60_000);
        await prisma.busJourney.update({ where: { journeyId: j.journeyId }, data: { status: 'ARRIVED', actualEndTime: new Date(), purgeAt } });
        await hub.broadcastToJourney(j.journeyId, 'SYSTEM', { text: 'AbhiBus has ended this trip chat. You can still read it until it’s deleted.' }, 'AbhiBus');
        hub.emitToJourney(j.journeyId, S2C.JOURNEY_ENDING, { purgeAt: purgeAt.toISOString() });
      } else if (to === 'closed' || to === 'deleted') {
        await hub.broadcastToJourney(j.journeyId, 'SYSTEM', { text: 'AbhiBus has closed this trip chat.' }, 'AbhiBus').catch(() => {});
        await prisma.busJourney.update({ where: { journeyId: j.journeyId }, data: { status: 'PURGED', ...(to === 'deleted' ? { platformRoomId: null } : {}) } });
        await hub.closeJourney(j.journeyId);
      } else if (to === 'open' || to === 'onboard') {
        await prisma.busJourney.update({ where: { journeyId: j.journeyId }, data: { status: 'IN_TRANSIT', purgeAt: null, actualEndTime: null } });
        await hub.broadcastToJourney(j.journeyId, 'SYSTEM', { text: 'AbhiBus has reopened this trip chat.' }, 'AbhiBus');
      }
      logger.info({ journeyId: j.journeyId, to }, 'room lifecycle from Trip Rooms applied');
      return { status: 200, body: { applied: to } };
    }
    if (e.type === 'member.muted' || e.type === 'member.unmuted' || e.type === 'member.restored') {
      const who = parseExt(e.data.external_user_id);
      if (!who) return { status: 200, body: { ignored: 'not an app passenger' } };
      if (e.type === 'member.muted') await muteSeat(who.journeyId, who.seat);
      else await clearSeat(who.journeyId, who.seat);
      logger.info({ journeyId: who.journeyId, seat: who.seat, event: e.type }, 'moderation from Trip Rooms applied');
      return { status: 200, body: { applied: e.type } };
    }
    if (e.type === 'member.left' && e.data?.reason === 'moderation') {
      const who = parseExt(e.data.external_user_id);
      if (!who) return { status: 200, body: { ignored: 'not an app passenger' } };
      await removeSeat(who.journeyId, who.seat, 'You were removed from this trip chat by AbhiBus.', 'by AbhiBus');
      return { status: 200, body: { removed: true } };
    }
    return { status: 200, body: { ignored: e.type } };
  },
};

/**
 * One Console post → the app's native message. Returns false for types the app doesn't show.
 * Everything lands in every active room of the bus (common + women-only), like conductor posts.
 */
async function renderInApp(journeyId: string, d: { message_id: string; content_type: string; sender: string; payload: any }): Promise<boolean> {
  const p = d.payload ?? {};
  const say = (text: string, from: string, extra: Partial<Extract<BroadcastPayload, { kind: 'ANNOUNCEMENT' }>> = {}) =>
    hub.broadcastToJourney(journeyId, 'BROADCAST', { kind: 'ANNOUNCEMENT', text, from, ...extra } satisfies BroadcastPayload, from);
  const sponsored = (b: Omit<Extract<BroadcastPayload, { kind: 'SPONSORED' }>, 'kind' | 'platformMessageId'>) =>
    hub.broadcastToJourney(journeyId, 'BROADCAST', { kind: 'SPONSORED', platformMessageId: d.message_id, ...b } satisfies BroadcastPayload, b.advertiser);
  switch (d.content_type) {
    case 'ALERT': await say(p.text, 'AbhiBus Ops', { hi: p.translations?.hi ?? null, severity: p.severity }); return true;
    case 'CREW': await say(p.text, p.role ?? 'Crew'); return true;
    case 'VOUCHER': await say(`₹${p.amount} delay voucher for everyone on this trip, valid ${p.validDays ?? 30} days. It’s in your AbhiBus wallet.`, 'AbhiBus'); return true;
    case 'SYSTEM': await hub.broadcastToJourney(journeyId, 'SYSTEM', { text: p.text }, 'AbhiBus'); return true;
    case 'TIMER': {
      // Native pinned countdown, so the app shows the same rest-stop timer as the hosted chat.
      const min = Math.max(1, Math.round((+new Date(p.leaveAt) - Date.now()) / 60_000));
      await startRestStop(journeyId, { label: 'Rest stop', durationMin: Math.min(90, min), place: p.stop ?? null });
      return true;
    }
    case 'AD':
      await sponsored({ label: 'Ad', advertiser: p.advertiser, title: p.title, body: p.stop ? `${p.body} · at ${p.stop}` : p.body, cta: p.cta ?? 'View offer', coupon: p.coupon ?? null, tile: p.tile ?? '#2b9d74' });
      return true;
    case 'POLL':
      // Native, votable card. Votes go back to the platform, so results count every app.
      await hub.broadcastToJourney(journeyId, 'BROADCAST', { kind: 'POLL_CARD', platformMessageId: d.message_id, by: p.by ?? d.sender, question: p.question, options: p.options ?? [], sponsored: !!p.sponsored, closesAt: p.closesAt ?? null } satisfies BroadcastPayload, p.by ?? d.sender);
      return true;
    case 'SURVEY':
      // Same questions and answer types as the hosted chat (1–5 stars, choice, short text).
      await hub.broadcastToJourney(journeyId, 'BROADCAST', { kind: 'SURVEY_CARD', platformMessageId: d.message_id, by: p.by ?? d.sender, sponsored: false /* research, not an ad (same as the hosted chat) */, questions: (p.questions ?? []).slice(0, 4).map((q: any) => ({ type: q.type, q: q.q, ...(q.options ? { options: q.options } : {}) })) } satisfies BroadcastPayload, p.by ?? d.sender);
      return true;
    default: return false;
  }
}

/** Link every active trip to its room, so Console posts reach it even before any passenger speaks. */
async function linkActiveJourneys() {
  const active = await prisma.busJourney.findMany({ where: { status: { in: ['SCHEDULED', 'IN_TRANSIT'] }, platformRoomId: null } });
  for (const j of active) await roomFor(j.journeyId).catch((err) => logger.warn({ journeyId: j.journeyId, err: (err as Error).message }, 'platform bridge: link failed'));
}
