import type { Server } from 'socket.io';
import { prisma } from '../db';
import { roomKey, seatKey, tripKey, type PresenceState, type RoomType, S2C } from '../shared/protocol';
import { getTenant } from './tenants';
import { display } from './identity';
import { logger } from '../lib/logger';

/**
 * The only object that talks to socket.io rooms.
 *   r:<room>:<channel>  members who joined that channel
 *   m:<room>:<member>   one member's sockets (private messages, moderation)
 *   t:<room>            every connected member of the trip (room-level updates)
 */
class Hub {
  io!: Server;
  attach(io: Server) { this.io = io; }
  toChannel(roomId: string, rt: RoomType, ev: string, data: unknown) { this.io?.to(roomKey(roomId, rt)).emit(ev, data); }
  toMember(roomId: string, memberId: string, ev: string, data: unknown) { this.io?.to(seatKey(roomId, memberId)).emit(ev, data); }
  toTrip(roomId: string, ev: string, data: unknown) { this.io?.to(tripKey(roomId)).emit(ev, data); }
  async disconnectMember(roomId: string, memberId: string) { this.io?.in(seatKey(roomId, memberId)).disconnectSockets(true); }

  private presenceTimers = new Map<string, NodeJS.Timeout>();
  /** Members of a channel (women channel: tenant-marked F only), with online flags. Gender only as counts. */
  async presence(roomId: string, rt: RoomType): Promise<PresenceState> {
    const room = await prisma.room.findUniqueOrThrow({ where: { id: roomId } });
    const { cfg } = await getTenant(room.tenantId);
    const sockets = this.io ? await this.io.in(roomKey(roomId, rt)).fetchSockets() : [];
    const online = new Set(sockets.map((s) => s.data.memberId as string));
    const rows = await prisma.member.findMany({ where: { roomId, removedAt: null, role: 'traveller', ...(rt === 'WOMEN_ONLY' ? { gender: 'F' as const } : {}) } });
    const members = rows.map((m) => ({ seat: m.id, ...display(m, cfg.identity.mode), online: online.has(m.id), guest: false, invitedBy: null }))
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
    return {
      roomType: rt, onlineSeats: [...online], count: members.length, members,
      men: rows.filter((m) => m.gender === 'M').length, women: rows.filter((m) => m.gender === 'F').length, guests: 0,
    };
  }
  schedulePresence(roomId: string, rt: RoomType) {
    const k = roomKey(roomId, rt);
    clearTimeout(this.presenceTimers.get(k));
    this.presenceTimers.set(k, setTimeout(async () => {
      this.presenceTimers.delete(k);
      try { this.toChannel(roomId, rt, S2C.PRESENCE, await this.presence(roomId, rt)); } catch (err) { logger.warn({ err }, 'presence failed'); }
    }, 500));
  }
}
export const hub = new Hub();
