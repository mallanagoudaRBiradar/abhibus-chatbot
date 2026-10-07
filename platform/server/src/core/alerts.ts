import type { Room } from '@prisma/client';
import { prisma } from '../db';
import { ApiError } from '../lib/errors';
import { createInAllChannels, channelsOf } from './messages';
import { emitEvent } from './events';
import { hub } from './hub';
import { journeyInfo } from './rooms';
import { S2C, type Severity } from '../shared/protocol';
import { logger } from '../lib/logger';

export interface AlertIn { text: string; severity: Severity; pin?: boolean; channels?: { push?: boolean; sms?: boolean; whatsapp?: boolean }; translations?: Record<string, string>; author?: string }

/**
 * Post an Ops alert to every channel of the room. Pinned by default (the
 * previous pin is replaced). Ads pause for `block_after_alert_min` after any
 * alert. Push / SMS / WhatsApp go through the tenant's own notification stack:
 * we emit `notification.requested` and the tenant's webhook sends it.
 */
export async function postAlert(room: Room, a: AlertIn, actor: string) {
  if (room.state === 'closed') throw new ApiError('room_state', 'This room is closed.');
  const text = a.text.trim().slice(0, 500);
  if (!text) throw new ApiError('invalid_request', 'text is required.');
  const pin = a.pin !== false;
  const msgs = await createInAllChannels(room.id, { senderName: 'Ops', contentType: 'ALERT', payload: { text, severity: a.severity, pin, translations: a.translations ?? {}, author: a.author ?? actor } });
  if (pin) for (const [i, ch] of (await channelsOf(room.id)).entries()) {
    const m = msgs.find((x) => x.roomType === (ch.kind === 'MAIN' ? 'MAIN_COMMON' : 'WOMEN_ONLY')) ?? msgs[i];
    await prisma.channel.update({ where: { id: ch.id }, data: { pinnedId: m.id } });
    hub.toChannel(room.id, m.roomType, S2C.PINNED, { pinnedAlert: m });
  }
  const r = await prisma.room.update({ where: { id: room.id }, data: { lastAlertAt: new Date() } });
  const members = await prisma.member.count({ where: { roomId: room.id, removedAt: null, role: 'traveller' } });
  const delivered = { in_room: members, push: a.channels?.push === false ? 0 : members, sms: a.channels?.sms ? Math.max(1, Math.round(members * 0.2)) : 0 };
  await emitEvent(room.tenantId, room.id, 'announcement.created', { room_id: room.id, trip_key: room.tripKey, announcement_id: msgs[0].id, text, severity: a.severity, translations: a.translations ?? {}, pin, actor, delivered });
  if (delivered.push || delivered.sms || a.channels?.whatsapp)
    await emitEvent(room.tenantId, room.id, 'notification.requested', { room_id: room.id, text, severity: a.severity, channels: { push: delivered.push > 0, sms: delivered.sms > 0, whatsapp: !!a.channels?.whatsapp }, audience: 'room_members' });
  logger.info({ room: room.id, severity: a.severity }, 'alert posted');
  return { id: msgs[0].id, room: r, delivered };
}

export async function broadcastRoomUpdate(roomId: string) {
  const r = await prisma.room.findUniqueOrThrow({ where: { id: roomId } });
  hub.toTrip(roomId, S2C.ROOM_UPDATE, await journeyInfo(r));
}
