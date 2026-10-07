import type { Member, Room } from '@prisma/client';
import { prisma } from '../db';
import { ApiError } from '../lib/errors';
import { createAction } from './actions';
import { audit } from './audit';
import { emitEvent } from './events';
import { hub } from './hub';
import { createInAllChannels, channelById, KIND_TO_RT } from './messages';
import { removeMember } from './members';
import { getTenant } from './tenants';
import { broadcastRoomUpdate } from './alerts';
import { S2C } from '../shared/protocol';
import { display } from './identity';

/**
 * Reports: one per (target, booking ref), so a family on one booking counts once.
 *  - message hidden for everyone at `report_hide_at` reports (Ops can restore)
 *  - a person reported by more than half the room's members (min 2) is removed
 *    for the rest of the trip
 * Reports are snapshotted for trust & safety and survive the purge (30 days).
 */
export async function reportMessage(room: Room, reporter: Member, messageId: string, reason: string) {
  const msg = await prisma.message.findUnique({ where: { id: messageId } });
  if (!msg) throw new ApiError('not_found', 'Message not found.');
  const ch = await channelById(msg.channelId);
  if (ch.roomId !== room.id || !msg.senderId || msg.senderId === reporter.id) throw new ApiError('invalid_request', 'You can’t report this message.');
  const fresh = await saveReport(room, reporter, msg.id, msg.senderId, reason, { contentType: msg.contentType, payload: msg.payload, sentAt: msg.createdAt });
  if (!fresh) return;
  const { cfg } = await getTenant(room.tenantId);
  const count = await prisma.report.count({ where: { targetKey: msg.id } });
  if (count >= cfg.report_hide_at && !msg.hidden) {
    await prisma.message.update({ where: { id: msg.id }, data: { hidden: true } });
    hub.toChannel(room.id, KIND_TO_RT[ch.kind], S2C.MSG_REMOVED, { roomType: KIND_TO_RT[ch.kind], messageId: msg.id });
    const sender = await prisma.member.findUnique({ where: { id: msg.senderId } });
    await createAction(room, { type: 'report', severity: 'info', title: `Message hidden after ${count} reports`, detail: `“${String((msg.payload as any)?.text ?? '').slice(0, 80)}” by ${sender ? display(sender, cfg.identity.mode).name : 'a traveller'}`, memberId: msg.senderId, data: { message_id: msg.id, reason } });
  }
  await checkMajority(room, msg.senderId);
}

export async function reportPerson(room: Room, reporter: Member, targetId: string, reason: string) {
  if (targetId === reporter.id) throw new ApiError('invalid_request', 'You can’t report yourself.');
  const recent = await prisma.message.findMany({ where: { senderId: targetId, channel: { roomId: room.id } }, orderBy: { createdAt: 'desc' }, take: 5, select: { contentType: true, payload: true, createdAt: true } });
  const fresh = await saveReport(room, reporter, `person:${targetId}`, targetId, reason, { kind: 'PERSON', recent });
  if (fresh) await checkMajority(room, targetId);
}

async function saveReport(room: Room, reporter: Member, targetKey: string, reportedId: string, reason: string, snapshot: object) {
  try {
    await prisma.report.create({ data: { roomId: room.id, targetKey, reporterRef: reporter.bookingRef, reporterId: reporter.id, reportedId, reason, snapshot: snapshot as object, retainUntil: new Date(Date.now() + 30 * 86_400_000) } });
  } catch (e: any) { if (e?.code === 'P2002') return false; throw e; }
  await emitEvent(room.tenantId, room.id, 'message.reported', { room_id: room.id, target: targetKey, reported_member_id: reportedId, reason });
  return true;
}

async function checkMajority(room: Room, memberId: string) {
  const target = await prisma.member.findUnique({ where: { id: memberId } });
  if (!target || target.removedAt) return;
  const reporters = new Set((await prisma.report.findMany({ where: { roomId: room.id, reportedId: memberId }, select: { reporterRef: true } })).map((r) => r.reporterRef));
  const members = await prisma.member.count({ where: { roomId: room.id, removedAt: null, role: 'traveller' } });
  if (reporters.size < 2 || reporters.size <= members / 2) return;
  const { cfg } = await getTenant(room.tenantId);
  const name = display(target, cfg.identity.mode).name;
  await removeMember(room, target, 'reported_by_majority', 'system');
  await createInAllChannels(room.id, { senderName: 'System', contentType: 'SYSTEM', payload: { text: `🚫 ${name} was removed from this chat after reports from more than half of the travellers.` } });
  await createAction(room, { type: 'report', severity: 'warning', title: `${name} removed by majority reports`, detail: `${reporters.size} of ${members} travellers reported them.`, memberId, data: { removed: true } });
  await audit({ tenantId: room.tenantId, actor: 'system', action: 'member.removed_by_reports', roomId: room.id, targetId: memberId, data: { reporters: reporters.size, members } });
}

export async function setMute(room: Room, m: Member, muted: boolean, actor: string, reason = 'Moderation') {
  await prisma.member.update({ where: { id: m.id }, data: { muted } });
  if (muted) hub.toMember(room.id, m.id, S2C.MUTED, { reason });
  await audit({ tenantId: room.tenantId, actor, action: muted ? 'member.muted' : 'member.unmuted', roomId: room.id, targetId: m.id, reason });
  await emitEvent(room.tenantId, room.id, muted ? 'member.muted' : 'member.unmuted', { room_id: room.id, member_id: m.id, external_user_id: m.externalUserId, reason, actor });
}

export async function moderateRoom(room: Room, a: { action: string; member_id?: string; enabled?: boolean; duration_min?: number; reason?: string }, actor: string) {
  if (a.action === 'ops_only' || a.action === 'slow_mode') {
    const enabled = a.enabled ?? true;
    await prisma.room.update({ where: { id: room.id }, data: a.action === 'ops_only' ? { opsOnly: enabled } : { slowMode: enabled } });
    if (enabled && a.duration_min) setTimeout(() => void prisma.room.update({ where: { id: room.id }, data: a.action === 'ops_only' ? { opsOnly: false } : { slowMode: false } }).then(() => broadcastRoomUpdate(room.id)), a.duration_min * 60_000).unref();
    await audit({ tenantId: room.tenantId, actor, action: `room.${a.action}.${enabled ? 'on' : 'off'}`, roomId: room.id, reason: a.reason });
    await broadcastRoomUpdate(room.id);
    await emitEvent(room.tenantId, room.id, 'room.moderation', { room_id: room.id, action: a.action, enabled, actor });
    return { applied: true, [a.action]: enabled };
  }
  if (!a.member_id) throw new ApiError('invalid_request', 'member_id is required for this action.');
  const m = await prisma.member.findUnique({ where: { id: a.member_id } });
  if (!m || m.roomId !== room.id) throw new ApiError('not_found', 'Member not found in this room.');
  if (a.action === 'mute_member' || a.action === 'unmute_member') { await setMute(room, m, a.action === 'mute_member', actor, a.reason); return { applied: true }; }
  if (a.action === 'remove_member') {
    await removeMember(room, m, 'moderation', actor);
    await audit({ tenantId: room.tenantId, actor, action: 'member.removed', roomId: room.id, targetId: m.id, reason: a.reason });
    return { applied: true };
  }
  throw new ApiError('invalid_request', 'action must be one of mute_member, unmute_member, remove_member, ops_only, slow_mode.');
}

/** Ops only, with a reason. Every reveal is logged and reviewed. */
export async function revealMember(room: Room, m: Member, reason: string, actor: string) {
  if (!['sos', 'harassment', 'lost_found', 'legal'].includes(reason)) throw new ApiError('invalid_request', 'reason must be sos, harassment, lost_found or legal.');
  const row = await audit({ tenantId: room.tenantId, actor, action: 'member.revealed', roomId: room.id, targetId: m.id, reason });
  await emitEvent(room.tenantId, room.id, 'member.revealed', { room_id: room.id, member_id: m.id, reason, actor, audit_id: row.id });
  return { booking_ref: m.bookingRef, external_user_id: m.externalUserId, seat_refs: m.seatRefs, segment: { from: m.segmentFrom, to: m.segmentTo }, audit_id: row.id };
}
