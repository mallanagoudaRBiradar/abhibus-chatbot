import { prisma } from '../db/prisma';
import { config } from '../config';
import { bookingSource, journeyIdFor } from '../booking';
import { DEMO } from '../demo/demoData';
import { randomUUID } from 'crypto';
import { networkInterfaces } from 'os';
import { signChatToken, signQrToken, verifyQrToken } from '../auth/tokens';
import { tracker } from '../tracking/gpsProvider';
import { haversineKm } from '../lib/geo';
import { logger } from '../lib/logger';
import { maskPnr, normalisePnr, normaliseSeat } from '../lib/util';
import { AVATARS, DISPLAY_NAME_RE, QR_RADIUS_KM, type JoinResponse, type JourneyInfo, type QrInvite, type QrJoinCheck } from '../shared/protocol';
import { checkMessage } from '../shared/moderation';
import { hub, REMOVED_REASON } from '../realtime/hub';
import type { BusJourney } from '@prisma/client';

export class JoinError extends Error {
  constructor(public code: 'NOT_FOUND' | 'TRIP_NOT_LIVE' | 'SEAT_CLAIMED' | 'JOURNEY_CLOSED' | 'INVALID' | 'REMOVED' | 'TOO_FAR', message: string, public meta?: Record<string, unknown>) { super(message); }
}

export interface ProfileInput { name: string; avatar: string | null }
/** First name + avatar the passenger picks. Letters only and run through the chat filter (no numbers / handles in names). */
export function cleanProfile(p: ProfileInput): ProfileInput {
  const name = p.name.trim().replace(/\s+/g, ' ');
  if (!DISPLAY_NAME_RE.test(name)) throw new JoinError('INVALID', 'Use your first name — letters only, up to 24 characters.');
  const verdict = checkMessage(name);
  if (!verdict.ok) throw new JoinError('INVALID', 'Please choose a different name.');
  if (p.avatar && !AVATARS[p.avatar]) throw new JoinError('INVALID', 'Pick an avatar from the list.');
  return { name, avatar: p.avatar ?? null };
}

export async function assertNotRemoved(journeyId: string, seat: string) {
  const ban = await prisma.seatMute.findUnique({ where: { journeyId_seatNumber: { journeyId, seatNumber: seat } } });
  if (ban?.reason === REMOVED_REASON) throw new JoinError('REMOVED', 'You were removed from this trip chat after reports from other passengers.');
}

/** One generic message for every "who are you" failure: no PNR/seat enumeration. */
const NOT_FOUND = () => new JoinError('NOT_FOUND', 'We couldn’t find an active trip for this PNR and seat. Check your ticket and try again.');

/**
 * PNR + Seat -> chat token.
 *
 *  1. Read the booking from abrs_new (read-only) — or the demo source.
 *  2. Confirm the seat belongs to the PNR and the ticket is confirmed.
 *  3. Upsert the journey + a privacy-stripped projection of ALL seats on the
 *     PNR (needed for family bookings & the women-room gate).
 *  4. Enforce the chat window: opens CHAT_OPEN_BEFORE_START_MIN before
 *     departure, closes PURGE_AFTER_ARRIVAL_MIN after arrival.
 *  5. Bind the seat to this device (first device wins) to stop a co-traveller
 *     on the same PNR from impersonating another seat, especially to reach
 *     the women-only room.
 *  6. Issue a seat-scoped JWT that expires at purge time.
 */
/**
 * Demo only. A demo ticket is shared by everyone trying the app, so:
 *  - first browser to tap it gets the ticket's seat;
 *  - the same browser always gets its own seat back (rejoin, reload, second tab);
 *  - any other browser gets a fresh seat on the same bus with the same ticket type,
 *    as a new PNR (e.g. AB7X2K9QG2), so it is a separate passenger everywhere
 *    (name, reports, women-only access, Trip Rooms console).
 */
async function demoSeatFor(pnr: string, seat: string, deviceId: string): Promise<{ pnr: string; seat: string }> {
  const base = DEMO.tickets.find((t) => t.pnr === pnr);
  if (!base) return { pnr, seat };
  const journeyId = journeyIdFor(DEMO.serviceId, DEMO.journeyDate());
  const rows = await prisma.passengerBooking.findMany({ where: { journeyId } });
  const mine = rows.find((r) => r.deviceId === deviceId && (r.pnrNumber === pnr || r.pnrNumber.startsWith(`${pnr}G`)));
  if (mine) return { pnr: mine.pnrNumber, seat: mine.seatNumber };
  const held = rows.find((r) => r.seatNumber === seat && r.deviceId && r.deviceId !== deviceId);
  if (!held) return { pnr, seat };
  const gender = base.seats.find((s) => s.seat === seat)?.gender ?? base.seats[0].gender;
  const taken = new Set([...rows.map((r) => r.seatNumber), ...DEMO.crowd.map((c) => c.seat), ...DEMO.tickets.flatMap((t) => t.seats.map((s) => s.seat)), ...[...DEMO.extraTickets.values()].flatMap((t) => t.seats.map((s) => s.seat))]);
  const free = Array.from({ length: 30 }, (_, i) => i + 1).flatMap((n) => ['L', 'U'].map((b) => `${n}${b}`)).find((s) => !taken.has(s));
  if (!free) throw new JoinError('SEAT_CLAIMED', 'The demo bus is full. Try again after the next restart.');
  let k = 2;
  while (DEMO.extraTickets.has(`${pnr}G${k}`) || rows.some((r) => r.pnrNumber === `${pnr}G${k}`)) k++;
  const extra = { pnr: `${pnr}G${k}`, label: `${base.label} (another browser)`, seats: [{ seat: free, gender }] };
  DEMO.extraTickets.set(extra.pnr, extra);
  logger.info({ ticket: pnr, seat: free, pnr: extra.pnr }, 'demo: another browser joined, gave it its own seat');
  return { pnr: extra.pnr, seat: free };
}

export async function joinJourney(input: { pnr: string; seat: string; deviceId: string; profile: ProfileInput }): Promise<JoinResponse> {
  const profile = cleanProfile(input.profile);
  let pnr = normalisePnr(input.pnr);
  let seat = normaliseSeat(input.seat);
  if (config.DEMO_MODE) ({ pnr, seat } = await demoSeatFor(pnr, seat, input.deviceId));
  if (!/^[A-Z0-9]{4,20}$/.test(pnr) || !/^[A-Z0-9]{1,6}$/.test(seat) || input.deviceId.length < 8) throw NOT_FOUND();

  const booking = await bookingSource.findByPnr(pnr);
  if (!booking || !booking.isActive) throw NOT_FOUND();
  const mySeat = booking.seats.find((s) => s.seat === seat);
  if (!mySeat) throw NOT_FOUND();

  const journeyId = journeyIdFor(booking.serviceId, booking.journeyDate);
  let journey = await prisma.busJourney.findUnique({ where: { journeyId } });

  if (!journey) {
    // Schedule must come from the ticket tables or from ops registration.
    if (!booking.schedule) throw new JoinError('TRIP_NOT_LIVE', 'Trip chat opens when your bus is about to depart.');
    journey = await prisma.busJourney.create({
      data: {
        journeyId,
        serviceId: booking.serviceId,
        journeyDate: booking.journeyDate,
        busNumber: booking.meta.busNumber ?? 'Bus details pending',
        operatorName: booking.meta.operatorName ?? 'AbhiBus partner',
        routeName: config.DEMO_MODE ? DEMO.routeName : `${booking.meta.sourceCity ?? 'Origin'} to ${booking.meta.destinationCity ?? 'Destination'}`,
        sourceCity: booking.meta.sourceCity ?? 'Origin',
        destinationCity: booking.meta.destinationCity ?? 'Destination',
        startTime: booking.schedule.start,
        estimatedEndTime: booking.schedule.end,
        status: 'SCHEDULED',
      },
    });
  }

  if (journey.status === 'PURGED') throw new JoinError('JOURNEY_CLOSED', 'This trip chat has ended.');
  const now = Date.now();
  const opensAt = +journey.startTime - config.CHAT_OPEN_BEFORE_START_MIN * 60_000;
  if (now < opensAt) throw new JoinError('TRIP_NOT_LIVE', 'Trip chat isn’t open yet.', { opensAt: new Date(opensAt).toISOString() });
  const closesAt = purgeTimeFor(journey);
  if (now > +closesAt) throw new JoinError('JOURNEY_CLOSED', 'This trip chat has ended.');
  if (journey.status === 'SCHEDULED' && now >= +journey.startTime)
    journey = await prisma.busJourney.update({ where: { journeyId }, data: { status: 'IN_TRANSIT' } });

  // Projection of every seat on this PNR. Name/age are never read, never stored.
  await prisma.$transaction(
    booking.seats.map((s) =>
      prisma.passengerBooking.upsert({
        where: { journeyId_seatNumber: { journeyId, seatNumber: s.seat } },
        create: { journeyId, seatNumber: s.seat, pnrNumber: pnr, gender: s.gender, phoneHash: s.phoneHash, channel: booking.channel },
        update: { pnrNumber: pnr, gender: s.gender, phoneHash: s.phoneHash },
      }),
    ),
  );

  // Seat <-> device binding.
  const row = await prisma.passengerBooking.findUniqueOrThrow({ where: { journeyId_seatNumber: { journeyId, seatNumber: seat } } });
  // Real trips: a seat belongs to the first phone that claims it (stops a co-traveller
  // on a family PNR taking over a woman's seat). Demo: tickets are shared by everyone
  // trying the app, so the newest device simply takes the seat over.
  const takeover = false; // demo: each browser gets its own seat (demoSeatFor), never someone else's
  if (row.deviceId && row.deviceId !== input.deviceId && !takeover)
    throw new JoinError('SEAT_CLAIMED', 'This seat is already in the chat on another phone. Contact AbhiBus support if that isn’t you.');
  await assertNotRemoved(journeyId, seat);
  await prisma.passengerBooking.update({
    where: { id: row.id },
    data: { displayName: profile.name, avatarId: profile.avatar, ...(row.deviceId && !takeover ? {} : { deviceId: input.deviceId, claimedAt: new Date() }) },
  });
  hub.setProfile(journeyId, seat, { name: profile.name, avatar: profile.avatar, guest: false });

  await prisma.chatRoom.upsert({
    where: { journeyId_roomType: { journeyId, roomType: 'MAIN_COMMON' } },
    create: { journeyId, roomType: 'MAIN_COMMON' }, update: {},
  });

  const token = signChatToken({ jid: journeyId, pnr, seat }, closesAt);
  return {
    token,
    me: { seat, handle: profile.name, name: profile.name, avatar: profile.avatar, guest: false, pnrMasked: maskPnr(pnr), gender: mySeat.gender },
    journey: await journeyInfo(journey),
    supportPhone: config.SUPPORT_PHONE || null,
  };
}

export function purgeTimeFor(j: Pick<BusJourney, 'purgeAt' | 'actualEndTime' | 'estimatedEndTime'>): Date {
  if (j.purgeAt) return j.purgeAt;
  const arrival = j.actualEndTime ?? j.estimatedEndTime;
  return new Date(+arrival + config.PURGE_AFTER_ARRIVAL_MIN * 60_000);
}

export async function journeyInfo(j: BusJourney): Promise<JourneyInfo> {
  const totalSeatsBooked = config.DEMO_MODE
    ? DEMO.crowd.length + DEMO.tickets.reduce((n, t) => n + t.seats.length, 0)
    : await prisma.passengerBooking.count({ where: { journeyId: j.journeyId } });
  return {
    journeyId: j.journeyId, busNumber: j.busNumber, operatorName: j.operatorName, routeName: j.routeName,
    sourceCity: j.sourceCity, destinationCity: j.destinationCity,
    startTime: j.startTime.toISOString(), estimatedEndTime: j.estimatedEndTime.toISOString(),
    status: j.status, purgeAt: purgeTimeFor(j).toISOString(), totalSeatsBooked,
  };
}

// ------------------------------------------------------------- QR guests ---
/**
 * Where a scanned QR takes the phone. It must be a normal web link: people
 * booked elsewhere won't have the AbhiBus app, and every phone camera opens
 * https links. Production: PUBLIC_WEB_URL (a universal link that opens the app
 * if installed, the web chat otherwise). Dev/demo: this laptop's Wi-Fi address
 * on the Expo web port, so a phone on the same network can open it.
 */
export function publicWebUrl() {
  if (config.PUBLIC_WEB_URL) return config.PUBLIC_WEB_URL.replace(/\/$/, '');
  // Prefer the Wi-Fi / Ethernet adapter over VPN tunnels and Docker bridges.
  const all = Object.entries(networkInterfaces()).flatMap(([name, list]) => (list ?? []).map((i) => ({ name, ...i })))
    .filter((i) => i.family === 'IPv4' && !i.internal && !/^(utun|tun|tap|docker|br-|veth|vboxnet|bridge|llw|awdl)/.test(i.name));
  const lan = all.find((i) => /^(en|eth|wlan|wl)/.test(i.name)) ?? all[0];
  return `http://${lan?.address ?? 'localhost'}:8081`;
}
const kmBetween = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => Math.round(haversineKm(a, b) * 10) / 10;

/** Provider side: a PNR-verified passenger near the bus mints an invite valid until the chat ends. */
export async function createQrInvite(journeyId: string, seat: string, coords: { lat: number; lng: number }): Promise<QrInvite> {
  const booking = await prisma.passengerBooking.findUnique({ where: { journeyId_seatNumber: { journeyId, seatNumber: seat } } });
  if (!booking || booking.channel === 'QR') throw new JoinError('INVALID', 'Only passengers with an AbhiBus ticket can invite others.');
  const journey = await prisma.busJourney.findUniqueOrThrow({ where: { journeyId } });
  const pos = await tracker.getPosition(journey);
  const providerKm = pos ? kmBetween(coords, pos) : null;
  const skipped = config.DEMO_MODE;
  if (!skipped && (providerKm == null || providerKm > QR_RADIUS_KM))
    throw new JoinError('TOO_FAR', `You need to be with the bus to invite someone (you’re ${providerKm ?? '?'} km away).`);
  const expiresAt = purgeTimeFor(journey);
  const token = signQrToken({ jid: journeyId, by: seat, lat: coords.lat, lng: coords.lng }, expiresAt);
  return { token, link: `${publicWebUrl()}/?qr=${encodeURIComponent(token)}`, expiresAt: expiresAt.toISOString(), check: { providerKm, skipped } };
}

/**
 * Scanner side: someone booked elsewhere (e.g. RedBus) joins as a guest.
 * They must be within QR_RADIUS_KM of the bus AND of where the QR was shown.
 * Guests get gender 'O' (unverified), so the women-only gate never opens for them.
 */
export async function joinViaQr(input: { token: string; coords: { lat: number; lng: number } | null; deviceId: string; profile: ProfileInput }): Promise<JoinResponse & { qrCheck: QrJoinCheck }> {
  const profile = cleanProfile(input.profile);
  let claims;
  try { claims = verifyQrToken(input.token); } catch { throw new JoinError('NOT_FOUND', 'This QR code isn’t valid any more. Ask a passenger to show a fresh one.'); }
  const journey = await prisma.busJourney.findUnique({ where: { journeyId: claims.jid } });
  if (!journey || journey.status === 'PURGED' || Date.now() > +purgeTimeFor(journey)) throw new JoinError('JOURNEY_CLOSED', 'This trip chat has ended.');

  const pos = await tracker.getPosition(journey);
  const busKm = pos && input.coords ? kmBetween(input.coords, pos) : null;
  const providerKm = input.coords ? kmBetween(input.coords, claims) : null;
  const skipped = config.DEMO_MODE;
  if (!skipped && !input.coords) throw new JoinError('TOO_FAR', 'Turn on location so we can confirm you’re with this bus.');
  if (!skipped && (busKm == null || busKm > QR_RADIUS_KM || providerKm! > QR_RADIUS_KM))
    throw new JoinError('TOO_FAR', 'You need to be on or next to this bus to join with its QR code.', { busKm, providerKm });

  const journeyId = journey.journeyId;
  const existing = await prisma.passengerBooking.findFirst({ where: { journeyId, deviceId: input.deviceId } });
  if (existing && existing.channel !== 'QR') throw new JoinError('INVALID', 'This phone is already in the chat with an AbhiBus ticket — join with your PNR.');
  let row = existing;
  if (row) {
    await assertNotRemoved(journeyId, row.seatNumber);
    row = await prisma.passengerBooking.update({ where: { id: row.id }, data: { displayName: profile.name, avatarId: profile.avatar } });
  } else {
    const guests = await prisma.passengerBooking.count({ where: { journeyId, channel: 'QR' } });
    row = await prisma.passengerBooking.create({
      data: {
        journeyId, seatNumber: `G${guests + 1}`, pnrNumber: `QR-${randomUUID().slice(0, 8).toUpperCase()}`, gender: 'O', channel: 'QR',
        deviceId: input.deviceId, claimedAt: new Date(), displayName: profile.name, avatarId: profile.avatar, invitedBy: claims.by,
      },
    });
    // A friendly heads-up in the lounge, so a new face doesn't appear out of nowhere.
    void hub.createMessage(journeyId, 'MAIN_COMMON', {
      senderSeat: null, senderHandle: 'AbhiBus', contentType: 'SYSTEM',
      payload: { text: `🎟️ ${profile.name} hopped on with ${hub.nameOf(journeyId, claims.by)}’s QR — say hi! 👋` },
    }).catch(() => {});
  }
  hub.setProfile(journeyId, row.seatNumber, { name: profile.name, avatar: profile.avatar, guest: true });
  logger.info({ journeyId, guest: row.seatNumber, invitedBy: claims.by, busKm, providerKm, skipped }, 'guest joined via QR');

  return {
    token: signChatToken({ jid: journeyId, pnr: row.pnrNumber, seat: row.seatNumber }, purgeTimeFor(journey)),
    me: { seat: row.seatNumber, handle: profile.name, name: profile.name, avatar: profile.avatar, guest: true, pnrMasked: 'Guest via QR', gender: 'O' },
    journey: await journeyInfo(journey),
    supportPhone: config.SUPPORT_PHONE || null,
    qrCheck: { busKm, providerKm, skipped },
  };
}
