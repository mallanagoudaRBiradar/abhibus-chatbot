import { Router } from 'express';
import { ensureDemoFleet } from './fleet';
import { prisma } from '../db';
import { logger } from '../lib/logger';
import { createMessage, messageListeners, emitReactions } from '../core/messages';
import { stopsOf, timetablePos } from '../core/rooms';
import { getTenant } from '../core/tenants';
import { display } from '../core/identity';
import { hub } from '../core/hub';
import { resetAll, seed } from './seed';
import { S2C, REACTIONS, type RoomType } from '../shared/protocol';

/**
 * DEMO ONLY (DEMO_MODE=true, refused in production). Makes the seeded trips
 * feel alive: co-passengers chat, read and react, on-board travellers share
 * location along the route. Also hosts a webhook receiver so the Developer
 * portal shows real, signed deliveries.
 */
const LINES: Record<string, string[]> = {
  bus: ['Anyone else boarding at {board}?', 'Is there a washroom break before {next}?', 'The bus is quite comfortable today.', 'Charging point near the back isn’t working, fyi', 'Roads are super smooth now 👌', 'How long till {next}?', 'AC is a bit too cold, anyone else?', 'Driver is very careful, nice ride so far', 'Does anyone know if we stop for dinner?', 'Reached {near} it seems'],
  train: ['Is the coach AC working for everyone?', 'Anyone getting down at {next}?', 'Water bottles are being sold near the door.', 'Which side does the platform come at {next}?', 'Pantry car has hot idlis right now', 'Train is running smoothly now', 'Anyone else going till {last}?'],
  flight: ['Is the lounge open at this hour?', 'Charging points near the gate are working.', 'Hope there is no further delay.', 'Anyone know if they’ll give snacks?', 'Coffee shop near gate is open btw', 'Heard the aircraft just landed from the previous sector'],
};
const fillLine = (line: string, v: Record<string, string>) => line.replace(/\{(\w+)\}/g, (_m, k) => v[k] ?? '');
export const sink: { tenant: string; type: string; at: string; signature: string }[] = [];
export const demoRouter = Router();
demoRouter.post('/webhook-sink/:tenant', (req, res) => {
  sink.unshift({ tenant: req.params.tenant, type: String(req.body?.type ?? ''), at: new Date().toISOString(), signature: String(req.header('x-triprooms-signature') ?? '') });
  sink.length = Math.min(sink.length, 200);
  res.json({ received: true });
});
demoRouter.get('/webhook-sink', (_req, res) => { res.json({ data: sink.slice(0, 50) }); });

const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
/** Walks each room's script in a shuffled order so the crowd never repeats itself back-to-back. */
const cursor = new Map<string, { order: number[]; i: number }>();
function nextLine(roomId: string, lines: string[]) {
  let c = cursor.get(roomId);
  if (!c || c.i >= c.order.length) {
    const order = lines.map((_, i) => i).sort(() => Math.random() - 0.5);
    if (c && order[0] === c.order[c.order.length - 1] && order.length > 1) order.push(order.shift()!);
    c = { order, i: 0 }; cursor.set(roomId, c);
  }
  return lines[c.order[c.i++]];
}

export async function startDemo() {
  const tenants = await prisma.tenant.count();
  const live = await prisma.room.count({ where: { state: { in: ['open', 'onboard'] } } });
  if (!tenants || !live) {
    logger.info('demo: (re)seeding — no live demo trips');
    await resetAll();
    await seed();
  }
  await ensureDemoFleet().catch((err) => logger.warn({ err }, 'demo fleet top-up failed'));

  // Real messages get seen and sometimes a reaction from the crowd.
  messageListeners.push((roomId, msg) => {
    if (!msg.senderSeat || msg.contentType !== 'TEXT') return;
    void (async () => {
      const crowd = await prisma.member.findMany({ where: { roomId, id: { not: msg.senderSeat! }, removedAt: null, role: 'traveller', externalUserId: { not: { startsWith: 'dashboard:' } } }, take: 8 });
      const sender = await prisma.member.findUnique({ where: { id: msg.senderSeat! } });
      if (!sender || !sender.externalUserId.startsWith('dashboard:')) return; // only react to the human trying the demo
      crowd.slice(0, 4).forEach((m, i) => setTimeout(async () => {
        await prisma.receipt.create({ data: { messageId: msg.id, memberId: m.id } }).catch(() => {});
        hub.toChannel(roomId, msg.roomType, S2C.RECEIPTS, { roomType: msg.roomType, updates: [{ messageId: msg.id, seats: [m.id] }] });
        if (i === 0 && Math.random() < 0.6) { await prisma.reaction.create({ data: { messageId: msg.id, memberId: m.id, key: pick([...REACTIONS]) } }).catch(() => {}); await emitReactions(msg.id); }
      }, 1500 + i * 1800));
    })().catch(() => {});
  });

  const loop = async () => {
    try {
      const rooms = await prisma.room.findMany({ where: { state: { in: ['open', 'onboard'] } } });
      for (const r of rooms) {
        const { cfg } = await getTenant(r.tenantId);
        const crowd = await prisma.member.findMany({ where: { roomId: r.id, removedAt: null, role: 'traveller', externalUserId: { not: { startsWith: 'dashboard:' } } } });
        const all = stopsOf(r), at = Math.min(all.length - 1, Math.floor(timetablePos(r)) + 1);
        const names = { board: all[0]?.name ?? '', next: all[at]?.name ?? '', last: all[all.length - 1]?.name ?? '', near: all[Math.max(0, at - 1)]?.name ?? '' };
        if (crowd.length >= cfg.social_min && !r.opsOnly && Math.random() < 0.35) {
          const m = pick(crowd);
          const rt: RoomType = m.gender === 'F' && Math.random() < 0.25 ? 'WOMEN_ONLY' : 'MAIN_COMMON';
          await createMessage(r.id, rt, { senderId: m.id, senderName: display(m, cfg.identity.mode).name, contentType: 'TEXT', payload: { text: fillLine(nextLine(r.id, LINES[r.vertical] ?? LINES.bus), names) } }).catch(() => {});
        }
        // Sharing travellers move along the route with the timetable (a few hundred metres of jitter).
        const stops = stopsOf(r).filter((s) => s.lat != null && s.lng != null);
        if (stops.length >= 2) {
          const pos = timetablePos(r);
          const i = Math.min(stops.length - 2, Math.floor(pos)), f = Math.min(1, pos - i);
          const a = stops[i], b = stops[i + 1];
          for (const m of crowd.filter((x) => x.sharingLocation)) {
            const lat = a.lat! + (b.lat! - a.lat!) * f + (Math.random() - 0.5) * 0.004;
            const lng = a.lng! + (b.lng! - a.lng!) * f + (Math.random() - 0.5) * 0.004;
            await prisma.locationFix.create({ data: { roomId: r.id, source: 'crowd', memberId: m.id, lat, lng } });
          }
        }
      }
    } catch (err) { logger.debug({ err }, 'demo tick skipped'); }
    setTimeout(() => void loop(), 12_000 + Math.random() * 6000).unref();
  };
  setTimeout(() => void loop(), 4000).unref();
  logger.info('🎬 demo simulator running');
}
