import type { Member, Room } from '@prisma/client';
import { prisma } from '../db';
import { ApiError } from '../lib/errors';
import { newId } from '../lib/ids';
import { createAction } from './actions';
import { emitEvent } from './events';
import { createMessage, createInAllChannels, pushUpdate, emitReactions, channelById } from './messages';
import { estimate } from './location';
import { getTenant, requireFeature } from './tenants';
import { display } from './identity';
import { mask } from '../shared/moderation';
import { stopsOf } from './rooms';
import { POLL_VOTE_PREFIX, type RoomType, type SurveyQuestion } from '../shared/protocol';

const nameOf = async (room: Room, m: Member) => display(m, (await getTenant(room.tenantId)).cfg.identity.mode).name;

// ------------------------------------------------------------ group issues --
/** One card per issue label per room; others tap “Me too”; escalates to Ops at the threshold. */
export async function reportIssue(room: Room, m: Member, rt: RoomType, label: string) {
  await requireFeature(room, 'issues');
  await prisma.issueReport.upsert({ where: { roomId_label_memberId: { roomId: room.id, label, memberId: m.id } }, create: { roomId: room.id, label, memberId: m.id }, update: {} });
  const count = await prisma.issueReport.count({ where: { roomId: room.id, label } });
  const { cfg } = await getTenant(room.tenantId);
  let card = await prisma.message.findFirst({ where: { channel: { roomId: room.id }, contentType: 'ISSUE', payload: { path: ['label'], equals: label } } });
  const wasEscalated = !!(card?.payload as any)?.escalated;
  const escalated = wasEscalated || count >= cfg.issue_escalate_at;
  const payload = { label, count, escalated, threshold: cfg.issue_escalate_at };
  if (!card) {
    const dto = await createMessage(room.id, rt, { senderName: 'Issue', contentType: 'ISSUE', payload });
    card = await prisma.message.findUniqueOrThrow({ where: { id: dto.id } });
  } else {
    await prisma.message.update({ where: { id: card.id }, data: { payload } });
  }
  await prisma.reaction.upsert({ where: { messageId_memberId_key: { messageId: card.id, memberId: m.id, key: 'issue:metoo' } }, create: { messageId: card.id, memberId: m.id, key: 'issue:metoo' }, update: {} });
  await pushUpdate(card.id);
  await emitReactions(card.id);
  await emitEvent(room.tenantId, room.id, 'issue.reported', { room_id: room.id, label, count });
  if (escalated && !wasEscalated) {
    await createAction(room, { type: 'issue', severity: 'warning', title: label, detail: `${count} travellers reported this. Auto-escalated.`, data: { label, count, message_id: card.id } });
  }
  return card.id;
}
export async function metoo(room: Room, m: Member, messageId: string) {
  const msg = await prisma.message.findUnique({ where: { id: messageId } });
  if (!msg || msg.contentType !== 'ISSUE') throw new ApiError('not_found', 'Issue not found.');
  const ch = await channelById(msg.channelId);
  return reportIssue(room, m, ch.kind === 'MAIN' ? 'MAIN_COMMON' : 'WOMEN_ONLY', (msg.payload as any).label);
}

// --------------------------------------------------------------------- SOS --
/** Private: only Ops sees it, with the trip and best location attached. Never posted in the room. */
export async function raiseSos(room: Room, m: Member, reason: string, coords?: { lat: number; lng: number } | null) {
  await requireFeature(room, 'sos');
  const loc = await estimate(room);
  const a = await createAction(room, {
    type: 'sos', severity: 'critical', title: reason, memberId: m.id,
    detail: `${await nameOf(room, m)} · ${loc.near} · ${coords ? 'traveller location attached' : `location from ${loc.source}`}`,
    data: { reason, location: coords ?? null, estimate: loc },
  });
  await createMessage(room.id, 'MAIN_COMMON', { senderName: 'Ops', contentType: 'PRIVATE', visibleTo: m.id, payload: { text: 'SOS received. An Ops agent will call you within 2 minutes. If you are in immediate danger, call 112.', from: 'Ops' } });
  return a;
}

// ------------------------------------------------------------ wait for me --
export async function waitForMe(room: Room, m: Member, minutes: number) {
  await requireFeature(room, 'wait_for_me');
  if (room.state !== 'open' && room.state !== 'scheduled') throw new ApiError('room_state', 'Wait-for-me works before boarding.');
  const stop = stopsOf(room).find((s) => s.code === m.segmentFrom)?.name ?? stopsOf(room)[0]?.name;
  const a = await createAction(room, { type: 'wait_request', severity: 'warning', title: `Wait for me · ${minutes} min late`, detail: `${await nameOf(room, m)} is heading to ${stop}.`, memberId: m.id, data: { minutes, stop } });
  await createMessage(room.id, 'MAIN_COMMON', { senderName: 'Ops', contentType: 'PRIVATE', visibleTo: m.id, payload: { text: `We’ve told the ${room.vertical} you’re ${minutes} min away. We’ll confirm shortly.`, from: 'Ops' } });
  return a;
}

// ------------------------------------------------------------ lost & found --
export async function lostFound(room: Room, m: Member, rt: RoomType, text: string) {
  await requireFeature(room, 'lost_found');
  const clean = mask(text.trim()).slice(0, 300);
  if (!clean) throw new ApiError('invalid_request', 'Describe the item first.');
  const msg = await createMessage(room.id, rt, { senderId: m.id, senderName: await nameOf(room, m), contentType: 'LOST', payload: { text: clean } });
  await createAction(room, { type: 'lost_found', severity: 'info', title: 'Lost & found', detail: `“${clean.slice(0, 80)}”`, memberId: m.id, data: { message_id: msg.id } });
  return msg;
}

// --------------------------------------------------------------- vouchers --
export async function issueVoucher(room: Room, amount: number, actor: string, note = 'For the delay') {
  await requireFeature(room, 'vouchers');
  const msgs = await createInAllChannels(room.id, { senderName: 'Ops', contentType: 'VOUCHER', payload: { amount, currency: 'INR', validDays: 30, note } });
  await emitEvent(room.tenantId, room.id, 'voucher.issued', { room_id: room.id, message_id: msgs[0].id, amount, actor });
  return msgs[0];
}
/** One claim per member; the tenant credits the wallet on `voucher.claimed`. */
export async function claimVoucher(room: Room, m: Member, messageId: string) {
  const msg = await prisma.message.findUnique({ where: { id: messageId } });
  if (!msg || msg.contentType !== 'VOUCHER') throw new ApiError('not_found', 'Voucher not found.');
  const key = 'voucher:claimed';
  const had = await prisma.reaction.findUnique({ where: { messageId_memberId_key: { messageId, memberId: m.id, key } } });
  if (!had) {
    await prisma.reaction.create({ data: { messageId, memberId: m.id, key } });
    await emitEvent(room.tenantId, room.id, 'voucher.claimed', { room_id: room.id, member_id: m.id, external_user_id: m.externalUserId, booking_ref: m.bookingRef, amount: (msg.payload as any).amount, message_id: messageId });
  }
  await emitReactions(messageId);
  return { code: `TRIP-${m.id.slice(-5).toUpperCase()}` };
}

// ------------------------------------------------------------------ rating --
export async function rateTrip(room: Room, m: Member, messageId: string, stars: number) {
  if (stars < 1 || stars > 5) throw new ApiError('invalid_request', 'stars must be 1–5.');
  await prisma.reaction.deleteMany({ where: { messageId, memberId: m.id, key: { startsWith: 'rate:' } } });
  await prisma.reaction.create({ data: { messageId, memberId: m.id, key: `rate:${stars}` } });
  await emitReactions(messageId);
  await emitEvent(room.tenantId, room.id, 'trip.rated', { room_id: room.id, member_id: m.id, external_user_id: m.externalUserId, stars });
}

// ------------------------------------------------------------------ polls --
/** Ops / tenant poll (2–4 options). Votes reuse the reaction rows `poll:<i>`; results on close via webhook. */
export async function createRoomPoll(room: Room, p: { question: string; options: string[]; closes_in_min?: number; campaign_id?: string; by: string }) {
  await requireFeature(room, 'polls');
  if (p.options.length < 2 || p.options.length > 4) throw new ApiError('invalid_request', 'options must have 2–4 items.');
  const closesAt = new Date(Date.now() + (p.closes_in_min ?? 30) * 60_000);
  const msgs = await createInAllChannels(room.id, { senderName: p.by, contentType: 'POLL', payload: { question: p.question.slice(0, 200), options: p.options.map((o) => o.slice(0, 80)), multi: false, by: p.by, sponsored: !!p.campaign_id, campaignId: p.campaign_id ?? null, closesAt: closesAt.toISOString() } });
  setTimeout(() => void pollResults(room, msgs.map((m) => m.id)), +closesAt - Date.now()).unref();
  return msgs[0];
}
async function pollResults(room: Room, ids: string[]) {
  const msg = await prisma.message.findUnique({ where: { id: ids[0] } });
  if (!msg) return;
  const opts = (msg.payload as any).options as string[];
  const votes = await prisma.reaction.groupBy({ by: ['key'], where: { messageId: { in: ids }, key: { startsWith: 'poll:' } }, _count: true });
  const results = opts.map((o, i) => ({ option: o, votes: votes.find((v) => v.key === `poll:${i}`)?._count ?? 0 }));
  await emitEvent(room.tenantId, room.id, 'poll.completed', { room_id: room.id, poll_id: ids[0], question: (msg.payload as any).question, results });
}

/** Vote (replaces any earlier vote). First vote on a sponsored poll counts as a campaign response. Returns live results. */
export async function votePoll(m: Member, messageId: string, options: number[]) {
  const msg = await prisma.message.findUnique({ where: { id: messageId } });
  if (!msg || msg.contentType !== 'POLL') throw new ApiError('not_found', 'Poll not found.');
  const p = msg.payload as { options: string[]; multi: boolean; campaignId?: string; closesAt?: string };
  if (p.closesAt && Date.parse(p.closesAt) < Date.now()) throw new ApiError('room_state', 'This poll has closed.');
  const picked = [...new Set(options)].filter((i) => i >= 0 && i < p.options.length);
  if (!p.multi && picked.length > 1) throw new ApiError('invalid_request', 'This poll allows one answer.');
  const first = !(await prisma.reaction.count({ where: { messageId, memberId: m.id, key: { startsWith: POLL_VOTE_PREFIX } } }));
  await prisma.$transaction([
    prisma.reaction.deleteMany({ where: { messageId, memberId: m.id, key: { startsWith: POLL_VOTE_PREFIX } } }),
    prisma.reaction.createMany({ data: picked.map((i) => ({ messageId, memberId: m.id, key: `${POLL_VOTE_PREFIX}${i}` })) }),
  ]);
  if (first && picked.length && p.campaignId) await prisma.campaign.update({ where: { id: p.campaignId }, data: { responses: { increment: 1 } } }).catch(() => {});
  await emitReactions(messageId);
  const votes = await prisma.reaction.groupBy({ by: ['key'], where: { messageId, key: { startsWith: POLL_VOTE_PREFIX } }, _count: true });
  return { results: p.options.map((o, i) => ({ option: o, votes: votes.find((v) => v.key === `${POLL_VOTE_PREFIX}${i}`)?._count ?? 0 })) };
}

// ---------------------------------------------------------------- surveys --
export async function sendSurvey(room: Room, s: { questions: SurveyQuestion[]; by: string; campaignId?: string }) {
  await requireFeature(room, 'surveys');
  return (await createInAllChannels(room.id, { senderName: s.by, contentType: 'SURVEY', payload: { questions: s.questions.slice(0, 4), by: s.by, campaignId: s.campaignId ?? null } }))[0];
}
export async function answerSurvey(room: Room, m: Member, messageId: string, answers: unknown[]) {
  const msg = await prisma.message.findUnique({ where: { id: messageId } });
  if (!msg || msg.contentType !== 'SURVEY') throw new ApiError('not_found', 'Survey not found.');
  await prisma.surveyResponse.upsert({ where: { messageId_memberId: { messageId, memberId: m.id } }, create: { messageId, memberId: m.id, answers: answers as object }, update: { answers: answers as object } });
  await prisma.reaction.upsert({ where: { messageId_memberId_key: { messageId, memberId: m.id, key: 'survey:done' } }, create: { messageId, memberId: m.id, key: 'survey:done' }, update: {} });
  const cid = (msg.payload as any).campaignId as string | null;
  if (cid) await prisma.campaign.update({ where: { id: cid }, data: { responses: { increment: 1 } } }).catch(() => {});
  await emitReactions(messageId);
  await emitEvent(room.tenantId, room.id, 'survey.response', { room_id: room.id, survey_message_id: messageId, member_id: m.id, answers, campaign_id: cid });
}

export const newSurveyId = () => newId('srv');
