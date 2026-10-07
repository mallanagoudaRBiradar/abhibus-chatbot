import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { ApiError, wrap } from '../lib/errors';
import { requireTenant } from '../auth/middleware';
import { signTenantToken } from '../auth/tokens';
import { verifySecret, randomSecret } from '../lib/crypto';
import { newId } from '../lib/ids';
import { limits } from '../lib/rateLimit';
import { RoomUpsertZ, getRoomForTenant, roomDto, upsertRoom, timings, stopsOf } from '../core/rooms';
import { MemberInZ, addMembers, getMember, memberDto, memberToken, moveMembers, removeMember } from '../core/members';
import { TripEventZ, applyTripEvent } from '../core/tripEvents';
import { postAlert } from '../core/alerts';
import { createInAllChannels, loadMessages, msgInclude, toDtos, KIND_TO_RT } from '../core/messages';
import { estimate } from '../core/location';
import { createRoomPoll, issueVoucher, sendSurvey } from '../core/traveller';
import { startGame, GAMES_CATALOG } from '../core/games';
import { actionDto, updateAction } from '../core/actions';
import { moderateRoom, revealMember } from '../core/moderation';
import { getTenant, invalidateTenant } from '../core/tenants';
import { emitEvent } from '../core/events';
import { audit } from '../core/audit';
import { hub } from '../core/hub';
import { mergeConfig } from '../shared/tenantConfig';
import { SCOPES } from '../shared/roles';
import { checkMessage, isCareMention } from '../shared/moderation';
import { toRef } from '../shared/refs';
import { display } from '../core/identity';
import { raiseCareTicket } from '../core/actions';
import { raiseSos, votePoll, answerSurvey } from '../core/traveller';
import { adClick } from '../core/ads';
import { createMessage } from '../core/messages';
import { campaignCreate, campaignStats } from './campaigns';
import { S2C } from '../shared/protocol';

/**
 * ============================================================================
 *  Tenant API  /v1   (server-to-server; never ship tokens in an app)
 * ============================================================================
 *  Four calls to plug in a tenant:
 *    1. PUT  /v1/rooms/by-key/{trip_key}          create or get the trip room
 *    2. POST /v1/rooms/{id}/members                add the traveller
 *    3. POST /v1/rooms/{id}/members/{mid}/token    short-lived member token
 *    4. open the hosted chat screen with that token (WebView / RN component)
 *  Then keep the room accurate with /trip-events and /location/sources.
 * ============================================================================
 */
export const v1 = Router();
const actor = (req: Request) => `client:${req.tenant!.cid}`;
const room = (req: Request) => getRoomForTenant(req.tenant!.tid, req.params.room_id);

// ---------------------------------------------------------- idempotency ---
const idem = new Map<string, { at: number; status: number; body: unknown }>();
setInterval(() => { const cut = Date.now() - 24 * 3600_000; for (const [k, v] of idem) if (v.at < cut) idem.delete(k); }, 600_000).unref();
v1.use((req: Request, res: Response, next: NextFunction) => {
  const k = req.header('idempotency-key');
  if (req.method !== 'POST' || !k) return next();
  const key = `${req.header('authorization')?.slice(-16)}:${req.path}:${k}`;
  const hit = idem.get(key);
  if (hit) return res.status(hit.status).setHeader('Idempotent-Replay', 'true').json(hit.body);
  const json = res.json.bind(res);
  res.json = (body: unknown) => { if (res.statusCode < 500) idem.set(key, { at: Date.now(), status: res.statusCode, body }); return json(body); };
  next();
});

// ------------------------------------------------------------------ auth ---
v1.post('/oauth/token', wrap(async (req, res) => {
  const b = z.object({ grant_type: z.literal('client_credentials'), client_id: z.string(), client_secret: z.string(), scope: z.string().optional() }).parse(req.body);
  if (!limits.login.take(`oauth:${req.ip}:${b.client_id}`)) throw new ApiError('rate_limited', 'Too many attempts.');
  const c = await prisma.apiClient.findUnique({ where: { clientId: b.client_id } });
  if (!c || c.revokedAt || !verifySecret(b.client_secret, c.secretHash)) throw new ApiError('unauthorized', 'Invalid client credentials.');
  const asked = b.scope ? b.scope.split(/\s+/).filter(Boolean) : c.scopes;
  const scopes = asked.filter((s) => c.scopes.includes(s));
  await prisma.apiClient.update({ where: { id: c.id }, data: { lastUsedAt: new Date() } });
  res.json({ access_token: signTenantToken({ tid: c.tenantId, cid: c.clientId, scopes }), token_type: 'Bearer', expires_in: 3600, tenant: c.tenantId, scope: scopes.join(' ') });
}));

// ----------------------------------------------------------------- rooms ---
v1.put('/rooms/by-key/:trip_key', requireTenant('rooms:write'), wrap(async (req, res) => {
  const body = RoomUpsertZ.parse(req.body);
  const { room: r, created } = await upsertRoom(req.tenant!.tid, req.params.trip_key, body, actor(req));
  res.status(created ? 201 : 200).json(await roomDto(r, { created }));
}));
v1.get('/rooms/:room_id', requireTenant('rooms:read'), wrap(async (req, res) => {
  const r = await room(req);
  res.json(await roomDto(r, { location: await estimate(r) }));
}));
v1.get('/rooms', requireTenant('rooms:read'), wrap(async (req, res) => {
  const q = z.object({ vertical: z.enum(['bus', 'train', 'flight', 'custom']).optional(), state: z.string().optional(), date: z.string().optional(), cursor: z.string().optional(), operator_id: z.string().optional(), train_no: z.string().optional(), flight_no: z.string().optional() }).parse(req.query);
  const where: any = { tenantId: req.tenant!.tid, ...(q.vertical ? { vertical: q.vertical } : {}), ...(q.state ? { state: { in: q.state.split(',') } } : {}) };
  if (q.date) { const d = new Date(`${q.date}T00:00:00+05:30`); where.departsAt = { gte: d, lt: new Date(+d + 86_400_000) }; }
  for (const k of ['operator_id', 'train_no', 'flight_no'] as const) if (q[k]) where.scope = { path: [k], equals: q[k] };
  const rows = await prisma.room.findMany({ where, orderBy: { departsAt: 'asc' }, take: 51, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}) });
  res.json({ data: await Promise.all(rows.slice(0, 50).map((r) => roomDto(r))), next_cursor: rows.length > 50 ? rows[49].id : null });
}));
v1.patch('/rooms/:room_id', requireTenant('rooms:write'), wrap(async (req, res) => {
  const r = await room(req);
  const b = z.object({ title: z.string().max(120).optional(), subtitle: z.string().max(160).optional(), schedule: RoomUpsertZ.shape.schedule.optional(), scope: z.record(z.any()).optional(), features: z.record(z.boolean()).optional(), meta: z.record(z.string()).optional() }).parse(req.body);
  const { cfg } = await getTenant(r.tenantId);
  const data: any = {};
  const updated: string[] = [];
  if (b.title) { data.title = b.title; updated.push('title'); }
  if (b.subtitle !== undefined) { data.subtitle = b.subtitle; updated.push('subtitle'); }
  if (b.scope) { data.scope = { ...(r.scope as object), ...b.scope }; updated.push(...Object.keys(b.scope).map((k) => `scope.${k}`)); }
  if (b.features) { data.features = { ...((r.features ?? {}) as object), ...b.features }; updated.push(...Object.keys(b.features).map((k) => `features.${k}`)); }
  if (b.meta) { data.meta = { ...((r.meta ?? {}) as object), ...b.meta }; updated.push('meta'); }
  if (b.schedule) {
    data.departsAt = new Date(b.schedule.departs_at); data.arrivesAt = new Date(b.schedule.arrives_at);
    Object.assign(data, (({ opensAt, readOnlyAt, purgeAt }) => ({ opensAt, readOnlyAt, purgeAt }))(timings(data.departsAt, data.arrivesAt, r.delayMin, cfg.timing)));
    updated.push('schedule');
  }
  await prisma.room.update({ where: { id: r.id }, data });
  await emitEvent(r.tenantId, r.id, 'room.updated', { room_id: r.id, updated, actor: actor(req) });
  res.json({ id: r.id, updated });
}));
v1.post('/rooms/:room_id/close', requireTenant('rooms:write'), wrap(async (req, res) => {
  const r = await room(req);
  const b = z.object({ reason: z.enum(['trip_cancelled', 'trip_completed', 'merged', 'other']), read_only_for_min: z.number().int().min(0).max(1440).optional(), message: z.string().max(500).optional() }).parse(req.body);
  if (b.message) await postAlert(r, { text: b.message, severity: b.reason === 'trip_cancelled' ? 'critical' : 'info' }, actor(req));
  const state = b.read_only_for_min === 0 ? 'closed' : 'read_only';
  await prisma.room.update({ where: { id: r.id }, data: { state, readOnlyAt: new Date() } });
  if (state === 'closed') hub.toTrip(r.id, S2C.JOURNEY_CLOSED, {});
  await emitEvent(r.tenantId, r.id, 'room.state_changed', { room_id: r.id, from: r.state, to: state, reason: b.reason });
  res.json({ id: r.id, state });
}));

// --------------------------------------------------------------- members ---
v1.post('/rooms/:room_id/members', requireTenant('members:write'), wrap(async (req, res) => {
  const r = await room(req);
  const b = z.object({ members: z.array(MemberInZ).min(1).max(500) }).parse(req.body);
  const added = await addMembers(r, b.members, actor(req));
  res.status(201).json({ added: added.map((m) => memberDto(m)), room_id: r.id, room_state: r.state, member_count: await prisma.member.count({ where: { roomId: r.id, removedAt: null } }) });
}));
v1.get('/rooms/:room_id/members', requireTenant('rooms:read'), wrap(async (req, res) => {
  const r = await room(req);
  const role = typeof req.query.role === 'string' ? req.query.role : undefined;
  const rows = await prisma.member.findMany({ where: { roomId: r.id, ...(role ? { role: role as any } : {}) }, orderBy: { createdAt: 'asc' } });
  res.json({ data: rows.map((m) => memberDto(m, { withExternal: true })) });
}));
v1.patch('/rooms/:room_id/members/:member_id', requireTenant('members:write'), wrap(async (req, res) => {
  const r = await room(req);
  const m = await getMember(r, req.params.member_id);
  const b = z.object({ segment: z.object({ from: z.string(), to: z.string() }).optional(), party_size: z.number().int().min(1).max(20).optional(), notify: z.record(z.boolean()).optional(), gender: z.enum(['M', 'F', 'O', 'U']).optional() }).parse(req.body);
  const row = await prisma.member.update({ where: { id: m.id }, data: { ...(b.segment ? { segmentFrom: b.segment.from, segmentTo: b.segment.to } : {}), ...(b.party_size ? { partySize: b.party_size } : {}), ...(b.notify ? { notify: b.notify } : {}), ...(b.gender ? { gender: b.gender } : {}) } });
  res.json(memberDto(row));
}));
v1.delete('/rooms/:room_id/members/:member_id', requireTenant('members:write'), wrap(async (req, res) => {
  const r = await room(req);
  const m = await getMember(r, req.params.member_id);
  await removeMember(r, m, String(req.query.reason ?? 'cancelled'), actor(req));
  res.json({ removed: true });
}));
v1.post(/^\/members:move$/, requireTenant('members:write'), wrap(async (req, res) => {
  const b = z.object({ from_room_id: z.string(), to_room_id: z.string(), member_ids: z.array(z.string()).min(1).max(500), reason: z.enum(['reschedule', 'charting', 'vehicle_change', 'flight_change']) }).parse(req.body);
  const moved = await moveMembers(req.tenant!.tid, b.from_room_id, b.to_room_id, b.member_ids, b.reason, actor(req));
  res.json({ moved: moved.length, members: moved.map((m) => memberDto(m)) });
}));
v1.post('/rooms/:room_id/members/:member_id/token', requireTenant('members:write'), wrap(async (req, res) => {
  const r = await room(req);
  const m = await getMember(r, req.params.member_id);
  const b = z.object({ ttl_sec: z.number().int().min(60).max(86_400).optional() }).parse(req.body ?? {});
  res.json(await memberToken(r, m, b.ttl_sec));
}));

// ------------------------------------------------- bring your own chat ---
/**
 * For tenants that keep their own chat UI (e.g. the AbhiBus app's built-in journey chat) but want
 * Trip Rooms' console, moderation, support desk and Ops tooling. Mirror each traveller message here;
 * "@care"/"@support"/"@<App> Care" become support tickets. Replies come back on `action.updated`.
 */
v1.post('/rooms/:room_id/members/:member_id/messages', requireTenant('members:write'), wrap(async (req, res) => {
  const r = await room(req);
  const m = await getMember(r, req.params.member_id);
  if (m.removedAt) throw new ApiError('forbidden', 'This member was removed from the room.');
  const b = z.object({ text: z.string().min(1).max(2000), client_msg_id: z.string().min(6).max(64), channel: z.enum(['MAIN', 'WOMEN']).default('MAIN') }).parse(req.body);
  const { cfg } = await getTenant(r.tenantId);
  const v = checkMessage(b.text, [cfg.support.care_handle]);
  if (!v.ok) throw new ApiError('invalid_request', `Blocked by the safety filter (${v.reason}). Not stored.`);
  const care = isCareMention(v.text, cfg.support.care_handle);
  const name = display(m, cfg.identity.mode).name;
  const msg = await createMessage(r.id, b.channel === 'WOMEN' ? 'WOMEN_ONLY' : 'MAIN_COMMON', { senderId: m.id, senderName: name, contentType: 'TEXT', payload: { text: v.text, via: 'tenant_app', ...(care ? { mentions: ['CARE'] } : {}) }, clientMsgId: b.client_msg_id });
  const ticket = care ? await raiseCareTicket(r, m, name, v.text, msg.id) : null;
  res.status(201).json({ message_id: msg.id, care_ticket: ticket ? { id: ticket.id, ref: toRef(ticket.id) } : null });
}));
/** A traveller tapped a sponsored card in your app: counts the click (once per traveller) and returns the coupon. */
v1.post('/rooms/:room_id/members/:member_id/ad-click', requireTenant('members:write'), wrap(async (req, res) => {
  const r = await room(req);
  const m = await getMember(r, req.params.member_id);
  const b = z.object({ message_id: z.string().min(1) }).parse(req.body);
  res.json(await adClick(r.id, m.id, b.message_id));
}));
/** The traveller voted in a poll shown in your app. Returns live results across every app. */
v1.post('/rooms/:room_id/members/:member_id/polls/:message_id/vote', requireTenant('members:write'), wrap(async (req, res) => {
  const r = await room(req);
  const m = await getMember(r, req.params.member_id);
  const b = z.object({ options: z.array(z.number().int().min(0).max(11)).min(1).max(12) }).parse(req.body);
  res.json(await votePoll(m, req.params.message_id, b.options));
}));
/** The traveller answered a survey shown in your app (counts as a campaign response). */
v1.post('/rooms/:room_id/members/:member_id/surveys/:message_id/answers', requireTenant('members:write'), wrap(async (req, res) => {
  const r = await room(req);
  const m = await getMember(r, req.params.member_id);
  const b = z.object({ answers: z.array(z.union([z.string().max(200), z.number()])).min(1).max(6) }).parse(req.body);
  await answerSurvey(r, m, req.params.message_id, b.answers);
  res.json({ recorded: true });
}));
v1.post('/rooms/:room_id/members/:member_id/sos', requireTenant('members:write'), wrap(async (req, res) => {
  const r = await room(req);
  const m = await getMember(r, req.params.member_id);
  const b = z.object({ reason: z.string().min(1).max(60).default('SOS from the app'), coords: z.object({ lat: z.number(), lng: z.number() }).nullable().optional(), external_incident_id: z.string().max(80).optional() }).parse(req.body ?? {});
  const a = await raiseSos(r, m, b.reason, b.coords ?? null);
  res.status(201).json({ action_id: a.id, ref: toRef(a.id) });
}));

// ------------------------------------------------- trip events & alerts ---
v1.post('/rooms/:room_id/trip-events', requireTenant('rooms:write'), wrap(async (req, res) => {
  res.status(201).json(await applyTripEvent(await room(req), TripEventZ.parse(req.body), actor(req)));
}));
const AnnZ = z.object({ text: z.string().min(1).max(500), severity: z.enum(['info', 'warning', 'critical']), pin: z.boolean().optional(), channels: z.object({ push: z.boolean().optional(), sms: z.boolean().optional(), whatsapp: z.boolean().optional() }).optional(), translations: z.record(z.string().max(500)).optional(), author: z.object({ ops_agent_id: z.string() }).optional() });
v1.post('/rooms/:room_id/announcements', requireTenant('announcements:write'), wrap(async (req, res) => {
  const b = AnnZ.parse(req.body);
  const out = await postAlert(await room(req), { ...b, author: b.author?.ops_agent_id }, actor(req));
  res.status(201).json({ id: out.id, delivered: out.delivered });
}));
export const SelectorZ = z.object({ vertical: z.enum(['bus', 'train', 'flight', 'custom']), operator_id: z.string().optional(), route: z.string().optional(), train_no: z.string().optional(), flight_no: z.string().optional(), airport: z.string().optional(), date: z.string().optional(), states: z.array(z.string()).optional(), room_ids: z.array(z.string()).optional() });
export async function matchRooms(tenantIds: string[], sel: z.infer<typeof SelectorZ>) {
  const rows = await prisma.room.findMany({ where: { tenantId: { in: tenantIds }, vertical: sel.vertical, state: { in: (sel.states ?? ['scheduled', 'dormant', 'open', 'onboard']) as any } } });
  return rows.filter((r) => {
    const s = (r.scope ?? {}) as Record<string, unknown>;
    if (sel.room_ids && !sel.room_ids.includes(r.id)) return false;
    if (sel.operator_id && s.operator_id !== sel.operator_id) return false;
    if (sel.route && s.route !== sel.route && s.route_code !== sel.route && r.title !== sel.route) return false;
    if (sel.train_no && s.train_no !== sel.train_no) return false;
    if (sel.flight_no && `${s.carrier ?? ''}${s.flight_no ?? ''}` !== sel.flight_no && s.flight_no !== sel.flight_no) return false;
    if (sel.airport && !stopsOf(r).some((x) => x.code === sel.airport)) return false;
    if (sel.date && r.departsAt.toISOString().slice(0, 10) !== sel.date && new Date(+r.departsAt + 330 * 60_000).toISOString().slice(0, 10) !== sel.date) return false;
    return true;
  });
}
v1.post('/broadcasts', requireTenant('announcements:write'), wrap(async (req, res) => {
  if (!limits.broadcast.take(req.tenant!.cid)) throw new ApiError('rate_limited', 'Broadcasts: 10 per minute.');
  const b = z.object({ selector: SelectorZ, announcement: AnnZ, dry_run: z.boolean().optional() }).parse(req.body);
  const rooms = await matchRooms([req.tenant!.tid], b.selector);
  const reach = await prisma.member.count({ where: { roomId: { in: rooms.map((r) => r.id) }, removedAt: null, role: 'traveller' } });
  if (b.dry_run) return res.json({ matched_rooms: rooms.length, reach, rooms: rooms.map((r) => ({ id: r.id, title: r.title })) });
  for (const r of rooms) await postAlert(r, { ...b.announcement, author: b.announcement.author?.ops_agent_id }, actor(req));
  const id = newId('bc');
  await emitEvent(req.tenant!.tid, null, 'broadcast.sent', { broadcast_id: id, matched_rooms: rooms.length, reach, actor: actor(req) });
  res.status(201).json({ broadcast_id: id, matched_rooms: rooms.length, reach });
}));

// -------------------------------------------------------------- messages ---
v1.get('/rooms/:room_id/messages', requireTenant('rooms:read'), wrap(async (req, res) => {
  const r = await room(req);
  const q = z.object({ since: z.string().datetime({ offset: true }).optional(), cursor: z.string().optional(), channel: z.enum(['MAIN', 'WOMEN']).optional() }).parse(req.query);
  const ch = await prisma.channel.findUnique({ where: { roomId_kind: { roomId: r.id, kind: q.channel ?? 'MAIN' } } });
  if (!ch) return res.json({ data: [], next_cursor: null });
  const rows = await prisma.message.findMany({ where: { channelId: ch.id, ...(q.since ? { createdAt: { gt: new Date(q.since) } } : {}) }, orderBy: { createdAt: 'desc' }, take: 51, include: msgInclude, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}) });
  const dtos = await toDtos(rows.slice(0, 50));
  res.json({ data: dtos.map((m, i) => ({ ...m, hidden: rows[i].hidden, visible_to: rows[i].visibleTo })), next_cursor: rows.length > 50 ? rows[49].id : null });
}));
v1.post('/rooms/:room_id/messages', requireTenant('announcements:write'), wrap(async (req, res) => {
  const r = await room(req);
  const b = z.object({ as: z.enum(['bot', 'system']), bot_id: z.string().optional(), text: z.string().min(1).max(1000), channel: z.enum(['MAIN', 'WOMEN', 'ALL']).optional() }).parse(req.body);
  let name = 'System';
  if (b.as === 'bot') {
    const bot = b.bot_id ? await prisma.bot.findUnique({ where: { id: b.bot_id } }) : null;
    if (!bot || bot.tenantId !== r.tenantId) throw new ApiError('not_found', 'bot_id not found for this tenant.');
    name = bot.name;
  }
  const data = { senderName: name, contentType: b.as === 'bot' ? 'TARA' as const : 'SYSTEM' as const, payload: b.as === 'bot' ? { text: b.text, source: 'bot', bot: name } : { text: b.text } };
  const out = b.channel === 'ALL' ? await createInAllChannels(r.id, data) : [await (await import('../core/messages')).createMessage(r.id, b.channel === 'WOMEN' ? 'WOMEN_ONLY' : 'MAIN_COMMON', data)];
  res.status(201).json({ id: out[0].id });
}));
v1.delete('/rooms/:room_id/messages/:message_id', requireTenant('moderation:write'), wrap(async (req, res) => {
  const r = await room(req);
  const reason = z.enum(['abuse', 'spam', 'personal_info', 'other']).parse(req.query.reason ?? 'other');
  const m = await prisma.message.findUnique({ where: { id: req.params.message_id }, include: { channel: true } });
  if (!m || m.channel.roomId !== r.id) throw new ApiError('not_found', 'Message not found.');
  await prisma.message.delete({ where: { id: m.id } });
  hub.toChannel(r.id, KIND_TO_RT[m.channel.kind], S2C.MSG_REMOVED, { roomType: KIND_TO_RT[m.channel.kind], messageId: m.id });
  await audit({ tenantId: r.tenantId, actor: actor(req), action: 'message.removed', roomId: r.id, targetId: m.id, reason });
  res.json({ removed: true });
}));

// -------------------------------------------------------------- location ---
v1.post('/rooms/:room_id/location/sources', requireTenant('location:write'), wrap(async (req, res) => {
  const r = await room(req);
  const b = z.object({
    source: z.enum(['vts', 'running_status', 'flight_status']), device_id: z.string().optional(),
    points: z.array(z.object({ lat: z.number(), lng: z.number(), ts: z.string().datetime({ offset: true }).optional(), speed_kmph: z.number().optional() })).max(100).optional(),
    last_station: z.string().optional(), departed_at: z.string().optional(), delay_min: z.number().int().optional(), next_station: z.string().optional(),
    status: z.string().optional(), gate: z.string().optional(), terminal: z.string().optional(), est_departure: z.string().optional(), est_arrival: z.string().optional(),
  }).parse(req.body);
  let accepted = 0;
  for (const p of b.points ?? []) { await prisma.locationFix.create({ data: { roomId: r.id, source: b.source, lat: p.lat, lng: p.lng, data: { speed_kmph: p.speed_kmph ?? null }, recordedAt: p.ts ? new Date(p.ts) : new Date() } }); accepted++; }
  if (!b.points?.length) { await prisma.locationFix.create({ data: { roomId: r.id, source: b.source, data: { last_station: b.last_station, next_station: b.next_station, status: b.status } } }); accepted = 1; }
  let triggered: string | null = null;
  // Feeds carry delay / gate facts: apply them as trip events so travellers hear about it once.
  const newDelay = b.delay_min ?? (b.est_departure ? Math.max(0, Math.round((Date.parse(b.est_departure) - +r.departsAt) / 60_000)) : undefined);
  if (newDelay !== undefined && newDelay !== r.delayMin) {
    await applyTripEvent(r, { type: 'delay', minutes: newDelay - r.delayMin, auto_announce: Math.abs(newDelay - r.delayMin) >= 10 }, actor(req));
    if (r.state === 'dormant') triggered = 'activation.on_delay';
  }
  if (b.gate && b.gate !== (r.meta as any)?.gate) await applyTripEvent(await room(req), { type: 'gate_change', gate: b.gate, terminal: b.terminal, auto_announce: true }, actor(req));
  res.json({ accepted, triggered, location: await estimate(await room(req)) });
}));
v1.get('/rooms/:room_id/location', requireTenant('rooms:read'), wrap(async (req, res) => {
  const r = await room(req);
  const e = await estimate(r);
  res.json({ ...e, stale_after_sec: 180, delay_min: r.delayMin, meta: r.meta });
}));

// ------------------------------------------------- polls, surveys, games ---
v1.post('/rooms/:room_id/polls', requireTenant('announcements:write'), wrap(async (req, res) => {
  const r = await room(req);
  const b = z.object({ question: z.string().min(1).max(200), options: z.array(z.string().min(1).max(80)).min(2).max(4), closes_in_min: z.number().int().min(1).max(720).optional(), campaign_id: z.string().optional() }).parse(req.body);
  const { t } = await getTenant(r.tenantId);
  const m = await createRoomPoll(r, { ...b, by: t.name });
  res.status(201).json({ id: m.id });
}));
const SurveyQZ = z.object({ type: z.enum(['rating', 'choice', 'text']), q: z.string().min(1).max(200), options: z.array(z.string().max(60)).max(6).optional() });
v1.post('/surveys', requireTenant('campaigns:write'), wrap(async (req, res) => {
  const b = z.object({ name: z.string().min(1).max(80), questions: z.array(SurveyQZ).min(1).max(4) }).parse(req.body);
  const row = await prisma.surveyTemplate.create({ data: { id: newId('srv', 6), tenantId: req.tenant!.tid, name: b.name, questions: b.questions } });
  res.status(201).json({ id: row.id });
}));
const pendingSurveys = new Map<string, { roomId: string; surveyId: string; trigger: string }>();
v1.post('/rooms/:room_id/surveys', requireTenant('campaigns:write'), wrap(async (req, res) => {
  const r = await room(req);
  const b = z.object({ survey_id: z.string(), trigger: z.enum(['now', 'on_drop', 'on_read_only']).default('now') }).parse(req.body);
  const s = await prisma.surveyTemplate.findUnique({ where: { id: b.survey_id } });
  if (!s || (s.tenantId && s.tenantId !== r.tenantId)) throw new ApiError('not_found', 'survey_id not found.');
  if (b.trigger === 'now' || (b.trigger === 'on_read_only' && r.state === 'read_only')) {
    const { t } = await getTenant(r.tenantId);
    await sendSurvey(r, { questions: s.questions as any, by: t.name });
    return res.json({ sent: true });
  }
  pendingSurveys.set(`${r.id}:${s.id}`, { roomId: r.id, surveyId: s.id, trigger: b.trigger });
  res.json({ scheduled: true, trigger: b.trigger });
}));
export { pendingSurveys };
v1.get('/games', requireTenant('rooms:read'), (_req, res) => { res.json({ data: GAMES_CATALOG }); });
v1.post('/rooms/:room_id/games', requireTenant('announcements:write'), wrap(async (req, res) => {
  const r = await room(req);
  const b = z.object({ game: z.enum(['QUIZ', 'EMOJI', 'trivia', 'emoji']), campaign_id: z.string().optional(), channel: z.enum(['MAIN', 'WOMEN']).optional() }).parse(req.body);
  const kind = b.game === 'trivia' ? 'QUIZ' : b.game === 'emoji' ? 'EMOJI' : b.game;
  const sponsor = b.campaign_id ? (await prisma.campaign.findUnique({ where: { id: b.campaign_id } }))?.advertiser : undefined;
  const m = await startGame(r, b.channel === 'WOMEN' ? 'WOMEN_ONLY' : 'MAIN_COMMON', null, kind, undefined, sponsor);
  res.status(201).json({ game_session: m.id });
}));
v1.post('/rooms/:room_id/vouchers', requireTenant('announcements:write'), wrap(async (req, res) => {
  const r = await room(req);
  const b = z.object({ amount: z.number().int().min(1).max(10_000), note: z.string().max(80).optional() }).parse(req.body);
  const m = await issueVoucher(r, b.amount, actor(req), b.note);
  res.status(201).json({ id: m.id });
}));

// ------------------------------------------------------------- campaigns ---
v1.post('/campaigns', requireTenant('campaigns:write'), wrap(async (req, res) => {
  res.status(201).json(await campaignCreate(req.body, [req.tenant!.tid], actor(req)));
}));
v1.get('/campaigns/:campaign_id/stats', requireTenant('campaigns:write'), wrap(async (req, res) => {
  res.json(await campaignStats(req.params.campaign_id, [req.tenant!.tid]));
}));

// ------------------------------------------------------ safety & actions ---
v1.get('/actions', requireTenant('moderation:write'), wrap(async (req, res) => {
  const q = z.object({ type: z.enum(['sos', 'issue', 'wait_request', 'lost_found', 'report']).optional(), status: z.enum(['open', 'acknowledged', 'resolved']).optional() }).parse(req.query);
  const rows = await prisma.action.findMany({ where: { tenantId: req.tenant!.tid, ...(q.type ? { type: q.type } : {}), ...(q.status ? { status: q.status } : {}) }, orderBy: { createdAt: 'desc' }, take: 100 });
  res.json({ data: rows.map(actionDto) });
}));
v1.patch('/actions/:action_id', requireTenant('moderation:write'), wrap(async (req, res) => {
  const b = z.object({ status: z.enum(['open', 'acknowledged', 'resolved']).optional(), private_reply: z.string().max(500).optional(), assignee: z.string().max(80).optional() }).parse(req.body);
  res.json(actionDto(await updateAction([req.tenant!.tid], req.params.action_id, b, actor(req))));
}));
v1.post('/rooms/:room_id/moderation', requireTenant('moderation:write'), wrap(async (req, res) => {
  const b = z.object({ action: z.enum(['mute_member', 'unmute_member', 'remove_member', 'ops_only', 'slow_mode']), member_id: z.string().optional(), enabled: z.boolean().optional(), duration_min: z.number().int().min(1).max(720).optional(), reason: z.string().max(200).optional() }).parse(req.body);
  res.json(await moderateRoom(await room(req), b, actor(req)));
}));
v1.post('/members/:member_id/reveal', requireTenant('moderation:write'), wrap(async (req, res) => {
  const b = z.object({ reason: z.enum(['sos', 'harassment', 'lost_found', 'legal']), ops_agent_id: z.string().min(1) }).parse(req.body);
  const m = await prisma.member.findUnique({ where: { id: req.params.member_id } });
  const r = m ? await prisma.room.findUnique({ where: { id: m.roomId } }) : null;
  if (!m || !r || r.tenantId !== req.tenant!.tid) throw new ApiError('not_found', 'Member not found.');
  res.json(await revealMember(r, m, b.reason, `${actor(req)}/${b.ops_agent_id}`));
}));

// ---------------------------------------------- bots, config, webhooks ---
v1.post('/bots', requireTenant('config:write'), wrap(async (req, res) => {
  const b = z.object({ name: z.string().min(1).max(40), label: z.string().min(1).max(12), webhook_url: z.string().url().optional(), triggers: z.array(z.enum(['mention', 'question', 'location_question', 'catch_up'])).min(1) }).parse(req.body);
  const row = await prisma.bot.create({ data: { id: newId('bot', 6), tenantId: req.tenant!.tid, name: b.name, label: b.label, webhookUrl: b.webhook_url ?? null, triggers: b.triggers } });
  res.status(201).json({ id: row.id });
}));
v1.get('/tenants/:tenant/config', requireTenant('rooms:read'), wrap(async (req, res) => {
  if (req.params.tenant !== req.tenant!.tid) throw new ApiError('forbidden', 'You can only read your own tenant.');
  const { t, cfg } = await getTenant(req.tenant!.tid);
  res.json({ tenant: t.id, version: t.version, config: cfg, theme: t.theme });
}));
v1.patch('/tenants/:tenant/config', requireTenant('config:write'), wrap(async (req, res) => {
  if (req.params.tenant !== req.tenant!.tid) throw new ApiError('forbidden', 'You can only change your own tenant.');
  const { t, cfg } = await getTenant(req.tenant!.tid);
  const next = mergeConfig(cfg, req.body);
  const row = await prisma.tenant.update({ where: { id: t.id }, data: { config: next, version: { increment: 1 } } });
  invalidateTenant(t.id);
  await audit({ tenantId: t.id, actor: actor(req), action: 'tenant.config_updated', data: req.body });
  await emitEvent(t.id, null, 'tenant.config_updated', { version: row.version, actor: actor(req) });
  res.json({ tenant: t.id, version: row.version });
}));
v1.post('/webhooks', requireTenant('webhooks:write'), wrap(async (req, res) => {
  const b = z.object({ url: z.string().url(), events: z.array(z.string().min(1)).min(1) }).parse(req.body);
  const secret = `whsec_${randomSecret(24)}`;
  const row = await prisma.webhook.create({ data: { id: newId('wh', 6), tenantId: req.tenant!.tid, url: b.url, events: b.events, secret } });
  res.status(201).json({ id: row.id, secret, url: row.url, events: row.events });
}));
v1.get('/webhooks', requireTenant('webhooks:write'), wrap(async (req, res) => {
  const rows = await prisma.webhook.findMany({ where: { tenantId: req.tenant!.tid } });
  res.json({ data: rows.map((w) => ({ id: w.id, url: w.url, events: w.events, active: w.active, created_at: w.createdAt })) });
}));
v1.delete('/webhooks/:id', requireTenant('webhooks:write'), wrap(async (req, res) => {
  const w = await prisma.webhook.findUnique({ where: { id: req.params.id } });
  if (!w || w.tenantId !== req.tenant!.tid) throw new ApiError('not_found', 'Webhook not found.');
  await prisma.webhook.delete({ where: { id: w.id } });
  res.json({ deleted: true });
}));

export const ALL_SCOPES = SCOPES;
export const moderationCheck = checkMessage;
