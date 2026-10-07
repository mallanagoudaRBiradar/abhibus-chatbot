import type { Room, RoomState } from '@prisma/client';
import { prisma } from '../db';
import { logger } from '../lib/logger';
import { emitEvent } from './events';
import { createInAllChannels } from './messages';
import { estimate } from './location';
import { hub } from './hub';
import { broadcastRoomUpdate } from './alerts';
import { stopsOf, fmtTime } from './rooms';
import { getTenant, roomFeatures } from './tenants';
import { S2C } from '../shared/protocol';
import { UNIT } from '../shared/verticals';
import { campaignTick } from './ads';

const MIN = 60_000;
const sys = (r: Room, text: string) => createInAllChannels(r.id, { senderName: 'System', contentType: 'SYSTEM', payload: { text } });

/**
 * Room state machine (runs every 30 s):
 *   scheduled ──opens_at──▶ open ──departure+delay──▶ onboard ──arrival+delay──▶ read_only ──+window──▶ closed ──purge_at──▶ purged
 *   dormant (flights, activation on_delay) ──delay ≥ threshold──▶ open
 */
export async function lifecycleTick(now = Date.now()) {
  const rooms = await prisma.room.findMany({ where: { OR: [{ state: { not: 'closed' } }, { purgeAt: { lte: new Date(now) } }] } });
  for (const r of rooms) {
    try { await step(r, now); } catch (err) { logger.warn({ err, room: r.id }, 'lifecycle step failed'); }
  }
}

async function step(r: Room, now: number) {
  const { cfg } = await getTenant(r.tenantId);
  const u = UNIT[r.vertical];
  const dep = +r.departsAt + r.delayMin * MIN;
  const arr = +r.arrivesAt + r.delayMin * MIN;
  const closesAt = +r.readOnlyAt + cfg.timing.readonly_after_min * MIN;
  let next: RoomState | null = null;

  if (r.state === 'dormant') {
    const act = (r.activation ?? {}) as { mode?: string; min_delay_min?: number };
    if (r.delayMin >= (act.min_delay_min ?? 45)) {
      next = 'open';
      await sys(r, `This room opened because the ${u.u} is delayed more than ${act.min_delay_min ?? 45} min. You’ll get every update here.`);
      await emitEvent(r.tenantId, r.id, 'notification.requested', { room_id: r.id, text: `${r.title}: delay room is open`, channels: { push: true }, audience: 'room_members' });
    } else if (now > arr) next = 'closed';
  } else if (r.state === 'scheduled' && now >= +r.opensAt) {
    next = 'open';
    await sys(r, `Room open. Only your ${cfg.identity.mode === 'handle' ? 'handle' : 'first name and avatar'} is visible to others.`);
  } else if (r.state === 'open' && now >= dep && r.vertical !== 'flight') {
    next = 'onboard';
    await sys(r, 'You’re on the way. Welcome aboard!');
  } else if (r.state === 'open' && r.vertical === 'flight' && now >= dep + 15 * MIN) {
    next = 'onboard';
    await sys(r, 'Boarding complete. Have a good flight.');
  } else if (r.state === 'onboard' && now >= arr) {
    next = 'read_only';
    await sys(r, `Trip complete. The room is now read-only for ${Math.round(cfg.timing.readonly_after_min / 60)} hours.`);
    await createInAllChannels(r.id, { senderName: 'System', contentType: 'RATE', payload: { prompt: `How was your ${u.u} trip?` } });
  } else if (r.state === 'read_only' && now >= closesAt) {
    next = 'closed';
  }

  if (r.state === 'closed' && now >= +r.purgeAt && !(r.meta as any)?.purged) return purge(r);

  if (next) {
    await prisma.room.update({ where: { id: r.id }, data: { state: next } });
    await emitEvent(r.tenantId, r.id, next === 'open' ? 'room.opened' : 'room.state_changed', { room_id: r.id, trip_key: r.tripKey, from: r.state, to: next });
    await broadcastRoomUpdate(r.id);
    if (next === 'closed') hub.toTrip(r.id, S2C.JOURNEY_CLOSED, {});
    r = { ...r, state: next };
  }

  if (r.state === 'onboard' || r.state === 'open') await stopsAndTimers(r);
  if (r.state !== 'closed' && r.state !== 'scheduled' && r.state !== 'dormant') hub.toTrip(r.id, S2C.LOCATION, await estimate(r));
}

/** Announce stops as the estimate passes them; start the rest-stop timer at rest stops. */
async function stopsAndTimers(r: Room) {
  const loc = await estimate(r);
  const stops = stopsOf(r);
  const reached = Math.floor(loc.progress * (stops.length - 1) + 1e-6);
  const meta = (r.meta ?? {}) as Record<string, any>;
  const last = typeof meta.lastStop === 'number' ? meta.lastStop : 0;
  if (reached <= last || r.vertical === 'flight') return;
  for (let i = last + 1; i <= reached; i++) {
    const s = stops[i];
    await sys(r, `${UNIT[r.vertical].unit} reached ${s.name} at ${fmtTime(new Date())}.`);
    if (s.type === 'rest_stop' && (await roomFeatures(r)).rest_stop) {
      const depAt = Date.parse(s.sched_dep ?? '') || Date.now() + 20 * MIN;
      await createInAllChannels(r.id, { senderName: 'Ops', contentType: 'TIMER', payload: { stop: s.name, leaveAt: new Date(depAt + r.delayMin * MIN).toISOString(), startedAt: new Date().toISOString() } });
      await emitEvent(r.tenantId, r.id, 'trip_event.rest_stop_started', { room_id: r.id, stop: s.code });
    }
    await emitEvent(r.tenantId, r.id, 'location.updated', { room_id: r.id, reached: s.code, confidence: loc.confidence, source: loc.source });
  }
  await prisma.room.update({ where: { id: r.id }, data: { meta: { ...meta, lastStop: reached } } });
}

/** Delete everything travellers wrote. Reports (trust & safety) and audit logs are kept separately. */
export async function purge(r: Room) {
  await prisma.channel.deleteMany({ where: { roomId: r.id } }); // cascades messages, reactions, receipts
  await prisma.locationFix.deleteMany({ where: { roomId: r.id } });
  await prisma.issueReport.deleteMany({ where: { roomId: r.id } });
  await prisma.member.updateMany({ where: { roomId: r.id }, data: { displayName: null, avatarId: null, seatRefs: [] } });
  await prisma.room.update({ where: { id: r.id }, data: { meta: { ...((r.meta ?? {}) as object), purged: true } } });
  await emitEvent(r.tenantId, r.id, 'room.purged', { room_id: r.id, trip_key: r.tripKey });
  logger.info({ room: r.id }, 'room purged');
}

export function startEngine() {
  const tick = () => lifecycleTick().catch((err) => logger.warn({ err }, 'lifecycle tick failed'));
  void tick();
  setInterval(tick, 30_000).unref();
  setInterval(() => campaignTick().catch((err) => logger.warn({ err }, 'campaign tick failed')), 60_000).unref();
  setTimeout(() => campaignTick().catch(() => {}), 8_000).unref();
}
