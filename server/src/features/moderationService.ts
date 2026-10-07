import { prisma } from '../db/prisma';
import { config } from '../config';
import { hub, REMOVED_REASON } from '../realtime/hub';
import { logger } from '../lib/logger';
import { S2C, seatKey, type ReportReason, type RoomType } from '../shared/protocol';

/**
 * Report & mute engine.
 *  - One report per (message, reporter PNR). Families on one PNR count once,
 *    so a group can't brigade a stranger into silence.
 *  - A message with >= REPORT_MUTE_THRESHOLD reports is hidden for everyone.
 *  - A seat with >= REPORT_MUTE_THRESHOLD distinct reporter PNRs across the
 *    journey is muted for the rest of the trip (read-only, can still use SOS).
 *  - REMOVAL: when more than half of a room's members (distinct reporter PNRs,
 *    min 2) have reported the same person, they're removed from the trip chat
 *    for good — sockets dropped, rejoin refused (seat_mute.reason = REMOVED).
 *  - Reported content is snapshotted for trust & safety and survives the chat
 *    purge until retain_until (30 days).
 */
/** Demo hook: lets simulated passengers add their reports to a real report. */
export const reportListeners: ((journeyId: string, roomType: RoomType, reportedSeat: string, messageId: string) => void)[] = [];
const MUTE_BY_REPORTS = 'AUTO_REPORT_THRESHOLD';
export const MUTE_BY_STAFF = 'MUTED_BY_ABHIBUS';

/**
 * Mutes are read from MySQL on every check (a primary-key lookup). No
 * in-process cache: with several instances, a cache on one node would let a
 * muted passenger keep posting through another.
 */
async function muteReason(journeyId: string, seat: string): Promise<string | null> {
  const row = await prisma.seatMute.findUnique({ where: { journeyId_seatNumber: { journeyId, seatNumber: seat } }, select: { reason: true } });
  return row?.reason ?? null;
}
export async function isMuted(journeyId: string, seat: string): Promise<boolean> {
  return (await muteReason(journeyId, seat)) !== null;
}
/** What the passenger is told, by cause. Never blame other passengers for a staff action. */
export async function muteNote(journeyId: string, seat: string): Promise<string | null> {
  const reason = await muteReason(journeyId, seat);
  if (!reason) return null;
  if (reason === MUTE_BY_STAFF) return 'AbhiBus has paused your messages in this chat. You can still read it, and SOS and support work as normal.';
  if (reason === MUTE_BY_REPORTS) return 'You’ve been muted for the rest of this trip after several passengers reported your messages. You can still read the chat and use SOS.';
  return 'You can’t post in this chat. You can still read it and use SOS.';
}

/** Staff mute from the Trip Rooms console. */
export async function muteSeat(journeyId: string, seat: string) {
  if ((await muteReason(journeyId, seat)) === REMOVED_REASON) return;
  await prisma.seatMute.upsert({ where: { journeyId_seatNumber: { journeyId, seatNumber: seat } }, create: { journeyId, seatNumber: seat, reason: MUTE_BY_STAFF }, update: { reason: MUTE_BY_STAFF } });
  hub.emitToSeat(journeyId, seat, S2C.MUTED, { reason: await muteNote(journeyId, seat) });
}
/** Unmute or un-remove (staff decision, e.g. muted or removed by mistake). They can post / rejoin straight away. */
export async function clearSeat(journeyId: string, seat: string) {
  await prisma.seatMute.deleteMany({ where: { journeyId, seatNumber: seat } });
  hub.emitToSeat(journeyId, seat, S2C.UNMUTED, {});
}

export async function reportMessage(journeyId: string, reporter: { pnr: string; seat: string }, messageId: string, reason: ReportReason) {
  const msg = await prisma.message.findUnique({ where: { messageId }, include: { room: true } });
  if (!msg || msg.room.journeyId !== journeyId) return { ok: false as const, code: 'NOT_FOUND' as const };
  if (!msg.senderSeat || msg.senderSeat === reporter.seat) return { ok: false as const, code: 'INVALID' as const };

  try {
    await prisma.messageReport.create({
      data: {
        journeyId, messageId, reporterPnr: reporter.pnr, reporterSeat: reporter.seat, reportedSeat: msg.senderSeat, reason,
        contentSnapshot: { contentType: msg.contentType, payload: msg.payload as object, sentAt: msg.createdAt.toISOString(), room: msg.room.roomType },
        retainUntil: new Date(Date.now() + 30 * 24 * 3600_000),
      },
    });
  } catch (e: any) {
    if (e?.code === 'P2002') return { ok: true as const, data: null }; // already reported: idempotent
    throw e;
  }

  const threshold = config.REPORT_MUTE_THRESHOLD;
  const msgReports = await prisma.messageReport.count({ where: { messageId } });
  if (msgReports >= threshold && !msg.isHidden) {
    await prisma.message.update({ where: { messageId }, data: { isHidden: true } });
    hub.emitToJourney(journeyId, S2C.MSG_REMOVED, { roomType: msg.room.roomType as RoomType, messageId }, [msg.room.roomType as RoomType]);
  }

  const distinctReporters = await prisma.messageReport.findMany({
    where: { journeyId, reportedSeat: msg.senderSeat }, distinct: ['reporterPnr'], select: { reporterPnr: true },
  });
  if (distinctReporters.length >= threshold && !(await isMuted(journeyId, msg.senderSeat))) {
    await prisma.seatMute.upsert({
      where: { journeyId_seatNumber: { journeyId, seatNumber: msg.senderSeat } },
      create: { journeyId, seatNumber: msg.senderSeat, reason: MUTE_BY_REPORTS }, update: {},
    });
    hub.emitToSeat(journeyId, msg.senderSeat, S2C.MUTED, { reason: await muteNote(journeyId, msg.senderSeat) });
    logger.warn({ journeyId, seat: msg.senderSeat }, 'seat auto-muted after reports');
  }
  for (const l of reportListeners) l(journeyId, msg.room.roomType as RoomType, msg.senderSeat, messageId);
  await checkMajorityRemoval(journeyId, msg.room.roomType as RoomType, msg.senderSeat);
  return { ok: true as const, data: null };
}

/**
 * Report a person (from the people list), not a single message. Stored in the
 * same table so it counts toward the same majority rule; the "message id" is a
 * stable per-person key, so each reporter PNR counts once per person per room.
 * Their last few messages are snapshotted as evidence for trust & safety.
 */
export async function reportPerson(journeyId: string, reporter: { pnr: string; seat: string }, roomType: RoomType, seat: string, reason: ReportReason) {
  if (seat === reporter.seat) return { ok: false as const, code: 'INVALID' as const };
  const recent = await prisma.message.findMany({
    where: { senderSeat: seat, room: { journeyId, roomType } }, orderBy: { createdAt: 'desc' }, take: 5,
    select: { contentType: true, payload: true, createdAt: true },
  });
  try {
    await prisma.messageReport.create({
      data: {
        journeyId, messageId: `person:${roomType}:${seat}`, reporterPnr: reporter.pnr, reporterSeat: reporter.seat, reportedSeat: seat, reason,
        contentSnapshot: { kind: 'PERSON', room: roomType, recent: recent.map((m) => ({ contentType: m.contentType, payload: m.payload as object, sentAt: m.createdAt.toISOString() })) },
        retainUntil: new Date(Date.now() + 30 * 24 * 3600_000),
      },
    });
  } catch (e: any) {
    if (e?.code === 'P2002') return { ok: true as const, data: null }; // already reported this person
    throw e;
  }
  for (const l of reportListeners) l(journeyId, roomType, seat, `person:${roomType}:${seat}`);
  await checkMajorityRemoval(journeyId, roomType, seat);
  return { ok: true as const, data: null };
}

/** Remove a passenger once more than half of the room has reported them. */
export async function checkMajorityRemoval(journeyId: string, roomType: RoomType, seat: string) {
  const existing = await prisma.seatMute.findUnique({ where: { journeyId_seatNumber: { journeyId, seatNumber: seat } } });
  if (existing?.reason === REMOVED_REASON) return;
  const reports = await prisma.messageReport.findMany({ where: { journeyId, reportedSeat: seat }, select: { reporterPnr: true, contentSnapshot: true } });
  const reporters = new Set(reports.filter((r) => (r.contentSnapshot as { room?: string })?.room === roomType).map((r) => r.reporterPnr));
  const members = (await hub.presence(journeyId, roomType)).count;
  if (reporters.size < 2 || reporters.size <= members / 2) return;

  await removeSeat(journeyId, seat, 'More than half of this chat reported your messages.', 'after reports from more than half of the passengers');
  logger.warn({ journeyId, seat, reporters: reporters.size, members }, 'passenger removed by majority reports');
}

/** Remove a passenger for the rest of the trip: disconnected, can't rejoin, and the room is told. */
export async function removeSeat(journeyId: string, seat: string, toThem: string, toRoom: string) {
  await prisma.seatMute.upsert({
    where: { journeyId_seatNumber: { journeyId, seatNumber: seat } },
    create: { journeyId, seatNumber: seat, reason: REMOVED_REASON }, update: { reason: REMOVED_REASON },
  });
  const name = hub.nameOf(journeyId, seat);
  hub.emitToSeat(journeyId, seat, S2C.REMOVED, { reason: toThem });
  setTimeout(() => hub.io.in(seatKey(journeyId, seat)).disconnectSockets(true), 500);
  for (const rt of await hub.activeRoomTypes(journeyId)) {
    await hub.createMessage(journeyId, rt, { senderSeat: null, senderHandle: 'AbhiBus', contentType: 'SYSTEM', payload: { text: `🚫 ${name} was removed from this chat ${toRoom}.` } });
    hub.schedulePresence(journeyId, rt);
  }
}

export async function setBlock(journeyId: string, blockerSeat: string, blockedSeat: string, blocked: boolean) {
  const key = { journeyId_blockerSeat_blockedSeat: { journeyId, blockerSeat, blockedSeat } };
  if (blocked) await prisma.seatBlock.upsert({ where: key, create: { journeyId, blockerSeat, blockedSeat }, update: {} });
  else await prisma.seatBlock.deleteMany({ where: { journeyId, blockerSeat, blockedSeat } });
  return blockedSeats(journeyId, blockerSeat);
}

export async function blockedSeats(journeyId: string, blockerSeat: string) {
  return (await prisma.seatBlock.findMany({ where: { journeyId, blockerSeat }, select: { blockedSeat: true } })).map((b) => b.blockedSeat);
}
