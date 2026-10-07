import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { prisma } from '../db/prisma';
import { logger } from '../lib/logger';
import { safeEqual } from '../lib/util';
import { cancelBooking, cancelJourney, IngestError, recordFixes, releaseSeat, upsertBooking, upsertJourney } from '../features/ingest';
import { JoinError, joinJourney, purgeTimeFor } from '../features/journeyService';
import { endRestStop, startRestStop } from '../features/restStop';
import { markArrived } from '../jobs/journeyTicker';
import { AdapterError, bookingFromGetTicket, cancellationFrom } from '../booking/abhibusAdapter';
import { hub } from '../realtime/hub';
import type { BroadcastPayload } from '../shared/protocol';

/**
 * ============================================================================
 *  Partner API  —  /v1/partner/*   (server-to-server, AbhiBus backend only)
 * ============================================================================
 *  Auth: header `x-api-key: <one of PARTNER_API_KEYS>`. Never ship it in an app.
 *  All writes are idempotent; retry freely on timeouts and 5xx.
 *  Full reference: docs/INTEGRATION.md
 * ============================================================================
 */
export const partnerRouter = Router();

partnerRouter.use((req: Request, res: Response, next: NextFunction) => {
  const key = req.header('x-api-key') ?? '';
  if (config.partnerKeys.some((k) => safeEqual(key, k))) return next();
  res.status(401).json({ code: 'UNAUTHORIZED', message: 'Missing or invalid x-api-key.' });
});

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

// --------------------------------------------------------------- schemas ---
const Iso = z.string().datetime({ offset: true }).transform((v) => new Date(v));
const RouteStopZ = z.object({
  name: z.string().min(1).max(80),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  kind: z.enum(['STOP', 'PICKUP', 'DROP', 'TOLL', 'REST']).optional(),
  at: z.string().datetime({ offset: true }).optional(),
  id: z.string().max(64).optional(),
  title: z.string().max(80).optional(),
  caption: z.string().max(200).optional(),
  imageUrl: z.string().url().max(500).nullable().optional(),
});
const JourneyZ = z.object({
  serviceId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'letters, digits, _ or - (max 40)'),
  journeyDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  busNumber: z.string().max(20).nullable().optional(),
  operatorName: z.string().max(80).nullable().optional(),
  sourceCity: z.string().min(1).max(60),
  destinationCity: z.string().min(1).max(60),
  startTime: Iso,
  estimatedEndTime: Iso,
  route: z.array(RouteStopZ).max(200).nullable().optional(),
  trackingRef: z.string().max(120).nullable().optional(),
  operatorHelpline: z.string().regex(/^\+?[\d -]{6,20}$/, 'phone number').nullable().optional(),
});
const PointZ = z.object({
  id: z.string().max(40).nullable().optional(),
  name: z.string().min(1).max(120),
  landmark: z.string().max(255).nullable().optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  at: Iso.nullable().optional(),
});
const BookingZ = z.object({
  pnr: z.string().min(4).max(24),
  status: z.enum(['CONFIRMED', 'CANCELLED']).default('CONFIRMED'),
  channel: z.enum(['OWN', 'API']).optional(),
  customerId: z.string().max(64).nullable().optional(),
  mobile: z.string().max(20).nullable().optional(),
  journey: JourneyZ,
  seats: z.array(z.object({ seat: z.string().min(1).max(8), gender: z.string().max(10), name: z.string().max(80).nullable().optional(), status: z.enum(['CONFIRMED', 'CANCELLED']).optional() })).max(60),
  boarding: PointZ.nullable().optional(),
  dropping: PointZ.nullable().optional(),
}).refine((b) => b.status === 'CANCELLED' || b.seats.length > 0, { message: 'A confirmed booking needs at least one seat.', path: ['seats'] });


// -------------------------------------------------------------- bookings ---
/** Booking confirmed or changed. Send the full current state of the PNR every time. */
partnerRouter.post('/bookings', wrap(async (req, res) => {
  res.json(await upsertBooking(BookingZ.parse(req.body)));
}));

/** Backfill / catch-up: up to 500 bookings per call. Each item succeeds or fails on its own. */
partnerRouter.post('/bookings/batch', wrap(async (req, res) => {
  const { bookings } = z.object({ bookings: z.array(z.unknown()).min(1).max(500) }).parse(req.body);
  const results = [];
  for (const raw of bookings) {
    const parsed = BookingZ.safeParse(raw);
    if (!parsed.success) { results.push({ ok: false, code: 'INVALID', issues: parsed.error.issues.slice(0, 3) }); continue; }
    try { results.push({ ok: true, pnr: parsed.data.pnr, ...(await upsertBooking(parsed.data)) }); }
    catch (e) { results.push({ ok: false, pnr: parsed.data.pnr, code: e instanceof IngestError ? e.code : 'INTERNAL', message: (e as Error).message }); }
  }
  res.json({ results, failed: results.filter((r) => !r.ok).length });
}));

/** Whole PNR cancelled, or only some seats (`seats`). */
partnerRouter.post('/bookings/:pnr/cancel', wrap(async (req, res) => {
  const { seats } = z.object({ seats: z.array(z.string().max(8)).max(60).optional() }).parse(req.body ?? {});
  res.json(await cancelBooking(req.params.pnr, seats));
}));

// --------------------------------------------------- AbhiBus raw adapter ---
/**
 * Forward AbhiBus responses as they are; we map them (booking/abhibusAdapter.ts).
 *   GetTicket            → /abhibus/ticket        after booking, modification, or any status change
 *   ConfirmCancellation  → /abhibus/cancellation  add "cancel_seats" from your request
 */
partnerRouter.post('/abhibus/ticket', wrap(async (req, res) => {
  let booking;
  try { booking = bookingFromGetTicket(req.body); } catch (e) { if (e instanceof AdapterError) return res.status(400).json({ code: 'INVALID', message: e.message }); throw e; }
  if (booking.status === 'CONFIRMED' && !booking.seats.length) return res.status(400).json({ code: 'INVALID', message: 'SelectedSeats is empty on a live ticket.' });
  res.json({ pnr: booking.pnr, status: booking.status, ...(await upsertBooking(booking)) });
}));

partnerRouter.post('/abhibus/cancellation', wrap(async (req, res) => {
  let c;
  try { c = cancellationFrom(req.body ?? {}); } catch (e) { if (e instanceof AdapterError) return res.status(400).json({ code: 'INVALID', message: e.message }); throw e; }
  if (!c.apply) return res.json({ pnr: c.pnr, ignored: true, reason: c.reason });
  res.json({ pnr: c.pnr, seats: c.seats, ...(await cancelBooking(c.pnr, c.seats.length ? c.seats : undefined)) });
}));

// -------------------------------------------------------------- journeys ---
/** Schedule change, bus swap or route update for a journey (bookings carry the journey too). */
partnerRouter.post('/journeys', wrap(async (req, res) => {
  const j = await upsertJourney(JourneyZ.parse(req.body));
  res.json({ journeyId: j.journeyId, status: j.status });
}));

partnerRouter.get('/journeys/:id', wrap(async (req, res) => {
  const j = await prisma.busJourney.findUnique({ where: { journeyId: req.params.id } });
  if (!j) return res.status(404).json({ code: 'NOT_FOUND' });
  const [booked, joined] = j.status === 'PURGED' ? [0, 0] : await Promise.all([
    prisma.passengerBooking.count({ where: { journeyId: j.journeyId, channel: { not: 'QR' } } }),
    prisma.passengerBooking.count({ where: { journeyId: j.journeyId, deviceId: { not: null } } }),
  ]);
  res.json({
    journeyId: j.journeyId, status: j.status, startTime: j.startTime, estimatedEndTime: j.estimatedEndTime,
    opensAt: new Date(+j.startTime - config.CHAT_OPEN_BEFORE_START_MIN * 60_000), roomsOpenedAt: j.roomsOpenedAt,
    closesAt: purgeTimeFor(j), lastFixAt: j.lastFixAt, seatsBooked: booked, seatsJoined: joined,
    routeStops: Array.isArray(j.route) ? j.route.length : 0, routeSource: j.routeAuto ? 'bookings' : 'partner', trackingRef: j.trackingRef,
    scheduleSource: j.scheduleAuto ? 'bookings' : 'partner', operatorName: j.operatorName, operatorHelpline: j.operatorHelpline,
    ...(await pointsOf(j.journeyId, j.status === 'PURGED')),
  });
}));

/**
 * Boarding / dropping points with passenger counts, in time order. firstBoarding is the
 * earliest pickup: the room opens CHAT_OPEN_BEFORE_START_MIN before it.
 */
async function pointsOf(journeyId: string, purged: boolean) {
  if (purged) return { firstBoarding: null, boardingPoints: [], droppingPoints: [] };
  const rows = await prisma.passengerBooking.findMany({
    where: { journeyId, channel: { not: 'QR' } },
    select: { pnrNumber: true, boardingId: true, boardingName: true, boardingLandmark: true, boardingAt: true, droppingId: true, droppingName: true, droppingAt: true },
  });
  const group = (kind: 'boarding' | 'dropping') => {
    const m = new Map<string, { name: string; landmark?: string | null; at: Date | null; seats: number; pnrs: Set<string> }>();
    for (const r of rows) {
      const name = kind === 'boarding' ? r.boardingName : r.droppingName;
      if (!name) continue;
      const key = (kind === 'boarding' ? r.boardingId : r.droppingId) ?? name;
      const g = m.get(key) ?? { name, ...(kind === 'boarding' ? { landmark: r.boardingLandmark } : {}), at: kind === 'boarding' ? r.boardingAt : r.droppingAt, seats: 0, pnrs: new Set<string>() };
      g.seats++; g.pnrs.add(r.pnrNumber); m.set(key, g);
    }
    return [...m.values()].sort((a, b) => (a.at ? +a.at : Infinity) - (b.at ? +b.at : Infinity)).map(({ pnrs, ...g }) => ({ ...g, bookings: pnrs.size }));
  };
  const boardingPoints = group('boarding');
  return { firstBoarding: boardingPoints[0] ?? null, boardingPoints, droppingPoints: group('dropping') };
}

const EventZ = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ARRIVED'), at: Iso.optional() }),
  z.object({ type: z.literal('CANCELLED') }),
  z.object({ type: z.literal('ANNOUNCEMENT'), text: z.string().min(2).max(280) }),
  z.object({ type: z.literal('REST_STOP'), label: z.string().min(2).max(40), durationMin: z.number().min(1).max(90), place: z.string().max(80).optional() }),
  z.object({ type: z.literal('REST_STOP_END') }),
]);

/** Things that happen to the bus: arrival, cancellation, crew announcements, rest stops. */
partnerRouter.post('/journeys/:id/events', wrap(async (req, res) => {
  const ev = EventZ.parse(req.body);
  const id = req.params.id;
  const j = await prisma.busJourney.findUnique({ where: { journeyId: id } });
  if (!j || j.status === 'PURGED') return res.status(404).json({ code: 'NOT_FOUND' });
  if (ev.type === 'CANCELLED') return res.json(await cancelJourney(id));
  if (!j.roomsOpenedAt && j.status === 'SCHEDULED') return res.status(409).json({ code: 'TRIP_NOT_LIVE', message: 'The chat for this journey is not open yet.' });
  switch (ev.type) {
    case 'ARRIVED': await markArrived(id, ev.at ?? new Date()); break;
    case 'ANNOUNCEMENT': await hub.broadcastToJourney(id, 'BROADCAST', { kind: 'ANNOUNCEMENT', text: ev.text } satisfies BroadcastPayload); break;
    case 'REST_STOP': await endRestStop(id, { announce: false }); await startRestStop(id, ev); break;
    case 'REST_STOP_END': await endRestStop(id, { announce: true }); break;
  }
  res.json({ ok: true });
}));

/** Support: passenger changed or reinstalled their phone. Frees the seat for the next device that joins. */
partnerRouter.post('/journeys/:id/seats/:seat/release', wrap(async (req, res) => {
  res.json(await releaseSeat(req.params.id, req.params.seat));
}));

// ------------------------------------------------------------- locations ---
/** Bus GPS from the tracking system. Up to 2,000 fixes per call; send every 15–60s per bus. */
partnerRouter.post('/locations', wrap(async (req, res) => {
  const { fixes } = z.object({
    fixes: z.array(z.object({
      journeyId: z.string().max(64), lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180),
      speedKmph: z.number().min(0).max(200).nullable().optional(), recordedAt: Iso,
    })).min(1).max(2000),
  }).parse(req.body);
  const future = Date.now() + 2 * 60_000;
  res.json(await recordFixes(fixes.filter((f) => +f.recordedAt <= future)));
}));

// --------------------------------------------------------- chat sessions ---
/**
 * The app wants to open the trip chat. The AbhiBus backend has already checked
 * the signed-in user owns this PNR; it calls this and hands { token, ... } to
 * the app, which connects the WebSocket with it.
 */
partnerRouter.post('/chat-sessions', wrap(async (req, res) => {
  const b = z.object({
    pnr: z.string().min(4).max(24), seat: z.string().min(1).max(8), deviceId: z.string().min(8).max(80),
    customerId: z.string().max(64).nullable().optional(), profile: z.unknown().optional(), // ignored: trip names are assigned
  }).parse(req.body);
  try {
    res.json(await joinJourney(b, { userId: b.customerId ?? null }));
  } catch (e) {
    if (e instanceof JoinError) {
      const status = { NOT_FOUND: 404, TRIP_NOT_LIVE: 403, SEAT_CLAIMED: 409, JOURNEY_CLOSED: 410, INVALID: 400, REMOVED: 403, TOO_FAR: 403 }[e.code];
      return res.status(status).json({ code: e.code, message: e.message, meta: e.meta });
    }
    throw e;
  }
}));

// ---------------------------------------------------------------- errors ---
partnerRouter.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof z.ZodError) return res.status(400).json({ code: 'INVALID', issues: err.issues.slice(0, 10) });
  if (err instanceof IngestError) return res.status(err.status).json({ code: err.code, message: err.message });
  logger.error({ err }, 'partner api error');
  res.status(500).json({ code: 'INTERNAL', message: 'Something went wrong. Retry with the same payload.' });
});
