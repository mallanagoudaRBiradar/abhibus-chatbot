import { z } from 'zod';
import { pollSummary, surveySummary } from '../core/responses';
import { toRef } from '../shared/refs';
import type { Campaign } from '@prisma/client';
import { prisma } from '../db';
import { ApiError } from '../lib/errors';
import { newId } from '../lib/ids';
import { emitEvent } from '../core/events';
import { audit } from '../core/audit';
import { FORMAT_LABEL } from '../core/ads';

export const CampaignZ = z.object({
  name: z.string().min(1).max(80),
  advertiser: z.string().min(1).max(80),
  format: z.enum(['card', 'sponsored_poll', 'sponsored_game', 'stop_offer', 'survey']),
  status: z.enum(['draft', 'live', 'paused']).default('live'),
  creative: z.object({ title: z.string().max(60).optional(), body: z.string().max(70).optional(), cta: z.string().max(24).optional(), tile: z.string().max(9).optional(), coupon: z.string().max(24).optional() }).default({}),
  poll: z.object({ q: z.string().min(1).max(200), opts: z.array(z.string().min(1).max(60)).min(2).max(4) }).optional(),
  survey: z.object({ questions: z.array(z.object({ type: z.enum(['rating', 'choice', 'text']), q: z.string().min(1).max(200), options: z.array(z.string().max(60)).max(6).optional() })).min(1).max(4) }).optional(),
  targeting: z.object({
    tenants: z.array(z.string()).optional(),
    verticals: z.array(z.enum(['bus', 'train', 'flight'])).min(1),
    routes: z.array(z.string()).optional(),
    stops: z.array(z.string()).optional(),
    stages: z.array(z.enum(['open', 'onboard', 'read_only'])).min(1),
  }),
  schedule: z.object({ start: z.string().optional(), end: z.string().optional() }).optional(),
  cap: z.object({ impressions: z.number().int().min(1) }).optional(),
});

export async function campaignCreate(body: unknown, allowedTenants: string[] | null, actor: string) {
  const b = CampaignZ.parse(body);
  if (b.format === 'sponsored_poll' && !b.poll) throw new ApiError('invalid_request', 'A sponsored poll needs poll.q and 2–4 poll.opts.');
  if (b.format === 'survey' && !b.survey) throw new ApiError('invalid_request', 'A survey needs survey.questions.');
  if ((b.format === 'card' || b.format === 'stop_offer') && !b.creative.title) throw new ApiError('invalid_request', 'Add creative.title for the card.');
  if (b.format === 'stop_offer' && !b.targeting.stops?.length) throw new ApiError('invalid_request', 'A stop offer needs targeting.stops.');
  const tenants = b.targeting.tenants ?? [];
  if (allowedTenants && tenants.some((t) => !allowedTenants.includes(t))) throw new ApiError('forbidden', 'You can only target your own tenants.');
  const row = await prisma.campaign.create({
    data: {
      id: newId('cmp', 6), name: b.name, advertiser: b.advertiser, format: b.format, status: b.status, creative: b.creative, poll: b.poll ?? undefined, survey: b.survey ?? undefined,
      tenantIds: allowedTenants && !tenants.length ? allowedTenants : tenants, verticals: b.targeting.verticals, routes: b.targeting.routes ?? [], stops: b.targeting.stops ?? [], stages: b.targeting.stages,
      startsAt: b.schedule?.start ? new Date(b.schedule.start) : null, endsAt: b.schedule?.end ? new Date(b.schedule.end) : null, capImpressions: b.cap?.impressions ?? null, createdBy: actor,
    },
  });
  await audit({ actor, action: 'campaign.created', targetId: row.id, data: { name: row.name } });
  await emitEvent(null, null, 'campaign.created', { campaign_id: row.id, ref: toRef(row.id), name: row.name, status: row.status, actor });
  return campaignDto(row);
}

export const campaignDto = (c: Campaign) => ({
  id: c.id, ref: toRef(c.id), name: c.name, advertiser: c.advertiser, format: c.format, format_label: FORMAT_LABEL[c.format], status: c.status,
  creative: c.creative, poll: c.poll, survey: c.survey,
  targeting: { tenants: c.tenantIds, verticals: c.verticals, routes: c.routes, stops: c.stops, stages: c.stages },
  schedule: { start: c.startsAt?.toISOString() ?? null, end: c.endsAt?.toISOString() ?? null }, cap: c.capImpressions,
  stats: { impressions: c.impressions, clicks: c.clicks, responses: c.responses, ctr: c.impressions ? +(c.clicks * 100 / c.impressions).toFixed(2) : 0 },
  created_by: c.createdBy, created_at: c.createdAt.toISOString(),
});

export async function campaignStats(id: string, allowedTenants: string[] | null) {
  const c = await prisma.campaign.findUnique({ where: { id } });
  if (!c || (allowedTenants && c.tenantIds.length && !c.tenantIds.some((t) => allowedTenants.includes(t)))) throw new ApiError('not_found', 'Campaign not found.');
  const held = await prisma.campaignDelivery.groupBy({ by: ['reason'], where: { campaignId: id, ok: false }, _count: true });
  const delivered = await prisma.campaignDelivery.count({ where: { campaignId: id, ok: true } });
  let results: unknown = null;
  if (c.format === 'sponsored_poll' || c.format === 'survey') {
    const ids = (await prisma.campaignDelivery.findMany({ where: { campaignId: id, ok: true }, select: { messageId: true } })).map((d) => d.messageId!).filter(Boolean);
    // Who answered, what, and the summary (avg rating, spread, vote split), across every room it ran in.
    results = c.format === 'sponsored_poll'
      ? await pollSummary(ids, ((c.poll as any)?.opts ?? []) as string[])
      : await surveySummary(ids, ((c.survey as any)?.questions ?? []) as any[]);
  }
  return { ...campaignDto(c), delivered_rooms: delivered, held_back: Object.fromEntries(held.map((h) => [h.reason, h._count])), results };
}
