import { prisma } from '../db';
import { logger } from '../lib/logger';
import { emitEvent } from './events';
import { messageListeners } from './messages';

/**
 * Everything the platform posts INTO a room (Ops alerts, crew posts, campaigns, polls, surveys,
 * vouchers, rest-stop timers, trip notices) is published once as `room.message_posted`.
 * Tenants with their own chat UI subscribe and render it natively, so whatever Ops or Marketing
 * do in the Console reaches every traveller, whichever app they're in.
 * Traveller messages (senderId set) and private messages (visibleTo set) are never published here.
 */
const OUTBOUND = new Set(['ALERT', 'CREW', 'AD', 'POLL', 'SURVEY', 'VOUCHER', 'TIMER', 'SYSTEM', 'GAME']);
const tenantOf = new Map<string, string>();

messageListeners.push((roomId, m, raw) => {
  if (raw.senderId || raw.visibleTo || m.roomType !== 'MAIN_COMMON' || !OUTBOUND.has(String(m.contentType))) return;
  void (async () => {
    let tenant = tenantOf.get(roomId);
    if (!tenant) { tenant = (await prisma.room.findUnique({ where: { id: roomId }, select: { tenantId: true } }))?.tenantId; if (tenant) tenantOf.set(roomId, tenant); }
    if (!tenant) return;
    await emitEvent(tenant, roomId, 'room.message_posted', { room_id: roomId, message_id: m.id, content_type: m.contentType, sender: m.senderHandle, payload: m.payload, created_at: m.createdAt });
  })().catch((err) => logger.warn({ err, roomId }, 'outbound publish failed'));
});
