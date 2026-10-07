import type { Server as HttpServer } from 'http';
import { Server, type Socket } from 'socket.io';
import { z } from 'zod';
import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../lib/logger';
import { RateLimiter, limits } from '../lib/rateLimit';
import { verifyMemberToken } from '../auth/tokens';
import { hub } from '../core/hub';
import { createMessage, emitReactions, loadMessages, pinned, channelOf } from '../core/messages';
import { estimate } from '../core/location';
import { journeyInfo } from '../core/rooms';
import { getTenant, roomFeatures, isQuiet } from '../core/tenants';
import { display } from '../core/identity';
import { reportMessage, reportPerson } from '../core/moderation';
import { replyAsTara, wantsTara, catchUp } from '../core/tara';
import { startGame, makeMove } from '../core/games';
import { adClick } from '../core/ads';
import { emitEvent } from '../core/events';
import { setProfile } from '../core/members';
import * as T from '../core/traveller';
import { checkMessage, isCareMention, BLOCK_REASON_COPY } from '../shared/moderation';
import { raiseCareTicket } from '../core/actions';
import { haversineKm } from '../lib/geo';
import { ApiError } from '../lib/errors';
import {
  C2S, S2C, REPORT_REASONS, STICKER_IDS, POLL_LIMITS, POLL_VOTE_PREFIX, isReactionEmoji, isSystemReactionKey, roomKey, seatKey, tripKey,
  type Ack, type ErrorCode, type RoomSnapshot, type RoomType, type BusLocationPayload,
} from '../shared/protocol';

/**
 * ============================================================================
 *  Realtime gateway for the hosted chat screen
 * ============================================================================
 *  Handshake: auth.token = member token (POST /v1/rooms/{id}/members/{mid}/token).
 *  Every handler: validate (zod) → authorise (room/channel/feature/state) →
 *  rate-limit → moderate → persist → fan out → ack.
 * ============================================================================
 */
interface Data { roomId: string; memberId: string; tenantId: string }
type S = Socket<any, any, any, Data>;
const RoomTypeZ = z.enum(['MAIN_COMMON', 'WOMEN_ONLY']);
const fail = (code: ErrorCode, message: string): Ack<never> => ({ ok: false, code, message });
const ok = <T,>(data: T): Ack<T> => ({ ok: true, data });
const CoordsZ = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracyM: z.number().min(0).max(100_000).nullable().optional() });
const lastSend = new Map<string, number>();
const tick = new RateLimiter(1, 1 / 8);

export function createRealtime(httpServer: HttpServer) {
  const io = new Server(httpServer, {
    path: '/ws', cors: { origin: config.corsOrigins }, transports: ['websocket'], maxHttpBufferSize: 16 * 1024,
    perMessageDeflate: { threshold: 1024 }, pingInterval: 25_000, pingTimeout: 20_000, connectionStateRecovery: { maxDisconnectionDuration: 2 * 60_000 },
  });
  hub.attach(io);

  io.use(async (socket: S, next) => {
    try {
      const c = verifyMemberToken(String(socket.handshake.auth?.token ?? ''));
      const [m, r] = await Promise.all([prisma.member.findUnique({ where: { id: c.mid } }), prisma.room.findUnique({ where: { id: c.rid } })]);
      if (!m || !r || m.roomId !== r.id) return next(new Error('UNAUTHORIZED'));
      if (m.removedAt) return next(new Error(m.removedReason === 'reported_by_majority' ? 'REMOVED' : 'UNAUTHORIZED'));
      if (r.state === 'closed') return next(new Error('JOURNEY_CLOSED'));
      socket.data = { roomId: r.id, memberId: m.id, tenantId: r.tenantId };
      next();
    } catch { next(new Error('UNAUTHORIZED')); }
  });

  io.on('connection', (socket: S) => {
    const { roomId, memberId } = socket.data;
    socket.join(seatKey(roomId, memberId));
    socket.join(tripKey(roomId));
    void prisma.member.update({ where: { id: memberId }, data: { lastSeenAt: new Date() } }).catch(() => {});
    const inRoom = (rt: RoomType) => socket.rooms.has(roomKey(roomId, rt));
    const rl = (b: keyof typeof limits) => limits[b].take(`${memberId}:${b}`);
    const ctx = async () => {
      const [room, me] = await Promise.all([prisma.room.findUniqueOrThrow({ where: { id: roomId } }), prisma.member.findUniqueOrThrow({ where: { id: memberId } })]);
      if (me.removedAt) throw new ApiError('forbidden', 'You were removed from this chat.');
      return { room, me };
    };
    const myName = async () => { const { room, me } = await ctx(); return display(me, (await getTenant(room.tenantId)).cfg.identity.mode).name; };

    function on<Z extends z.ZodTypeAny>(event: string, schema: Z, fn: (input: z.infer<Z>) => Promise<Ack<any>>) {
      socket.on(event, async (raw: unknown, ack?: (a: Ack<any>) => void) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        const parsed = schema.safeParse(raw ?? {});
        if (!parsed.success) return reply(fail('INVALID', 'Invalid request.'));
        try { reply(await fn(parsed.data)); }
        catch (err) {
          if (err instanceof ApiError) return reply(fail(err.code === 'feature_disabled' ? 'FEATURE_OFF' : err.code === 'room_state' ? 'GAME_CLOSED' : err.code === 'forbidden' ? 'FORBIDDEN' : err.code === 'not_found' ? 'NOT_FOUND' : 'INVALID', err.message));
          logger.error({ err, event, roomId, memberId }, 'socket handler failed');
          reply(fail('INTERNAL', 'Something went wrong. Try again.'));
        }
      });
    }
    /** Shared checks for anything a traveller posts. */
    const canPost = async (rt: RoomType) => {
      const { room, me } = await ctx();
      if (!inRoom(rt)) return { err: fail('NOT_IN_ROOM', 'Join the room first.') };
      if (me.muted) return { err: fail('MUTED', 'You’ve been muted for the rest of this trip.') };
      if (room.opsOnly) return { err: fail('OPS_ONLY', 'Only Ops can post right now.') };
      if (room.state === 'read_only' || room.state === 'closed') return { err: fail('JOURNEY_CLOSED', 'This trip is over. The room is read-only.') };
      return { room, me };
    };

    // ------------------------------------------------------------- join ----
    on(C2S.ROOM_JOIN, z.object({ roomType: RoomTypeZ, since: z.string().datetime().optional() }), async ({ roomType, since }) => {
      const { room, me } = await ctx();
      const f = await roomFeatures(room);
      // WOMEN-ONLY GATE (server-authoritative): booking gender sent by the tenant, re-checked on every join.
      if (roomType === 'WOMEN_ONLY' && (!f.women_channel || me.gender !== 'F')) {
        if (me.gender !== 'F') logger.warn({ roomId, memberId }, 'SECURITY: blocked women-only join');
        return fail('FORBIDDEN', 'This room is only for travellers booked as women on this trip.');
      }
      await channelOf(roomId, roomType);
      socket.join(roomKey(roomId, roomType));
      const page = since ? { ...(await loadMessages(roomId, roomType, me, { after: new Date(since), limit: 200 })), hasMore: true } : await loadMessages(roomId, roomType, me, { limit: 60 });
      const loc = await estimate(room);
      const timer = await prisma.message.findFirst({ where: { channel: { roomId, kind: roomType === 'MAIN_COMMON' ? 'MAIN' : 'WOMEN' }, contentType: 'TIMER' }, orderBy: { createdAt: 'desc' } });
      const snap: RoomSnapshot = {
        roomType, messages: page.messages, hasMore: page.hasMore, presence: await hub.presence(roomId, roomType),
        pinned: null, game: null,
        progress: { progress: loc.progress, placeLabel: loc.near.replace(/^(near|at|between) /, ''), highway: '', nextStop: loc.nextStop ? { name: loc.nextStop.name, distanceKm: 0 } : null, etaToDestination: new Date(+room.arrivesAt + room.delayMin * 60_000).toISOString(), updatedAt: loc.updatedAt },
        landmarks: [], muted: me.muted,
        blockedSeats: (await prisma.block.findMany({ where: { roomId, blockerId: memberId } })).map((b) => b.blockedId),
        serverNow: new Date().toISOString(),
        alert: await pinned(roomId, roomType),
        timer: timer && Date.parse((timer.payload as any).leaveAt) > Date.now() - 10 * 60_000 ? (await (await import('../core/messages')).toDtos([{ ...timer, reactions: [], receipts: [] }]))[0] : null,
        location: loc, journey: await journeyInfo(room, me), sharingLocation: me.sharingLocation,
      };
      hub.schedulePresence(roomId, roomType);
      return ok(snap);
    });
    on(C2S.ROOM_LEAVE, z.object({ roomType: RoomTypeZ }), async ({ roomType }) => { socket.leave(roomKey(roomId, roomType)); hub.schedulePresence(roomId, roomType); return ok(null); });
    on(C2S.ROOM_HISTORY, z.object({ roomType: RoomTypeZ, before: z.string().datetime() }), async ({ roomType, before }) => {
      if (!inRoom(roomType)) return fail('NOT_IN_ROOM', 'Join the room first.');
      const { me } = await ctx();
      return ok(await loadMessages(roomId, roomType, me, { before: new Date(before), limit: 40 }));
    });

    // ------------------------------------------------------------- send ----
    const SendZ = z.discriminatedUnion('contentType', [
      z.object({ roomType: RoomTypeZ, clientMsgId: z.string().min(6).max(64), contentType: z.literal('TEXT'), payload: z.object({ text: z.string().max(2000) }) }),
      z.object({ roomType: RoomTypeZ, clientMsgId: z.string().min(6).max(64), contentType: z.literal('STICKER'), payload: z.object({ stickerId: z.string() }) }),
    ]);
    on(C2S.MSG_SEND, SendZ, async (input) => {
      const c = await canPost(input.roomType);
      if ('err' in c) return c.err!;
      const { room, me } = c;
      const { cfg } = await getTenant(room.tenantId);
      const f = await roomFeatures(room);
      if (!f.chat) return fail('FEATURE_OFF', 'Group chat is off for this trip. Ask Tara instead.');
      // Slow mode is an Ops switch for heated rooms; normal chat is only burst-limited (limits.message).
      const gap = room.slowMode ? Math.max(5, cfg.slow_mode_sec) * 1000 : 0;
      const wait = Math.ceil((gap - (Date.now() - (lastSend.get(memberId) ?? 0))) / 1000);
      if (gap && wait > 0) return fail('SLOW_MODE', `Slow mode: you can send again in ${wait} s.`);
      if (!rl('message')) return fail('RATE_LIMITED', 'Slow down a little.');
      let payload: object;
      if (input.contentType === 'TEXT') {
        const v = checkMessage(input.payload.text, [cfg.support.care_handle]);
        if (!v.ok) return fail('BLOCKED_CONTENT', BLOCK_REASON_COPY[v.reason]);
        const care = f.mentions && isCareMention(v.text, cfg.support.care_handle);
        payload = care ? { text: v.text, mentions: ['CARE'] } : { text: v.text };
      } else {
        if (!STICKER_IDS.includes(input.payload.stickerId as any)) return fail('INVALID', 'Unknown sticker.');
        payload = { stickerId: input.payload.stickerId };
      }
      lastSend.set(memberId, Date.now());
      const msg = await createMessage(roomId, input.roomType, { senderId: memberId, senderName: display(me, cfg.identity.mode).name, contentType: input.contentType, payload, clientMsgId: input.clientMsgId });
      // @care / @support / @<App> Care → a ticket in Console → Customer support (also fires the care.mentioned webhook).
      if ((payload as any).mentions) await raiseCareTicket(room, me, display(me, cfg.identity.mode).name, (payload as any).text, msg.id);
      if (input.contentType === 'TEXT' && (await wantsTara(room, (payload as any).text))) setTimeout(() => void replyAsTara(room, input.roomType, me, (payload as any).text).catch(() => {}), 700);
      return ok(msg);
    });

    on(C2S.MSG_SEEN, z.object({ roomType: RoomTypeZ, messageIds: z.array(z.string().uuid()).min(1).max(100) }), async ({ roomType, messageIds }) => {
      if (!inRoom(roomType)) return ok(null);
      const ch = await channelOf(roomId, roomType);
      const rows = await prisma.message.findMany({ where: { id: { in: messageIds }, channelId: ch.id, senderId: { not: memberId } }, select: { id: true } });
      if (!rows.length) return ok(null);
      await prisma.receipt.createMany({ data: rows.map((r) => ({ messageId: r.id, memberId })), skipDuplicates: true });
      hub.toChannel(roomId, roomType, S2C.RECEIPTS, { roomType, updates: rows.map((r) => ({ messageId: r.id, seats: [memberId] })) });
      return ok(null);
    });
    on(C2S.MSG_REACT, z.object({ messageId: z.string().uuid(), emoji: z.string().max(16).refine(isReactionEmoji) }), async ({ messageId, emoji }) => {
      const { room } = await ctx();
      if (!(await roomFeatures(room)).reactions) return fail('FEATURE_OFF', 'Reactions are off for this trip.');
      if (!rl('reaction')) return fail('RATE_LIMITED', 'Slow down a little.');
      const mine = await prisma.reaction.findMany({ where: { messageId, memberId } });
      const emojiRows = mine.filter((r) => !isSystemReactionKey(r.key) && !r.key.includes(':'));
      const had = emojiRows.some((r) => r.key === emoji);
      await prisma.$transaction([
        prisma.reaction.deleteMany({ where: { messageId, memberId, key: { in: emojiRows.map((r) => r.key) } } }),
        ...(had ? [] : [prisma.reaction.create({ data: { messageId, memberId, key: emoji } })]),
      ]);
      await emitReactions(messageId);
      return ok(null);
    });

    // ------------------------------------------------------ polls & games --
    on(C2S.POLL_CREATE, z.object({ roomType: RoomTypeZ, clientMsgId: z.string().min(6).max(64), question: z.string().max(POLL_LIMITS.questionMax), multi: z.boolean(), options: z.array(z.string().max(POLL_LIMITS.optionMax)).min(2).max(POLL_LIMITS.maxOptions) }), async (b) => {
      const c = await canPost(b.roomType);
      if ('err' in c) return c.err!;
      if (!(await roomFeatures(c.room)).polls) return fail('FEATURE_OFF', 'Polls are off for this trip.');
      const texts = [b.question, ...b.options].map((t) => t.trim());
      if (texts.some((t) => !t)) return fail('INVALID', 'Fill in the question and every option.');
      for (const t of texts) { const v = checkMessage(t); if (!v.ok) return fail('BLOCKED_CONTENT', BLOCK_REASON_COPY[v.reason]); }
      return ok(await createMessage(roomId, b.roomType, { senderId: memberId, senderName: await myName(), contentType: 'POLL', payload: { question: texts[0], options: texts.slice(1), multi: b.multi }, clientMsgId: b.clientMsgId }));
    });
    on(C2S.POLL_VOTE, z.object({ messageId: z.string().uuid(), options: z.array(z.number().int().min(0).max(11)).max(12) }), async ({ messageId, options }) => {
      if (!rl('reaction')) return fail('RATE_LIMITED', 'Slow down a little.');
      const { me } = await ctx();
      try { await T.votePoll(me, messageId, options); return ok(null); }
      catch (e: any) { return fail(e?.code === 'not_found' ? 'NOT_FOUND' : e?.code === 'room_state' ? 'GAME_CLOSED' : 'INVALID', e?.message ?? 'Couldn’t vote.'); }
    });
    on(C2S.GAME_START, z.object({ roomType: RoomTypeZ, clientMsgId: z.string().min(6).max(64), kind: z.enum(['QUIZ', 'EMOJI', 'TTT']) }), async ({ roomType, clientMsgId, kind }) => {
      const c = await canPost(roomType);
      if ('err' in c) return c.err!;
      return ok(await startGame(c.room, roomType, c.me, kind, clientMsgId));
    });
    on(C2S.GAME_MOVE, z.object({ messageId: z.string().uuid(), move: z.discriminatedUnion('type', [z.object({ type: z.literal('answer'), option: z.number().int().min(0).max(9) }), z.object({ type: z.literal('join') }), z.object({ type: z.literal('cell'), cell: z.number().int().min(0).max(8) })]) }), async ({ messageId, move }) => {
      if (!rl('reaction')) return fail('RATE_LIMITED', 'Slow down a little.');
      const { room, me } = await ctx();
      await makeMove(room, me, messageId, move);
      return ok(null);
    });

    // ---------------------------------------------------------- location --
    on(C2S.LOCATION_SHARE, z.object({ roomType: RoomTypeZ, clientMsgId: z.string().min(6).max(64), coords: CoordsZ.optional(), live: z.object({ minutes: z.union([z.literal(10), z.literal(15), z.literal(20)]) }).optional() }), async ({ roomType, clientMsgId, coords, live }) => {
      const c = await canPost(roomType);
      if ('err' in c) return c.err!;
      if (!rl('location')) return fail('RATE_LIMITED', 'A location was just shared. Try again in a bit.');
      const { room } = c;
      if (live && !(await roomFeatures(room)).live_location) return fail('FEATURE_OFF', 'Live location is off for this trip.');
      const loc = await estimate(room);
      const official = await prisma.locationFix.findFirst({ where: { roomId, source: { not: 'crowd' }, lat: { not: null } }, orderBy: { recordedAt: 'desc' } });
      let payload: BusLocationPayload;
      if (coords) {
        payload = { lat: coords.lat, lng: coords.lng, placeLabel: 'Shared location', highway: '', speedKmph: null, recordedAt: new Date().toISOString(), progress: loc.progress, nextStop: null, source: 'PASSENGER', accuracyM: coords.accuracyM != null ? Math.round(coords.accuracyM) : null, distanceFromBusM: official?.lat != null ? Math.round(haversineKm(coords, { lat: official.lat, lng: official.lng! }) * 1000) : null, live: live ? { minutes: live.minutes, until: new Date(Date.now() + live.minutes * 60_000).toISOString(), stoppedAt: null } : null };
      } else {
        payload = { lat: official?.lat ?? 0, lng: official?.lng ?? 0, placeLabel: loc.near.replace(/^(near|at) /, ''), highway: loc.source, speedKmph: null, recordedAt: loc.updatedAt, progress: loc.progress, nextStop: loc.nextStop ? { name: loc.nextStop.name, distanceKm: 0 } : null, source: 'BUS' };
      }
      const msg = await createMessage(roomId, roomType, { senderId: memberId, senderName: await myName(), contentType: 'BUS_LOCATION', payload, clientMsgId });
      if (live) setTimeout(() => void (async () => (await import('../core/messages')).pushUpdate(msg.id))(), live.minutes * 60_000 + 500).unref();
      return ok(msg);
    });
    const ownLive = async (messageId: string) => {
      const m = await prisma.message.findUnique({ where: { id: messageId } });
      const p = m?.payload as BusLocationPayload | undefined;
      return m && m.senderId === memberId && p?.live ? { m, p } : null;
    };
    on(C2S.LOCATION_UPDATE, z.object({ messageId: z.string().uuid(), coords: CoordsZ }), async ({ messageId, coords }) => {
      if (!tick.take(memberId)) return ok(null);
      const own = await ownLive(messageId);
      if (!own) return fail('NOT_FOUND', 'Live location not found.');
      if (own.p.live!.stoppedAt || Date.now() >= Date.parse(own.p.live!.until)) return fail('GAME_CLOSED', 'Live location has ended.');
      await prisma.message.update({ where: { id: messageId }, data: { payload: { ...own.p, lat: coords.lat, lng: coords.lng, accuracyM: coords.accuracyM ?? null, recordedAt: new Date().toISOString() } as object } });
      await (await import('../core/messages')).pushUpdate(messageId);
      return ok(null);
    });
    on(C2S.LOCATION_STOP, z.object({ messageId: z.string().uuid() }), async ({ messageId }) => {
      const own = await ownLive(messageId);
      if (!own) return fail('NOT_FOUND', 'Live location not found.');
      await prisma.message.update({ where: { id: messageId }, data: { payload: { ...own.p, live: { ...own.p.live!, stoppedAt: new Date().toISOString() } } as object } });
      await (await import('../core/messages')).pushUpdate(messageId);
      return ok(null);
    });
    /** Anonymous crowd location while on board (helps everyone track the vehicle). Stops at the drop point. */
    on(C2S.CROWD_SHARE, z.object({ on: z.boolean(), coords: CoordsZ.optional() }), async ({ on: share, coords }) => {
      const { room } = await ctx();
      if (!(await roomFeatures(room)).location_crowd) return fail('FEATURE_OFF', 'Crowd location is off for this trip.');
      if (share && room.state !== 'onboard') return fail('INVALID', 'You can share once you’re on board.');
      await prisma.member.update({ where: { id: memberId }, data: { sharingLocation: share } });
      if (share && coords) await prisma.locationFix.create({ data: { roomId, source: 'crowd', memberId, lat: coords.lat, lng: coords.lng } });
      if (share) await emitEvent(room.tenantId, roomId, 'location.sharing_started', { room_id: roomId });
      hub.toTrip(roomId, S2C.LOCATION, await estimate(room));
      return ok(null);
    });
    on(C2S.CROWD_PING, z.object({ coords: CoordsZ }), async ({ coords }) => {
      if (!limits.location.take(`${memberId}:ping`)) return ok(null);
      const { me } = await ctx();
      if (!me.sharingLocation) return ok(null);
      await prisma.locationFix.create({ data: { roomId, source: 'crowd', memberId, lat: coords.lat, lng: coords.lng } });
      return ok(null);
    });

    // ------------------------------------------------- safety & reporting --
    on(C2S.MSG_REPORT, z.object({ messageId: z.string().uuid(), reason: z.enum(REPORT_REASONS) }), async ({ messageId, reason }) => {
      if (!rl('report')) return fail('RATE_LIMITED', 'You’ve sent several reports. Our team is reviewing them.');
      const { room, me } = await ctx();
      await reportMessage(room, me, messageId, reason);
      return ok(null);
    });
    on(C2S.PERSON_REPORT, z.object({ seat: z.string().max(40), roomType: RoomTypeZ, reason: z.enum(REPORT_REASONS) }), async ({ seat, reason }) => {
      if (!rl('report')) return fail('RATE_LIMITED', 'You’ve sent several reports. Our team is reviewing them.');
      const { room, me } = await ctx();
      await reportPerson(room, me, seat, reason);
      return ok(null);
    });
    on(C2S.SEAT_BLOCK, z.object({ seat: z.string().max(40), blocked: z.boolean() }), async ({ seat, blocked }) => {
      if (seat === memberId) return fail('INVALID', 'You can’t block yourself.');
      if (blocked) await prisma.block.upsert({ where: { roomId_blockerId_blockedId: { roomId, blockerId: memberId, blockedId: seat } }, create: { roomId, blockerId: memberId, blockedId: seat }, update: {} });
      else await prisma.block.deleteMany({ where: { roomId, blockerId: memberId, blockedId: seat } });
      return ok((await prisma.block.findMany({ where: { roomId, blockerId: memberId } })).map((b) => b.blockedId));
    });
    on(C2S.SOS_RAISE, z.object({ reason: z.string().min(1).max(60), coords: CoordsZ.optional() }), async ({ reason, coords }) => {
      if (!rl('action')) return fail('RATE_LIMITED', 'Your alert is already with Ops.');
      const { room, me } = await ctx();
      const a = await T.raiseSos(room, me, reason, coords ?? null);
      return ok({ actionId: a.id });
    });
    on(C2S.WAIT_REQUEST, z.object({ minutes: z.number().int().min(1).max(30) }), async ({ minutes }) => {
      if (!rl('action')) return fail('RATE_LIMITED', 'Ops already has your request.');
      const { room, me } = await ctx();
      return ok({ actionId: (await T.waitForMe(room, me, minutes)).id });
    });
    on(C2S.ISSUE_REPORT, z.object({ roomType: RoomTypeZ, label: z.string().min(1).max(60) }), async ({ roomType, label }) => {
      if (!rl('action')) return fail('RATE_LIMITED', 'Slow down a little.');
      const { room, me } = await ctx();
      return ok({ messageId: await T.reportIssue(room, me, roomType, label) });
    });
    on(C2S.ISSUE_METOO, z.object({ messageId: z.string().uuid() }), async ({ messageId }) => { const { room, me } = await ctx(); await T.metoo(room, me, messageId); return ok(null); });
    on(C2S.LOST_POST, z.object({ roomType: RoomTypeZ, text: z.string().min(1).max(300) }), async ({ roomType, text }) => {
      if (!rl('action')) return fail('RATE_LIMITED', 'Slow down a little.');
      const { room, me } = await ctx();
      return ok(await T.lostFound(room, me, roomType, text));
    });

    // ------------------------------------------- cards: survey, voucher… --
    on(C2S.SURVEY_ANSWER, z.object({ messageId: z.string().uuid(), answers: z.array(z.union([z.string().max(200), z.number()])).max(6) }), async ({ messageId, answers }) => { const { room, me } = await ctx(); await T.answerSurvey(room, me, messageId, answers); return ok(null); });
    on(C2S.VOUCHER_CLAIM, z.object({ messageId: z.string().uuid() }), async ({ messageId }) => { const { room, me } = await ctx(); return ok(await T.claimVoucher(room, me, messageId)); });
    on(C2S.AD_CLICK, z.object({ messageId: z.string().uuid() }), async ({ messageId }) => ok(await adClick(roomId, memberId, messageId)));
    on(C2S.RATE_TRIP, z.object({ messageId: z.string().uuid(), stars: z.number().int().min(1).max(5) }), async ({ messageId, stars }) => { const { room, me } = await ctx(); await T.rateTrip(room, me, messageId, stars); return ok(null); });

    // -------------------------------------------------------------- Tara --
    on(C2S.CATCH_UP, z.object({ roomType: RoomTypeZ.optional() }), async ({ roomType }) => {
      const { room, me } = await ctx();
      const text = await catchUp(room);
      await createMessage(roomId, roomType ?? 'MAIN_COMMON', { senderName: 'Tara', contentType: 'PRIVATE', payload: { text, from: 'Tara' }, visibleTo: me.id });
      return ok(null);
    });
    on(C2S.ASK_TARA, z.object({ roomType: RoomTypeZ, question: z.string().min(1).max(300) }), async ({ roomType, question }) => {
      const { room, me } = await ctx();
      if (!(await roomFeatures(room)).tara) return fail('FEATURE_OFF', 'Tara is off for this trip.');
      await replyAsTara(room, roomType, me, question, { privateTo: me.id });
      return ok(null);
    });

    // ----------------------------------------------------------- profile --
    on(C2S.PROFILE_SET, z.object({ name: z.string().max(40), avatar: z.string().max(16).nullable() }), async ({ name, avatar }) => {
      const { me } = await ctx();
      const m = await setProfile(me, name, avatar);
      hub.schedulePresence(roomId, 'MAIN_COMMON');
      return ok({ name: m.displayName, avatar: m.avatarId });
    });

    socket.on(C2S.TYPING, (raw: unknown) => {
      const p = z.object({ roomType: RoomTypeZ, isTyping: z.boolean() }).safeParse(raw);
      if (!p.success || !inRoom(p.data.roomType)) return;
      socket.to(roomKey(roomId, p.data.roomType)).emit(S2C.TYPING, { roomType: p.data.roomType, seat: memberId, isTyping: p.data.isTyping });
    });
    socket.on('disconnect', () => { hub.schedulePresence(roomId, 'MAIN_COMMON'); hub.schedulePresence(roomId, 'WOMEN_ONLY'); });
  });
  return io;
}

export const quietNow = isQuiet;
