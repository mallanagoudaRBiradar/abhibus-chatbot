import { prisma } from '../db/prisma';
import { config } from '../config';
import { logger } from '../lib/logger';
import { tracker } from '../tracking/gpsProvider';

/**
 * SOS — priority alert to the AbhiBus Safety Desk + the passenger's emergency
 * contacts on their AbhiBus account.
 *
 * Product decisions:
 *  - SILENT to the bus. The crew and other passengers are NOT notified. If the
 *    threat is on board (including staff), announcing the alert could escalate.
 *  - The incident record is never deleted with the chat.
 *  - The bus GPS fix is attached server-side; the phone sends nothing.
 *  - The app also offers a one-tap call to 112 (India's national emergency
 *    number) because no app should stand between a person and the police.
 */
export async function raiseSos(journeyId: string, who: { pnr: string; seat: string }) {
  const j = await prisma.busJourney.findUniqueOrThrow({ where: { journeyId } });
  const pos = await tracker.getPosition(j).catch(() => null);
  const ev = await prisma.sosEvent.create({
    data: { journeyId, pnrNumber: who.pnr, seatNumber: who.seat, lat: pos?.lat, lng: pos?.lng, placeLabel: pos ? `${pos.placeLabel} (${pos.highway})` : null },
  });

  const alert = {
    type: 'JOURNEY_SOS', incidentId: ev.id, priority: 'P1', journeyId, busNumber: j.busNumber, operator: j.operatorName,
    seat: who.seat, pnr: who.pnr, location: pos ? { lat: pos.lat, lng: pos.lng, label: ev.placeLabel, at: pos.recordedAt } : null,
    raisedAt: ev.createdAt,
  };

  if (config.SUPPORT_WEBHOOK_URL) {
    // Fire with retry; never block the passenger's confirmation on it.
    void (async () => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await fetch(config.SUPPORT_WEBHOOK_URL!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(alert) });
          if (res.ok) return;
        } catch { /* retry */ }
        await new Promise((r) => setTimeout(r, attempt * 1500));
      }
      logger.error({ incidentId: ev.id }, 'SOS webhook failed after retries');
    })();
  }
  // TODO(platform): notify emergency contacts saved on the AbhiBus account (SMS/WhatsApp via prod_whatsapp).
  logger.warn({ incidentId: ev.id, journeyId, seat: who.seat }, '🚨 SOS raised');

  return { incidentId: ev.id, placeLabel: ev.placeLabel, supportPhone: config.SUPPORT_PHONE || null, emergencyNumber: '112' };
}
