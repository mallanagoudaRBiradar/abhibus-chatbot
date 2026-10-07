import { Prisma, type BusJourney } from '@prisma/client';
import { prisma } from '../db/prisma';
import { retryOnConflict } from '../db/retry';
import { logger } from '../lib/logger';
import { hashPhone, normaliseGender, normalisePnr, normaliseSeat } from '../lib/util';
import { seal } from '../lib/pii';
import { emitPartnerEvent } from '../lib/webhooks';
import { journeyIdFor } from '../booking/types';
import { hub } from '../realtime/hub';
import { S2C } from '../shared/protocol';
import { purgeTimeFor } from './journeyService';
import type { RouteStop } from '../tracking/gpsProvider';

/**
 * ============================================================================
 *  Partner ingestion — the AbhiBus booking system PUSHES data to us.
 * ============================================================================
 *  booking confirmed  -> upsertBooking   (journey created/updated + one row per seat)
 *  booking cancelled  -> cancelBooking   (whole PNR or some seats; live sockets dropped)
 *  schedule change    -> upsertJourney   (delay, bus swap, route)
 *  bus GPS            -> recordFixes     (bulk, every ~30s per bus)
 *
 *  We keep only what the chat and Ops need: PNR, seat, gender, the booking
 *  account id, boarding/dropping points, and (encrypted, Ops-only) the
 *  passenger's name and the booking contact phone. Never ages, emails or
 *  payment data. Everything is hard-deleted with the chat after arrival
 *  (jobs/expirySweeper).
 * ============================================================================
 */
export class IngestError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export interface JourneyInput {
  serviceId: string; journeyDate: string;
  busNumber?: string | null; operatorName?: string | null;
  sourceCity: string; destinationCity: string;
  startTime: Date; estimatedEndTime: Date;
  route?: RouteStop[] | null;
  /** AbhiBus tracking id (track.abhibus.com ?service=…), to match the GPS feed. */
  trackingRef?: string | null;
  /** Bus operator's helpline, offered in the SOS sheet. */
  operatorHelpline?: string | null;
}

/** A boarding or dropping point on one booking. */
export interface PointInput { id?: string | null; name: string; landmark?: string | null; lat?: number | null; lng?: number | null; at?: Date | null }

export interface BookingInput {
  pnr: string;
  status: 'CONFIRMED' | 'CANCELLED';
  channel?: 'OWN' | 'API';
  customerId?: string | null;
  mobile?: string | null;
  journey: JourneyInput;
  seats: { seat: string; gender: string; name?: string | null; status?: 'CONFIRMED' | 'CANCELLED' }[];
  boarding?: PointInput | null;
  dropping?: PointInput | null;
}

function journeyData(j: JourneyInput) {
  return {
    serviceId: j.serviceId, journeyDate: j.journeyDate,
    busNumber: j.busNumber || 'Bus details pending', operatorName: j.operatorName || 'AbhiBus partner',
    routeName: `${j.sourceCity} to ${j.destinationCity}`, sourceCity: j.sourceCity, destinationCity: j.destinationCity,
    startTime: j.startTime, estimatedEndTime: j.estimatedEndTime,
    ...(j.trackingRef ? { trackingRef: j.trackingRef } : {}),
    ...(j.operatorHelpline ? { operatorHelpline: j.operatorHelpline } : {}),
    // An explicit route wins over the one built from passengers' boarding/dropping points.
    ...(j.route !== undefined ? { route: j.route ? (j.route as unknown as Prisma.InputJsonValue) : Prisma.DbNull, routeAuto: !j.route } : {}),
  };
}

/**
 * Create or update a journey. Times can move until arrival; a purged journey is final.
 * `fromBooking`: the journey's times follow its passengers, so the room opens before the
 * EARLIEST boarding and closes after the LATEST drop (refreshFromBookings keeps that exact
 * as people book and cancel). A direct journey update (POST /v1/partner/journeys: delay,
 * reschedule) sets the times explicitly, and bookings stop moving them.
 */
export async function upsertJourney(j: JourneyInput, opts: { fromBooking?: boolean } = {}): Promise<BusJourney> {
  if (+j.estimatedEndTime <= +j.startTime) throw new IngestError(400, 'INVALID', 'estimatedEndTime must be after startTime.');
  const journeyId = journeyIdFor(j.serviceId, j.journeyDate);
  const data = journeyData(j);
  const existing = await prisma.busJourney.findUnique({ where: { journeyId } });
  if (existing?.status === 'PURGED') throw new IngestError(409, 'JOURNEY_CLOSED', `Journey ${journeyId} has ended and its chat was deleted.`);
  if (existing && opts.fromBooking) {
    if (existing.scheduleAuto) {
      data.startTime = new Date(Math.min(+existing.startTime, +j.startTime));
      data.estimatedEndTime = new Date(Math.max(+existing.estimatedEndTime, +j.estimatedEndTime));
    } else {
      data.startTime = existing.startTime; // explicit schedule from the partner wins
      data.estimatedEndTime = existing.estimatedEndTime;
    }
  }
  if (!opts.fromBooking) (data as Record<string, unknown>).scheduleAuto = false;
  if (existing?.status === 'ARRIVED') {
    // After arrival only cosmetic fields may change; the purge clock is already running.
    const { startTime: _s, estimatedEndTime: _e, ...rest } = data;
    return prisma.busJourney.update({ where: { journeyId }, data: rest });
  }
  return retryOnConflict(() => prisma.busJourney.upsert({ where: { journeyId }, create: { journeyId, ...data }, update: data }));
}

/** Drop a seat's live sockets with a reason (cancelled, resold, re-gated). */
function kickSeat(journeyId: string, seat: string, reason: string) {
  hub.emitToSeat(journeyId, seat, S2C.REMOVED, { reason });
  setTimeout(() => hub.io?.in(`s:${journeyId}:${seat}`).disconnectSockets(true), 300);
}

/** A seat changes hands (cancelled or resold): forget everything tied to the previous passenger. */
async function clearSeatState(tx: Prisma.TransactionClient, journeyId: string, seat: string) {
  await tx.seatMute.deleteMany({ where: { journeyId, seatNumber: seat } });
  await tx.seatBlock.deleteMany({ where: { journeyId, OR: [{ blockerSeat: seat }, { blockedSeat: seat }] } });
}

/**
 * Idempotent: the same payload twice is a no-op. Send it on confirmation and
 * again on any change (seat swap, partial cancellation, schedule change).
 */
export async function upsertBooking(b: BookingInput) {
  const pnr = normalisePnr(b.pnr);
  if (b.status === 'CANCELLED') return { journeyId: journeyIdFor(b.journey.serviceId, b.journey.journeyDate), ...(await cancelBooking(pnr)) };

  const journey = await upsertJourney(b.journey, { fromBooking: true });
  const journeyId = journey.journeyId;
  const live = b.seats.filter((s) => s.status !== 'CANCELLED').map((s) => ({ seat: normaliseSeat(s.seat), gender: normaliseGender(s.gender), name: s.name?.trim() || null }));
  if (new Set(live.map((s) => s.seat)).size !== live.length) throw new IngestError(400, 'INVALID', 'Duplicate seat in booking.');
  const phoneHash = hashPhone(b.mobile);
  const contactPhoneEnc = seal(b.mobile?.trim() || null);
  const points = pointColumns(b.boarding, b.dropping);
  const kicks: { seat: string; reason: string }[] = [];

  // Rescheduled to another bus or date (same PNR): it leaves the old journey.
  const moved = await prisma.passengerBooking.findMany({ where: { pnrNumber: pnr, journeyId: { not: journeyId }, journey: { status: { not: 'PURGED' } } } });
  if (moved.length) {
    await prisma.$transaction(async (tx) => {
      for (const r of moved) await clearSeatState(tx, r.journeyId, r.seatNumber);
      await tx.passengerBooking.deleteMany({ where: { id: { in: moved.map((r) => r.id) } } });
    });
    for (const r of moved) if (r.deviceId) kickSeat(r.journeyId, r.seatNumber, 'Your booking moved to another trip. Open trip chat from your updated booking.');
    for (const jid of new Set(moved.map((r) => r.journeyId))) await refreshFromBookings(jid);
  }

  const result = await retryOnConflict(() => prisma.$transaction(async (tx) => {
    kicks.length = 0;
    const current = await tx.passengerBooking.findMany({ where: { journeyId, seatNumber: { in: live.map((s) => s.seat) } } });
    const bySeat = new Map(current.map((r) => [r.seatNumber, r]));
    let added = 0;
    for (const s of live) {
      const row = bySeat.get(s.seat);
      if (row && row.pnrNumber !== pnr) {
        // Seat resold to a new PNR: the previous passenger loses it.
        if (row.deviceId) kicks.push({ seat: s.seat, reason: 'This seat is no longer on your booking.' });
        await clearSeatState(tx, journeyId, s.seat);
        await tx.passengerBooking.delete({ where: { id: row.id } });
      }
      if (!row || row.pnrNumber !== pnr) {
        await tx.passengerBooking.create({ data: { journeyId, seatNumber: s.seat, pnrNumber: pnr, gender: s.gender, channel: b.channel ?? 'OWN', customerId: b.customerId ?? null, phoneHash, contactPhoneEnc, passengerNameEnc: seal(s.name), ...points } });
        added++;
      } else {
        if (row.gender !== s.gender && row.deviceId) kicks.push({ seat: s.seat, reason: 'Your booking details changed. Please rejoin the chat.' });
        await tx.passengerBooking.update({ where: { id: row.id }, data: {
          gender: s.gender, customerId: b.customerId ?? row.customerId, phoneHash: phoneHash ?? row.phoneHash,
          contactPhoneEnc: contactPhoneEnc ?? row.contactPhoneEnc, passengerNameEnc: seal(s.name) ?? row.passengerNameEnc, ...points,
        } });
      }
    }
    // Seats that were on this PNR but are not any more (partial cancellation / seat change).
    const dropped = await tx.passengerBooking.findMany({ where: { journeyId, pnrNumber: pnr, seatNumber: { notIn: live.map((s) => s.seat) } } });
    for (const row of dropped) {
      if (row.deviceId) kicks.push({ seat: row.seatNumber, reason: 'This seat was cancelled on your booking.' });
      await clearSeatState(tx, journeyId, row.seatNumber);
    }
    await tx.passengerBooking.deleteMany({ where: { id: { in: dropped.map((r) => r.id) } } });
    return { added, removed: dropped.length };
  }));

  for (const k of kicks) kickSeat(journeyId, k.seat, k.reason);
  await refreshFromBookings(journeyId);
  // Booked after the room opened: tell the backend so it can notify this passenger now.
  if (journey.roomsOpenedAt && result.added) emitRoomOpened(journey, live.map((s) => ({ pnr, seat: s.seat, customerId: b.customerId ?? null })));
  return { journeyId, seats: live.map((s) => s.seat), ...result };
}

/** Boarding / dropping point → passenger_booking columns (only what was sent). */
function pointColumns(bp?: PointInput | null, dp?: PointInput | null) {
  return {
    ...(bp ? { boardingId: bp.id ?? null, boardingName: bp.name, boardingLandmark: bp.landmark?.slice(0, 255) ?? null, boardingLat: bp.lat ?? null, boardingLng: bp.lng ?? null, boardingAt: bp.at ?? null } : {}),
    ...(dp ? { droppingId: dp.id ?? null, droppingName: dp.name, droppingLat: dp.lat ?? null, droppingLng: dp.lng ?? null, droppingAt: dp.at ?? null } : {}),
  };
}

/**
 * Keep a journey in step with its passengers (after every booking, cancellation, move):
 *  - schedule (unless set explicitly): start = EARLIEST boarding time on the bus, so the
 *    room opens CHAT_OPEN_BEFORE_START_MIN before the first passenger gets on; end =
 *    LATEST drop, so the chat lives until the last passenger is off (+ purge delay).
 *  - route (unless sent explicitly): every boarding and dropping point with coordinates,
 *    in time order. Enough for "near <stop>" labels, progress without GPS, pickup cards.
 */
export async function refreshFromBookings(journeyId: string) {
  const j = await prisma.busJourney.findUnique({ where: { journeyId }, select: { routeAuto: true, scheduleAuto: true, status: true, route: true, startTime: true, estimatedEndTime: true } });
  if (!j || j.status === 'PURGED') return;
  const rows = await prisma.passengerBooking.findMany({
    where: { journeyId, channel: { not: 'QR' } },
    select: { boardingId: true, boardingName: true, boardingLandmark: true, boardingLat: true, boardingLng: true, boardingAt: true,
              droppingId: true, droppingName: true, droppingLat: true, droppingLng: true, droppingAt: true },
  });
  const data: Prisma.BusJourneyUpdateInput = {};

  if (j.scheduleAuto && (j.status === 'SCHEDULED' || j.status === 'IN_TRANSIT')) {
    const boards = rows.map((r) => r.boardingAt).filter((d): d is Date => !!d).map(Number);
    const drops = rows.map((r) => r.droppingAt).filter((d): d is Date => !!d).map(Number);
    const start = boards.length ? Math.min(...boards) : +j.startTime;
    const end = drops.length ? Math.max(...drops) : +j.estimatedEndTime;
    if (end > start && (start !== +j.startTime || end !== +j.estimatedEndTime)) { data.startTime = new Date(start); data.estimatedEndTime = new Date(end); }
  }
  const stops = new Map<string, RouteStop & { t: number }>();
  for (const r of rows) {
    if (r.boardingName && r.boardingLat != null && r.boardingLng != null) {
      const key = `P:${r.boardingId ?? r.boardingName}`;
      if (!stops.has(key)) stops.set(key, { id: key, name: r.boardingName, lat: r.boardingLat, lng: r.boardingLng, kind: 'PICKUP', title: r.boardingLandmark ?? r.boardingName, ...(r.boardingAt ? { at: r.boardingAt.toISOString() } : {}), t: r.boardingAt ? +r.boardingAt : 0 });
    }
    if (r.droppingName && r.droppingLat != null && r.droppingLng != null) {
      const key = `D:${r.droppingId ?? r.droppingName}`;
      if (!stops.has(key)) stops.set(key, { id: key, name: r.droppingName, lat: r.droppingLat, lng: r.droppingLng, kind: 'DROP', ...(r.droppingAt ? { at: r.droppingAt.toISOString() } : {}), t: r.droppingAt ? +r.droppingAt : Number.MAX_SAFE_INTEGER });
    }
  }
  if (j.routeAuto) {
    const route = [...stops.values()].sort((a, b) => a.t - b.t).map(({ t: _t, ...stop }) => stop);
    const next = route.length >= 2 ? route : null;
    if (JSON.stringify(next) !== JSON.stringify(j.route ?? null)) data.route = next ? (next as unknown as Prisma.InputJsonValue) : Prisma.DbNull;
  }
  if (Object.keys(data).length) await prisma.busJourney.update({ where: { journeyId }, data });
}

/** Cancel a whole PNR, or only `seats`. Live passengers are disconnected. */
export async function cancelBooking(pnrRaw: string, seats?: string[]) {
  const pnr = normalisePnr(pnrRaw);
  const rows = await prisma.passengerBooking.findMany({
    where: { pnrNumber: pnr, journey: { status: { not: 'PURGED' } }, ...(seats?.length ? { seatNumber: { in: seats.map(normaliseSeat) } } : {}) },
  });
  if (!rows.length) return { cancelled: 0 };
  await prisma.$transaction(async (tx) => {
    for (const r of rows) await clearSeatState(tx, r.journeyId, r.seatNumber);
    await tx.passengerBooking.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
  });
  for (const jid of new Set(rows.map((r) => r.journeyId))) await refreshFromBookings(jid);
  for (const r of rows) {
    if (r.deviceId) kickSeat(r.journeyId, r.seatNumber, 'Your booking was cancelled, so you’ve left this trip chat.');
  }
  logger.info({ pnr, seats: rows.map((r) => r.seatNumber) }, 'booking cancelled');
  return { cancelled: rows.length };
}

/** Support tool: unbind a seat from its phone (passenger changed or reinstalled the app). */
export async function releaseSeat(journeyId: string, seat: string) {
  const s = normaliseSeat(seat);
  const r = await prisma.passengerBooking.updateMany({ where: { journeyId, seatNumber: s }, data: { deviceId: null, claimedAt: null } });
  if (!r.count) throw new IngestError(404, 'NOT_FOUND', 'No booking for that seat on this journey.');
  kickSeat(journeyId, s, 'This seat was moved to another phone by AbhiBus support.');
  return { released: true };
}

export interface Fix { journeyId: string; lat: number; lng: number; speedKmph?: number | null; recordedAt: Date }

/**
 * Bulk GPS update: one SQL statement for the whole batch (MySQL 8 JSON_TABLE).
 * Out-of-order fixes (older than what we have) are ignored. 2,000 buses every
 * 30s is ~70 rows/s.
 */
export async function recordFixes(fixes: Fix[]) {
  if (!fixes.length) return { updated: 0 };
  const utc = (d: Date) => d.toISOString().replace('T', ' ').replace('Z', ''); // DATETIME(3), UTC like Prisma
  const rows = JSON.stringify(fixes.map((f) => ({ j: f.journeyId, lat: f.lat, lng: f.lng, speed: f.speedKmph ?? null, at: utc(f.recordedAt) })));
  const updated = await prisma.$executeRaw`
    UPDATE chat_bus_journey AS j
      JOIN JSON_TABLE(${rows}, '$[*]' COLUMNS (
             journey_id VARCHAR(191) PATH '$.j',
             lat DOUBLE PATH '$.lat',
             lng DOUBLE PATH '$.lng',
             speed DOUBLE PATH '$.speed' NULL ON EMPTY,
             at DATETIME(3) PATH '$.at'
           )) AS f ON f.journey_id COLLATE utf8mb4_unicode_ci = j.journey_id  -- JSON_TABLE text defaults to another collation
       SET j.last_lat = f.lat, j.last_lng = f.lng, j.last_speed_kmph = f.speed, j.last_fix_at = f.at
     WHERE j.status <> 'PURGED'
       AND (j.last_fix_at IS NULL OR j.last_fix_at < f.at)`;
  return { updated };
}

/** The bus run was cancelled: tell everyone and purge on the next sweep. */
export async function cancelJourney(journeyId: string) {
  const j = await prisma.busJourney.findUnique({ where: { journeyId } });
  if (!j || j.status === 'PURGED') throw new IngestError(404, 'NOT_FOUND', 'Journey not found.');
  if (j.roomsOpenedAt) await hub.broadcastToJourney(journeyId, 'SYSTEM', { text: 'This trip was cancelled by the operator. AbhiBus will contact you about your booking. This chat is closing.' }, 'AbhiBus');
  await prisma.busJourney.update({ where: { journeyId }, data: { purgeAt: new Date(Date.now() + 60_000) } });
  return { closingAt: new Date(Date.now() + 60_000).toISOString() };
}

export function emitRoomOpened(j: BusJourney, passengers: { pnr: string; seat: string; customerId: string | null }[]) {
  emitPartnerEvent('room.opened', {
    journeyId: j.journeyId, serviceId: j.serviceId, journeyDate: j.journeyDate, busNumber: j.busNumber,
    routeName: j.routeName, startTime: j.startTime.toISOString(), closesAt: purgeTimeFor(j).toISOString(),
    passengers,
  });
}
