import { prisma } from '../db/prisma';
import { config } from '../config';
import { hub } from '../realtime/hub';
import { logger } from '../lib/logger';
import { refreshProgress } from '../features/progress';
import { tickGame } from '../features/etaGame';
import { sweepExpiredRestStop } from '../features/restStop';
import { S2C } from '../shared/protocol';

/**
 * Every 30s, for each live journey:
 *  - pull the bus GPS fix and push a tiny progress update (~200 bytes)
 *  - lock / resolve the ETA game
 *  - auto-unpin finished rest stops
 *  - detect arrival -> set purge_at = arrival + PURGE_AFTER_ARRIVAL_MIN and warn clients
 */
export function startJourneyTicker() {
  const tick = async () => {
    const live = await prisma.busJourney.findMany({ where: { status: { in: ['SCHEDULED', 'IN_TRANSIT', 'ARRIVED'] } } });
    for (const j of live) {
      try {
        if (j.status === 'SCHEDULED' && Date.now() >= +j.startTime)
          await prisma.busJourney.update({ where: { journeyId: j.journeyId }, data: { status: 'IN_TRANSIT' } });
        const entry = await refreshProgress(j);
        if (!entry) continue;
        hub.emitToJourney(j.journeyId, S2C.PROGRESS, entry.state);
        await tickGame(j.journeyId, entry.position);
        await sweepExpiredRestStop(j.journeyId);

        if (j.status !== 'ARRIVED' && entry.position.progress >= 1) await markArrived(j.journeyId, new Date());
      } catch (err) {
        logger.error({ err, journeyId: j.journeyId }, 'journey tick failed');
      }
    }
  };
  setInterval(() => void tick(), 30_000).unref();
  void tick();
}

export async function markArrived(journeyId: string, at: Date) {
  const purgeAt = new Date(+at + config.PURGE_AFTER_ARRIVAL_MIN * 60_000);
  await prisma.busJourney.update({ where: { journeyId }, data: { status: 'ARRIVED', actualEndTime: at, purgeAt } });
  await hub.broadcastToJourney(journeyId, 'SYSTEM', { text: `You’ve arrived. This chat and its messages will be deleted at ${purgeAt.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' })}.` }, 'AbhiBus');
  hub.emitToJourney(journeyId, S2C.JOURNEY_ENDING, { purgeAt: purgeAt.toISOString() });
}
