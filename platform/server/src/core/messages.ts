import type { ChannelKind, ContentType as DbContentType, Member, Message, Prisma, Reaction, Receipt } from '@prisma/client';
import { prisma } from '../db';
import { hub } from './hub';
import { getTenant } from './tenants';
import { display } from './identity';
import { publicGame } from './gamesView';
import { S2C, type ChatMessage, type ContentType, type RoomType } from '../shared/protocol';

export const KIND_TO_RT: Record<ChannelKind, RoomType> = { MAIN: 'MAIN_COMMON', WOMEN: 'WOMEN_ONLY' };
export const RT_TO_KIND: Record<RoomType, ChannelKind> = { MAIN_COMMON: 'MAIN', WOMEN_ONLY: 'WOMEN' };

/** DB content type ↔ protocol content type (location kept under its old protocol name). */
const toProto = (c: DbContentType): ContentType => (c === 'LOCATION' ? 'BUS_LOCATION' : (c as ContentType));
const toDb = (c: ContentType): DbContentType => (c === 'BUS_LOCATION' ? 'LOCATION' : c === 'BROADCAST' ? 'ALERT' : (c as DbContentType));

const channelCache = new Map<string, { id: string; roomId: string; kind: ChannelKind }>();
export async function channelOf(roomId: string, rt: RoomType) {
  const key = `${roomId}:${rt}`;
  const hit = channelCache.get(key);
  if (hit) return hit;
  const ch = await prisma.channel.upsert({ where: { roomId_kind: { roomId, kind: RT_TO_KIND[rt] } }, create: { roomId, kind: RT_TO_KIND[rt] }, update: {} });
  const v = { id: ch.id, roomId, kind: ch.kind };
  channelCache.set(key, v);
  channelCache.set(`id:${ch.id}`, v);
  return v;
}
export async function channelById(id: string) {
  const hit = channelCache.get(`id:${id}`);
  if (hit) return hit;
  const ch = await prisma.channel.findUniqueOrThrow({ where: { id } });
  const v = { id, roomId: ch.roomId, kind: ch.kind };
  channelCache.set(`id:${id}`, v);
  return v;
}
export async function channelsOf(roomId: string) {
  return prisma.channel.findMany({ where: { roomId } });
}

type Row = Message & { reactions?: Pick<Reaction, 'memberId' | 'key'>[]; receipts?: Pick<Receipt, 'memberId'>[] };
export const msgInclude = { reactions: { select: { memberId: true, key: true }, orderBy: { createdAt: 'asc' as const } }, receipts: { select: { memberId: true } } };

/** Sender profiles for a batch of messages (identity depends on tenant mode). */
async function senders(roomId: string, ids: string[]) {
  const room = await prisma.room.findUniqueOrThrow({ where: { id: roomId }, select: { tenantId: true } });
  const { cfg } = await getTenant(room.tenantId);
  const rows = ids.length ? await prisma.member.findMany({ where: { id: { in: [...new Set(ids)] } } }) : [];
  return new Map(rows.map((m) => [m.id, { ...display(m, cfg.identity.mode), role: m.role }]));
}

export async function toDtos(rows: Row[]): Promise<ChatMessage[]> {
  if (!rows.length) return [];
  const ch = await channelById(rows[0].channelId);
  const prof = await senders(ch.roomId, rows.map((r) => r.senderId).filter((x): x is string => !!x));
  return Promise.all(rows.map(async (m) => {
    const c = m.channelId === ch.id ? ch : await channelById(m.channelId);
    const reactions: Record<string, string[]> = {};
    for (const r of m.reactions ?? []) (reactions[r.key] ??= []).push(r.memberId);
    const p = m.senderId ? prof.get(m.senderId) : undefined;
    return {
      id: m.id, roomType: KIND_TO_RT[c.kind], senderSeat: m.senderId, senderHandle: p?.name ?? m.senderName,
      senderAvatar: p?.avatar ?? null, senderGuest: false, contentType: toProto(m.contentType), payload: m.contentType === 'GAME' && (m.payload as any)?.game ? publicGame((m.payload as any).game) : m.payload,
      createdAt: m.createdAt.toISOString(), clientMsgId: m.clientMsgId, seenBy: (m.receipts ?? []).map((r) => r.memberId), reactions,
    };
  }));
}
export const toDto = async (m: Row) => (await toDtos([m]))[0];

export interface NewMessage {
  senderId?: string | null; senderName: string; contentType: ContentType; payload: object;
  clientMsgId?: string | null; visibleTo?: string | null;
}

/** Persist + fan out. Idempotent on (channel, sender, clientMsgId) for offline retries. */
export async function createMessage(roomId: string, rt: RoomType, data: NewMessage): Promise<ChatMessage> {
  const ch = await channelOf(roomId, rt);
  let row: Row;
  try {
    row = await prisma.message.create({
      data: { channelId: ch.id, senderId: data.senderId ?? null, senderName: data.senderName, contentType: toDb(data.contentType), payload: data.payload as Prisma.InputJsonValue, clientMsgId: data.clientMsgId ?? null, visibleTo: data.visibleTo ?? null },
      include: msgInclude,
    });
  } catch (e: any) {
    if (e?.code === 'P2002' && data.clientMsgId) {
      const ex = await prisma.message.findFirstOrThrow({ where: { channelId: ch.id, senderId: data.senderId ?? null, clientMsgId: data.clientMsgId }, include: msgInclude });
      return toDto(ex);
    }
    throw e;
  }
  const dto = await toDto(row);
  if (data.visibleTo) hub.toMember(roomId, data.visibleTo, S2C.PRIVATE_NEW, dto);
  else hub.toChannel(roomId, rt, S2C.MSG_NEW, dto);
  for (const l of messageListeners) l(roomId, dto, data);
  return dto;
}
type MsgListener = (roomId: string, m: ChatMessage, raw: NewMessage) => void;
export const messageListeners: MsgListener[] = [];

/** Every channel of the room (alerts, timers, system notices go to all of them). */
export async function createInAllChannels(roomId: string, data: NewMessage) {
  const chs = await channelsOf(roomId);
  const out: ChatMessage[] = [];
  for (const c of chs) out.push(await createMessage(roomId, KIND_TO_RT[c.kind], data));
  return out;
}

export async function pushUpdate(messageId: string) {
  const m = await prisma.message.findUnique({ where: { id: messageId }, include: msgInclude });
  if (!m) return;
  const ch = await channelById(m.channelId);
  const dto = await toDto(m);
  if (m.visibleTo) hub.toMember(ch.roomId, m.visibleTo, S2C.MSG_UPDATE, dto);
  else hub.toChannel(ch.roomId, KIND_TO_RT[ch.kind], S2C.MSG_UPDATE, dto);
}

export async function emitReactions(messageId: string) {
  const m = await prisma.message.findUnique({ where: { id: messageId }, select: { channelId: true } });
  if (!m) return;
  const ch = await channelById(m.channelId);
  const all = await prisma.reaction.findMany({ where: { messageId }, select: { memberId: true, key: true }, orderBy: { createdAt: 'asc' } });
  const reactions: Record<string, string[]> = {};
  for (const r of all) (reactions[r.key] ??= []).push(r.memberId);
  hub.toChannel(ch.roomId, KIND_TO_RT[ch.kind], S2C.REACTIONS, { roomType: KIND_TO_RT[ch.kind], messageId, reactions });
}

/** History for one member: hides others' private messages and hidden (reported) ones. */
export async function loadMessages(roomId: string, rt: RoomType, member: Pick<Member, 'id'> | null, opts: { before?: Date; after?: Date; limit: number }) {
  const ch = await channelOf(roomId, rt);
  const where: Prisma.MessageWhereInput = {
    channelId: ch.id, hidden: false,
    OR: [{ visibleTo: null }, ...(member ? [{ visibleTo: member.id }] : [])],
    ...(opts.before ? { createdAt: { lt: opts.before } } : opts.after ? { createdAt: { gt: opts.after } } : {}),
  };
  const rows = await prisma.message.findMany({ where, orderBy: { createdAt: 'desc' }, take: opts.limit + 1, include: msgInclude });
  const hasMore = rows.length > opts.limit;
  return { messages: await toDtos(rows.slice(0, opts.limit).reverse()), hasMore };
}

export async function pinned(roomId: string, rt: RoomType) {
  const ch = await prisma.channel.findUnique({ where: { roomId_kind: { roomId, kind: RT_TO_KIND[rt] } } });
  if (!ch?.pinnedId) return null;
  const m = await prisma.message.findUnique({ where: { id: ch.pinnedId }, include: msgInclude });
  return m ? toDto(m) : null;
}
