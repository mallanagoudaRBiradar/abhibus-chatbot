import { prisma } from '../db/prisma';
import { hub } from '../realtime/hub';
import { roomKey } from '../shared/protocol';
import { Polyline } from '../lib/geo';
import { FIX_STALE_MS, routeOf, tracker } from '../tracking/gpsProvider';
import type { TripInfo } from '../shared/protocol';

/**
 * The trip panel (tap the route in the header): who's on this bus and where
 * it is, straight from our DB.
 *  - travellers: live bookings (cancelled seats are deleted at ingestion), how
 *    many have joined the chat, women and QR guests. Online comes from presence on the phone.
 *  - stops: the journey route (partner route, or built from passengers'
 *    boarding/dropping points), with times, how many board/drop there and
 *    whether the bus has passed it. Your own stops are marked.
 *  - bus: latest GPS fix if it's fresh, else an estimate from the timetable.
 * Counts only, never names or seats.
 */
export async function tripInfo(journeyId: string, mySeat: string): Promise<TripInfo | null> {
  const [j, rows] = await Promise.all([
    prisma.busJourney.findUnique({ where: { journeyId } }),
    prisma.passengerBooking.findMany({
      where: { journeyId },
      select: { seatNumber: true, gender: true, channel: true, deviceId: true, boardingName: true, boardingAt: true, droppingName: true, droppingAt: true },
    }),
  ]);
  if (!j) return null;

  const connected = new Set((await hub.io.in(roomKey(journeyId, 'MAIN_COMMON')).fetchSockets()).map((s) => s.data.seat as string));
  const ticketed = rows.filter((r) => r.channel !== 'QR');
  const travellers = {
    booked: ticketed.length,
    joined: rows.filter((r) => r.deviceId || connected.has(r.seatNumber)).length,
    women: ticketed.filter((r) => r.gender === 'F').length,
    guests: rows.length - ticketed.length,
  };

  const pos = await tracker.getPosition(j);
  const progress = pos?.progress ?? 0;
  const gps = !!(j.lastFixAt && j.lastLat != null && Date.now() - +j.lastFixAt < FIX_STALE_MS);
  const bus = pos && {
    placeLabel: pos.placeLabel, progress, speedKmph: pos.speedKmph, lat: pos.lat, lng: pos.lng,
    nextStop: pos.nextStop, eta: pos.etaToDestination?.toISOString() ?? null,
    source: gps ? 'GPS' as const : 'SCHEDULE' as const, fixAt: gps ? j.lastFixAt!.toISOString() : null,
  };

  const me = rows.find((r) => r.seatNumber === mySeat);
  const count = (key: 'boardingName' | 'droppingName', name: string) => rows.filter((r) => r[key] === name).length;
  const timeAt = (key: 'boardingName' | 'droppingName', at: 'boardingAt' | 'droppingAt', name: string) =>
    rows.find((r) => r[key] === name && r[at])?.[at]?.toISOString() ?? null;
  const stops = routeOf(j);
  const line = stops.length >= 2 ? new Polyline(stops) : null;
  const list = stops.map((s, i) => {
    const boarding = count('boardingName', s.name);
    const dropping = count('droppingName', s.name);
    const at = s.at ?? timeAt('boardingName', 'boardingAt', s.name) ?? timeAt('droppingName', 'droppingAt', s.name);
    const passed = line ? line.fracOf(i) < progress - 0.005 : !!at && Date.parse(at) < Date.now();
    return {
      name: s.name, kind: s.kind ?? (boarding ? 'PICKUP' : dropping ? 'DROP' : 'STOP'), at, passed, boarding, dropping,
      mine: me?.boardingName === s.name ? 'BOARD' as const : me?.droppingName === s.name ? 'DROP' as const : null,
    };
  });

  return {
    travellers, bus,
    stops: list,
    schedule: { departs: j.startTime.toISOString(), arrives: j.estimatedEndTime.toISOString() },
    myStops: me ? { boarding: me.boardingName, boardingAt: me.boardingAt?.toISOString() ?? null, dropping: me.droppingName, droppingAt: me.droppingAt?.toISOString() ?? null } : null,
  };
}
