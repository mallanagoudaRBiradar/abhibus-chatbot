import type { Room, Vertical as DbVertical, RoomState } from '@prisma/client';
import { toRef } from '../shared/refs';
import { z } from 'zod';
import { prisma } from '../db';
import { ApiError } from '../lib/errors';
import { newId } from '../lib/ids';
import { getTenant, roomFeatures } from './tenants';
import { emitEvent } from './events';
import type { JourneyInfo, Vertical } from '../shared/protocol';

// ------------------------------------------------------------------ input --
export const StopZ = z.object({
  code: z.string().min(1).max(12),
  name: z.string().min(1).max(80),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  sched_arr: z.string().datetime({ offset: true }).optional(),
  sched_dep: z.string().datetime({ offset: true }).optional(),
  type: z.string().max(20).optional(), // boarding | dropping | rest_stop | halt
  terminal: z.string().max(8).optional(),
  gate: z.string().max(8).optional(),
  day: z.number().int().optional(),
});
export type Stop = z.infer<typeof StopZ>;

export const RoomUpsertZ = z.object({
  vertical: z.enum(['bus', 'train', 'flight', 'custom']),
  title: z.string().min(1).max(120),
  subtitle: z.string().max(160).optional(),
  scope: z.record(z.any()),
  schedule: z.object({ departs_at: z.string().datetime({ offset: true }), arrives_at: z.string().datetime({ offset: true }) }),
  route: z.object({ stops: z.array(StopZ).min(2).max(80) }),
  activation: z.object({ mode: z.enum(['always', 'on_delay']), min_delay_min: z.number().int().min(0).max(1440).default(45) }).optional(),
  features: z.record(z.boolean()).optional(),
  location_feed: z.enum(['none', 'vts', 'running_status', 'flight_status']).optional(),
  locale: z.string().max(10).optional(),
  metadata: z.record(z.any()).optional(),
});
export type RoomUpsert = z.infer<typeof RoomUpsertZ>;

// ---------------------------------------------------------------- timings --
const MIN = 60_000;
/** opens_at = departure − open_before; read_only_at = arrival (+delay); closed after the read-only window; purged N days later. */
export function timings(departs: Date, arrives: Date, delayMin: number, t: { open_before_min: number; readonly_after_min: number; purge_days: number }) {
  const opensAt = new Date(+departs - t.open_before_min * MIN);
  const readOnlyAt = new Date(+arrives + delayMin * MIN);
  const closesAt = new Date(+readOnlyAt + t.readonly_after_min * MIN);
  const purgeAt = new Date(+closesAt + t.purge_days * 24 * 60 * MIN);
  return { opensAt, readOnlyAt, closesAt, purgeAt };
}

export const stopsOf = (r: Pick<Room, 'stops'>) => (r.stops as Stop[]) ?? [];
const schedOf = (s: Stop) => Date.parse(s.sched_arr ?? s.sched_dep ?? '');
/** Scheduled + delay, per stop (arrival if known, else departure). */
export function etaOf(r: Pick<Room, 'stops' | 'delayMin'>, i: number) {
  const s = stopsOf(r)[i];
  const t = schedOf(s);
  return Number.isFinite(t) ? new Date(t + r.delayMin * MIN) : null;
}

/** Fraction of the route covered by the timetable (shifted by the delay), in stop units. */
export function timetablePos(r: Pick<Room, 'stops' | 'delayMin' | 'departsAt' | 'arrivesAt'>, now = Date.now()) {
  const stops = stopsOf(r);
  const pts: [number, number][] = [];
  stops.forEach((s, i) => {
    const a = Date.parse(s.sched_arr ?? s.sched_dep ?? '');
    const d = Date.parse(s.sched_dep ?? s.sched_arr ?? '');
    if (Number.isFinite(a)) pts.push([a, i]);
    if (Number.isFinite(d) && d !== a) pts.push([d, i]);
  });
  if (pts.length < 2) {
    const f = (now - (+r.departsAt + r.delayMin * MIN)) / (+r.arrivesAt - +r.departsAt);
    return Math.max(0, Math.min(1, f)) * (stops.length - 1);
  }
  const t = now - r.delayMin * MIN;
  if (t <= pts[0][0]) return 0;
  for (let k = 0; k < pts.length - 1; k++) {
    const [ta, ia] = pts[k], [tb, ib] = pts[k + 1];
    if (t >= ta && t <= tb) return tb === ta ? ib : ia + ((ib - ia) * (t - ta)) / (tb - ta);
  }
  return stops.length - 1;
}

export function placeLabel(r: Pick<Room, 'stops'>, pos: number) {
  const s = stopsOf(r), i = Math.floor(pos), f = pos - i, last = s.length - 1;
  if (i >= last) return `at ${s[last].name}`;
  if (f < 0.12) return `${pos === i ? 'at' : 'near'} ${s[i].name}`;
  if (f > 0.88) return `near ${s[i + 1].name}`;
  return `between ${s[i].name} and ${s[i + 1].name}`;
}
export const nextIdx = (r: Pick<Room, 'stops'>, pos: number) => Math.min(stopsOf(r).length - 1, Math.floor(pos + 1e-9) + 1);

export const fmtTime = (d: Date | null) => {
  if (!d) return '—';
  const ist = new Date(+d + 330 * MIN);
  let h = ist.getUTCHours(); const m = ist.getUTCMinutes(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ap}`;
};

// ----------------------------------------------------------------- upsert --
/**
 * PUT /v1/rooms/by-key/{trip_key}. Idempotent: first call creates, later calls
 * return (and refresh schedule/stops/title). Same key + different vertical = conflict.
 */
export async function upsertRoom(tenantId: string, tripKey: string, input: RoomUpsert, actor: string) {
  const { t, cfg } = await getTenant(tenantId);
  if (!t.verticals.includes(input.vertical as DbVertical) && input.vertical !== 'custom')
    throw new ApiError('invalid_request', `Tenant ${tenantId} isn’t set up for ${input.vertical} rooms.`);
  const departs = new Date(input.schedule.departs_at), arrives = new Date(input.schedule.arrives_at);
  if (+arrives <= +departs) throw new ApiError('invalid_request', 'schedule.arrives_at must be after departs_at.');

  const existing = await prisma.room.findUnique({ where: { tenantId_tripKey: { tenantId, tripKey } } });
  if (existing && existing.vertical !== input.vertical) throw new ApiError('trip_key_conflict', `trip_key already used by a ${existing.vertical} room.`);
  const tm = timings(departs, arrives, existing?.delayMin ?? 0, cfg.timing);
  const parentKey = typeof input.scope.parent_trip_key === 'string' ? input.scope.parent_trip_key : null;
  const parent = parentKey ? await prisma.room.findUnique({ where: { tenantId_tripKey: { tenantId, tripKey: parentKey } } }) : null;
  const data = {
    vertical: input.vertical as DbVertical, title: input.title, subtitle: input.subtitle ?? '', scope: input.scope,
    departsAt: departs, arrivesAt: arrives, stops: input.route.stops, activation: input.activation ?? undefined,
    features: input.features ?? undefined, locationFeed: input.location_feed ?? 'none', locale: input.locale ?? 'en-IN',
    metadata: input.metadata ?? undefined, opensAt: tm.opensAt, readOnlyAt: tm.readOnlyAt, purgeAt: tm.purgeAt,
    parentRoomId: parent?.id ?? null,
  };
  if (existing) {
    const room = await prisma.room.update({ where: { id: existing.id }, data });
    return { room, created: false };
  }
  const initial: RoomState = input.activation?.mode === 'on_delay' ? 'dormant' : 'scheduled';
  const room = await prisma.room.create({ data: { id: newId('room', 8), tenantId, tripKey, ...data, state: initial } });
  await prisma.channel.create({ data: { roomId: room.id, kind: 'MAIN' } });
  if ((await roomFeatures(room)).women_channel) await prisma.channel.create({ data: { roomId: room.id, kind: 'WOMEN' } });
  await emitEvent(tenantId, room.id, 'room.created', { room_id: room.id, trip_key: tripKey, vertical: room.vertical, state: room.state, actor });
  return { room, created: true };
}

/** API representation (Developer portal → Rooms). */
export async function roomDto(r: Room, extra: Record<string, unknown> = {}) {
  const memberCount = await prisma.member.count({ where: { roomId: r.id, removedAt: null, role: 'traveller' } });
  return {
    id: r.id, ref: toRef(r.id), trip_key: r.tripKey, vertical: r.vertical, state: r.state, title: r.title, subtitle: r.subtitle, scope: r.scope,
    schedule: { departs_at: r.departsAt.toISOString(), arrives_at: r.arrivesAt.toISOString() },
    delay_min: r.delayMin, breakdown: r.breakdown, ops_only: r.opsOnly, slow_mode: r.slowMode, meta: r.meta,
    activation: r.activation, location_feed: r.locationFeed, parent_room_id: r.parentRoomId,
    opens_at: r.opensAt.toISOString(), read_only_at: r.readOnlyAt.toISOString(), purge_at: r.purgeAt.toISOString(),
    member_count: memberCount, ...extra,
  };
}

/** What the chat screen shows about the trip. */
export async function journeyInfo(r: Room, member?: { segmentFrom: string | null; segmentTo: string | null }): Promise<JourneyInfo> {
  const { t } = await getTenant(r.tenantId);
  const stops = stopsOf(r);
  const memberCount = await prisma.member.count({ where: { roomId: r.id, removedAt: null, role: 'traveller' } });
  return {
    tenantId: t.id, tenantName: t.name, vertical: r.vertical as Vertical, state: r.state, subtitle: r.subtitle,
    delayMin: r.delayMin, opsOnly: r.opsOnly, slowMode: r.slowMode, meta: (r.meta ?? {}) as Record<string, string>,
    stops: stops.map((s, i) => ({ code: s.code, name: s.name, eta: etaOf(r, i)?.toISOString() ?? '', type: s.type })),
    boardingCode: member?.segmentFrom ?? stops[0]?.code ?? null, dropCode: member?.segmentTo ?? stops[stops.length - 1]?.code ?? null,
    opensAt: r.opensAt.toISOString(), readOnlyAt: r.readOnlyAt.toISOString(),
    journeyId: r.id, busNumber: String((r.meta as any)?.vehicle_no ?? (r.scope as any)?.vehicle_no ?? (r.scope as any)?.train_no ?? (r.scope as any)?.flight_no ?? ''),
    operatorName: String((r.scope as any)?.operator_name ?? (r.scope as any)?.train_name ?? (r.scope as any)?.carrier ?? t.name),
    routeName: r.title, sourceCity: stops[0]?.name ?? '', destinationCity: stops[stops.length - 1]?.name ?? '',
    startTime: r.departsAt.toISOString(), estimatedEndTime: new Date(+r.arrivesAt + r.delayMin * MIN).toISOString(),
    status: r.state === 'onboard' ? 'IN_TRANSIT' : r.state === 'read_only' ? 'ARRIVED' : r.state === 'closed' ? 'PURGED' : 'SCHEDULED',
    purgeAt: r.purgeAt.toISOString(), totalSeatsBooked: memberCount,
  };
}

export async function getRoomForTenant(tenantId: string, roomId: string) {
  const r = await prisma.room.findUnique({ where: { id: roomId } });
  if (!r || r.tenantId !== tenantId) throw new ApiError('not_found', `Room ${roomId} not found.`);
  return r;
}
