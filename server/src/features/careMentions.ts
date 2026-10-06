import { config } from '../config';
import { logger } from '../lib/logger';
import { prisma } from '../db/prisma';

/**
 * "@AbhiBus Care" in a chat message → a ticket for the support desk.
 * Uses the same SUPPORT_WEBHOOK_URL as SOS (lower priority, P3). Without a
 * webhook configured it's logged, so the flow is visible in development.
 * TODO(platform): route to the CRM / agent console and let agents reply in-chat.
 */
export async function notifyCare(journeyId: string, who: { seat: string; name: string }, messageId: string, text: string) {
  const j = await prisma.busJourney.findUnique({ where: { journeyId } });
  const ticket = {
    type: 'JOURNEY_CHAT_MENTION', priority: 'P3', journeyId, messageId, text,
    busNumber: j?.busNumber, operator: j?.operatorName, seat: who.seat, passenger: who.name, raisedAt: new Date().toISOString(),
  };
  if (config.SUPPORT_WEBHOOK_URL) {
    try {
      await fetch(config.SUPPORT_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ticket) });
    } catch (err) { logger.warn({ err, messageId }, 'care mention webhook failed'); }
  }
  logger.info({ journeyId, seat: who.seat, messageId }, '🛎️ AbhiBus Care mentioned');
}
