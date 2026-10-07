import type { Campaign, Room } from '@prisma/client';
import { prisma } from '../db';
import { createMessage } from './messages';
import { emitEvent } from './events';
import { getTenant, isQuiet, roomFeatures } from './tenants';
import { etaOf, stopsOf, timetablePos } from './rooms';
import { startGame } from './games';
import { logger } from '../lib/logger';
import type { FeatureKey } from '../shared/tenantConfig';
import { strs } from '../lib/json';

const MIN = 60_000;
const FEATURE_FOR: Record<Campaign['format'], FeatureKey> = { card: 'ads', stop_offer: 'ads', sponsored_poll: 'polls', sponsored_game: 'games', survey: 'surveys' };
export const FORMAT_LABEL: Record<Campaign['format'], string> = { card: 'Sponsored card', sponsored_poll: 'Sponsored poll', sponsored_game: 'Sponsored game', stop_offer: 'Stop offer', survey: 'Research survey' };

/** Route identifiers a campaign can target: route name, train no, flight no, title. */
const routeKeys = (r: Room) => {
  const s = (r.scope ?? {}) as Record<string, unknown>;
  return [s.route, s.route_code, s.train_no, s.flight_no && `${s.carrier ?? ''}${s.flight_no}`, s.operator_id, r.title].filter(Boolean).map(String);
};

/**
 * Can this campaign be shown in this room right now? Returns the first rule
 * that blocks it, so Marketing sees exactly why it was held back.
 * Surveys are research, not ads: they skip frequency limits but respect quiet hours and stage.
 */
export async function adCheck(r: Room, c: Campaign): Promise<{ ok: true } | { ok: false; why: string }> {
  const { cfg } = await getTenant(r.tenantId);
  const f = await roomFeatures(r);
  if (!f[FEATURE_FOR[c.format]]) return { ok: false, why: `${FEATURE_FOR[c.format]} turned off for this tenant` };
  if (c.status !== 'live') return { ok: false, why: 'campaign not live' };
  const now = Date.now();
  if ((c.startsAt && +c.startsAt > now) || (c.endsAt && +c.endsAt < now)) return { ok: false, why: 'outside campaign dates' };
  if (c.capImpressions && c.impressions >= c.capImpressions) return { ok: false, why: 'impression cap reached' };
  const tenantIds = strs(c.tenantIds), routes = strs(c.routes);
  if (tenantIds.length && !tenantIds.includes(r.tenantId)) return { ok: false, why: 'tenant not targeted' };
  if (!strs(c.verticals).includes(r.vertical)) return { ok: false, why: 'vertical not targeted' };
  if (routes.length && !routeKeys(r).some((k) => routes.includes(k))) return { ok: false, why: 'route not targeted' };
  if (!strs(c.stages).includes(r.state)) return { ok: false, why: `room stage ${r.state}` };
  const isAd = c.format !== 'survey';
  if (isQuiet(cfg) && isAd) return { ok: false, why: 'quiet hours' };
  if (isAd) {
    if (r.breakdown) return { ok: false, why: 'breakdown in progress' };
    if (r.lastAlertAt && now - +r.lastAlertAt < cfg.ads.block_after_alert_min * MIN) return { ok: false, why: `Ops alert in last ${cfg.ads.block_after_alert_min} min` };
    if (r.lastAdAt && now - +r.lastAdAt < cfg.ads.gap_min * MIN) return { ok: false, why: `1 ad per ${cfg.ads.gap_min} min` };
    if (r.adCount >= cfg.ads.max_per_trip) return { ok: false, why: `max ${cfg.ads.max_per_trip} per trip` };
  }
  if (c.format === 'stop_offer') {
    const stops = stopsOf(r);
    const i = stops.findIndex((s) => strs(c.stops).some((x) => x.toLowerCase() === s.name.toLowerCase() || x === s.code));
    if (i < 0) return { ok: false, why: 'stop not on route' };
    const eta = etaOf(r, i);
    const pos = timetablePos(r);
    if (pos > i + 0.01) return { ok: false, why: `already passed ${stops[i].name}` };
    if (eta && (+eta - now) / MIN > 60) return { ok: false, why: `more than 60 min from ${stops[i].name}` };
  }
  return { ok: true };
}

/** Deliver (or log why not). One delivery per campaign per room. */
export async function deliver(r: Room, c: Campaign, opts: { force?: boolean } = {}) {
  const already = await prisma.campaignDelivery.findFirst({ where: { campaignId: c.id, roomId: r.id, ok: true } });
  if (already) return { ok: false, why: 'already delivered to this room' };
  const chk = await adCheck(r, c);
  if (!chk.ok) {
    const last = await prisma.campaignDelivery.findFirst({ where: { campaignId: c.id, roomId: r.id }, orderBy: { createdAt: 'desc' } });
    if (opts.force || last?.reason !== chk.why) await prisma.campaignDelivery.create({ data: { campaignId: c.id, roomId: r.id, ok: false, reason: chk.why } });
    return chk;
  }
  const cr = c.creative as { title?: string; body?: string; cta?: string; tile?: string; coupon?: string };
  let messageId: string;
  if (c.format === 'sponsored_poll') {
    const p = c.poll as { q: string; opts: string[] };
    messageId = (await createMessage(r.id, 'MAIN_COMMON', { senderName: c.advertiser, contentType: 'POLL', payload: { question: p.q, options: p.opts, multi: false, by: c.advertiser, sponsored: true, campaignId: c.id } })).id;
  } else if (c.format === 'survey') {
    const s = c.survey as { questions: object[] };
    messageId = (await createMessage(r.id, 'MAIN_COMMON', { senderName: c.advertiser, contentType: 'SURVEY', payload: { questions: s.questions, by: c.advertiser, campaignId: c.id } })).id;
  } else if (c.format === 'sponsored_game') {
    messageId = (await startGame(r, 'MAIN_COMMON', null, 'QUIZ', undefined, c.advertiser)).id;
  } else {
    const stop = c.format === 'stop_offer' ? stopsOf(r).find((s) => strs(c.stops).some((x) => x.toLowerCase() === s.name.toLowerCase() || x === s.code))?.name ?? null : null;
    messageId = (await createMessage(r.id, 'MAIN_COMMON', { senderName: c.advertiser, contentType: 'AD', payload: { campaignId: c.id, advertiser: c.advertiser, format: c.format, title: cr.title ?? c.name, body: cr.body ?? '', cta: cr.cta ?? 'Open', tile: cr.tile ?? '#2b9d74', stop, coupon: cr.coupon ?? null } })).id;
  }
  const members = await prisma.member.count({ where: { roomId: r.id, removedAt: null, role: 'traveller' } });
  await prisma.campaignDelivery.create({ data: { campaignId: c.id, roomId: r.id, ok: true, reason: 'delivered', messageId } });
  await prisma.campaign.update({ where: { id: c.id }, data: { impressions: { increment: members } } });
  if (c.format !== 'survey') await prisma.room.update({ where: { id: r.id }, data: { adCount: { increment: 1 }, lastAdAt: new Date() } });
  await emitEvent(r.tenantId, r.id, c.format === 'survey' ? 'survey.delivered' : 'ad.delivered', { room_id: r.id, campaign_id: c.id, campaign: c.name, advertiser: c.advertiser, format: c.format, impressions: members });
  return { ok: true as const, messageId };
}

/** Background: every minute, offer each live campaign to each active room. */
export async function campaignTick() {
  const campaigns = await prisma.campaign.findMany({ where: { status: 'live' } });
  if (!campaigns.length) return;
  const rooms = await prisma.room.findMany({ where: { state: { in: ['open', 'onboard', 'read_only'] } } });
  for (const r of rooms) for (const c of campaigns) {
    try { const res = await deliver(r, c); if (res.ok) break; } // at most one new item per room per tick
    catch (err) { logger.warn({ err, room: r.id, campaign: c.id }, 'delivery failed'); }
  }
}

export async function adClick(roomId: string, memberId: string, messageId: string) {
  const msg = await prisma.message.findUnique({ where: { id: messageId } });
  const cid = (msg?.payload as any)?.campaignId as string | undefined;
  if (!msg || !cid) return { coupon: null };
  const had = await prisma.reaction.findUnique({ where: { messageId_memberId_key: { messageId, memberId, key: 'ad:clicked' } } });
  if (!had) {
    await prisma.reaction.create({ data: { messageId, memberId, key: 'ad:clicked' } });
    await prisma.campaign.update({ where: { id: cid }, data: { clicks: { increment: 1 } } }).catch(() => {});
    const room = await prisma.room.findUniqueOrThrow({ where: { id: roomId } });
    await emitEvent(room.tenantId, roomId, 'ad.clicked', { room_id: roomId, campaign_id: cid, member_id: memberId });
  }
  return { coupon: (msg.payload as any).coupon ?? `TRIP-${cid.slice(-4).toUpperCase()}` };
}
