import { prisma } from '../db';
import { logger } from '../lib/logger';
import { newId } from '../lib/ids';
import { signWebhook } from '../lib/crypto';
import { strs } from '../lib/json';

/**
 * Platform events. Every event is:
 *  1. stored in event_log (audit + "Live deliveries" in the Developer portal),
 *  2. pushed to the dashboard's live stream (SSE),
 *  3. POSTed to the tenant's subscribed webhooks, signed with
 *     X-TripRooms-Signature: t=<unix>,v1=<HMAC-SHA256("t.body", secret)>,
 *     retried with exponential backoff for up to 24 h.
 */
export type PlatformEvent = { id: string; type: string; tenant: string | null; room: string | null; data: unknown; created_at: string };
type Listener = (e: PlatformEvent) => void;
const listeners = new Set<Listener>();
export const onEvent = (fn: Listener) => { listeners.add(fn); return () => listeners.delete(fn); };

export async function emitEvent(tenantId: string | null, roomId: string | null, type: string, data: unknown) {
  const id = newId('evt');
  const row = await prisma.eventLog.create({ data: { id, tenantId, roomId, type, data: (data ?? {}) as object } });
  const e: PlatformEvent = { id, type, tenant: tenantId, room: roomId, data, created_at: row.createdAt.toISOString() };
  for (const l of listeners) { try { l(e); } catch { /* listener errors never break the caller */ } }
  if (tenantId) void deliverWebhooks(e).catch((err) => logger.warn({ err, id }, 'webhook dispatch failed'));
  return e;
}

const BACKOFF_SEC = [0, 10, 60, 300, 1800, 7200, 21600, 43200]; // ≈ 24 h total

async function deliverWebhooks(e: PlatformEvent) {
  const hooks = await prisma.webhook.findMany({ where: { tenantId: e.tenant!, active: true } });
  const targets = hooks.filter((h) => { const ev = strs(h.events); return ev.includes(e.type) || ev.includes('*') || ev.some((x) => x.endsWith('.*') && e.type.startsWith(x.slice(0, -1))); });
  for (const h of targets) void attempt(e, h.id, h.url, h.secret, 0);
}

async function attempt(e: PlatformEvent, hookId: string, url: string, secret: string, n: number): Promise<void> {
  const body = JSON.stringify({ id: e.id, type: e.type, created_at: e.created_at, tenant: e.tenant, data: e.data });
  let status = 0;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-triprooms-signature': signWebhook(secret, body), 'x-triprooms-event': e.type }, body, signal: AbortSignal.timeout(5000) });
    status = res.status;
  } catch { status = 0; }
  const ok = status >= 200 && status < 300;
  await recordDelivery(e.id, { webhook_id: hookId, status, attempt: n + 1, ok, at: new Date().toISOString() });
  if (!ok && n + 1 < BACKOFF_SEC.length) setTimeout(() => void attempt(e, hookId, url, secret, n + 1), BACKOFF_SEC[n + 1] * 1000).unref();
}

async function recordDelivery(eventId: string, d: object) {
  const row = await prisma.eventLog.findUnique({ where: { id: eventId }, select: { deliveries: true } });
  const list = Array.isArray(row?.deliveries) ? (row!.deliveries as object[]) : [];
  await prisma.eventLog.update({ where: { id: eventId }, data: { deliveries: [...list, d].slice(-20) } }).catch(() => {});
}
