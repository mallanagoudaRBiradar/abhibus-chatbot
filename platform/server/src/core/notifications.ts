import { prisma } from '../db';
import { can, type Permission, type Role } from '../shared/roles';
import { toRef } from '../shared/refs';

/**
 * The console notification centre. One rule per platform event says who needs to know
 * (by permission, so roles stay the single source of truth), how urgent it is, what it says
 * and where clicking it takes you. Read state lives on the user (notifState).
 */
export type Severity = 'critical' | 'warning' | 'info';
export interface Notif {
  id: string; type: string; severity: Severity; title: string; body: string; kind: string;
  room: { id: string; ref: string; title: string } | null; link: string; created_at: string; unread: boolean;
}
type Room = { id: string; title: string; tenantId: string };
type Rule = { any: Permission[]; map: (d: any, room: Room | null, ref: string) => Omit<Notif, 'id' | 'type' | 'room' | 'created_at' | 'unread'> | null };

const roomLink = (room: Room | null) => (room ? `/ops/rooms/${room.id}` : '/ops/rooms');
const ISSUE = (kind: string, severity: Severity): Rule => ({
  any: ['inbox.act', 'rooms.act'],
  map: (d, room, ref) => ({ kind, severity, title: `${kind} in ${ref}`, body: [d.title, d.detail].filter(Boolean).join(' · ') || room?.title || '', link: roomLink(room) }),
});
const STAFF_ACTORS = /@/; // console users act with their email; seed / simulator / bridge don't

const RULES: Record<string, Rule> = {
  'sos.raised': { any: ['inbox.act', 'rooms.act'], map: (d, room, ref) => ({ kind: 'SOS', severity: 'critical', title: `SOS in ${ref}`, body: `${d.title ?? 'A traveller needs help'}${d.detail ? ` · ${d.detail}` : ''}`, link: roomLink(room) }) },
  'issue.escalated': ISSUE('Group issue', 'warning'),
  'wait_request.raised': ISSUE('Wait for me', 'warning'),
  'lost_found.created': ISSUE('Lost & found', 'info'),
  'message.reported': { any: ['moderation.act'], map: (_d, room, ref) => ({ kind: 'Report', severity: 'info', title: `Message reported in ${ref}`, body: room?.title ?? '', link: roomLink(room) }) },
  'care.mentioned': { any: ['support.handle'], map: (d, room, ref) => ({ kind: 'Support', severity: /\b(unsafe|harass|medical|emergency|accident|police|stolen)/i.test(d.text ?? '') ? 'critical' : 'warning', title: d.follow_up ? `Traveller wrote again · ${ref}` : `New support ticket · ${ref}`, body: String(d.text ?? '').slice(0, 160), link: d.action_id ? `/support/queue/${d.action_id}` : '/support/queue' }) },
  'action.updated': { any: ['rooms.act'], map: (d, room, ref) => (d.escalated ? { kind: 'Handover', severity: 'critical', title: `Support handed over ${d.ref ?? 'a ticket'} · ${ref}`, body: `${d.actor} needs Ops on this trip.`, link: roomLink(room) } : null) },
  'trip_event.breakdown': { any: ['rooms.act'], map: (d, room, ref) => ({ kind: 'Breakdown', severity: 'critical', title: `Breakdown reported · ${ref}`, body: d.reason ?? room?.title ?? '', link: roomLink(room) }) },
  'trip_event.cancelled': { any: ['rooms.act', 'rooms.manage'], map: (d, room, ref) => ({ kind: 'Cancelled', severity: 'warning', title: `Trip cancelled · ${ref}`, body: d.reason ?? room?.title ?? '', link: roomLink(room) }) },
  'survey.response': { any: ['campaigns.read'], map: (d, room, ref) => ({ kind: 'Response', severity: 'info', title: `New survey response · ${ref}`, body: `Answers: ${(d.answers ?? []).map((a: unknown) => (typeof a === 'number' ? `${a}★` : String(a))).join(' · ')}`, link: d.campaign_id ? `/marketing/campaigns/${d.campaign_id}` : roomLink(room) }) },
  'poll.completed': { any: ['campaigns.read', 'rooms.act'], map: (d, room, ref) => ({ kind: 'Poll', severity: 'info', title: `Poll closed · ${ref}`, body: `${d.question} · ${(d.results ?? []).map((r: any) => `${r.option} ${r.votes}`).join(', ')}`, link: roomLink(room) }) },
  'campaign.created': { any: ['campaigns.read'], map: (d) => (STAFF_ACTORS.test(d.actor ?? '') ? { kind: 'Campaign', severity: 'info', title: `Campaign ${d.status === 'live' ? 'launched' : 'saved'} · ${d.name ?? ''}`, body: `by ${d.actor}`, link: d.campaign_id ? `/marketing/campaigns/${d.campaign_id}` : '/marketing/campaigns' } : null) },
  'room.created': { any: ['rooms.manage'], map: (d, room, ref) => (STAFF_ACTORS.test(d.actor ?? '') ? { kind: 'Room', severity: 'info', title: `Room created · ${ref}`, body: `${room?.title ?? ''} · by ${d.actor}`, link: roomLink(room) } : null) },
  'room.state_changed': { any: ['rooms.manage', 'rooms.act'], map: (d, room, ref) => (STAFF_ACTORS.test(d.actor ?? '') ? { kind: 'Room', severity: 'info', title: `${d.to === 'closed' ? 'Room closed' : d.to === 'read_only' ? 'Chat ended' : 'Room reopened'} · ${ref}`, body: `${room?.title ?? ''} · by ${d.actor}`, link: roomLink(room) } : null) },
  'room.deleted': { any: ['rooms.manage'], map: (d, _room, ref) => ({ kind: 'Room', severity: 'warning', title: `Room deleted · ${ref}`, body: `${d.title ?? ''} · by ${d.actor}`, link: '/admin/rooms' }) },
};
export const NOTIFY_TYPES = Object.keys(RULES);

type State = { seenAt?: string; read?: string[] };

export async function notificationsFor(user: { uid: string; role: Role }, tenantIds: string[], limit = 60) {
  const types = NOTIFY_TYPES.filter((t) => RULES[t].any.some((p) => can(user.role, p)));
  const [u, rows] = await Promise.all([
    prisma.user.findUnique({ where: { id: user.uid }, select: { notifState: true } }),
    prisma.eventLog.findMany({ where: { type: { in: types }, OR: [{ tenantId: { in: tenantIds } }, { tenantId: null }], createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } }, orderBy: { createdAt: 'desc' }, take: 250 }),
  ]);
  const st = (u?.notifState ?? {}) as State;
  const read = new Set(st.read ?? []);
  const seen = st.seenAt ? +new Date(st.seenAt) : 0;
  const roomIds = [...new Set(rows.map((r) => r.roomId).filter(Boolean) as string[])];
  const rooms = new Map((await prisma.room.findMany({ where: { id: { in: roomIds } }, select: { id: true, title: true, tenantId: true } })).map((r) => [r.id, r]));
  const out: Notif[] = [];
  for (const e of rows) {
    const room = e.roomId ? rooms.get(e.roomId) ?? null : null;
    const ref = room ? toRef(room.id) : e.roomId ? toRef(e.roomId) : '';
    const n = RULES[e.type].map(e.data as any, room, ref);
    if (!n) continue;
    out.push({ id: e.id, type: e.type, ...n, room: room ? { id: room.id, ref, title: room.title } : null, created_at: e.createdAt.toISOString(), unread: +e.createdAt > seen && !read.has(e.id) });
    if (out.length >= limit) break;
  }
  return { data: out, unread: out.filter((n) => n.unread).length };
}

export async function markRead(uid: string, ids: string[] | 'all') {
  const u = await prisma.user.findUnique({ where: { id: uid }, select: { notifState: true } });
  const st = (u?.notifState ?? {}) as State;
  const next: State = ids === 'all' ? { seenAt: new Date().toISOString(), read: [] } : { seenAt: st.seenAt, read: [...new Set([...(st.read ?? []), ...ids])].slice(-300) };
  await prisma.user.update({ where: { id: uid }, data: { notifState: next as object } });
}
