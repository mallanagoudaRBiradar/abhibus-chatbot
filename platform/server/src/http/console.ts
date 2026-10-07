import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { ApiError, wrap } from '../lib/errors';
import { assertTenantAccess, requireUser, userBearer, userTenants } from '../auth/middleware';
import { isUserTokenRevoked, revokeUserToken, signTenantToken, signUserToken } from '../auth/tokens';
import { hashSecret, randomSecret, verifySecret, signWebhook } from '../lib/crypto';
import { newId } from '../lib/ids';
import { limits } from '../lib/rateLimit';
import { ROLES, ROLE_LABELS, ROLE_PERMISSIONS, SCOPES, can, type Role } from '../shared/roles';
import { FEATURE_LABELS, mergeConfig, defaultConfig } from '../shared/tenantConfig';
import { TEMPLATES, UNIT } from '../shared/verticals';
import { getTenant, invalidateTenant, isQuiet } from '../core/tenants';
import { roomDto, stopsOf, fmtTime, etaOf, nextIdx, timetablePos, upsertRoom, timings } from '../core/rooms';
import { estimate } from '../core/location';
import { postAlert } from '../core/alerts';
import { TripEventZ, applyTripEvent, EVENT_TYPES } from '../core/tripEvents';
import { msgInclude, toDtos, createInAllChannels, KIND_TO_RT } from '../core/messages';
import { actionDto, updateAction } from '../core/actions';
import { moderateRoom, revealMember, setMute } from '../core/moderation';
import { issueVoucher } from '../core/traveller';
import { addMembers, memberToken, restoreMember } from '../core/members';
import { display } from '../core/identity';
import { audit } from '../core/audit';
import { emitEvent, onEvent } from '../core/events';
import { hub } from '../core/hub';
import { deliver, adCheck, FORMAT_LABEL } from '../core/ads';
import { campaignCreate, campaignDto, campaignStats } from './campaigns';
import { SelectorZ, matchRooms } from './v1';
import { API_SPEC, WEBHOOK_EVENTS } from '../shared/apiSpec';
import { DISPLAY_NAME_RE, S2C } from '../shared/protocol';
import { CARE_ALIASES } from '../shared/moderation';
import { pollSummary, siblingsOf, surveySummary } from '../core/responses';
import { markRead, notificationsFor } from '../core/notifications';
import { purge } from '../core/lifecycle';
import { broadcastRoomUpdate } from '../core/alerts';
import { roomFeatures } from '../core/tenants';
import { parseRef, toRef } from '../shared/refs';
import { config } from '../config';
import { strs } from '../lib/json';

/**
 * ============================================================================
 *  Dashboard API  /console/v1   (signed-in staff; role + tenant scoped)
 * ============================================================================
 */
export const consoleApi = Router();
const me = (req: Request) => req.user!;
const actor = (req: Request) => me(req).email;
const allTenantIds = async () => (await prisma.tenant.findMany({ select: { id: true } })).map((t) => t.id);
const myTenants = async (req: Request) => userTenants(me(req), await allTenantIds());
const isDeleted = (r: { meta: unknown }) => !!(r.meta as any)?.deleted;
async function roomFor(req: Request) {
  const r = await prisma.room.findUnique({ where: { id: req.params.room_id } });
  if (!r || isDeleted(r)) throw new ApiError('not_found', 'Room not found (it may have been deleted).');
  assertTenantAccess(me(req), r.tenantId);
  return r;
}

// ------------------------------------------------------------------ auth ---
consoleApi.post('/auth/login', wrap(async (req, res) => {
  const b = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
  if (!limits.login.take(`${req.ip}:${b.email.toLowerCase()}`)) throw new ApiError('rate_limited', 'Too many attempts. Try again in a minute.');
  const u = await prisma.user.findUnique({ where: { email: b.email.toLowerCase() } });
  if (!u || !u.active || !verifySecret(b.password, u.passwordHash)) throw new ApiError('unauthorized', 'Email or password is incorrect.');
  await prisma.user.update({ where: { id: u.id }, data: { lastLoginAt: new Date() } });
  await audit({ actor: u.email, action: 'user.login' });
  const token = signUserToken({ uid: u.id, email: u.email, role: u.role as Role, tenants: strs(u.tenantIds) });
  res.json({ token, user: userDto(u) });
}));
/** Sign out: the token stops working everywhere (other tabs, the live stream), not just in this browser. */
consoleApi.post('/auth/logout', requireUser(), wrap(async (req, res) => {
  revokeUserToken(userBearer(req));
  await audit({ actor: actor(req), action: 'user.logout' });
  res.json({ signed_out: true });
}));
const userDto = (u: { id: string; email: string; name: string; role: string; tenantIds: unknown; active: boolean; lastLoginAt: Date | null; createdAt: Date }) => ({
  id: u.id, email: u.email, name: u.name, role: u.role, role_label: ROLE_LABELS[u.role as Role], tenants: strs(u.tenantIds), active: u.active,
  permissions: ROLE_PERMISSIONS[u.role as Role], last_login_at: u.lastLoginAt?.toISOString() ?? null, created_at: u.createdAt.toISOString(),
});
consoleApi.get('/me', requireUser(), wrap(async (req, res) => {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: me(req).uid } });
  res.json({ user: userDto(u), roles: ROLES.map((r) => ({ id: r, label: ROLE_LABELS[r], permissions: ROLE_PERMISSIONS[r] })) });
}));
consoleApi.post('/me/password', requireUser(), wrap(async (req, res) => {
  const b = z.object({ current: z.string(), next: z.string().min(10, 'Use at least 10 characters.') }).parse(req.body);
  const u = await prisma.user.findUniqueOrThrow({ where: { id: me(req).uid } });
  if (!verifySecret(b.current, u.passwordHash)) throw new ApiError('unauthorized', 'Current password is incorrect.');
  await prisma.user.update({ where: { id: u.id }, data: { passwordHash: hashSecret(b.next) } });
  await audit({ actor: u.email, action: 'user.password_changed' });
  res.json({ ok: true });
}));

// -------------------------------------------------------------- overview ---
consoleApi.get('/tenants', requireUser('rooms.read'), wrap(async (req, res) => {
  const ids = await myTenants(req);
  const rows = await prisma.tenant.findMany({ where: { id: { in: ids } }, orderBy: { name: 'asc' } });
  res.json({ data: await Promise.all(rows.map(async (t) => ({ id: t.id, name: t.name, verticals: t.verticals, theme: t.theme, version: t.version, quiet_now: isQuiet((await getTenant(t.id)).cfg) }))) });
}));
consoleApi.get('/overview', requireUser('rooms.read'), wrap(async (req, res) => {
  const ids = await myTenants(req);
  const since = new Date(Date.now() - 24 * 3600_000);
  const [rooms, members, actions, sos, alerts, live, events] = await Promise.all([
    prisma.room.groupBy({ by: ['tenantId', 'state'], where: { tenantId: { in: ids } }, _count: true }),
    prisma.member.count({ where: { room: { tenantId: { in: ids }, state: { in: ['open', 'onboard'] } }, removedAt: null, role: 'traveller' } }),
    prisma.action.groupBy({ by: ['severity'], where: { tenantId: { in: ids }, status: { not: 'resolved' }, type: { not: 'care' } }, _count: true }),
    prisma.action.count({ where: { tenantId: { in: ids }, type: 'sos', status: { not: 'resolved' } } }),
    prisma.message.count({ where: { contentType: 'ALERT', createdAt: { gte: since }, channel: { kind: 'MAIN', room: { tenantId: { in: ids } } } } }),
    prisma.campaign.count({ where: { status: 'live' } }),
    prisma.eventLog.count({ where: { tenantId: { in: ids }, createdAt: { gte: new Date(Date.now() - 3600_000) } } }),
  ]);
  const byTenant = ids.map((id) => ({ tenant: id, live: rooms.filter((r) => r.tenantId === id && ['open', 'onboard'].includes(r.state)).reduce((a, r) => a + r._count, 0), total: rooms.filter((r) => r.tenantId === id).reduce((a, r) => a + r._count, 0) }));
  res.json({
    live_rooms: byTenant.reduce((a, t) => a + t.live, 0), travellers_live: members, open_actions: actions.reduce((a, x) => a + x._count, 0),
    open_by_severity: Object.fromEntries(actions.map((a) => [a.severity, a._count])),
    care_waiting: await prisma.action.count({ where: { tenantId: { in: ids }, type: 'care', status: { not: 'resolved' }, assignee: null } }), sos_open: sos, alerts_24h: alerts, campaigns_live: live, events_last_hour: events, by_tenant: byTenant,
  });
}));

// ------------------------------------------------------------------- ops ---
async function statusChips(r: Awaited<ReturnType<typeof roomFor>>) {
  const chips: { label: string; tone: 'crit' | 'warn' | 'ok' | 'info' | 'mute' }[] = [];
  const open = (await prisma.action.findMany({ where: { roomId: r.id, status: { not: 'resolved' } }, select: { type: true, status: true, data: true } })).filter((a) => a.type !== 'care' || (a.data as any)?.escalated_to_ops);
  if (open.some((a) => a.type === 'sos')) chips.push({ label: 'SOS', tone: 'crit' });
  if (r.breakdown) chips.push({ label: 'Breakdown', tone: 'crit' });
  if (open.some((a) => a.type !== 'sos' && a.status === 'open')) chips.push({ label: 'Open issue', tone: 'warn' });
  if (r.delayMin) chips.push({ label: `Delayed ${r.delayMin} min`, tone: 'warn' });
  const loc = await estimate(r);
  if (loc.confidence === 'estimated' && r.vertical !== 'flight') chips.push({ label: 'No live location', tone: 'info' });
  if (r.opsOnly) chips.push({ label: 'Ops only', tone: 'mute' });
  if (r.slowMode) chips.push({ label: 'Slow mode', tone: 'mute' });
  if (isQuiet((await getTenant(r.tenantId)).cfg)) chips.push({ label: 'Quiet hours', tone: 'mute' });
  if (!chips.length) chips.push({ label: 'On time', tone: 'ok' });
  return { chips, location: loc };
}
/**
 * Plain facets of a trip, the words people search by: operator (VRL, FreshBus, IRCTC train name,
 * airline), from / to city, and departure time in IST. Cheap: no DB calls.
 */
type RoomRow = Awaited<ReturnType<typeof prisma.room.findMany>>[number];
const DEPART_BUCKETS: Record<string, [number, number]> = { early: [0, 5], morning: [5, 12], afternoon: [12, 17], evening: [17, 21], night: [21, 24] };
function facetsOf(r: RoomRow) {
  const s = (r.scope ?? {}) as Record<string, any>;
  const [from, to] = r.title.split(/\s*[→>-]\s*/).map((x) => x.trim());
  const operator = String(s.operator_name ?? s.train_name ?? s.airline ?? s.carrier_name ?? s.carrier ?? r.subtitle.split('·')[0] ?? '').trim() || 'Unknown';
  const istHour = new Date(+r.departsAt + 330 * 60_000).getUTCHours();
  return { operator, from: from || r.title, to: to || '', istHour, bucket: Object.entries(DEPART_BUCKETS).find(([, [a, b]]) => istHour >= a && istHour < b)?.[0] ?? 'night', vehicle: String(s.vehicle_no ?? s.train_no ?? (s.flight_no ? `${s.carrier ?? ''}${s.flight_no}` : '')) };
}
const RoomQ = z.object({
  tenant: z.string().optional(), vertical: z.string().optional(), filter: z.string().optional(), state: z.string().optional(),
  operator: z.string().optional(), from: z.string().optional(), to: z.string().optional(), departs: z.string().optional(), q: z.string().max(80).optional(),
  sort: z.enum(['attention', 'departs', 'travellers']).default('attention'),
});
async function roomsMatching(req: Request, q: z.infer<typeof RoomQ>, opts: { skip?: 'operator' | 'from' | 'to' | 'departs' } = {}) {
  const ids = (await myTenants(req)).filter((t) => !q.tenant || q.tenant === t);
  const rows = await prisma.room.findMany({ where: { tenantId: { in: ids }, ...(q.vertical ? { vertical: q.vertical as any } : {}), state: q.state ? { in: q.state.split(',') as any } : { notIn: ['closed'] } }, orderBy: { departsAt: 'asc' }, take: 2000 });
  const now = Date.now();
  const needle = (q.q ?? '').trim().toLowerCase();
  const ref = needle ? parseRef(needle) : null;
  return rows.filter((r) => !isDeleted(r)).map((r) => ({ r, f: facetsOf(r) })).filter(({ r, f }) => {
    if (q.operator && opts.skip !== 'operator' && !q.operator.split('|').includes(f.operator)) return false;
    if (q.from && opts.skip !== 'from' && !q.from.split('|').includes(f.from)) return false;
    if (q.to && opts.skip !== 'to' && !q.to.split('|').includes(f.to)) return false;
    if (q.departs && opts.skip !== 'departs') {
      if (q.departs === 'next2h') { if (+r.departsAt < now - 15 * 60_000 || +r.departsAt > now + 2 * 3600_000) return false; }
      else if (q.departs === 'departed') { if (+r.departsAt > now) return false; }
      else if (f.bucket !== q.departs) return false;
    }
    if (needle) {
      if (ref?.kind === 'room') return r.id.startsWith(ref.idPrefix);
      if (!`${r.title} ${r.subtitle} ${r.tripKey} ${f.operator} ${f.vehicle}`.toLowerCase().includes(needle)) return false;
    }
    return true;
  });
}
/** Filter options from the trips that exist, with counts, so every dropdown only offers real choices. */
consoleApi.get('/rooms/facets', requireUser('rooms.read'), wrap(async (req, res) => {
  const q = RoomQ.parse(req.query);
  const count = (list: { f: ReturnType<typeof facetsOf> }[], k: 'operator' | 'from' | 'to' | 'bucket') =>
    Object.entries(list.reduce<Record<string, number>>((a, { f }) => { if (f[k]) a[f[k]] = (a[f[k]] ?? 0) + 1; return a; }, {})).map(([value, n]) => ({ value, n })).sort((a, b) => b.n - a.n || a.value.localeCompare(b.value));
  // Each facet counts against the other active filters (so you can see what's left to pick).
  const [ops, froms, tos, deps, all] = await Promise.all([roomsMatching(req, q, { skip: 'operator' }), roomsMatching(req, q, { skip: 'from' }), roomsMatching(req, q, { skip: 'to' }), roomsMatching(req, q, { skip: 'departs' }), roomsMatching(req, { ...q, operator: undefined, from: undefined, to: undefined, departs: undefined, q: undefined })]);
  const now = Date.now();
  res.json({ operators: count(ops, 'operator'), from: count(froms, 'from'), to: count(tos, 'to'), departs: count(deps, 'bucket'), next2h: deps.filter(({ r }) => +r.departsAt >= now - 15 * 60_000 && +r.departsAt <= now + 2 * 3600_000).length, total: all.length });
}));
consoleApi.get('/rooms', requireUser('rooms.read'), wrap(async (req, res) => {
  const q = RoomQ.parse(req.query);
  const matched = await roomsMatching(req, q);
  const rows = matched.slice(0, 400).map((x) => x.r);
  let out = await Promise.all(rows.map(async (r) => {
    const { chips, location } = await statusChips(r);
    const last = await prisma.message.findFirst({ where: { contentType: 'ALERT', channel: { roomId: r.id, kind: 'MAIN' } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    return { ...(await roomDto(r)), tenant_id: r.tenantId, chips, location, last_alert_at: last?.createdAt.toISOString() ?? null, facets: facetsOf(r) };
  }));
  if (q.filter === 'action') out = out.filter((r) => r.chips.some((c) => c.tone === 'crit' || c.label === 'Open issue'));
  if (q.filter === 'delayed') out = out.filter((r) => r.delay_min > 0);
  if (q.filter === 'nogps') out = out.filter((r) => r.chips.some((c) => c.label === 'No live location'));
  const sev = (x: typeof out[number]) => x.chips.filter((c) => c.tone === 'crit').length * 10 + x.chips.filter((c) => c.tone === 'warn').length;
  if (q.sort === 'attention') out.sort((a, b) => sev(b) - sev(a));
  if (q.sort === 'travellers') out.sort((a, b) => b.member_count - a.member_count);
  // 'departs' keeps the DB order (earliest departure first)
  res.json({ data: out, total: matched.length });
}));
consoleApi.get('/rooms/:room_id', requireUser('rooms.read'), wrap(async (req, res) => {
  const r = await roomFor(req);
  const { cfg, t } = await getTenant(r.tenantId);
  const members = await prisma.member.findMany({ where: { roomId: r.id }, orderBy: { createdAt: 'asc' } });
  const { chips, location } = await statusChips(r);
  const pos = timetablePos(r);
  res.json({
    room: { ...(await roomDto(r)), tenant_id: r.tenantId, tenant_name: t.name, unit: UNIT[r.vertical].unit },
    chips, location, identity_mode: cfg.identity.mode,
    stops: stopsOf(r).map((s, i) => ({ ...s, eta: etaOf(r, i)?.toISOString() ?? null, eta_label: fmtTime(etaOf(r, i)), passed: i < Math.floor(pos) })),
    next_stop_idx: nextIdx(r, pos),
    members: members.map((m) => ({ id: m.id, handle: m.handle, shown_as: display(m, cfg.identity.mode).name, role: m.role, muted: m.muted, removed: !!m.removedAt, removed_reason: m.removedReason, sharing_location: m.sharingLocation, segment: { from: m.segmentFrom, to: m.segmentTo }, party_size: m.partySize, gender_known: m.gender !== 'U' })),
    actions: (await prisma.action.findMany({ where: { roomId: r.id }, orderBy: { createdAt: 'desc' }, take: 30 })).map(actionDto),
    templates: TEMPLATES.filter((x) => x.vertical.includes(r.vertical as any)).map((x) => ({ id: x.id, label: x.label, severity: x.severity })),
    event_types: (EVENT_TYPES as any)[r.vertical],
    updates: (await prisma.tripEvent.findMany({ where: { roomId: r.id }, orderBy: { createdAt: 'desc' }, take: 40 })).map((e) => ({ id: e.id, ref: toRef(e.id), type: e.type, data: e.data, actor: e.actor, created_at: e.createdAt.toISOString() })),
  });
}));
consoleApi.get('/rooms/:room_id/messages', requireUser('rooms.read'), wrap(async (req, res) => {
  const r = await roomFor(req);
  const kind = req.query.channel === 'WOMEN' ? 'WOMEN' : 'MAIN';
  const ch = await prisma.channel.findUnique({ where: { roomId_kind: { roomId: r.id, kind } } });
  if (!ch) return res.json({ data: [] });
  const rows = await prisma.message.findMany({ where: { channelId: ch.id }, orderBy: { createdAt: 'desc' }, take: 80, include: msgInclude });
  const dtos = await toDtos(rows);
  const reports = await prisma.report.groupBy({ by: ['targetKey'], where: { roomId: r.id }, _count: true });
  res.json({ data: dtos.map((m, i) => ({ ...m, sender_member_id: rows[i].senderId, hidden: rows[i].hidden, visible_to: rows[i].visibleTo, reports: reports.find((x) => x.targetKey === m.id)?._count ?? 0 })) });
}));
/** Responses to one poll or survey in this room: who answered, what, and the summary. */
consoleApi.get('/rooms/:room_id/messages/:message_id/responses', requireUser('rooms.read'), wrap(async (req, res) => {
  const r = await roomFor(req);
  const m = await prisma.message.findUnique({ where: { id: req.params.message_id }, include: { channel: { select: { roomId: true } } } });
  if (!m || m.channel.roomId !== r.id || !['POLL', 'SURVEY'].includes(m.contentType)) throw new ApiError('not_found', 'Poll or survey not found in this room.');
  const p = m.payload as any;
  const ids = await siblingsOf(m);
  const camp = p.campaignId ? await prisma.campaign.findUnique({ where: { id: p.campaignId }, select: { id: true, name: true, advertiser: true, createdBy: true, createdAt: true } }) : null;
  const made = { by: p.by ?? m.senderName, at: m.createdAt.toISOString(), campaign: camp ? { id: camp.id, ref: toRef(camp.id), name: camp.name, advertiser: camp.advertiser, created_by: camp.createdBy } : null };
  res.json({ made, ...(m.contentType === 'POLL' ? await pollSummary(ids, p.options ?? []) : await surveySummary(ids, p.questions ?? [])), question: p.question ?? null });
}));
consoleApi.post('/rooms/:room_id/alerts', requireUser('rooms.act'), wrap(async (req, res) => {
  const r = await roomFor(req);
  const b = z.object({ text: z.string().min(1).max(500), severity: z.enum(['info', 'warning', 'critical']), push: z.boolean().default(true), sms: z.boolean().default(false), translations: z.record(z.string()).optional() }).parse(req.body);
  const out = await postAlert(r, { text: b.text, severity: b.severity, channels: { push: b.push, sms: b.sms }, translations: b.translations, author: actor(req) }, actor(req));
  await audit({ tenantId: r.tenantId, actor: actor(req), action: 'alert.posted', roomId: r.id, data: { severity: b.severity } });
  res.status(201).json(out.delivered);
}));
consoleApi.post('/rooms/:room_id/trip-events', requireUser('rooms.act'), wrap(async (req, res) => {
  const r = await roomFor(req);
  const dryRun = req.query.dry_run === 'true';
  const out = await applyTripEvent(r, TripEventZ.parse(req.body), actor(req), { dryRun });
  if (dryRun) return res.json(out);
  await audit({ tenantId: r.tenantId, actor: actor(req), action: `trip_event.${req.body.type}`, roomId: r.id, targetId: (out as { event_id: string }).event_id, data: req.body });
  res.status(201).json(out);
}));
consoleApi.get('/rooms/:room_id/template/:id', requireUser('rooms.read'), wrap(async (req, res) => {
  const r = await roomFor(req);
  const tpl = TEMPLATES.find((x) => x.id === req.params.id && x.vertical.includes(r.vertical as any));
  if (!tpl) throw new ApiError('not_found', 'Template not found.');
  const pos = timetablePos(r), ni = r.vertical === 'flight' ? 0 : nextIdx(r, pos), stops = stopsOf(r), meta = (r.meta ?? {}) as Record<string, string>;
  const loc = await estimate(r);
  const ctx = { unit: UNIT[r.vertical].unit, delay: r.delayMin, minutes: 20, nextStop: stops[ni]?.name, newTime: fmtTime(etaOf(r, ni)), place: loc.near, platform: meta.platform ?? '3', coach: meta.coach ?? String((r.scope as any).coach ?? ''), gate: meta.gate ?? '—', terminal: meta.terminal, belt: meta.belt ?? '4', stop: stops.find((s) => s.type === 'rest_stop')?.name ?? stops[ni]?.name, flightNo: `${(r.scope as any).carrier ?? ''}${(r.scope as any).flight_no ?? ''}`, boarding: stops[0]?.name };
  res.json({ text: tpl.en(ctx), hi: tpl.hi?.(ctx) ?? null, severity: tpl.severity });
}));
consoleApi.post('/rooms/:room_id/vouchers', requireUser('rooms.act'), wrap(async (req, res) => {
  const r = await roomFor(req);
  const b = z.object({ amount: z.number().int().min(1).max(10_000) }).parse(req.body);
  await issueVoucher(r, b.amount, actor(req));
  await audit({ tenantId: r.tenantId, actor: actor(req), action: 'voucher.issued', roomId: r.id, data: b });
  res.status(201).json({ ok: true });
}));
consoleApi.post('/rooms/:room_id/crew', requireUser('rooms.act'), wrap(async (req, res) => {
  const r = await roomFor(req);
  const b = z.object({ text: z.string().min(1).max(300), role: z.string().max(20).default(r.vertical === 'flight' ? 'Cabin crew' : r.vertical === 'train' ? 'TTE' : 'Conductor') }).parse(req.body);
  await createInAllChannels(r.id, { senderName: b.role, contentType: 'CREW', payload: { text: b.text, role: b.role } });
  res.status(201).json({ ok: true });
}));
consoleApi.post('/rooms/:room_id/moderation', requireUser('moderation.act'), wrap(async (req, res) => {
  const r = await roomFor(req);
  const b = z.object({ action: z.enum(['mute_member', 'unmute_member', 'remove_member', 'ops_only', 'slow_mode']), member_id: z.string().optional(), enabled: z.boolean().optional(), duration_min: z.number().int().optional(), reason: z.string().max(200).optional() }).parse(req.body);
  res.json(await moderateRoom(r, b, actor(req)));
}));
consoleApi.post('/rooms/:room_id/members/:member_id/reveal', requireUser('members.reveal'), wrap(async (req, res) => {
  const r = await roomFor(req);
  const b = z.object({ reason: z.enum(['sos', 'harassment', 'lost_found', 'legal']) }).parse(req.body);
  const m = await prisma.member.findUnique({ where: { id: req.params.member_id } });
  if (!m || m.roomId !== r.id) throw new ApiError('not_found', 'Member not found.');
  res.json(await revealMember(r, m, b.reason, actor(req)));
}));
consoleApi.post('/rooms/:room_id/members/:member_id/restore', requireUser('moderation.act'), wrap(async (req, res) => {
  const r = await roomFor(req);
  const m = await prisma.member.findUnique({ where: { id: req.params.member_id } });
  if (!m || m.roomId !== r.id) throw new ApiError('not_found', 'Member not found.');
  await restoreMember(r, m, actor(req));
  await audit({ tenantId: r.tenantId, actor: actor(req), action: 'member.restored', roomId: r.id, targetId: m.id });
  res.json({ restored: true });
}));
consoleApi.post('/rooms/:room_id/members/:member_id/mute', requireUser('moderation.act'), wrap(async (req, res) => {
  const r = await roomFor(req);
  const m = await prisma.member.findUnique({ where: { id: req.params.member_id } });
  if (!m || m.roomId !== r.id) throw new ApiError('not_found', 'Member not found.');
  await setMute(r, m, z.object({ muted: z.boolean() }).parse(req.body).muted, actor(req));
  res.json({ ok: true });
}));
consoleApi.post('/rooms/:room_id/messages/:message_id/:op', requireUser('moderation.act'), wrap(async (req, res) => {
  const r = await roomFor(req);
  const m = await prisma.message.findUnique({ where: { id: req.params.message_id }, include: { channel: true } });
  if (!m || m.channel.roomId !== r.id) throw new ApiError('not_found', 'Message not found.');
  const rt = KIND_TO_RT[m.channel.kind];
  if (req.params.op === 'restore') {
    await prisma.message.update({ where: { id: m.id }, data: { hidden: false } });
    const [dto] = await toDtos([await prisma.message.findUniqueOrThrow({ where: { id: m.id }, include: msgInclude })]);
    hub.toChannel(r.id, rt, S2C.MSG_NEW, dto);
  } else if (req.params.op === 'remove') {
    await prisma.message.delete({ where: { id: m.id } });
    hub.toChannel(r.id, rt, S2C.MSG_REMOVED, { roomType: rt, messageId: m.id });
  } else throw new ApiError('invalid_request', 'op must be restore or remove.');
  await audit({ tenantId: r.tenantId, actor: actor(req), action: `message.${req.params.op}`, roomId: r.id, targetId: m.id });
  res.json({ ok: true });
}));
/** Live traveller view: the dashboard embeds the real chat screen as a demo member of this room. */
consoleApi.post('/rooms/:room_id/preview-member', requireUser('rooms.read'), wrap(async (req, res) => {
  const r = await roomFor(req);
  const b = z.object({ gender: z.enum(['M', 'F', 'U']).default('U') }).parse(req.body ?? {});
  const u = await prisma.user.findUniqueOrThrow({ where: { id: me(req).uid } });
  const first = u.name.split(/\s+/)[0].replace(/[^\p{L}]/gu, '').slice(0, 12);
  const name = DISPLAY_NAME_RE.test(first) ? first : 'Ops';
  const [m] = await addMembers(r, [{ external_user_id: `dashboard:${me(req).uid}:${b.gender}`, booking_ref: `PREVIEW-${me(req).uid.slice(0, 6)}`, gender: b.gender, display_name: name }], actor(req));
  // Console staff skip the traveller profile step: they're here to watch the room, not to introduce themselves.
  const ready = m.profileSet ? m : await prisma.member.update({ where: { id: m.id }, data: { displayName: name, profileSet: true } });
  res.json(await memberToken(r, ready, 4 * 3600));
}));

// ---------------------------------------------------------- notifications ---
/** The bell: what this person needs to know (by role), newest first, with read state. */
consoleApi.get('/notifications', requireUser(), wrap(async (req, res) => {
  res.json(await notificationsFor(me(req), await myTenants(req), Math.min(100, Number(req.query.limit ?? 60))));
}));
consoleApi.post('/notifications/read', requireUser(), wrap(async (req, res) => {
  const b = z.object({ ids: z.array(z.string()).max(200).optional(), all: z.boolean().optional() }).parse(req.body ?? {});
  await markRead(me(req).uid, b.all ? 'all' : b.ids ?? []);
  res.json({ ok: true });
}));

// --------------------------------------------------- room manager (admin) ---
/**
 * Admin control over trip rooms: create one, create many (route × buses × days), edit and save,
 * end the chat, close, reopen or delete — one at a time or for a selection. Every change is audited
 * and emits the same events partner apps already handle, so connected apps follow along.
 */
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'op';
const StopIn = z.object({ name: z.string().min(1).max(80), code: z.string().max(12).optional(), at_min: z.number().int().min(0).max(4320), type: z.string().max(20).optional() });
const RoomIn = z.object({
  tenant: z.string(), vertical: z.enum(['bus', 'train', 'flight']).default('bus'),
  from: z.string().min(1).max(60), to: z.string().min(1).max(60),
  operator_name: z.string().min(1).max(60), vehicle_no: z.string().max(20).optional(), service_id: z.string().max(40).optional(), coach: z.string().max(60).optional(), route: z.string().max(20).optional(),
  duration_min: z.number().int().min(15).max(4320), stops: z.array(StopIn).max(20).optional(),
  activation: z.enum(['always', 'on_delay']).default('always'), features: z.record(z.boolean()).optional(),
});
type RoomInT = z.infer<typeof RoomIn>;
/** One room definition + a departure time → the platform's room upsert body and trip key. */
function buildRoom(b: RoomInT, departs: Date, keyHint?: string) {
  const arrives = new Date(+departs + b.duration_min * 60_000);
  const mid = (b.stops ?? []).filter((s) => s.at_min > 0 && s.at_min < b.duration_min).sort((x, y) => x.at_min - y.at_min);
  const code = (s: string) => s.replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase() || 'STOP';
  const stops = [
    { code: code(b.from), name: b.from, sched_dep: departs.toISOString(), type: 'boarding' },
    ...mid.map((s, i) => ({ code: (s.code || code(s.name)) + (i + 1), name: s.name, sched_arr: new Date(+departs + s.at_min * 60_000).toISOString(), sched_dep: new Date(+departs + (s.at_min + (s.type === 'rest_stop' ? 15 : 2)) * 60_000).toISOString(), type: s.type ?? 'halt' })),
    { code: code(b.to), name: b.to, sched_arr: arrives.toISOString(), type: 'dropping' },
  ];
  const date = new Date(+departs + 330 * 60_000).toISOString().slice(0, 10);
  const hhmm = new Date(+departs + 330 * 60_000).toISOString().slice(11, 16).replace(':', '');
  const route = b.route || `${code(b.from).slice(0, 3)}-${code(b.to).slice(0, 3)}`;
  const tripKey = keyHint ?? `${b.vertical}:${slug(b.operator_name)}:${b.service_id || b.vehicle_no?.replace(/\s+/g, '') || `${route}-${hhmm}`}:${date}`;
  return {
    tripKey,
    body: {
      vertical: b.vertical, title: `${b.from} → ${b.to}`, subtitle: [b.operator_name, b.coach].filter(Boolean).join(' · '),
      scope: { operator_id: `op_${slug(b.operator_name)}`, operator_name: b.operator_name, route, ...(b.vehicle_no ? { vehicle_no: b.vehicle_no } : {}), ...(b.service_id ? { service_id: b.service_id } : {}), source: 'console' },
      schedule: { departs_at: departs.toISOString(), arrives_at: arrives.toISOString() }, route: { stops },
      activation: { mode: b.activation, min_delay_min: 45 }, ...(b.features ? { features: b.features } : {}),
    } as any,
  };
}
const istDate = (d: string, hhmm: string) => new Date(`${d}T${hhmm}:00+05:30`);

consoleApi.post('/rooms', requireUser('rooms.manage'), wrap(async (req, res) => {
  const b = RoomIn.extend({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), time: z.string().regex(/^\d{2}:\d{2}$/), trip_key: z.string().max(120).optional() }).parse(req.body);
  assertTenantAccess(me(req), b.tenant);
  const { tripKey, body } = buildRoom(b, istDate(b.date, b.time), b.trip_key);
  const existing = await prisma.room.findUnique({ where: { tenantId_tripKey: { tenantId: b.tenant, tripKey } } });
  if (existing && !isDeleted(existing)) throw new ApiError('trip_key_conflict', `A room already exists for this trip (${toRef(existing.id)}). Open it to edit instead.`);
  const { room } = await upsertRoom(b.tenant, tripKey, body, actor(req));
  await audit({ tenantId: b.tenant, actor: actor(req), action: 'room.created', roomId: room.id, data: { trip_key: tripKey } });
  res.status(201).json({ id: room.id, ref: toRef(room.id), trip_key: tripKey });
}));

/** Many rooms at once: one route, a list of buses (operator + departure time), a date range and weekdays. Preview first (dry_run). */
consoleApi.post('/rooms/bulk', requireUser('rooms.manage'), wrap(async (req, res) => {
  const b = z.object({
    template: RoomIn.omit({ operator_name: true, vehicle_no: true, service_id: true, coach: true }),
    buses: z.array(z.object({ operator_name: z.string().min(1).max(60), time: z.string().regex(/^\d{2}:\d{2}$/), vehicle_no: z.string().max(20).optional(), coach: z.string().max(60).optional(), service_id: z.string().max(40).optional() })).min(1).max(100),
    dates: z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), weekdays: z.array(z.number().int().min(0).max(6)).min(1).default([0, 1, 2, 3, 4, 5, 6]) }),
    dry_run: z.boolean().default(true),
  }).parse(req.body);
  assertTenantAccess(me(req), b.template.tenant);
  const days: string[] = [];
  for (let d = new Date(`${b.dates.from}T00:00:00Z`); +d <= +new Date(`${b.dates.to}T00:00:00Z`) && days.length < 62; d = new Date(+d + 86_400_000))
    if (b.dates.weekdays.includes(d.getUTCDay())) days.push(d.toISOString().slice(0, 10));
  const plan = days.flatMap((day) => b.buses.map((bus) => ({ day, bus, ...buildRoom({ ...b.template, ...bus }, istDate(day, bus.time)) })));
  if (plan.length > 500) throw new ApiError('invalid_request', `That's ${plan.length} rooms; the limit is 500 per run. Narrow the dates or buses.`);
  const existing = new Set((await prisma.room.findMany({ where: { tenantId: b.template.tenant, tripKey: { in: plan.map((p) => p.tripKey) } }, select: { tripKey: true, meta: true } })).filter((r) => !isDeleted(r)).map((r) => r.tripKey));
  const preview = plan.map((p) => ({ trip_key: p.tripKey, title: p.body.title, operator: p.bus.operator_name, vehicle_no: p.bus.vehicle_no ?? null, departs_at: p.body.schedule.departs_at, arrives_at: p.body.schedule.arrives_at, exists: existing.has(p.tripKey) }));
  if (b.dry_run) return res.json({ total: plan.length, new: preview.filter((x) => !x.exists).length, existing: existing.size, preview: preview.slice(0, 200) });
  const created: { id: string; ref: string }[] = [];
  for (const p of plan) if (!existing.has(p.tripKey)) { const { room } = await upsertRoom(b.template.tenant, p.tripKey, p.body, actor(req)); created.push({ id: room.id, ref: toRef(room.id) }); }
  await audit({ tenantId: b.template.tenant, actor: actor(req), action: 'room.bulk_created', data: { count: created.length, route: `${b.template.from} → ${b.template.to}`, days: days.length, buses: b.buses.length } });
  res.status(201).json({ created: created.length, skipped: plan.length - created.length, rooms: created.slice(0, 200) });
}));

/** Everything an admin can edit on a room, plus the effective feature switches. */
consoleApi.get('/rooms/:room_id/admin', requireUser('rooms.manage'), wrap(async (req, res) => {
  const r = await roomFor(req);
  const s = (r.scope ?? {}) as Record<string, any>;
  res.json({
    id: r.id, ref: toRef(r.id), trip_key: r.tripKey, tenant_id: r.tenantId, vertical: r.vertical, state: r.state, title: r.title, subtitle: r.subtitle,
    operator_name: s.operator_name ?? '', vehicle_no: s.vehicle_no ?? '', route: s.route ?? '',
    departs_at: r.departsAt.toISOString(), arrives_at: r.arrivesAt.toISOString(), stops: stopsOf(r), activation: (r.activation as any)?.mode ?? 'always',
    features: await roomFeatures(r), overrides: r.features ?? {}, feature_labels: FEATURE_LABELS,
    opens_at: r.opensAt.toISOString(), read_only_at: r.readOnlyAt.toISOString(), purge_at: r.purgeAt.toISOString(),
  });
}));
consoleApi.patch('/rooms/:room_id', requireUser('rooms.manage'), wrap(async (req, res) => {
  const r = await roomFor(req);
  const b = z.object({ title: z.string().min(1).max(120).optional(), subtitle: z.string().max(160).optional(), operator_name: z.string().max(60).optional(), vehicle_no: z.string().max(20).optional(),
    departs_at: z.string().datetime({ offset: true }).optional(), arrives_at: z.string().datetime({ offset: true }).optional(), features: z.record(z.boolean()).optional(), activation: z.enum(['always', 'on_delay']).optional() }).parse(req.body);
  const { cfg } = await getTenant(r.tenantId);
  const data: any = {}; const changed: string[] = [];
  if (b.title && b.title !== r.title) { data.title = b.title; changed.push('title'); }
  if (b.subtitle !== undefined && b.subtitle !== r.subtitle) { data.subtitle = b.subtitle; changed.push('subtitle'); }
  if (b.operator_name !== undefined || b.vehicle_no !== undefined) { data.scope = { ...(r.scope as object), ...(b.operator_name !== undefined ? { operator_name: b.operator_name } : {}), ...(b.vehicle_no !== undefined ? { vehicle_no: b.vehicle_no } : {}) }; changed.push('operator/vehicle'); }
  if (b.features) { data.features = { ...((r.features ?? {}) as object), ...b.features }; changed.push('features'); }
  if (b.activation) { data.activation = { ...((r.activation ?? {}) as object), mode: b.activation }; changed.push('activation'); }
  if (b.departs_at || b.arrives_at) {
    const dep = new Date(b.departs_at ?? r.departsAt), arr = new Date(b.arrives_at ?? r.arrivesAt);
    if (+arr <= +dep) throw new ApiError('invalid_request', 'Arrival must be after departure.');
    const shift = +dep - +r.departsAt;
    data.departsAt = dep; data.arrivesAt = arr;
    data.stops = stopsOf(r).map((s) => ({ ...s, ...(s.sched_dep ? { sched_dep: new Date(+new Date(s.sched_dep) + shift).toISOString() } : {}), ...(s.sched_arr ? { sched_arr: new Date(+new Date(s.sched_arr) + shift).toISOString() } : {}) }));
    Object.assign(data, (({ opensAt, readOnlyAt, purgeAt }) => ({ opensAt, readOnlyAt, purgeAt }))(timings(dep, arr, r.delayMin, cfg.timing)));
    changed.push('schedule');
  }
  if (!changed.length) return res.json({ id: r.id, changed });
  await prisma.room.update({ where: { id: r.id }, data });
  await audit({ tenantId: r.tenantId, actor: actor(req), action: 'room.updated', roomId: r.id, data: { changed } });
  await emitEvent(r.tenantId, r.id, 'room.updated', { room_id: r.id, updated: changed, actor: actor(req) });
  await broadcastRoomUpdate(r.id);
  res.json({ id: r.id, changed });
}));

/** End chat (read-only: travellers can read, not post), close (nobody can open it), reopen, or delete (content wiped, room gone). */
async function roomLifecycle(r: Awaited<ReturnType<typeof roomFor>>, action: 'end_chat' | 'close' | 'reopen' | 'delete', who: string, message?: string) {
  if (action === 'delete') {
    await purge(r);
    await prisma.room.update({ where: { id: r.id }, data: { state: 'closed', meta: { ...((r.meta ?? {}) as object), purged: true, deleted: true, deleted_by: who, deleted_at: new Date().toISOString() } } });
    hub.toTrip(r.id, S2C.JOURNEY_CLOSED, {});
    await audit({ tenantId: r.tenantId, actor: who, action: 'room.deleted', roomId: r.id, data: { trip_key: r.tripKey, title: r.title } });
    await emitEvent(r.tenantId, r.id, 'room.deleted', { room_id: r.id, ref: toRef(r.id), trip_key: r.tripKey, title: r.title, actor: who });
    return 'deleted';
  }
  if (message?.trim()) await postAlert(r, { text: message.trim(), severity: action === 'reopen' ? 'info' : 'warning' }, who);
  const { cfg } = await getTenant(r.tenantId);
  const to = action === 'end_chat' ? 'read_only' : action === 'close' ? 'closed' : Date.now() >= +r.departsAt ? 'onboard' : 'open';
  const extra = action === 'reopen' ? (({ readOnlyAt, purgeAt }) => ({ readOnlyAt, purgeAt }))(timings(r.departsAt, new Date(Math.max(+r.arrivesAt, Date.now() + 3600_000)), r.delayMin, cfg.timing)) : { readOnlyAt: new Date() };
  await prisma.room.update({ where: { id: r.id }, data: { state: to as any, ...extra } });
  if (to === 'closed') hub.toTrip(r.id, S2C.JOURNEY_CLOSED, {});
  await broadcastRoomUpdate(r.id).catch(() => {});
  await audit({ tenantId: r.tenantId, actor: who, action: `room.${action}`, roomId: r.id });
  await emitEvent(r.tenantId, r.id, 'room.state_changed', { room_id: r.id, from: r.state, to, reason: action, actor: who });
  return to;
}
consoleApi.post('/rooms/:room_id/lifecycle', requireUser('rooms.manage'), wrap(async (req, res) => {
  const b = z.object({ action: z.enum(['end_chat', 'close', 'reopen', 'delete']), message: z.string().max(500).optional() }).parse(req.body);
  res.json({ state: await roomLifecycle(await roomFor(req), b.action, actor(req), b.message) });
}));
consoleApi.post('/rooms/bulk-action', requireUser('rooms.manage'), wrap(async (req, res) => {
  const b = z.object({ ids: z.array(z.string()).min(1).max(500), action: z.enum(['end_chat', 'close', 'reopen', 'delete']), message: z.string().max(500).optional() }).parse(req.body);
  const ids = await myTenants(req);
  const rooms = (await prisma.room.findMany({ where: { id: { in: b.ids }, tenantId: { in: ids } } })).filter((r) => !isDeleted(r));
  for (const r of rooms) await roomLifecycle(r, b.action, actor(req), b.message);
  res.json({ done: rooms.length });
}));

// ---------------------------------------------------------------- search ---
/**
 * One box for everything: reference codes (TR-/IS-/UP-/CM-), trip keys, routes, bus/train/flight
 * numbers, titles. Booking refs only for roles allowed to reveal identities, and every such lookup is audited.
 */
consoleApi.get('/search', requireUser('rooms.read'), wrap(async (req, res) => {
  const q = String(req.query.q ?? '').trim().slice(0, 80);
  if (q.length < 2) return res.json({ rooms: [], issues: [], updates: [], campaigns: [] });
  const ids = await myTenants(req);
  const ref = parseRef(q);
  const like = { contains: q }; // MySQL utf8mb4 collations are case-insensitive already
  const roomSel = { id: true, title: true, subtitle: true, tenantId: true, vertical: true, state: true, tripKey: true, departsAt: true } as const;
  const roomOut = (r: { id: string; title: string; subtitle: string; tenantId: string; vertical: string; state: string; tripKey: string; departsAt: Date }, why?: string) =>
    ({ id: r.id, ref: toRef(r.id), title: r.title, subtitle: r.subtitle, tenant_id: r.tenantId, vertical: r.vertical, state: r.state, trip_key: r.tripKey, departs_at: r.departsAt.toISOString(), why });

  const [rooms, issues, updates, campaigns, byBooking] = await Promise.all([
    prisma.room.findMany({ where: { tenantId: { in: ids }, OR: ref?.kind === 'room' ? [{ id: { startsWith: ref.idPrefix } }] : [{ title: like }, { subtitle: like }, { tripKey: like }] }, select: roomSel, orderBy: { departsAt: 'desc' }, take: 8 }),
    prisma.action.findMany({ where: { tenantId: { in: ids }, OR: ref?.kind === 'act' ? [{ id: { startsWith: ref.idPrefix } }] : [{ title: like }, { detail: like }] }, orderBy: { createdAt: 'desc' }, take: 6 }),
    ref?.kind === 'evt' ? prisma.tripEvent.findMany({ where: { id: { startsWith: ref.idPrefix } }, take: 5 }) : Promise.resolve([]),
    can(me(req).role, 'campaigns.read') ? prisma.campaign.findMany({ where: ref?.kind === 'cmp' ? { id: { startsWith: ref.idPrefix } } : { OR: [{ name: like }, { advertiser: like }] }, take: 5 }) : Promise.resolve([]),
    !ref && can(me(req).role, 'members.reveal') && /^[A-Z0-9-]{5,}$/i.test(q) ? prisma.member.findMany({ where: { bookingRef: { equals: q }, room: { tenantId: { in: ids } } }, select: { roomId: true, handle: true }, take: 5 }) : Promise.resolve([]),
  ]);
  if (byBooking.length) await audit({ actor: actor(req), action: 'search.booking_ref', reason: 'console search', data: { rooms: byBooking.map((m) => m.roomId) } });
  const extraRooms = await prisma.room.findMany({ where: { tenantId: { in: ids }, id: { in: [...new Set([...byBooking.map((m) => m.roomId), ...updates.map((u) => u.roomId), ...issues.map((a) => a.roomId)])] } }, select: roomSel });
  const roomById = new Map(extraRooms.map((r) => [r.id, r]));
  res.json({
    rooms: [...rooms.map((r) => roomOut(r)), ...byBooking.filter((m) => !rooms.some((r) => r.id === m.roomId)).flatMap((m) => roomById.get(m.roomId) ? [roomOut(roomById.get(m.roomId)!, `booking ${q.toUpperCase()} · ${m.handle}`)] : [])],
    issues: issues.map((a) => ({ ...actionDto(a), room: roomById.get(a.roomId) ? roomOut(roomById.get(a.roomId)!) : null })),
    // trip_event has no tenant column: keep only updates whose room this user can see.
    updates: updates.filter((u) => ids.includes(roomById.get(u.roomId)?.tenantId ?? '')).map((u) => ({ id: u.id, ref: toRef(u.id), type: u.type, created_at: u.createdAt.toISOString(), room: roomById.get(u.roomId) ? roomOut(roomById.get(u.roomId)!) : null })),
    campaigns: campaigns.map((c) => ({ id: c.id, ref: toRef(c.id), name: c.name, advertiser: c.advertiser, status: c.status })),
  });
}));

// ----------------------------------------------------------------- inbox ---
consoleApi.get('/inbox', requireUser('rooms.read'), wrap(async (req, res) => {
  const q = z.object({ tenant: z.string().optional(), status: z.string().optional(), type: z.string().optional() }).parse(req.query);
  const ids = (await myTenants(req)).filter((t) => !q.tenant || q.tenant === t);
  const all = await prisma.action.findMany({ where: { tenantId: { in: ids }, ...(q.status ? { status: { in: q.status.split(',') as any } } : {}), ...(q.type ? { type: q.type as any } : {}) }, orderBy: { createdAt: 'desc' }, take: 200 });
  // Support tickets live in Customer support; Ops sees one only after support hands it over.
  const rows = all.filter((a) => a.type !== 'care' || (a.data as any)?.escalated_to_ops);
  const rooms = await prisma.room.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.roomId))] } }, select: { id: true, title: true, subtitle: true, tenantId: true, vertical: true } });
  const sev = { critical: 0, warning: 1, info: 2 } as const;
  rows.sort((a, b) => Number(a.status === 'resolved') - Number(b.status === 'resolved') || sev[a.severity] - sev[b.severity] || +a.createdAt - +b.createdAt);
  res.json({ data: rows.map((a) => { const r = rooms.find((x) => x.id === a.roomId); return { ...actionDto(a), tenant_id: a.tenantId, room: r ? { ...r, ref: toRef(r.id) } : null }; }) });
}));
consoleApi.patch('/inbox/:action_id', requireUser('inbox.act'), wrap(async (req, res) => {
  const b = z.object({ status: z.enum(['open', 'acknowledged', 'resolved']).optional(), private_reply: z.string().max(500).optional(), assignee: z.string().optional() }).parse(req.body);
  res.json(actionDto(await updateAction(await myTenants(req), req.params.action_id, b, actor(req))));
}));

// ------------------------------------------------------ customer support ---
/** Travellers reach the desk with any of these in a trip chat (plus the app's own care handle). */
const careHandles = async (ids: string[]) => Object.fromEntries(await Promise.all(ids.map(async (id) => [id, (await getTenant(id)).cfg.support.care_handle] as const)));
const ticketOut = (a: Awaited<ReturnType<typeof prisma.action.findFirstOrThrow>>, room: { id: string; title: string; subtitle: string; vertical: string } | undefined, member: { handle: string; displayName: string | null } | undefined) => {
  const d = (a.data ?? {}) as Record<string, any>;
  return { ...actionDto(a), tenant_id: a.tenantId, who: d.who ?? member?.displayName ?? member?.handle ?? 'Traveller', thread: d.thread ?? [], escalated: !!d.escalated_to_ops, room: room ? { ...room, ref: toRef(room.id) } : null };
};
consoleApi.get('/support/tickets', requireUser('support.handle'), wrap(async (req, res) => {
  const q = z.object({ view: z.enum(['waiting', 'mine', 'open', 'resolved']).default('waiting'), tenant: z.string().optional() }).parse(req.query);
  const ids = (await myTenants(req)).filter((t) => !q.tenant || q.tenant === t);
  const where = {
    tenantId: { in: ids }, type: 'care' as const,
    ...(q.view === 'resolved' ? { status: 'resolved' as const } : { status: { not: 'resolved' as const } }),
    ...(q.view === 'waiting' ? { assignee: null } : q.view === 'mine' ? { assignee: actor(req) } : {}),
  };
  const [rows, counts] = await Promise.all([
    prisma.action.findMany({ where, orderBy: { updatedAt: 'desc' }, take: 200 }),
    prisma.action.groupBy({ by: ['assignee'], where: { tenantId: { in: ids }, type: 'care', status: { not: 'resolved' } }, _count: true }),
  ]);
  const sev = { critical: 0, warning: 1, info: 2 } as const;
  rows.sort((a, b) => sev[a.severity] - sev[b.severity] || +a.createdAt - +b.createdAt); // urgent first, then whoever has waited longest
  const [rooms, members] = await Promise.all([
    prisma.room.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.roomId))] } }, select: { id: true, title: true, subtitle: true, vertical: true } }),
    prisma.member.findMany({ where: { id: { in: rows.flatMap((r) => (r.memberId ? [r.memberId] : [])) } }, select: { id: true, handle: true, displayName: true } }),
  ]);
  res.json({
    data: rows.map((a) => ticketOut(a, rooms.find((r) => r.id === a.roomId), members.find((m) => m.id === a.memberId))),
    counts: { waiting: counts.find((c) => c.assignee === null)?._count ?? 0, mine: counts.find((c) => c.assignee === actor(req))?._count ?? 0, open: counts.reduce((n, c) => n + c._count, 0) },
    handles: await careHandles(ids), aliases: CARE_ALIASES.map((a) => `@${a}`),
  });
}));
consoleApi.get('/support/tickets/:id', requireUser('support.handle'), wrap(async (req, res) => {
  const a = await prisma.action.findUnique({ where: { id: req.params.id } });
  if (!a || a.type !== 'care') throw new ApiError('not_found', 'Ticket not found.');
  assertTenantAccess(me(req), a.tenantId);
  const room = await prisma.room.findUniqueOrThrow({ where: { id: a.roomId } });
  const { cfg, t } = await getTenant(room.tenantId);
  const m = a.memberId ? await prisma.member.findUnique({ where: { id: a.memberId } }) : null;
  // What was happening in the room around the first mention, so the agent has context without opening the room.
  const ch = await prisma.channel.findUnique({ where: { roomId_kind: { roomId: room.id, kind: 'MAIN' } } });
  const around = ch ? await prisma.message.findMany({ where: { channelId: ch.id, createdAt: { lte: new Date(+a.createdAt + 10 * 60_000) }, OR: [{ visibleTo: null }, { visibleTo: a.memberId ?? undefined }] }, orderBy: { createdAt: 'desc' }, take: 14, include: msgInclude }) : [];
  const context = (await toDtos(around.reverse())).map((x, i) => ({ ...x, mine: around[i].senderId === a.memberId }));
  res.json({
    ticket: ticketOut(a, room, m ?? undefined),
    traveller: m ? { member_id: m.id, shown_as: display(m, cfg.identity.mode).name, handle: m.handle, segment: { from: m.segmentFrom, to: m.segmentTo }, party_size: m.partySize, removed: !!m.removedAt, locale: m.locale } : null,
    room: { ...(await roomDto(room)), tenant_id: room.tenantId, tenant_name: t.name },
    care_handle: cfg.support.care_handle, support_phone: cfg.support.phone, context,
  });
}));
consoleApi.patch('/support/tickets/:id', requireUser('support.handle'), wrap(async (req, res) => {
  const b = z.object({ claim: z.boolean().optional(), release: z.boolean().optional(), status: z.enum(['open', 'acknowledged', 'resolved']).optional(), private_reply: z.string().min(1).max(500).optional(), escalate: z.boolean().optional() }).parse(req.body);
  const a = await prisma.action.findUnique({ where: { id: req.params.id } });
  if (!a || a.type !== 'care') throw new ApiError('not_found', 'Ticket not found.');
  const row = await updateAction(await myTenants(req), a.id, {
    status: b.status ?? (b.claim && a.status === 'open' ? 'acknowledged' : undefined), private_reply: b.private_reply, escalate: b.escalate,
    assignee: b.claim ? actor(req) : b.release ? null : undefined,
  }, actor(req));
  res.json(ticketOut(row, undefined, undefined));
}));

// ------------------------------------------------------------- broadcast ---
consoleApi.post('/broadcasts', requireUser('broadcast.send'), wrap(async (req, res) => {
  const b = z.object({ tenant: z.string(), selector: SelectorZ, text: z.string().max(500).optional(), severity: z.enum(['info', 'warning', 'critical']).default('warning'), push: z.boolean().default(true), sms: z.boolean().default(false), dry_run: z.boolean().default(false) }).parse(req.body);
  assertTenantAccess(me(req), b.tenant);
  const rooms = await matchRooms([b.tenant], b.selector);
  const reach = await prisma.member.count({ where: { roomId: { in: rooms.map((r) => r.id) }, removedAt: null, role: 'traveller' } });
  if (b.dry_run || !b.text?.trim()) return res.json({ matched_rooms: rooms.length, reach, rooms: rooms.map((r) => ({ id: r.id, title: r.title, subtitle: r.subtitle })) });
  for (const r of rooms) await postAlert(r, { text: b.text, severity: b.severity, channels: { push: b.push, sms: b.sms }, author: actor(req) }, actor(req));
  await audit({ tenantId: b.tenant, actor: actor(req), action: 'broadcast.sent', data: { rooms: rooms.length, reach, selector: b.selector } });
  await emitEvent(b.tenant, null, 'broadcast.sent', { matched_rooms: rooms.length, reach, actor: actor(req) });
  res.status(201).json({ matched_rooms: rooms.length, reach });
}));
consoleApi.get('/broadcast-options', requireUser('rooms.read'), wrap(async (req, res) => {
  const tenant = String(req.query.tenant ?? '');
  assertTenantAccess(me(req), tenant);
  const rooms = await prisma.room.findMany({ where: { tenantId: tenant, state: { notIn: ['closed', 'read_only'] } }, select: { vertical: true, scope: true, title: true } });
  const pick = (k: string) => [...new Set(rooms.map((r) => (r.scope as any)?.[k]).filter(Boolean))];
  res.json({ verticals: [...new Set(rooms.map((r) => r.vertical))], operator_id: pick('operator_id'), route: pick('route'), train_no: pick('train_no'), flight_no: [...new Set(rooms.filter((r) => r.vertical === 'flight').map((r) => `${(r.scope as any).carrier ?? ''}${(r.scope as any).flight_no ?? ''}`))] });
}));

// ----------------------------------------------------------------- audit ---
consoleApi.get('/audit', requireUser('audit.read'), wrap(async (req, res) => {
  const ids = await myTenants(req);
  const rows = await prisma.auditLog.findMany({ where: { OR: [{ tenantId: { in: ids } }, ...(me(req).tenants.length ? [] : [{ tenantId: null }])] }, orderBy: { createdAt: 'desc' }, take: 300 });
  const rooms = await prisma.room.findMany({ where: { id: { in: rows.map((r) => r.roomId).filter(Boolean) as string[] } }, select: { id: true, title: true } });
  res.json({ data: rows.map((a) => ({ ...a, created_at: a.createdAt.toISOString(), room_title: rooms.find((r) => r.id === a.roomId)?.title ?? null })) });
}));

// ------------------------------------------------------------- campaigns ---
/**
 * Routes Marketing can target, from the trips that actually exist: one row per route key (the value
 * campaign targeting matches), with how many rooms and travellers it reaches right now.
 */
consoleApi.get('/campaigns/routes', requireUser('campaigns.read'), wrap(async (req, res) => {
  const ids = await myTenants(req);
  const rooms = await prisma.room.findMany({ where: { tenantId: { in: ids }, state: { in: ['scheduled', 'dormant', 'open', 'onboard', 'read_only'] } }, select: { id: true, tenantId: true, vertical: true, state: true, title: true, scope: true } });
  const counts = await prisma.member.groupBy({ by: ['roomId'], where: { roomId: { in: rooms.map((r) => r.id) }, removedAt: null, role: 'traveller' }, _count: true });
  const by = new Map<string, { key: string; label: string; vertical: string; tenants: Set<string>; rooms: { id: string; ref: string; tenant: string; state: string; travellers: number }[] }>();
  for (const r of rooms) {
    const s = (r.scope ?? {}) as Record<string, any>;
    const key = String(s.route ?? s.route_code ?? (s.flight_no ? `${s.carrier ?? ''}${s.flight_no}` : s.train_no) ?? r.title);
    const label = r.vertical === 'train' && s.train_no ? `${s.train_no} ${s.train_name ?? r.title}` : r.vertical === 'flight' ? `${key} · ${r.title}` : `${r.title}${s.route ? ` (${s.route})` : ''}`;
    const row = by.get(key) ?? { key, label, vertical: r.vertical, tenants: new Set<string>(), rooms: [] };
    row.tenants.add(r.tenantId);
    row.rooms.push({ id: r.id, ref: toRef(r.id), tenant: r.tenantId, state: r.state, travellers: counts.find((c) => c.roomId === r.id)?._count ?? 0 });
    by.set(key, row);
  }
  res.json({ data: [...by.values()].map((x) => ({ ...x, tenants: [...x.tenants] })).sort((a, b) => b.rooms.length - a.rooms.length) });
}));
consoleApi.get('/campaigns', requireUser('campaigns.read'), wrap(async (_req, res) => {
  const rows = await prisma.campaign.findMany({ orderBy: { createdAt: 'desc' } });
  res.json({ data: rows.map(campaignDto) });
}));
consoleApi.post('/campaigns', requireUser('campaigns.write'), wrap(async (req, res) => {
  const out = await campaignCreate(req.body, me(req).tenants.length ? me(req).tenants : null, actor(req));
  let delivered = 0;
  if (out.status === 'live') {
    const c = await prisma.campaign.findUniqueOrThrow({ where: { id: out.id } });
    for (const r of await prisma.room.findMany({ where: { state: { in: ['open', 'onboard', 'read_only'] } } })) if ((await deliver(r, c)).ok) delivered++;
  }
  res.status(201).json({ ...out, delivered_now: delivered });
}));
consoleApi.get('/campaigns/:id', requireUser('campaigns.read'), wrap(async (req, res) => {
  const stats = await campaignStats(req.params.id, null);
  const log = await prisma.campaignDelivery.findMany({ where: { campaignId: req.params.id }, orderBy: { createdAt: 'desc' }, take: 60 });
  const rooms = await prisma.room.findMany({ where: { id: { in: [...new Set(log.map((l) => l.roomId))] } }, select: { id: true, title: true, vertical: true, tenantId: true } });
  res.json({ ...stats, log: log.map((l) => ({ ok: l.ok, reason: l.reason, at: l.createdAt.toISOString(), room: rooms.find((r) => r.id === l.roomId) ?? { id: l.roomId } })) });
}));
consoleApi.patch('/campaigns/:id', requireUser('campaigns.write'), wrap(async (req, res) => {
  const b = z.object({ status: z.enum(['draft', 'live', 'paused', 'ended']) }).parse(req.body);
  const row = await prisma.campaign.update({ where: { id: req.params.id }, data: { status: b.status } });
  await audit({ actor: actor(req), action: `campaign.${b.status}`, targetId: row.id });
  res.json(campaignDto(row));
}));
consoleApi.post('/campaigns/:id/deliver', requireUser('campaigns.write'), wrap(async (req, res) => {
  const c = await prisma.campaign.findUnique({ where: { id: req.params.id } });
  if (!c) throw new ApiError('not_found', 'Campaign not found.');
  const rooms = await prisma.room.findMany({ where: { state: { in: ['open', 'onboard', 'read_only'] } } });
  const results = [];
  for (const r of rooms) results.push({ room: r.title, room_id: r.id, ...(await deliver(r, c, { force: true })) });
  res.json({ delivered: results.filter((x) => x.ok).length, results });
}));
consoleApi.get('/campaigns/:id/check/:room_id', requireUser('campaigns.read'), wrap(async (req, res) => {
  const c = await prisma.campaign.findUniqueOrThrow({ where: { id: req.params.id } });
  res.json(await adCheck(await roomFor(req), c));
}));
consoleApi.get('/ad-rules', requireUser('campaigns.read'), wrap(async (req, res) => {
  const rows = await prisma.tenant.findMany({ where: { id: { in: await myTenants(req) } } });
  res.json({ data: await Promise.all(rows.map(async (t) => { const { cfg } = await getTenant(t.id); return { tenant: t.id, name: t.name, ads: cfg.ads, quiet: cfg.quiet, ads_on: cfg.features.ads, quiet_now: isQuiet(cfg) }; })), formats: FORMAT_LABEL });
}));

// ---------------------------------------------------- developer: config ---
consoleApi.get('/config/:tenant', requireUser('config.read'), wrap(async (req, res) => {
  assertTenantAccess(me(req), req.params.tenant);
  const { t, cfg } = await getTenant(req.params.tenant);
  res.json({ tenant: t.id, name: t.name, verticals: t.verticals, theme: t.theme, version: t.version, config: cfg, feature_labels: FEATURE_LABELS });
}));
consoleApi.patch('/config/:tenant', requireUser('config.write'), wrap(async (req, res) => {
  assertTenantAccess(me(req), req.params.tenant);
  const b = z.object({ config: z.record(z.any()).optional(), theme: z.object({ brand: z.string().max(9), brandInk: z.string().max(9), font: z.string().max(40).optional(), logoText: z.string().max(30).optional() }).optional() }).parse(req.body);
  const { t, cfg } = await getTenant(req.params.tenant);
  const row = await prisma.tenant.update({ where: { id: t.id }, data: { ...(b.config ? { config: mergeConfig(cfg, b.config) } : {}), ...(b.theme ? { theme: b.theme } : {}), version: { increment: 1 } } });
  invalidateTenant(t.id);
  await audit({ tenantId: t.id, actor: actor(req), action: 'tenant.config_updated', data: b });
  await emitEvent(t.id, null, 'tenant.config_updated', { version: row.version, actor: actor(req) });
  res.json({ version: row.version });
}));

// ------------------------------------------------------ developer: keys ---
const keyDto = (k: { id: string; tenantId: string; name: string; clientId: string; secretHint: string; scopes: unknown; createdAt: Date; lastUsedAt: Date | null; revokedAt: Date | null; createdBy: string | null }) => ({
  id: k.id, tenant: k.tenantId, name: k.name, client_id: k.clientId, secret_hint: `••••${k.secretHint}`, scopes: strs(k.scopes), created_by: k.createdBy,
  created_at: k.createdAt.toISOString(), last_used_at: k.lastUsedAt?.toISOString() ?? null, revoked_at: k.revokedAt?.toISOString() ?? null,
});
consoleApi.get('/keys', requireUser('keys.manage'), wrap(async (req, res) => {
  const rows = await prisma.apiClient.findMany({ where: { tenantId: { in: await myTenants(req) } }, orderBy: { createdAt: 'desc' } });
  res.json({ data: rows.map(keyDto), scopes: SCOPES });
}));
consoleApi.post('/keys', requireUser('keys.manage'), wrap(async (req, res) => {
  const b = z.object({ tenant: z.string(), name: z.string().min(1).max(60), scopes: z.array(z.enum(SCOPES)).min(1) }).parse(req.body);
  assertTenantAccess(me(req), b.tenant);
  const secret = `trs_${randomSecret(24)}`;
  const row = await prisma.apiClient.create({ data: { tenantId: b.tenant, name: b.name, clientId: `tnt_${b.tenant}_${randomSecret(4).toLowerCase()}`, secretHash: hashSecret(secret), secretHint: secret.slice(-4), scopes: b.scopes, createdBy: actor(req) } });
  await audit({ tenantId: b.tenant, actor: actor(req), action: 'api_key.created', targetId: row.clientId });
  res.status(201).json({ ...keyDto(row), client_secret: secret, note: 'Copy the secret now. It is shown only once.' });
}));
consoleApi.post('/keys/:id/rotate', requireUser('keys.manage'), wrap(async (req, res) => {
  const k = await prisma.apiClient.findUnique({ where: { id: req.params.id } });
  if (!k) throw new ApiError('not_found', 'Key not found.');
  assertTenantAccess(me(req), k.tenantId);
  const secret = `trs_${randomSecret(24)}`;
  const row = await prisma.apiClient.update({ where: { id: k.id }, data: { secretHash: hashSecret(secret), secretHint: secret.slice(-4) } });
  await audit({ tenantId: k.tenantId, actor: actor(req), action: 'api_key.rotated', targetId: k.clientId });
  res.json({ ...keyDto(row), client_secret: secret, note: 'Copy the new secret now. The old one stops working immediately.' });
}));
consoleApi.delete('/keys/:id', requireUser('keys.manage'), wrap(async (req, res) => {
  const k = await prisma.apiClient.findUnique({ where: { id: req.params.id } });
  if (!k) throw new ApiError('not_found', 'Key not found.');
  assertTenantAccess(me(req), k.tenantId);
  await prisma.apiClient.update({ where: { id: k.id }, data: { revokedAt: new Date() } });
  await audit({ tenantId: k.tenantId, actor: actor(req), action: 'api_key.revoked', targetId: k.clientId });
  res.json({ revoked: true });
}));

// -------------------------------------------------- developer: webhooks ---
consoleApi.get('/webhooks', requireUser('webhooks.manage'), wrap(async (req, res) => {
  const rows = await prisma.webhook.findMany({ where: { tenantId: { in: await myTenants(req) } } });
  res.json({ data: rows.map((w) => ({ id: w.id, tenant: w.tenantId, url: w.url, events: w.events, active: w.active, created_at: w.createdAt })), events: WEBHOOK_EVENTS });
}));
consoleApi.post('/webhooks', requireUser('webhooks.manage'), wrap(async (req, res) => {
  const b = z.object({ tenant: z.string(), url: z.string().url(), events: z.array(z.string()).min(1) }).parse(req.body);
  assertTenantAccess(me(req), b.tenant);
  const secret = `whsec_${randomSecret(24)}`;
  const row = await prisma.webhook.create({ data: { id: newId('wh', 6), tenantId: b.tenant, url: b.url, events: b.events, secret } });
  await audit({ tenantId: b.tenant, actor: actor(req), action: 'webhook.created', targetId: row.id, data: { url: b.url } });
  res.status(201).json({ id: row.id, secret, note: 'Use this secret to verify X-TripRooms-Signature. Shown once.' });
}));
consoleApi.delete('/webhooks/:id', requireUser('webhooks.manage'), wrap(async (req, res) => {
  const w = await prisma.webhook.findUnique({ where: { id: req.params.id } });
  if (!w) throw new ApiError('not_found', 'Webhook not found.');
  assertTenantAccess(me(req), w.tenantId);
  await prisma.webhook.delete({ where: { id: w.id } });
  res.json({ deleted: true });
}));
consoleApi.post('/webhooks/:id/test', requireUser('webhooks.manage'), wrap(async (req, res) => {
  const w = await prisma.webhook.findUnique({ where: { id: req.params.id } });
  if (!w) throw new ApiError('not_found', 'Webhook not found.');
  assertTenantAccess(me(req), w.tenantId);
  const body = JSON.stringify({ id: newId('evt'), type: 'webhook.test', created_at: new Date().toISOString(), tenant: w.tenantId, data: { hello: 'from Trip Rooms' } });
  let status = 0;
  try { status = (await fetch(w.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-triprooms-signature': signWebhook(w.secret, body) }, body, signal: AbortSignal.timeout(5000) })).status; } catch { status = 0; }
  res.json({ status, ok: status >= 200 && status < 300 });
}));

// ------------------------------------------------- events, stream, docs ---
consoleApi.get('/events', requireUser('events.read'), wrap(async (req, res) => {
  const ids = await myTenants(req);
  const rows = await prisma.eventLog.findMany({ where: { OR: [{ tenantId: { in: ids } }, ...(me(req).tenants.length ? [] : [{ tenantId: null }])], ...(req.query.room ? { roomId: String(req.query.room) } : {}) }, orderBy: { createdAt: 'desc' }, take: Math.min(200, Number(req.query.limit ?? 60)) });
  res.json({ data: rows.map((e) => ({ id: e.id, type: e.type, tenant: e.tenantId, room: e.roomId, data: e.data, deliveries: e.deliveries, created_at: e.createdAt.toISOString() })) });
}));
/** Server-sent events: the dashboard updates live (rooms, inbox, deliveries) without polling. */
consoleApi.get('/stream', requireUser('events.read'), async (req: Request, res: Response) => {
  const ids = new Set(await myTenants(req));
  const global = !me(req).tenants.length;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write(`event: ready\ndata: {}\n\n`);
  const off = onEvent((e) => { if ((e.tenant && ids.has(e.tenant)) || (!e.tenant && global)) res.write(`event: platform\ndata: ${JSON.stringify(e)}\n\n`); });
  const token = userBearer(req);
  const ping = setInterval(() => { if (isUserTokenRevoked(token)) res.end(); else res.write(': ping\n\n'); }, 20_000);
  req.on('close', () => { off(); clearInterval(ping); });
});
consoleApi.get('/docs/spec', requireUser(), (_req, res) => { res.json({ endpoints: API_SPEC, webhooks: WEBHOOK_EVENTS, base_url: '/v1' }); });
/** "Try it": a 15-minute tenant token so the sandbox calls the real /v1 API. */
consoleApi.post('/sandbox/token', requireUser('sandbox.use'), wrap(async (req, res) => {
  const b = z.object({ tenant: z.string() }).parse(req.body);
  assertTenantAccess(me(req), b.tenant);
  await audit({ tenantId: b.tenant, actor: actor(req), action: 'sandbox.token_issued' });
  res.json({ access_token: signTenantToken({ tid: b.tenant, cid: `sandbox:${me(req).email}`, scopes: [...SCOPES] }), expires_in: 3600, base_url: '/v1' });
}));

// ------------------------------------------------------- admin: people ---
consoleApi.get('/users', requireUser('users.manage'), wrap(async (_req, res) => {
  const rows = await prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
  res.json({ data: rows.map(userDto), roles: ROLES.map((r) => ({ id: r, label: ROLE_LABELS[r], permissions: ROLE_PERMISSIONS[r] })) });
}));
consoleApi.post('/users', requireUser('users.manage'), wrap(async (req, res) => {
  const b = z.object({ email: z.string().email(), name: z.string().min(1).max(80), role: z.enum(ROLES), tenants: z.array(z.string()).default([]) }).parse(req.body);
  const temp = randomSecret(9);
  const row = await prisma.user.create({ data: { email: b.email.toLowerCase(), name: b.name, role: b.role, tenantIds: b.tenants, passwordHash: hashSecret(temp) } }).catch((e: any) => { if (e?.code === 'P2002') throw new ApiError('invalid_request', 'A user with this email already exists.'); throw e; });
  await audit({ actor: actor(req), action: 'user.created', targetId: row.email, data: { role: b.role, tenants: b.tenants } });
  res.status(201).json({ user: userDto(row), temporary_password: temp, note: 'Share this once; ask them to change it after signing in.' });
}));
consoleApi.patch('/users/:id', requireUser('users.manage'), wrap(async (req, res) => {
  const b = z.object({ role: z.enum(ROLES).optional(), tenants: z.array(z.string()).optional(), active: z.boolean().optional(), name: z.string().max(80).optional(), reset_password: z.boolean().optional() }).parse(req.body);
  if (req.params.id === me(req).uid && (b.active === false || (b.role && b.role !== 'admin'))) throw new ApiError('invalid_request', 'You can’t deactivate or demote yourself.');
  const temp = b.reset_password ? randomSecret(9) : null;
  const row = await prisma.user.update({ where: { id: req.params.id }, data: { ...(b.role ? { role: b.role } : {}), ...(b.tenants ? { tenantIds: b.tenants } : {}), ...(b.active !== undefined ? { active: b.active } : {}), ...(b.name ? { name: b.name } : {}), ...(temp ? { passwordHash: hashSecret(temp) } : {}) } });
  await audit({ actor: actor(req), action: 'user.updated', targetId: row.email, data: { ...b, reset_password: !!temp } });
  res.json({ user: userDto(row), ...(temp ? { temporary_password: temp } : {}) });
}));

// ------------------------------------------------------ admin: tenants ---
consoleApi.post('/tenants', requireUser('tenants.manage'), wrap(async (req, res) => {
  const b = z.object({ id: z.string().regex(/^[a-z][a-z0-9_]{2,30}$/), name: z.string().min(1).max(60), verticals: z.array(z.enum(['bus', 'train', 'flight', 'custom'])).min(1), theme: z.object({ brand: z.string(), brandInk: z.string().default('#ffffff'), logoText: z.string().optional() }), identity: z.enum(['handle', 'profile']).default('handle') }).parse(req.body);
  const row = await prisma.tenant.create({ data: { id: b.id, name: b.name, verticals: b.verticals, theme: b.theme, config: defaultConfig({}, b.identity) } }).catch((e: any) => { if (e?.code === 'P2002') throw new ApiError('invalid_request', 'Tenant id already exists.'); throw e; });
  await audit({ tenantId: row.id, actor: actor(req), action: 'tenant.created' });
  res.status(201).json({ id: row.id, name: row.name });
}));

export const PUBLIC = { chatUrl: config.CHAT_WEB_URL };
