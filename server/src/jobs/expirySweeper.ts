import { prisma } from '../db/prisma';
import { config } from '../config';
import { hub } from '../realtime/hub';
import { logger } from '../lib/logger';
import { leaderInterval } from '../lib/leader';
import { forEachLimit } from '../lib/concurrency';
import { emitPartnerEvent } from '../lib/webhooks';
import { forgetProgress } from '../features/progress';

/**
 * AUTO-DESTRUCT. Runs every minute on the leader instance.
 * For journeys past purge time (arrival + 2h, or estimated arrival + 2h if
 * the bus never reported arrival):
 *   1. tell connected phones, then force-close their sockets (cluster-wide)
 *   2. hard-delete rooms (cascades: messages, receipts, reactions), the
 *      passenger projection, mutes, blocks and games
 *   3. keep only the BusJourney row (no PII) marked PURGED
 *   4. journey.closed webhook to the backend
 * SosEvent and MessageReport are intentionally untouched (see schema).
 * Also prunes expired report snapshots.
 */
const PURGE_BATCH = 500;

export function startExpirySweeper() {
  leaderInterval('expiry-sweeper', 60_000, async () => {
    const now = new Date();
    const fallbackCutoff = new Date(+now - config.CHAT_CLOSE_AFTER_LAST_DROP_MIN * 60_000);
    const due = await prisma.busJourney.findMany({
      where: {
        status: { not: 'PURGED' },
        // purgeAt set (arrived / ended by Ops), or 3 h past the last drop time and not arrived later than that.
        OR: [
          { purgeAt: { lte: now } },
          { purgeAt: null, estimatedEndTime: { lte: fallbackCutoff }, OR: [{ actualEndTime: null }, { actualEndTime: { lte: fallbackCutoff } }] },
        ],
      },
      select: { journeyId: true },
      take: PURGE_BATCH,
    });
    await forEachLimit(due, 8, async ({ journeyId }) => {
      try {
        await hub.closeJourney(journeyId);
        // The raw bus-online rows of this trip go with the chat.
        const pnrs = (await prisma.passengerBooking.findMany({ where: { journeyId }, select: { pnrNumber: true }, distinct: ['pnrNumber'] })).map((b) => b.pnrNumber);
        await prisma.$transaction([
          prisma.chatAbhibusInbox.deleteMany({ where: { pnr: { in: pnrs }, processedAt: { not: null } } }),
          prisma.chatRoom.deleteMany({ where: { journeyId } }),
          prisma.passengerBooking.deleteMany({ where: { journeyId } }),
          prisma.seatMute.deleteMany({ where: { journeyId } }),
          prisma.seatBlock.deleteMany({ where: { journeyId } }),
          prisma.etaGame.deleteMany({ where: { journeyId } }),
          prisma.busJourney.update({ where: { journeyId }, data: { status: 'PURGED', purgeAt: now, lastLat: null, lastLng: null } }),
        ]);
        forgetProgress(journeyId);
        emitPartnerEvent('journey.closed', { journeyId });
        logger.info({ journeyId }, '🧹 journey chat purged');
      } catch (err) {
        logger.error({ err, journeyId }, 'purge failed — will retry next sweep');
      }
    });
    await prisma.messageReport.deleteMany({ where: { retainUntil: { lte: now } } });
  });
}
