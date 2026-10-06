import { prisma } from '../db/prisma';
import { config } from '../config';
import { hub } from '../realtime/hub';
import { logger } from '../lib/logger';
import { forgetProgress } from '../features/progress';
import { forgetMutes } from '../features/moderationService';

/**
 * AUTO-DESTRUCT. Runs every minute.
 * For journeys past purge time (arrival + 2h, or estimated arrival + 2h if
 * the bus never reported arrival):
 *   1. tell connected phones, then force-close their sockets
 *   2. hard-delete rooms (cascades: messages, receipts, reactions), the
 *      passenger projection, mutes, blocks and games
 *   3. keep only the BusJourney row (no PII) marked PURGED
 * SosEvent and MessageReport are intentionally untouched (see schema).
 * Also prunes expired report snapshots.
 */
export function startExpirySweeper() {
  const sweep = async () => {
    const now = new Date();
    const fallbackCutoff = new Date(+now - config.PURGE_AFTER_ARRIVAL_MIN * 60_000);
    const due = await prisma.busJourney.findMany({
      where: {
        status: { not: 'PURGED' },
        OR: [{ purgeAt: { lte: now } }, { purgeAt: null, estimatedEndTime: { lte: fallbackCutoff } }],
      },
      select: { journeyId: true },
    });
    for (const { journeyId } of due) {
      try {
        await hub.closeJourney(journeyId);
        await prisma.$transaction([
          prisma.chatRoom.deleteMany({ where: { journeyId } }),
          prisma.passengerBooking.deleteMany({ where: { journeyId } }),
          prisma.seatMute.deleteMany({ where: { journeyId } }),
          prisma.seatBlock.deleteMany({ where: { journeyId } }),
          prisma.etaGame.deleteMany({ where: { journeyId } }),
          prisma.busJourney.update({ where: { journeyId }, data: { status: 'PURGED', purgeAt: now } }),
        ]);
        forgetProgress(journeyId);
        forgetMutes(journeyId);
        logger.info({ journeyId }, '🧹 journey chat purged');
      } catch (err) {
        logger.error({ err, journeyId }, 'purge failed — will retry next sweep');
      }
    }
    await prisma.messageReport.deleteMany({ where: { retainUntil: { lte: now } } });
  };
  setInterval(() => void sweep(), 60_000).unref();
  void sweep();
}
