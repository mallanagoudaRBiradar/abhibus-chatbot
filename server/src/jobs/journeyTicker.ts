import { closeTimeAfter } from '../features/journeyService';
import type { BusJourney } from '@prisma/client';
import { prisma } from '../db/prisma';
import { retryOnConflict } from '../db/retry';
import { config } from '../config';
import { hub } from '../realtime/hub';
import { logger } from '../lib/logger';
import { leaderInterval } from '../lib/leader';
import { forEachLimit } from '../lib/concurrency';
import { refreshProgress } from '../features/progress';
import { tickGame } from '../features/etaGame';
import { sweepExpiredRestStop } from '../features/restStop';
import { emitRoomOpened } from '../features/ingest';
import { purgeTimeFor } from '../features/journeyService';
import { S2C, type RoomType } from '../shared/protocol';
import { platformBridge } from '../platform/bridge';

/**
 * Every 30s, on the leader instance only:
 *  1. ROOM OPENER: journeys departing within CHAT_OPEN_BEFORE_START_MIN get
 *     their rooms created, and the backend is told (room.opened webhook) so it
 *     can push "Your trip chat is open" to each passenger.
 *  2. For each live journey (TICK_CONCURRENCY in parallel):
 *     - push a tiny progress update (~200 bytes) from the latest GPS fix
 *     - lock / resolve the ETA game
 *     - auto-unpin finished rest stops
 *     - detect arrival -> set purge_at = max(last drop time, arrival) + CHAT_CLOSE_AFTER_LAST_DROP_MIN and warn clients
 *
 * Emits reach sockets on every instance through the Redis adapter.
 */
export function startJourneyTicker() {
  leaderInterval('journey-ticker', 30_000, async () => {
    await openDueRooms();
    const live = await prisma.busJourney.findMany({
      where: { OR: [{ status: 'IN_TRANSIT' }, { status: 'SCHEDULED', roomsOpenedAt: { not: null } }] },
    });
    await forEachLimit(live, config.TICK_CONCURRENCY, async (j) => {
      try { await tickJourney(j); } catch (err) { logger.error({ err, journeyId: j.journeyId }, 'journey tick failed'); }
    });
  });
}

async function tickJourney(j: BusJourney) {
  const now = Date.now();
  if (j.status === 'SCHEDULED' && now >= +j.startTime)
    j = await prisma.busJourney.update({ where: { journeyId: j.journeyId }, data: { status: 'IN_TRANSIT' } });
  await sweepExpiredRestStop(j.journeyId);
  const entry = await refreshProgress(j);
  if (entry) {
    hub.emitToJourney(j.journeyId, S2C.PROGRESS, entry.state);
    await tickGame(j.journeyId, entry.position);
  }
  // Arrival: the bus reached the end of its route, or (no GPS/route) the timetable says so.
  const arrived = entry ? entry.position.progress >= 0.995 : now >= +j.estimatedEndTime;
  if (j.status === 'IN_TRANSIT' && arrived) await markArrived(j.journeyId, new Date());
}

/** Batch size per tick. 2,000 journeys a day spread over the day is far below this. */
const OPEN_BATCH = 500;

async function openDueRooms() {
  // Drain everything due this tick, OPEN_BATCH at a time (a backlog never waits for the next tick).
  for (let round = 0; round < 20; round++) if ((await openBatch()) < OPEN_BATCH) return;
}

async function openBatch(): Promise<number> {
  const now = new Date();
  const due = await prisma.busJourney.findMany({
    where: { status: 'SCHEDULED', roomsOpenedAt: null, startTime: { lte: new Date(+now + config.CHAT_OPEN_BEFORE_START_MIN * 60_000) } },
    include: { bookings: { select: { pnrNumber: true, seatNumber: true, customerId: true, gender: true, channel: true } } },
    orderBy: { startTime: 'asc' },
    take: OPEN_BATCH,
  });
  await forEachLimit(due, config.TICK_CONCURRENCY, async (j) => {
    try {
      if (+purgeTimeFor(j) <= +now) return; // never opened in time; the sweeper deletes it
      const types: RoomType[] = ['MAIN_COMMON', ...(j.bookings.some((b) => b.gender === 'F') ? ['WOMEN_ONLY' as const] : [])];
      await retryOnConflict(() => prisma.$transaction([
        ...types.map((roomType) => prisma.chatRoom.upsert({ where: { journeyId_roomType: { journeyId: j.journeyId, roomType } }, create: { journeyId: j.journeyId, roomType }, update: {} })),
        prisma.busJourney.update({ where: { journeyId: j.journeyId }, data: { roomsOpenedAt: now } }),
      ]));
      const passengers = j.bookings.filter((b) => b.channel !== 'QR').map((b) => ({ pnr: b.pnrNumber, seat: b.seatNumber, customerId: b.customerId }));
      if (passengers.length) emitRoomOpened({ ...j, roomsOpenedAt: now }, passengers);
      platformBridge.link(j.journeyId); // Ops console (no-op unless the bridge is configured)
      logger.info({ journeyId: j.journeyId, rooms: types, passengers: passengers.length }, 'trip chat opened');
    } catch (err) {
      logger.error({ err, journeyId: j.journeyId }, 'room open failed, will retry next tick');
    }
  });
  return due.length;
}

export async function markArrived(journeyId: string, at: Date) {
  // Arriving early never cuts anyone short: the chat still runs until 3 h after the last passenger's drop time.
  const j = await prisma.busJourney.findUnique({ where: { journeyId }, select: { estimatedEndTime: true } });
  if (!j) return;
  const purgeAt = closeTimeAfter(j.estimatedEndTime, at);
  // Conditional: two callers (ticker + conductor/partner event) post the message once.
  const { count } = await prisma.busJourney.updateMany({ where: { journeyId, status: { in: ['SCHEDULED', 'IN_TRANSIT'] } }, data: { status: 'ARRIVED', actualEndTime: at, purgeAt } });
  if (!count) return;
  await hub.broadcastToJourney(journeyId, 'SYSTEM', { text: `You’ve arrived. This chat and its messages will be deleted at ${purgeAt.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' })}.` }, 'AbhiBus');
  hub.emitToJourney(journeyId, S2C.JOURNEY_ENDING, { purgeAt: purgeAt.toISOString() });
}
