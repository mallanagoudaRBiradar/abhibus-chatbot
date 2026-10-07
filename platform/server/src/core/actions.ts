import type { ActionStatus, ActionType, Room, Severity } from '@prisma/client';
import { toRef } from '../shared/refs';
import { prisma } from '../db';
import { ApiError } from '../lib/errors';
import { newId } from '../lib/ids';
import { emitEvent } from './events';
import { createMessage } from './messages';
import { audit } from './audit';
import { getTenant } from './tenants';

const EVENT: Record<ActionType, string> = { sos: 'sos.raised', issue: 'issue.escalated', wait_request: 'wait_request.raised', lost_found: 'lost_found.created', report: 'message.reported', care: 'care.mentioned' };

/** Creates an item in the Ops action inbox and notifies the tenant (webhook). */
export async function createAction(room: Room, a: { type: ActionType; severity: Severity; title: string; detail: string; memberId?: string | null; data?: object }) {
  const row = await prisma.action.create({ data: { id: newId('act'), tenantId: room.tenantId, roomId: room.id, memberId: a.memberId ?? null, type: a.type, severity: a.severity, title: a.title, detail: a.detail, data: a.data ?? {} } });
  const m = a.memberId ? await prisma.member.findUnique({ where: { id: a.memberId } }) : null;
  await emitEvent(room.tenantId, room.id, EVENT[a.type], {
    action_id: row.id, room_id: room.id, trip_key: room.tripKey, type: a.type, severity: a.severity, title: a.title, detail: a.detail,
    member_id: m?.id ?? null, external_user_id: m?.externalUserId ?? null, booking_ref: m?.bookingRef ?? null, ...a.data,
  });
  return row;
}

export const actionDto = (a: Awaited<ReturnType<typeof createAction>>) => ({
  id: a.id, ref: toRef(a.id), type: a.type, severity: a.severity, title: a.title, detail: a.detail, room_id: a.roomId, member_id: a.memberId,
  status: a.status === 'acknowledged' ? 'acknowledged' : a.status, data: a.data, assignee: a.assignee, created_at: a.createdAt.toISOString(), updated_at: a.updatedAt.toISOString(),
});

/** Acknowledge / resolve; optional private reply (only that traveller sees it). */
export async function updateAction(tenantIds: string[] | null, id: string, u: { status?: ActionStatus; private_reply?: string; assignee?: string | null; escalate?: boolean }, actor: string) {
  const a = await prisma.action.findUnique({ where: { id } });
  if (!a || (tenantIds && !tenantIds.includes(a.tenantId))) throw new ApiError('not_found', `Action ${id} not found.`);
  const data = { ...((a.data ?? {}) as Record<string, any>) };
  if (u.private_reply) {
    if (!a.memberId) throw new ApiError('invalid_request', 'This action has no traveller to reply to.');
    const room = await prisma.room.findUniqueOrThrow({ where: { id: a.roomId } });
    // Support tickets are answered by the app's care desk by name; everything else comes from Ops.
    const from = a.type === 'care' ? (await getTenant(a.tenantId)).cfg.support.care_handle : 'Ops';
    const text = u.private_reply.slice(0, 500);
    await createMessage(room.id, 'MAIN_COMMON', { senderName: from, contentType: 'PRIVATE', payload: { text, from }, visibleTo: a.memberId });
    data.thread = [...(data.thread ?? []), { from: 'agent', by: actor, text, at: new Date().toISOString() }];
  }
  if (u.escalate) { data.escalated_to_ops = true; data.escalated_by = actor; }
  const status = u.status ?? (u.private_reply && a.status === 'open' ? 'acknowledged' : a.status);
  const assignee = u.assignee === undefined ? (a.assignee ?? (u.private_reply && a.type === 'care' ? actor : null)) : u.assignee;
  const row = await prisma.action.update({ where: { id }, data: { status, assignee, data, ...(u.escalate ? { severity: 'critical' } : {}) } });
  await audit({ tenantId: a.tenantId, actor, action: `action.${u.escalate ? 'escalated' : status}${u.private_reply ? '+reply' : ''}`, roomId: a.roomId, targetId: id });
  const who = a.memberId ? await prisma.member.findUnique({ where: { id: a.memberId }, select: { externalUserId: true, bookingRef: true } }) : null;
  const reply = u.private_reply ? { text: u.private_reply.slice(0, 500), from: a.type === 'care' ? (await getTenant(a.tenantId)).cfg.support.care_handle : 'Ops' } : null;
  // Tenants that run their own chat UI deliver `reply` to the traveller themselves (see /v1 "Bring your own chat").
  await emitEvent(a.tenantId, a.roomId, 'action.updated', { action_id: id, ref: toRef(id), type: a.type, status, assignee, escalated: !!u.escalate, private_reply: !!u.private_reply, reply, room_id: a.roomId, member_id: a.memberId, external_user_id: who?.externalUserId ?? null, booking_ref: who?.bookingRef ?? null, actor });
  return row;
}

const URGENT_WORDS = /\b(unsafe|harass\w*|emergency|medical|accident|stolen|theft|help me|urgent|police|injur\w*)\b/i;

/**
 * A traveller tagged the support desk. One open ticket per traveller per room: a second
 * mention while it's open is added to the same ticket (no duplicate pings for the desk).
 */
export async function raiseCareTicket(room: Room, m: { id: string; externalUserId: string; bookingRef: string }, who: string, text: string, messageId: string) {
  const urgent = URGENT_WORDS.test(text);
  const open = await prisma.action.findFirst({ where: { roomId: room.id, memberId: m.id, type: 'care', status: { not: 'resolved' } } });
  const entry = { from: 'traveller', by: who, text, at: new Date().toISOString(), message_id: messageId };
  if (open) {
    const data = { ...((open.data ?? {}) as Record<string, any>) };
    data.thread = [...(data.thread ?? []), entry];
    const row = await prisma.action.update({ where: { id: open.id }, data: { detail: text.slice(0, 280), data, status: 'open', ...(urgent ? { severity: 'critical' } : {}) } });
    await emitEvent(room.tenantId, room.id, 'care.mentioned', { action_id: row.id, room_id: room.id, member_id: m.id, external_user_id: m.externalUserId, booking_ref: m.bookingRef, text, message_id: messageId, follow_up: true });
    return row;
  }
  return createAction(room, { type: 'care', severity: urgent ? 'critical' : 'warning', title: `${who} needs help`, detail: text.slice(0, 280), memberId: m.id, data: { text, message_id: messageId, who, thread: [entry] } });
}
