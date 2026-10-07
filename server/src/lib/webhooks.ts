import { createHmac, randomUUID } from 'crypto';
import { config } from '../config';
import { logger } from './logger';

/**
 * Signed events to the AbhiBus backend (PARTNER_WEBHOOK_URL).
 *
 *   POST <PARTNER_WEBHOOK_URL>
 *   x-journeychat-event:     room.opened | journey.closed | sos.raised | seat.removed
 *   x-journeychat-id:        unique per event (dedupe on your side; retries reuse it)
 *   x-journeychat-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *
 * Fire-and-forget with retries (1s, 5s, 30s, 2m). Never blocks the chat.
 * Unset URL = events are only logged.
 */
export type PartnerEvent = 'room.opened' | 'journey.closed' | 'sos.raised' | 'seat.removed';

const BACKOFF_MS = [1_000, 5_000, 30_000, 120_000];

export function sign(body: string, secret: string, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

export function emitPartnerEvent(event: PartnerEvent, data: Record<string, unknown>) {
  const id = randomUUID();
  if (!config.PARTNER_WEBHOOK_URL) { logger.debug({ event, id }, 'partner webhook not configured'); return; }
  const body = JSON.stringify({ id, event, createdAt: new Date().toISOString(), data });
  void (async () => {
    for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
      try {
        const res = await fetch(config.PARTNER_WEBHOOK_URL!, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-journeychat-event': event,
            'x-journeychat-id': id,
            'x-journeychat-signature': sign(body, config.PARTNER_WEBHOOK_SECRET!),
          },
          body,
          signal: AbortSignal.timeout(5_000),
        });
        if (res.ok) return;
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          logger.error({ event, id, status: res.status }, 'partner webhook rejected, not retrying');
          return;
        }
      } catch { /* network: retry */ }
      if (attempt < BACKOFF_MS.length) await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
    }
    logger.error({ event, id }, 'partner webhook failed after retries');
  })();
}
