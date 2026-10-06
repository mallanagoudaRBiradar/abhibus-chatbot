import { prisma } from '../db/prisma';
import { hub } from '../realtime/hub';
import { roomKey, S2C, type BroadcastPayload, type PinnedState, type RoomType } from '../shared/protocol';

type RestStop = Extract<BroadcastPayload, { kind: 'REST_STOP' }>;
const GRACE_MS = 90_000; // keep the "Bus is leaving" state visible briefly after zero

/**
 * Conductor triggers a break -> one BROADCAST message per active room, pinned
 * at the top of each. The app renders a live countdown from `endsAt` corrected
 * by the server-clock offset, so every phone hits 00:00 at the same moment.
 */
export async function startRestStop(journeyId: string, input: { label: string; durationMin: number; place?: string | null }) {
  const startedAt = new Date();
  const durationSec = Math.round(input.durationMin * 60);
  const payload: RestStop = {
    kind: 'REST_STOP', label: input.label, place: input.place ?? null,
    startedAt: startedAt.toISOString(), endsAt: new Date(+startedAt + durationSec * 1000).toISOString(), durationSec,
  };
  const posted = await hub.broadcastToJourney(journeyId, 'BROADCAST', payload);
  for (const { roomType, message } of posted) {
    await prisma.chatRoom.update({ where: { journeyId_roomType: { journeyId, roomType } }, data: { pinnedMessageId: message.id } });
    hub.io.to(roomKey(journeyId, roomType)).emit(S2C.PINNED, { pinned: { messageId: message.id, payload } satisfies PinnedState });
  }
  return payload;
}

export async function endRestStop(journeyId: string, opts: { announce: boolean }) {
  const rooms = await prisma.chatRoom.findMany({ where: { journeyId, pinnedMessageId: { not: null } } });
  if (!rooms.length) return false;
  let label = 'Break';
  for (const room of rooms) {
    const pinned = await prisma.message.findUnique({ where: { messageId: room.pinnedMessageId! } });
    label = (pinned?.payload as any)?.label ?? label;
    await prisma.chatRoom.update({ where: { roomId: room.roomId }, data: { pinnedMessageId: null } });
    hub.io.to(roomKey(journeyId, room.roomType as RoomType)).emit(S2C.PINNED, { pinned: null });
  }
  if (opts.announce) await hub.broadcastToJourney(journeyId, 'BROADCAST', { kind: 'REST_STOP_ENDED', label } satisfies BroadcastPayload);
  return true;
}

export async function getPinned(journeyId: string, roomType: RoomType): Promise<PinnedState | null> {
  const room = await prisma.chatRoom.findUnique({ where: { journeyId_roomType: { journeyId, roomType } } });
  if (!room?.pinnedMessageId) return null;
  const msg = await prisma.message.findUnique({ where: { messageId: room.pinnedMessageId } });
  const payload = msg?.payload as RestStop | undefined;
  if (!msg || payload?.kind !== 'REST_STOP') return null;
  if (Date.parse(payload.endsAt) + GRACE_MS < Date.now()) return null;
  return { messageId: msg.messageId, payload };
}

/** Called by the ticker: auto-unpin breaks once the timer + grace has elapsed. */
export async function sweepExpiredRestStop(journeyId: string) {
  const room = await prisma.chatRoom.findFirst({ where: { journeyId, pinnedMessageId: { not: null } } });
  if (!room) return;
  const msg = await prisma.message.findUnique({ where: { messageId: room.pinnedMessageId! } });
  const p = msg?.payload as RestStop | undefined;
  if (!p || Date.parse(p.endsAt) + GRACE_MS < Date.now()) await endRestStop(journeyId, { announce: true });
}
