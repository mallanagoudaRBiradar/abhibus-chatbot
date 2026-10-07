import type { Server } from 'socket.io';
import type { Message, MessageReaction, Prisma, ReadReceipt, RoomType as DbRoomType } from '@prisma/client';
import { publicGame } from '../features/gamesView';
import { prisma } from '../db/prisma';
import { logger } from '../lib/logger';
import { seatSort } from '../lib/util';
import {
  S2C, roomKey, seatKey,
  handleForSeat, type ChatMessage, type ContentType, type PresenceState, type RoomType,
} from '../shared/protocol';

/**
 * ============================================================================
 *  RealtimeHub — the only object that talks to socket.io rooms.
 * ============================================================================
 *  Socket.io room topology per journey:
 *    j:<journeyId>:MAIN_COMMON   every verified passenger on the bus
 *    j:<journeyId>:WOMEN_ONLY    only seats whose booking gender === 'F'
 *    s:<journeyId>:<seat>        private channel to one seat (mute notices)
 *
 *  Everything here works unchanged with the Redis adapter (multi-node):
 *  presence is computed with io.in(room).fetchSockets(), which is cluster-wide.
 * ============================================================================
 */
type MsgWithRel = Message & { receipts?: Pick<ReadReceipt, 'seatNumber'>[]; reactions?: Pick<MessageReaction, 'seatNumber' | 'emoji'>[] };

export type Profile = { name: string; avatar: string | null; guest: boolean };
/** seat_mute.reason for passengers removed after reports from more than half the room. */
export const REMOVED_REASON = 'REMOVED_BY_MAJORITY_REPORTS';

export class RealtimeHub {
  io!: Server;
  private roomIds = new Map<string, string>();               // roomKey -> roomId
  private roomJourney = new Map<string, string>();           // roomId -> journeyId (for sender profiles)
  private presenceTimers = new Map<string, NodeJS.Timeout>();
  private receiptBuf = new Map<string, Map<string, Set<string>>>(); // roomKey -> msgId -> seats
  private receiptTimer: NodeJS.Timeout | null = null;
  /** Demo simulator plugs extra "online" seats in here. */
  virtualSeats: (journeyId: string, roomType: RoomType) => string[] = () => [];
  /** Demo simulator: simulated co-passengers who count as room members. */
  virtualMembers: (journeyId: string, roomType: RoomType) => (Profile & { seat: string; gender: 'M' | 'F' | 'O' })[] = () => [];

  // ------------------------------------------------------------ profiles ---
  /** jid:seat -> display profile. Warmed from passenger_booking; crowd seats are set by the simulator. */
  private profiles = new Map<string, Profile>();
  setProfile(journeyId: string, seat: string, p: Profile) { this.profiles.set(`${journeyId}:${seat}`, p); }
  profileOf(journeyId: string, seat: string): Profile | undefined { return this.profiles.get(`${journeyId}:${seat}`); }
  /** Display name for system lines ("Rahul beat Priya…"); falls back to the seat. */
  nameOf(journeyId: string, seat: string | null | undefined) { return (seat && this.profileOf(journeyId, seat)?.name) || (seat ? handleForSeat(seat) : 'Someone'); }
  async warmProfiles(journeyId: string) {
    const rows = await prisma.passengerBooking.findMany({ where: { journeyId, deviceId: { not: null } }, select: { seatNumber: true, displayName: true, avatarId: true, channel: true } });
    for (const r of rows) if (r.displayName) this.setProfile(journeyId, r.seatNumber, { name: r.displayName, avatar: r.avatarId, guest: r.channel === 'QR' });
  }
  /** Listeners for passenger messages (used by the demo simulator). */
  onPassengerMessage: ((journeyId: string, msg: ChatMessage) => void)[] = [];

  attach(io: Server) { this.io = io; }

  // ------------------------------------------------------------- rooms ----
  async roomId(journeyId: string, roomType: RoomType): Promise<string> {
    const key = roomKey(journeyId, roomType);
    const cached = this.roomIds.get(key);
    if (cached) return cached;
    const room = await prisma.chatRoom.upsert({
      where: { journeyId_roomType: { journeyId, roomType: roomType as DbRoomType } },
      create: { journeyId, roomType: roomType as DbRoomType },
      update: {},
    });
    this.roomIds.set(key, room.roomId);
    this.roomJourney.set(room.roomId, journeyId);
    return room.roomId;
  }

  async activeRoomTypes(journeyId: string): Promise<RoomType[]> {
    const rooms = await prisma.chatRoom.findMany({ where: { journeyId, isActive: true }, select: { roomType: true } });
    return rooms.map((r) => r.roomType as RoomType);
  }

  // ----------------------------------------------------------- messages ---
  toDto(m: MsgWithRel, roomType: RoomType): ChatMessage {
    const reactions: Record<string, string[]> = {};
    for (const r of m.reactions ?? []) (reactions[r.emoji] ??= []).push(r.seatNumber);
    const room = this.roomJourney.get(m.roomId);
    const prof = m.senderSeat && room ? this.profileOf(room, m.senderSeat) : undefined;
    // Polls are stored as TEXT rows with a `poll` field (no DB enum change; old
    // clients still see the "📊 question" fallback text). Surface them as POLL.
    // Mini games likewise (TEXT row with `game`); secrets are stripped by publicGame().
    const poll = m.contentType === 'TEXT' ? (m.payload as any)?.poll : null;
    const game = m.contentType === 'TEXT' ? (m.payload as any)?.game : null;
    return {
      id: m.messageId, roomType, senderSeat: m.senderSeat, senderHandle: m.senderHandle,
      contentType: game ? 'GAME' : poll ? 'POLL' : (m.contentType as ContentType),
      payload: game ? publicGame(game) : poll ?? m.payload, createdAt: m.createdAt.toISOString(),
      senderAvatar: prof?.avatar ?? null, senderGuest: prof?.guest ?? false,
      clientMsgId: m.clientMsgId, seenBy: (m.receipts ?? []).map((r) => r.seatNumber).sort(seatSort), reactions,
    };
  }

  readonly msgInclude = { receipts: { select: { seatNumber: true } }, reactions: { select: { seatNumber: true, emoji: true }, orderBy: { createdAt: 'asc' } } } as const; // time order: first seat = first mover

  async loadMessages(journeyId: string, roomType: RoomType, opts: { before?: Date; after?: Date; limit: number; viewerSeat?: string }) {
    const roomId = await this.roomId(journeyId, roomType);
    // Private messages (support replies) only ever load for the seat they were sent to.
    const where: Prisma.MessageWhereInput = { roomId, isHidden: false, OR: [{ visibleToSeat: null }, ...(opts.viewerSeat ? [{ visibleToSeat: opts.viewerSeat }] : [])] };
    if (opts.before) where.createdAt = { lt: opts.before };
    if (opts.after) where.createdAt = { gt: opts.after };
    const rows = await prisma.message.findMany({
      where, include: this.msgInclude, orderBy: { createdAt: opts.after ? 'asc' : 'desc' }, take: opts.limit + 1,
    });
    const hasMore = rows.length > opts.limit;
    const page = rows.slice(0, opts.limit);
    if (!opts.after) page.reverse();
    return { messages: page.map((m) => this.toDto(m, roomType)), hasMore };
  }

  /**
   * Persist + fan out. Idempotent on (room, seat, clientMsgId) so a phone that
   * lost signal mid-send can safely retry from its outbox.
   */
  async createMessage(journeyId: string, roomType: RoomType, data: {
    senderSeat: string | null; senderHandle: string; contentType: Exclude<ContentType, 'POLL' | 'GAME'>; payload: object; clientMsgId?: string | null; // polls and games are stored as TEXT
    visibleToSeat?: string | null;
  }): Promise<ChatMessage> {
    const roomId = await this.roomId(journeyId, roomType);
    let row: MsgWithRel;
    try {
      row = await prisma.message.create({
        data: { roomId, senderSeat: data.senderSeat, senderHandle: data.senderHandle, contentType: data.contentType, payload: data.payload as Prisma.InputJsonValue, clientMsgId: data.clientMsgId ?? null, visibleToSeat: data.visibleToSeat ?? null },
        include: this.msgInclude,
      });
    } catch (e: any) {
      if (e?.code === 'P2002' && data.clientMsgId) {
        const existing = await prisma.message.findFirstOrThrow({ where: { roomId, senderSeat: data.senderSeat, clientMsgId: data.clientMsgId }, include: this.msgInclude });
        return this.toDto(existing, roomType); // duplicate retry: do not re-broadcast
      }
      throw e;
    }
    const dto = this.toDto(row, roomType);
    if (data.visibleToSeat) { this.io.to(seatKey(journeyId, data.visibleToSeat)).emit(S2C.MSG_NEW, dto); return dto; } // private: that seat only
    this.io.to(roomKey(journeyId, roomType)).emit(S2C.MSG_NEW, dto);
    if (dto.senderSeat) for (const l of this.onPassengerMessage) l(journeyId, dto);
    return dto;
  }

  /** Re-send a message that changed after it was posted (game revealed / solved / expired). */
  async pushUpdate(messageId: string) {
    const m = await prisma.message.findUnique({ where: { messageId }, include: { ...this.msgInclude, room: true } });
    if (!m) return;
    const roomType = m.room.roomType as RoomType;
    this.io.to(roomKey(m.room.journeyId, roomType)).emit(S2C.MSG_UPDATE, this.toDto(m, roomType));
  }

  /** Broadcast a message's reaction set (emoji reactions, poll votes and game moves all share it). */
  async emitReactions(journeyId: string, roomType: RoomType, messageId: string) {
    const all = await prisma.messageReaction.findMany({ where: { messageId }, select: { seatNumber: true, emoji: true }, orderBy: { createdAt: 'asc' } });
    const reactions: Record<string, string[]> = {};
    for (const r of all) (reactions[r.emoji] ??= []).push(r.seatNumber);
    this.io.to(roomKey(journeyId, roomType)).emit(S2C.REACTIONS, { roomType, messageId, reactions });
  }

  /** Conductor / system posts go to every active room on the bus. */
  async broadcastToJourney(journeyId: string, contentType: Exclude<ContentType, 'POLL' | 'GAME'>, payload: object, senderHandle = 'Conductor') {
    const out: { roomType: RoomType; message: ChatMessage }[] = [];
    for (const roomType of await this.activeRoomTypes(journeyId))
      out.push({ roomType, message: await this.createMessage(journeyId, roomType, { senderSeat: null, senderHandle, contentType, payload }) });
    return out;
  }

  emitToJourney(journeyId: string, event: string, data: unknown, roomTypes: RoomType[] = ['MAIN_COMMON', 'WOMEN_ONLY']) {
    for (const rt of roomTypes) this.io.to(roomKey(journeyId, rt)).emit(event, data);
  }
  emitToSeat(journeyId: string, seat: string, event: string, data: unknown) {
    this.io.to(seatKey(journeyId, seat)).emit(event, data);
  }

  // ----------------------------------------------------------- presence ---
  async presence(journeyId: string, roomType: RoomType): Promise<PresenceState> {
    const sockets = await this.io.in(roomKey(journeyId, roomType)).fetchSockets();
    const seats = new Set<string>(sockets.map((s) => s.data.seat as string));
    for (const v of this.virtualSeats(journeyId, roomType)) seats.add(v);
    const onlineSeats = [...seats].sort(seatSort);

    // Members = everyone who has joined this room (women room: F bookings only), minus people removed by reports.
    const [rows, removed] = await Promise.all([
      prisma.passengerBooking.findMany({
        where: { journeyId, deviceId: { not: null }, ...(roomType === 'WOMEN_ONLY' ? { gender: 'F' as const } : {}) },
        select: { seatNumber: true, gender: true, displayName: true, avatarId: true, channel: true, invitedBy: true },
      }),
      prisma.seatMute.findMany({ where: { journeyId, reason: REMOVED_REASON }, select: { seatNumber: true } }),
    ]);
    const gone = new Set(removed.map((r) => r.seatNumber));
    const people = [
      ...rows.filter((r) => !gone.has(r.seatNumber)).map((r) => {
        const p = { name: r.displayName ?? handleForSeat(r.seatNumber), avatar: r.avatarId, guest: r.channel === 'QR' };
        if (r.displayName) this.setProfile(journeyId, r.seatNumber, p);
        return { seat: r.seatNumber, gender: r.gender, ...p, invitedBy: r.invitedBy ? this.nameOf(journeyId, r.invitedBy) : null };
      }),
      ...this.virtualMembers(journeyId, roomType).filter((v) => !gone.has(v.seat)),
    ];
    const members = people
      .map(({ gender: _g, ...m }) => ({ ...m, online: seats.has(m.seat) }))
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
    return {
      roomType, onlineSeats, count: members.length, members,
      men: people.filter((p) => p.gender === 'M').length,
      women: people.filter((p) => p.gender === 'F').length,
      guests: people.filter((p) => p.guest).length,
    };
  }

  /** Debounced: a bus entering a tunnel can drop 20 sockets at once. */
  schedulePresence(journeyId: string, roomType: RoomType) {
    const key = roomKey(journeyId, roomType);
    clearTimeout(this.presenceTimers.get(key));
    this.presenceTimers.set(key, setTimeout(async () => {
      this.presenceTimers.delete(key);
      try { this.io.to(key).emit(S2C.PRESENCE, await this.presence(journeyId, roomType)); }
      catch (e) { logger.warn({ err: e }, 'presence emit failed'); }
    }, 500));
  }

  // ----------------------------------------------------------- receipts ---
  /**
   * Read receipts are buffered and flushed as one batch per room every 800ms.
   * On a full bus, 30 phones scrolling past the same message would otherwise
   * generate 30 broadcasts x 30 recipients.
   */
  queueReceipts(journeyId: string, roomType: RoomType, messageIds: string[], seat: string) {
    const key = roomKey(journeyId, roomType);
    const room = this.receiptBuf.get(key) ?? new Map<string, Set<string>>();
    for (const id of messageIds) (room.get(id) ?? room.set(id, new Set()).get(id)!).add(seat);
    this.receiptBuf.set(key, room);
    this.receiptTimer ??= setTimeout(() => this.flushReceipts(), 800);
  }
  private flushReceipts() {
    this.receiptTimer = null;
    for (const [key, room] of this.receiptBuf) {
      const roomType = key.split(':').pop() as RoomType;
      const updates = [...room].map(([messageId, seats]) => ({ messageId, seats: [...seats] }));
      this.io.to(key).emit(S2C.RECEIPTS, { roomType, updates });
    }
    this.receiptBuf.clear();
  }

  // ------------------------------------------------------------ teardown --
  async closeJourney(journeyId: string) {
    for (const rt of ['MAIN_COMMON', 'WOMEN_ONLY'] as RoomType[]) {
      const key = roomKey(journeyId, rt);
      this.io.to(key).emit(S2C.JOURNEY_CLOSED, {});
      this.io.in(key).disconnectSockets(true);
      this.roomIds.delete(key);
    }
  }
}

export const hub = new RealtimeHub();
