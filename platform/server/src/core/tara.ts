import type { Member, Room } from '@prisma/client';
import { prisma } from '../db';
import { estimate } from './location';
import { etaOf, fmtTime, stopsOf } from './rooms';
import { createMessage } from './messages';
import { emitEvent } from './events';
import { getTenant, roomFeatures } from './tenants';
import { signWebhook } from '../lib/crypto';
import { logger } from '../lib/logger';
import { UNIT } from '../shared/verticals';
import type { RoomType } from '../shared/protocol';

const MIN = 60_000;
const dur = (m: number) => (m < 60 ? `${Math.max(0, Math.round(m))} min` : `${Math.floor(m / 60)} hr${m % 60 ? ` ${Math.round(m % 60)} min` : ''}`);
const QUESTION = /(where|cross|reach|eta|how far|location|platform|gate|catch me up|summar|missed|depart|belt|baggage|refund|cancel|new departure|how long|pantry|dinner|food|meal|voucher|stop|when|time)/i;

/**
 * Should Tara answer this group message? Only when tagged (@Tara) — people ask
 * each other questions and Tara must not hijack the conversation. In a room too
 * small for group chat, any trip question gets an answer.
 */
export async function wantsTara(room: Room, text: string) {
  if (!(await roomFeatures(room)).tara) return false;
  if (/@tara\b/i.test(text)) return true;
  const { cfg } = await getTenant(room.tenantId);
  const members = await prisma.member.count({ where: { roomId: room.id, removedAt: null, role: 'traveller' } });
  return members < cfg.social_min && QUESTION.test(text);
}

/** Rule-based answers grounded in live trip data (location fusion, ETAs, room facts, latest alert). */
export async function answer(room: Room, member: Member | null, text: string): Promise<string> {
  const t = text.toLowerCase().replace(/@tara\b/g, '').trim();
  const loc = await estimate(room);
  const stops = stopsOf(room);
  const meta = (room.meta ?? {}) as Record<string, string>;
  const u = UNIT[room.vertical];
  const target = (() => {
    const code = room.state === 'open' ? member?.segmentFrom : member?.segmentTo;
    const i = stops.findIndex((s) => s.code === code);
    return i >= 0 ? i : room.state === 'open' ? 0 : stops.length - 1;
  })();

  if (/catch me up|summar|missed/.test(t)) return catchUp(room);
  if (room.vertical === 'train' && /platform/.test(t)) return `Platform ${meta.platform ?? 'not announced yet'}${loc.nextStop ? ` at ${loc.nextStop.name}, expected ${fmtTime(new Date(loc.nextStop.eta))}` : ''}.`;
  if (room.vertical === 'train' && /pantry|dinner|food/.test(t)) return 'Pantry orders close after the next station. E-catering is available in your booking app.';
  if (room.vertical === 'flight' && /gate/.test(t)) return `Gate ${meta.gate ?? 'not announced yet'}${meta.terminal ? `, Terminal ${meta.terminal}` : ''}. I’ll post here if it changes.`;
  if (room.vertical === 'flight' && /meal|voucher|food/.test(t)) return 'No meal voucher announcement yet. Ops will post here if the airline confirms.';
  if (room.vertical === 'flight' && /belt|baggage|bag/.test(t)) return meta.belt ? `Belt ${meta.belt}.` : 'The belt is announced after landing. I’ll post it here.';
  if (/refund|cancel/.test(t)) return 'You can see cancellation charges for your ticket in My Trips. Ops can’t change refunds in this room.';
  if (room.breakdown && /where|when|how long|reach|eta|moving|start|breakdown|replacement|alternate/.test(t)) {
    const alert = await prisma.message.findFirst({ where: { channel: { roomId: room.id, kind: 'MAIN' }, contentType: 'ALERT' }, orderBy: { createdAt: 'desc' } });
    return `The ${u.u} has stopped ${loc.near} because of a breakdown. ${alert ? `Latest from Ops: “${(alert.payload as any).text}”` : 'Ops is arranging help and will post here.'}`;
  }
  if (/(rest|washroom|toilet|loo|dinner|lunch|break|halt|dhaba)/.test(t) && room.vertical === 'bus') {
    const i = stops.findIndex((s, k) => s.type === 'rest_stop' && (etaOf(room, k)?.getTime() ?? 0) > Date.now() - 20 * MIN);
    return i >= 0 ? `Next break: ${stops[i].name} around ${fmtTime(etaOf(room, i))}, usually about 20 min.` : 'No more planned breaks on this trip. If you need one, tell the crew or use “Report issue”.';
  }
  if (/(next|which) (stop|station|halt)|stop.*next/.test(t) && room.vertical !== 'flight') {
    return loc.nextStop ? `Next ${room.vertical === 'train' ? 'station' : 'stop'}: ${loc.nextStop.name}, expected ${fmtTime(new Date(loc.nextStop.eta))}. The ${u.u} is ${loc.near}.` : `The ${u.u} is ${loc.near}; no more stops before ${stops[stops.length - 1].name}.`;
  }
  if (room.vertical === 'flight') {
    const dep = new Date(+room.departsAt + room.delayMin * MIN);
    return loc.near === 'in the air'
      ? `We’re in the air, expected at ${stops[stops.length - 1].name} at ${fmtTime(etaOf(room, stops.length - 1))}.`
      : `${room.delayMin ? `Delayed ${room.delayMin} min. ` : ''}New departure ${fmtTime(dep)}${meta.gate ? ` from gate ${meta.gate}` : ''}.`;
  }
  if (QUESTION.test(t)) {
    const eta = etaOf(room, target);
    const mins = eta ? (+eta - Date.now()) / MIN : 0;
    const src = loc.confidence === 'estimated' ? 'No live source right now, so this is an estimate from the timetable.' : `Source: ${loc.source}.`;
    return `The ${u.u} is ${loc.near}. About ${dur(mins)} to ${stops[target].name}. ${src}`;
  }
  return 'I can help with location, ETA, stops, platforms, gates, catch-ups and trip questions. Ask me anything about this trip.';
}

export async function catchUp(room: Room) {
  const recent = await prisma.message.findMany({ where: { channel: { roomId: room.id, kind: 'MAIN' }, visibleTo: null, hidden: false }, orderBy: { createdAt: 'desc' }, take: 40 });
  const chat = recent.filter((m) => m.contentType === 'TEXT').length;
  const alert = recent.find((m) => m.contentType === 'ALERT');
  const loc = await estimate(room);
  return `Catch-up: ${chat} chat message${chat === 1 ? '' : 's'} recently. Latest Ops update: ${alert ? (alert.payload as any).text : 'none yet.'} ${UNIT[room.vertical].unit} is ${loc.near}.`;
}

/** Post Tara's reply; notify any registered bot so an LLM can answer instead/as well. */
export async function replyAsTara(room: Room, rt: RoomType, member: Member | null, question: string, opts: { privateTo?: string } = {}) {
  const text = await answer(room, member, question);
  const msg = await createMessage(room.id, rt, { senderName: 'Tara', contentType: opts.privateTo ? 'PRIVATE' : 'TARA', payload: opts.privateTo ? { text, from: 'Tara' } : { text, source: 'rules' }, visibleTo: opts.privateTo ?? null });
  await emitEvent(room.tenantId, room.id, 'bot.replied', { room_id: room.id, bot: 'tara', question: question.slice(0, 200), answer: text });
  void notifyBots(room, member, question).catch((err) => logger.debug({ err }, 'bot webhook failed'));
  return msg;
}

async function notifyBots(room: Room, member: Member | null, text: string) {
  const bots = await prisma.bot.findMany({ where: { tenantId: room.tenantId, webhookUrl: { not: null } } });
  for (const b of bots) {
    const body = JSON.stringify({ type: 'bot.message_received', bot_id: b.id, room_id: room.id, member_id: member?.id ?? null, text, context: { vertical: room.vertical, state: room.state, delay_min: room.delayMin, meta: room.meta, location: await estimate(room) } });
    await fetch(b.webhookUrl!, { method: 'POST', headers: { 'content-type': 'application/json', 'x-triprooms-signature': signWebhook(b.id, body) }, body, signal: AbortSignal.timeout(4000) }).catch(() => {});
  }
}
