import { z } from 'zod';
import type { Room } from '@prisma/client';
import { prisma } from '../db';
import { ApiError } from '../lib/errors';
import { newId } from '../lib/ids';
import { postAlert, broadcastRoomUpdate } from './alerts';
import { emitEvent } from './events';
import { createInAllChannels } from './messages';
import { estimate } from './location';
import { etaOf, fmtTime, nextIdx, stopsOf, timetablePos, timings } from './rooms';
import { getTenant, roomFeatures } from './tenants';
import { templateFor } from '../shared/verticals';
import { UNIT } from '../shared/verticals';
import { toRef } from '../shared/refs';

const BUS = ['delay', 'breakdown', 'vehicle_swap', 'boarding_point_change', 'stop_arrived', 'rest_stop_started', 'cancelled', 'diverted', 'resolved'] as const;
const TRAIN = ['delay', 'platform_change', 'coach_position', 'stop_arrived', 'charting_done', 'cancelled', 'diverted', 'rescheduled'] as const;
const FLIGHT = ['delay', 'gate_change', 'boarding_started', 'gate_closed', 'departed', 'landed', 'baggage_belt', 'cancelled', 'diverted'] as const;
export const EVENT_TYPES = { bus: BUS, train: TRAIN, flight: FLIGHT, custom: ['delay', 'cancelled'] } as const;

export const TripEventZ = z.object({
  type: z.string(),
  minutes: z.number().int().min(-600).max(1440).optional(),
  at_stop: z.string().max(12).optional(),
  station: z.string().max(12).optional(),
  platform: z.string().max(8).optional(),
  coach: z.string().max(8).optional(),
  gate: z.string().max(8).optional(),
  terminal: z.string().max(8).optional(),
  belt: z.string().max(8).optional(),
  vehicle_no: z.string().max(20).optional(),
  boarding: z.string().max(80).optional(),
  reason: z.string().max(200).optional(),
  auto_announce: z.boolean().default(true),
  channels: z.array(z.enum(['push', 'sms', 'whatsapp'])).optional(),
});
export type TripEventIn = z.infer<typeof TripEventZ>;

/**
 * The main way tenants keep a room accurate. Updates room facts, optionally
 * posts a templated, pinned alert (English + Hindi), logs the event and emits
 * `trip_event.<type>`.
 */
export async function applyTripEvent(room: Room, ev: TripEventIn, actor: string, opts: { dryRun?: boolean } = {}) {
  const allowed = (EVENT_TYPES as any)[room.vertical] as readonly string[];
  if (!allowed.includes(ev.type)) throw new ApiError('invalid_request', `type "${ev.type}" isn’t valid for a ${room.vertical} room. Use one of: ${allowed.join(', ')}.`);
  const { cfg } = await getTenant(room.tenantId);
  const meta = { ...((room.meta ?? {}) as Record<string, string>) };
  const patch: Partial<Room> = {};
  let r = room;

  switch (ev.type) {
    case 'delay': patch.delayMin = Math.max(0, room.delayMin + (ev.minutes ?? 0)); break;
    case 'breakdown': patch.breakdown = true; break;
    case 'resolved': patch.breakdown = false; break;
    case 'vehicle_swap': if (ev.vehicle_no) meta.vehicle_no = ev.vehicle_no; patch.breakdown = false; break;
    case 'platform_change': if (ev.platform) meta.platform = ev.platform; break;
    case 'coach_position': if (ev.coach) meta.coach = ev.coach; break;
    case 'gate_change': if (ev.gate) meta.gate = ev.gate; if (ev.terminal) meta.terminal = ev.terminal; break;
    case 'baggage_belt': if (ev.belt) meta.belt = ev.belt; break;
    case 'boarding_started': meta.boarding = 'started'; break;
    case 'gate_closed': meta.boarding = 'closed'; break;
    case 'departed': patch.state = 'onboard'; break;
    case 'landed': patch.state = 'read_only'; break;
    case 'cancelled': patch.state = 'read_only'; break;
  }
  patch.meta = meta as any;
  if (patch.delayMin !== undefined) Object.assign(patch, (({ readOnlyAt, purgeAt }) => ({ readOnlyAt, purgeAt }))(timings(room.departsAt, room.arrivesAt, patch.delayMin!, cfg.timing)));

  // Dry run: what would change and what travellers would read. Nothing is saved or sent.
  if (opts.dryRun) {
    const next = { ...room, ...patch } as Room;
    return { dry_run: true as const, changes: describeChanges(room, next), announcement: ev.auto_announce ? await announcementFor(next, ev, meta) : null };
  }

  r = await prisma.room.update({ where: { id: room.id }, data: patch as any });

  const id = newId('evt');
  await prisma.tripEvent.create({ data: { id, roomId: room.id, type: ev.type, data: ev as object, actor } });

  let announcementId: string | null = null;
  const ann = ev.auto_announce ? await announcementFor(r, ev, meta) : null;
  if (ann) {
    const res = await postAlert(r, {
      text: ann.text, severity: ann.severity, translations: ann.hi ? { hi: ann.hi } : {},
      channels: { push: !ev.channels || ev.channels.includes('push'), sms: ev.channels?.includes('sms'), whatsapp: ev.channels?.includes('whatsapp') },
    }, actor);
    announcementId = res.id;
  }
  if (ev.type === 'rest_stop_started' && (await roomFeatures(r)).rest_stop) {
    const mins = ev.minutes ?? 20;
    const stopName = ev.at_stop ? stopsOf(r).find((s) => s.code === ev.at_stop)?.name ?? ev.at_stop : (await estimate(r)).near.replace(/^(at|near) /, '');
    await createInAllChannels(r.id, { senderName: 'Ops', contentType: 'TIMER', payload: { stop: stopName, leaveAt: new Date(Date.now() + mins * 60_000).toISOString(), startedAt: new Date().toISOString() } });
  }
  if (ev.type === 'stop_arrived') await createInAllChannels(r.id, { senderName: 'System', contentType: 'SYSTEM', payload: { text: `${UNIT[r.vertical].unit} reached ${stopsOf(r).find((s) => s.code === (ev.at_stop ?? ev.station))?.name ?? ev.at_stop ?? ev.station}.` } });

  await emitEvent(r.tenantId, r.id, `trip_event.${ev.type}`, { room_id: r.id, event_id: id, ...ev, delay_min: r.delayMin, meta: r.meta, actor });
  await broadcastRoomUpdate(r.id);
  const eta: Record<string, string> = {};
  stopsOf(r).forEach((s, i) => { const e = etaOf(r, i); if (e) eta[s.code] = e.toISOString(); });
  return { event_id: id, ref: toRef(id), applied: { delay_min: r.delayMin, breakdown: r.breakdown, state: r.state, meta: r.meta, eta }, announcement_id: announcementId };
}

/** The standard alert (English + Hindi) a trip event posts, worded for the room's state after the event. */
async function announcementFor(r: Room, ev: TripEventIn, meta: Record<string, string>) {
  const tpl = templateFor(ev.type === 'rest_stop_started' ? 'rest_stop' : ev.type, r.vertical as any);
  if (!tpl) return null;
  const pos = timetablePos(r);
  const ni = r.vertical === 'flight' ? 0 : nextIdx(r, pos);
  const stops = stopsOf(r);
  const loc = await estimate(r);
  const ctx = {
    unit: UNIT[r.vertical].unit, minutes: ev.minutes, delay: r.delayMin, nextStop: stops[ni]?.name, newTime: fmtTime(etaOf(r, ni)),
    place: loc.near, platform: meta.platform, coach: meta.coach, gate: meta.gate, terminal: meta.terminal, belt: meta.belt,
    stop: ev.at_stop ? stops.find((s) => s.code === ev.at_stop)?.name ?? ev.at_stop : stops[ni]?.name,
    flightNo: String((r.scope as any).carrier ?? '') + String((r.scope as any).flight_no ?? ''), reason: ev.reason, boarding: ev.boarding,
  };
  return { text: tpl.en(ctx), hi: tpl.hi?.(ctx) ?? null, severity: ev.type === 'delay' && (ev.minutes ?? 0) < 0 ? 'info' as const : tpl.severity };
}

const STATE_WORD: Record<string, string> = { scheduled: 'Scheduled', dormant: 'Dormant', open: 'Waiting to board', onboard: 'On the way', read_only: 'Read-only (trip over)', closed: 'Closed' };
/** Plain-language list of what an event changes, for the console's review step. */
function describeChanges(a: Room, b: Room) {
  const out: string[] = [];
  if (a.delayMin !== b.delayMin) out.push(b.delayMin ? `Delay ${a.delayMin} → ${b.delayMin} min; every stop's ETA moves by ${b.delayMin - a.delayMin > 0 ? '+' : ''}${b.delayMin - a.delayMin} min` : `Delay cleared (was ${a.delayMin} min); ETAs back to timetable`);
  if (a.breakdown !== b.breakdown) out.push(b.breakdown ? 'Marked as broken down: ads pause, the room shows a breakdown banner' : 'Breakdown cleared');
  if (a.state !== b.state) out.push(`Room status ${STATE_WORD[a.state] ?? a.state} → ${STATE_WORD[b.state] ?? b.state}${b.state === 'read_only' ? '; travellers can read but no longer post' : ''}`);
  const am = (a.meta ?? {}) as Record<string, string>, bm = (b.meta ?? {}) as Record<string, string>;
  const LABEL: Record<string, string> = { vehicle_no: 'Vehicle number', platform: 'Platform', coach: 'Coach position', gate: 'Gate', terminal: 'Terminal', belt: 'Baggage belt', boarding: 'Boarding' };
  for (const k of Object.keys(LABEL)) if ((am[k] ?? '') !== (bm[k] ?? '')) out.push(`${LABEL[k]} ${am[k] ? `${am[k]} → ` : 'set to '}${bm[k]}`);
  return out;
}
