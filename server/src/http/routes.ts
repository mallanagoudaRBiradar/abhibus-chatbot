import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { prisma } from '../db/prisma';
import { logger } from '../lib/logger';
import { limits } from '../lib/rateLimit';
import { safeEqual } from '../lib/util';
import { verifyAppSession } from '../auth/appSession';
import { verifyChatToken, type ChatClaims } from '../auth/tokens';
import { JoinError, joinJourney, joinViaQr } from '../features/journeyService';
import { endRestStop, startRestStop } from '../features/restStop';
import { createEtaGameForNextToll, resolveGame } from '../features/etaGame';
import { raiseSos } from '../features/sos';
import { markArrived } from '../jobs/journeyTicker';
import { hub } from '../realtime/hub';
import { DEMO } from '../demo/demoData';
import type { BroadcastPayload } from '../shared/protocol';
import { platformBridge } from '../platform/bridge';

export const router = Router();

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

// ---------------------------------------------------------------- health --
router.get('/healthz', (_req, res) => res.json({ ok: true, demo: config.DEMO_MODE, bookingSource: config.BOOKING_SOURCE }));

// ------------------------------------------------------------ demo tickets --
router.get('/v1/demo/tickets', (_req, res) => {
  if (!config.DEMO_MODE) return res.status(404).end();
  res.json({ tickets: DEMO.tickets.map((t) => ({ pnr: t.pnr, label: t.label, seats: t.seats.map((s) => s.seat) })) });
});

// ------------------------------------------------------------ PNR join ----
/**
 * POST /v1/journey-chat/join  { pnr, seat, deviceId }
 * Authorization: Bearer <AbhiBus app session>   (required outside DEMO_MODE)
 */
router.post('/v1/journey-chat/join', wrap(async (req, res) => {
  const body = z.object({
    pnr: z.string().min(4).max(24), seat: z.string().min(1).max(8), deviceId: z.string().min(8).max(80),
    profile: z.object({ name: z.string().max(40), avatar: z.string().max(16).nullable() }),
  }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ code: 'INVALID', message: 'Enter your PNR, seat number and name.' });

  const throttleKey = `${req.ip}:${body.data.pnr.toUpperCase()}`;
  if (!limits.join.take(throttleKey)) return res.status(429).json({ code: 'RATE_LIMITED', message: 'Too many attempts. Wait a minute and try again.' });

  const session = await verifyAppSession(req.header('authorization'));
  if (!session) return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Sign in to the AbhiBus app to join your trip chat.' });

  try {
    res.json(await joinJourney(body.data));
  } catch (e) {
    if (e instanceof JoinError) {
      const status = { NOT_FOUND: 404, TRIP_NOT_LIVE: 403, SEAT_CLAIMED: 409, JOURNEY_CLOSED: 410, INVALID: 400, REMOVED: 403, TOO_FAR: 403 }[e.code];
      return res.status(status).json({ code: e.code, message: e.message, meta: e.meta });
    }
    throw e;
  }
}));

// ------------------------------------------------------------- QR join ----
/**
 * POST /v1/journey-chat/join-qr  { token, coords, deviceId, profile }
 * For passengers booked elsewhere (e.g. RedBus): no AbhiBus session needed —
 * the signed invite + matching locations are the proof of being on this bus.
 */
router.post('/v1/journey-chat/join-qr', wrap(async (req, res) => {
  const body = z.object({
    token: z.string().min(20).max(2000), deviceId: z.string().min(8).max(80),
    coords: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).nullable(),
    profile: z.object({ name: z.string().max(40), avatar: z.string().max(16).nullable() }),
  }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ code: 'INVALID', message: 'Scan the QR again and allow location.' });
  if (!limits.join.take(`${req.ip}:qr`)) return res.status(429).json({ code: 'RATE_LIMITED', message: 'Too many attempts. Wait a minute and try again.' });
  try {
    res.json(await joinViaQr(body.data));
  } catch (e) {
    if (e instanceof JoinError) {
      const status = { NOT_FOUND: 404, TRIP_NOT_LIVE: 403, SEAT_CLAIMED: 409, JOURNEY_CLOSED: 410, INVALID: 400, REMOVED: 403, TOO_FAR: 403 }[e.code];
      return res.status(status).json({ code: e.code, message: e.message, meta: e.meta });
    }
    throw e;
  }
}));

// ------------------------------------------------------------------ SOS ---
const chatAuth = (req: Request): ChatClaims | null => {
  try { return verifyChatToken((req.header('authorization') ?? '').replace(/^Bearer /, '')); } catch { return null; }
};

router.post('/v1/journey-chat/sos', wrap(async (req, res) => {
  const claims = chatAuth(req);
  if (!claims) return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Session expired.' });
  if (!limits.sos.take(`${claims.jid}:${claims.seat}`)) return res.status(429).json({ code: 'RATE_LIMITED', message: 'Your alert is already with our safety team.' });
  res.json(await raiseSos(claims.jid, { pnr: claims.pnr, seat: claims.seat }));
}));

// ----------------------------------------------------- conductor / ops ----
/**
 * Conductor endpoints are called by the operator crew app.
 * TODO(platform): swap the static key for the operator app's OAuth + a
 * conductor<->bus assignment check.
 */
const requireKey = (expected: string) => (req: Request, res: Response, next: NextFunction) =>
  safeEqual(req.header('x-api-key') ?? '', expected) ? next() : res.status(401).json({ code: 'UNAUTHORIZED' });
const conductor = requireKey(config.CONDUCTOR_API_KEY);
const ops = requireKey(config.OPS_API_KEY);

const journeyOr404 = async (id: string, res: Response) => {
  const j = await prisma.busJourney.findUnique({ where: { journeyId: id } });
  if (!j || j.status === 'PURGED') { res.status(404).json({ code: 'NOT_FOUND' }); return null; }
  return j;
};

router.post('/v1/conductor/journeys/:id/rest-stop', conductor, wrap(async (req, res) => {
  const body = z.object({ label: z.string().min(2).max(40), durationMin: z.number().min(1).max(90), place: z.string().max(80).optional() }).parse(req.body);
  if (!(await journeyOr404(req.params.id, res))) return;
  await endRestStop(req.params.id, { announce: false });
  res.json(await startRestStop(req.params.id, body));
}));

router.post('/v1/conductor/journeys/:id/rest-stop/end', conductor, wrap(async (req, res) => {
  if (!(await journeyOr404(req.params.id, res))) return;
  res.json({ ended: await endRestStop(req.params.id, { announce: true }) });
}));

router.post('/v1/conductor/journeys/:id/announce', conductor, wrap(async (req, res) => {
  const { text } = z.object({ text: z.string().min(2).max(280) }).parse(req.body);
  if (!(await journeyOr404(req.params.id, res))) return;
  await hub.broadcastToJourney(req.params.id, 'BROADCAST', { kind: 'ANNOUNCEMENT', text } satisfies BroadcastPayload);
  res.json({ ok: true });
}));

router.post('/v1/conductor/journeys/:id/arrived', conductor, wrap(async (req, res) => {
  if (!(await journeyOr404(req.params.id, res))) return;
  await markArrived(req.params.id, new Date());
  res.json({ ok: true });
}));

/** Ops: register a journey when ticket tables don't carry schedule/bus details. */
router.post('/v1/ops/journeys', ops, wrap(async (req, res) => {
  const b = z.object({
    serviceId: z.string(), journeyDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), busNumber: z.string(), operatorName: z.string(),
    sourceCity: z.string(), destinationCity: z.string(), startTime: z.string().datetime({ offset: true }), estimatedEndTime: z.string().datetime({ offset: true }),
  }).parse(req.body);
  const journeyId = `${b.serviceId}:${b.journeyDate}`;
  const data = { ...b, routeName: `${b.sourceCity} to ${b.destinationCity}`, startTime: new Date(b.startTime), estimatedEndTime: new Date(b.estimatedEndTime) };
  res.json(await prisma.busJourney.upsert({ where: { journeyId }, create: { journeyId, ...data }, update: data }));
}));

router.post('/v1/ops/journeys/:id/eta-game', ops, wrap(async (req, res) => {
  if (!(await journeyOr404(req.params.id, res))) return;
  res.json(await createEtaGameForNextToll(req.params.id));
}));

router.post('/v1/ops/eta-games/:id/resolve', ops, wrap(async (req, res) => {
  const { actualAt } = z.object({ actualAt: z.string().datetime({ offset: true }).optional() }).parse(req.body ?? {});
  res.json(await resolveGame(req.params.id, actualAt ? new Date(actualAt) : new Date()));
}));

router.get('/v1/ops/journeys/:id/sos', ops, wrap(async (req, res) => {
  res.json(await prisma.sosEvent.findMany({ where: { journeyId: req.params.id }, orderBy: { createdAt: 'desc' } }));
}));

// ------------------------------------------------------ Trip Rooms bridge --
/** Signed callbacks from the Trip Rooms platform (support replies, Ops alerts). See platform/bridge.ts. */
router.post('/v1/platform/webhook', wrap(async (req, res) => {
  const out = await platformBridge.handleWebhook((req as unknown as { rawBody?: Buffer }).rawBody, req.header('x-triprooms-signature'));
  res.status(out.status).json(out.body);
}));
router.get('/v1/platform/status', ops, (_req, res) => { res.json(platformBridge.status()); });
/** Vote in / answer a Trip Rooms poll or survey shown in this chat. */
router.post('/v1/journey-chat/poll-vote', wrap(async (req, res) => {
  const claims = chatAuth(req);
  if (!claims) return res.status(401).json({ code: 'UNAUTHORIZED' });
  const b = z.object({ messageId: z.string().uuid(), option: z.number().int().min(0).max(11) }).parse(req.body);
  try { res.json(await platformBridge.vote(claims.jid, claims.seat, b.messageId, b.option)); }
  catch (e) { res.status(409).json({ code: 'POLL_FAILED', message: (e as Error).message.includes('closed') ? 'This poll has closed.' : 'Couldn’t record your vote. Try again.' }); }
}));
router.post('/v1/journey-chat/survey-answer', wrap(async (req, res) => {
  const claims = chatAuth(req);
  if (!claims) return res.status(401).json({ code: 'UNAUTHORIZED' });
  const b = z.object({ messageId: z.string().uuid(), answers: z.array(z.union([z.string().max(200), z.number()])).min(1).max(6) }).parse(req.body);
  try { res.json(await platformBridge.answer(claims.jid, claims.seat, b.messageId, b.answers)); }
  catch { res.status(409).json({ code: 'SURVEY_FAILED', message: 'Couldn’t send your answers. Try again.' }); }
}));
/** Passenger tapped a sponsored card (shown via the bridge): counts the click, returns the coupon. */
router.post('/v1/journey-chat/ad-click', wrap(async (req, res) => {
  const claims = chatAuth(req);
  if (!claims) return res.status(401).json({ code: 'UNAUTHORIZED' });
  const { messageId } = z.object({ messageId: z.string().min(1).max(64) }).parse(req.body);
  res.json(await platformBridge.adClick(claims.jid, claims.seat, messageId).catch(() => ({ coupon: null })));
}));

// ------------------------------------------------------------- errors -----
router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof z.ZodError) return res.status(400).json({ code: 'INVALID', issues: err.issues });
  logger.error({ err }, 'http error');
  res.status(500).json({ code: 'INTERNAL', message: 'Something went wrong. Try again.' });
});
