import type { Member, Message } from '@prisma/client';
import { prisma } from '../db';
import { display } from './identity';
import { getTenant } from './tenants';
import { toRef } from '../shared/refs';
import { POLL_VOTE_PREFIX } from '../shared/protocol';

/**
 * Who answered a poll or survey, what they said, and the summary a person actually wants
 * (average rating, star spread, vote split). Used by the room view and the campaign page,
 * across every copy of the message (each channel / each room it was delivered to).
 */
type Q = { type: 'rating' | 'choice' | 'text'; q: string; options?: string[] };
export interface Respondent { member_id: string; who: string; via: string; room: { id: string; ref: string; title: string } }

async function respondents(memberIds: string[]): Promise<Map<string, Respondent>> {
  const members = await prisma.member.findMany({ where: { id: { in: [...new Set(memberIds)] } }, include: { room: { select: { id: true, title: true, tenantId: true } } } });
  const out = new Map<string, Respondent>();
  for (const m of members) {
    const { cfg, t } = await getTenant(m.room.tenantId);
    out.set(m.id, {
      member_id: m.id, who: display(m as Member, cfg.identity.mode).name,
      via: m.externalUserId.startsWith('abhibus-app:') ? `${t.name} app` : m.externalUserId.startsWith('dashboard:') ? 'Console preview' : 'Trip chat',
      room: { id: m.room.id, ref: toRef(m.room.id), title: m.room.title },
    });
  }
  return out;
}

export async function surveySummary(messageIds: string[], questions: Q[]) {
  const rows = await prisma.surveyResponse.findMany({ where: { messageId: { in: messageIds } }, orderBy: { createdAt: 'desc' }, take: 500 });
  const who = await respondents(rows.map((r) => r.memberId));
  const answersOf = (i: number) => rows.map((r) => (r.answers as unknown[])?.[i]).filter((a) => a !== undefined && a !== null && a !== '');
  return {
    kind: 'survey' as const,
    total: rows.length,
    questions: questions.map((q, i) => {
      const a = answersOf(i);
      if (q.type === 'rating') {
        const nums = a.map(Number).filter((n) => n >= 1 && n <= 5);
        return { ...q, count: nums.length, avg: nums.length ? +(nums.reduce((s, n) => s + n, 0) / nums.length).toFixed(2) : null, dist: [1, 2, 3, 4, 5].map((s) => nums.filter((n) => n === s).length) };
      }
      if (q.type === 'choice') {
        const opts = q.options ?? ['Yes', 'No', 'Not sure'];
        return { ...q, count: a.length, counts: opts.map((o) => ({ option: o, n: a.filter((x) => x === o).length })) };
      }
      return { ...q, count: a.length, texts: a.map(String).slice(0, 50) };
    }),
    responses: rows.map((r) => ({ ...(who.get(r.memberId) ?? { member_id: r.memberId, who: 'Traveller', via: 'Trip chat', room: null }), answers: r.answers as unknown[], at: r.createdAt.toISOString() })),
  };
}

export async function pollSummary(messageIds: string[], options: string[]) {
  const votes = await prisma.reaction.findMany({ where: { messageId: { in: messageIds }, key: { startsWith: POLL_VOTE_PREFIX } }, orderBy: { createdAt: 'desc' } });
  const who = await respondents(votes.map((v) => v.memberId));
  const voters = new Set(votes.map((v) => v.memberId));
  return {
    kind: 'poll' as const,
    total: voters.size,
    options: options.map((o, i) => {
      const vs = votes.filter((v) => v.key === `${POLL_VOTE_PREFIX}${i}`);
      return { option: o, votes: vs.length, voters: vs.map((v) => ({ ...(who.get(v.memberId) ?? { member_id: v.memberId, who: 'Traveller', via: 'Trip chat', room: null }), at: v.createdAt.toISOString() })) };
    }),
  };
}

/** Every copy of a poll/survey in the same room (alerts and Ops posts go to each channel). */
export async function siblingsOf(m: Message & { channel: { roomId: string } }) {
  const near = { gte: new Date(+m.createdAt - 5000), lte: new Date(+m.createdAt + 5000) };
  const rows = await prisma.message.findMany({ where: { contentType: m.contentType, createdAt: near, channel: { roomId: m.channel.roomId } }, select: { id: true, payload: true } });
  const key = JSON.stringify((m.payload as any)?.question ?? (m.payload as any)?.questions);
  return rows.filter((r) => JSON.stringify((r.payload as any)?.question ?? (r.payload as any)?.questions) === key).map((r) => r.id);
}
