import { z } from 'zod';
import type { Member, Room } from '@prisma/client';
import { prisma } from '../db';
import { ApiError } from '../lib/errors';
import { newId } from '../lib/ids';
import { randomHandle } from '../shared/handles';
import { signMemberToken } from '../auth/tokens';
import { emitEvent } from './events';
import { hub } from './hub';
import { createMessage } from './messages';
import { getTenant } from './tenants';
import { config } from '../config';
import { AVATARS, DISPLAY_NAME_RE } from '../shared/protocol';
import { checkMessage } from '../shared/moderation';

export const MemberInZ = z.object({
  external_user_id: z.string().min(1).max(80),
  booking_ref: z.string().min(1).max(40),
  segment: z.object({ from: z.string().max(12), to: z.string().max(12) }).optional(),
  party_size: z.number().int().min(1).max(20).optional(),
  seat_refs: z.array(z.string().max(12)).max(20).optional(),
  chart_status: z.enum(['waitlisted', 'rac', 'charted']).optional(),
  locale: z.string().max(10).optional(),
  notify: z.object({ push: z.boolean().optional(), sms: z.boolean().optional(), whatsapp: z.boolean().optional() }).optional(),
  /** Only to gate the women-only channel; never shown to anyone. */
  gender: z.enum(['M', 'F', 'O', 'U']).optional(),
  role: z.enum(['traveller', 'crew']).optional(),
  display_name: z.string().max(40).optional(), // profile mode: prefill (the traveller can change it)
  /** The traveller already picked a name in your own app: use it and skip the profile step. Letters only. */
  profile: z.object({ name: z.string().max(24), avatar: z.string().max(40).nullable().optional() }).optional(),
});
export type MemberIn = z.infer<typeof MemberInZ>;

export const memberDto = (m: Member, opts: { withExternal?: boolean } = {}) => ({
  member_id: m.id, handle: m.handle, display_name: m.displayName, role: m.role, muted: m.muted,
  sharing_location: m.sharingLocation, removed: !!m.removedAt, segment: m.segmentFrom ? { from: m.segmentFrom, to: m.segmentTo } : null,
  party_size: m.partySize, chart_status: m.chartStatus, ...(opts.withExternal ? { external_user_id: m.externalUserId, booking_ref: m.bookingRef } : {}),
});

/** Add travellers (≤500). Idempotent per external_user_id: one handle per person per room, even with several seats. */
export async function addMembers(room: Room, list: MemberIn[], actor: string) {
  if (list.length > 500) throw new ApiError('invalid_request', 'Up to 500 members per call.');
  if (room.state === 'closed') throw new ApiError('room_state', 'This room is closed.');
  const taken = new Set((await prisma.member.findMany({ where: { roomId: room.id }, select: { handle: true } })).map((m) => m.handle));
  const out: Member[] = [];
  for (const m of list) {
    const existing = await prisma.member.findUnique({ where: { roomId_externalUserId: { roomId: room.id, externalUserId: m.external_user_id } } });
    const data = {
      bookingRef: m.booking_ref, segmentFrom: m.segment?.from ?? null, segmentTo: m.segment?.to ?? null, partySize: m.party_size ?? 1,
      seatRefs: m.seat_refs ?? [], chartStatus: m.chart_status ?? null, locale: m.locale ?? 'en-IN', notify: m.notify ?? {},
      gender: m.gender ?? 'U', role: m.role ?? 'traveller', ...(m.display_name ? { displayName: m.display_name.slice(0, 24) } : {}),
      ...(m.profile && DISPLAY_NAME_RE.test(m.profile.name.trim()) ? { displayName: m.profile.name.trim(), profileSet: true } : {}),
    };
    if (existing) {
      out.push(await prisma.member.update({ where: { id: existing.id }, data: { ...data, removedAt: existing.removedReason === 'cancelled' ? null : existing.removedAt } }));
      continue;
    }
    const handle = randomHandle(taken);
    taken.add(handle);
    out.push(await prisma.member.create({ data: { id: newId('mem', 8), roomId: room.id, externalUserId: m.external_user_id, handle, ...data } }));
  }
  if (out.length) await emitEvent(room.tenantId, room.id, 'member.joined', { room_id: room.id, members: out.map((m) => ({ member_id: m.id, handle: m.handle, external_user_id: m.externalUserId })), actor });
  hub.schedulePresence(room.id, 'MAIN_COMMON');
  return out;
}

export async function getMember(room: Room, memberId: string) {
  const m = await prisma.member.findUnique({ where: { id: memberId } });
  if (!m || m.roomId !== room.id) throw new ApiError('not_found', `Member ${memberId} not found in this room.`);
  return m;
}

export async function removeMember(room: Room, m: Member, reason: string, actor: string) {
  await prisma.member.update({ where: { id: m.id }, data: { removedAt: new Date(), removedReason: reason } });
  hub.toMember(room.id, m.id, 'moderation:removed', { reason });
  await hub.disconnectMember(room.id, m.id);
  await emitEvent(room.tenantId, room.id, 'member.left', { room_id: room.id, member_id: m.id, external_user_id: m.externalUserId, reason, actor });
  hub.schedulePresence(room.id, 'MAIN_COMMON');
}

/** Undo a removal (e.g. removed by mistake): they can rejoin and post again. */
export async function restoreMember(room: Room, m: Member, actor: string) {
  if (!m.removedAt) return m;
  const row = await prisma.member.update({ where: { id: m.id }, data: { removedAt: null, removedReason: null } });
  await emitEvent(room.tenantId, room.id, 'member.restored', { room_id: room.id, member_id: m.id, external_user_id: m.externalUserId, actor });
  hub.schedulePresence(room.id, 'MAIN_COMMON');
  return row;
}

/** Reschedule / bus swap / flight change / train charting: fresh handle in the new room. */
export async function moveMembers(tenantId: string, fromId: string, toId: string, memberIds: string[], reason: string, actor: string) {
  const [from, to] = await Promise.all([prisma.room.findUnique({ where: { id: fromId } }), prisma.room.findUnique({ where: { id: toId } })]);
  if (!from || !to || from.tenantId !== tenantId || to.tenantId !== tenantId) throw new ApiError('not_found', 'Both rooms must exist in your tenant.');
  const members = await prisma.member.findMany({ where: { id: { in: memberIds }, roomId: fromId } });
  const moved = await addMembers(to, members.map((m) => ({
    external_user_id: m.externalUserId, booking_ref: m.bookingRef, segment: m.segmentFrom ? { from: m.segmentFrom, to: m.segmentTo ?? '' } : undefined,
    party_size: m.partySize, seat_refs: m.seatRefs, chart_status: (m.chartStatus as any) ?? undefined, locale: m.locale, gender: m.gender,
  })), actor);
  for (const m of members) await removeMember(from, m, reason === 'charting' ? 'moved_to_coach' : 'moved', actor);
  if (moved.length) await createMessage(to.id, 'MAIN_COMMON', { senderName: 'System', contentType: 'SYSTEM', payload: { text: reason === 'charting' ? `Chart prepared: ${moved.length} traveller${moved.length > 1 ? 's' : ''} moved into this coach room.` : `${moved.length} traveller${moved.length > 1 ? 's' : ''} joined from another trip.` } });
  await emitEvent(tenantId, toId, 'member.moved', { from_room_id: fromId, to_room_id: toId, count: moved.length, reason });
  return moved;
}

/** Short-lived token the tenant app passes to the chat screen. */
export async function memberToken(room: Room, m: Member, ttlSec = 3600) {
  if (m.removedAt) throw new ApiError('forbidden', 'This member has left or was removed from the room.');
  const ttl = Math.min(ttlSec, Math.max(60, Math.floor((+room.purgeAt - Date.now()) / 1000)));
  const token = signMemberToken({ rid: room.id, mid: m.id, tid: room.tenantId }, ttl);
  const url = `${config.CHAT_WEB_URL}/?token=${encodeURIComponent(token)}`;
  return { token, expires_at: new Date(Date.now() + ttl * 1000).toISOString(), chat_url: url, realtime_url: `/ws` };
}

/** Profile identity mode: the traveller picks a first name (letters only, filtered) + avatar. */
export async function setProfile(m: Member, name: string, avatar: string | null) {
  const room = await prisma.room.findUniqueOrThrow({ where: { id: m.roomId } });
  const { cfg } = await getTenant(room.tenantId);
  if (cfg.identity.mode !== 'profile') throw new ApiError('feature_disabled', 'This trip uses random handles.');
  const clean = name.trim().replace(/\s+/g, ' ');
  if (!DISPLAY_NAME_RE.test(clean) || !checkMessage(clean).ok) throw new ApiError('invalid_request', 'Use your first name — letters only, up to 24 characters.');
  if (avatar && !AVATARS[avatar]) throw new ApiError('invalid_request', 'Pick an avatar from the list.');
  return prisma.member.update({ where: { id: m.id }, data: { displayName: clean, avatarId: avatar, profileSet: true } });
}
