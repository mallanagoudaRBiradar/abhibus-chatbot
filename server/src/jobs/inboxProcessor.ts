import type { ChatAbhibusInbox } from '@prisma/client';
import { purgeTimeFor } from '../features/journeyService';
import { prisma } from '../db/prisma';
import { logger } from '../lib/logger';
import { metrics } from '../lib/metrics';
import { leaderInterval } from '../lib/leader';
import { AdapterError, bookingFromGetTicket, bookingFromHistory, cancellationFrom } from '../booking/abhibusAdapter';
import { cancelBooking, IngestError, upsertBooking } from '../features/ingest';

/**
 * ============================================================================
 *  chat_abhibus_inbox → rooms. Every 3s, on the leader instance only.
 * ============================================================================
 *  bus-online inserts the raw data it already has, and does nothing else:
 *    BOOKING       ticket::makeTicketHistory   (once per confirmed ticket)
 *    CANCELLATION  Webservices_App::ConfirmCancellation response + the request's cancel_seats
 *    TICKET        a GetTicketDetails response (supported, not currently sent)
 *  and does nothing else. Here they become bookings / cancellations through the
 *  same code as the partner API (booking/abhibusAdapter.ts → features/ingest.ts).
 *
 *  - Order: rows run in id order; if one fails, later rows of the same PNR wait.
 *  - Of several BOOKING/TICKET rows for one PNR in a batch, only the latest is applied
 *    (the others are marked processed): it carries the full current state.
 *  - Rows, raw payload included, live exactly as long as the trip's chat: until
 *    3 h after the last passenger's drop time (purgeTimeFor). The expiry sweeper
 *    deletes a trip's rows when it ends the chat; keep_until (= that same time)
 *    covers rows whose seats were all cancelled. PNR not on any trip: 24 h.
 *    Parked (failed) rows: 7 days.
 *  - keep_until comes from abrs_new_chat_tables2.sql. Until the DBA runs it, nothing
 *    processed is deleted (we never select or write that column without it).
 * ============================================================================
 */
const BATCH = 200;
const MAX_ATTEMPTS = 5;
const UNMATCHED_KEEP_MS = 24 * 3600_000;
let lastCleanup = 0;

/** Every column except keep_until, so this works before abrs_new_chat_tables2.sql has run. */
const COLS = { id: true, eventType: true, pnr: true, cancelSeats: true, payload: true, createdAt: true, processedAt: true, attempts: true, lastError: true } as const;
type Row = Omit<ChatAbhibusInbox, 'keepUntil'>;

let keepColumn: boolean | null = null;
async function hasKeepUntil() {
  if (keepColumn === null) {
    const r = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chat_abhibus_inbox' AND COLUMN_NAME = 'keep_until'`;
    keepColumn = Number(r[0]?.n ?? 0) > 0;
    if (!keepColumn) logger.warn('chat_abhibus_inbox.keep_until is missing (run prisma/sql/abrs_new_chat_tables2.sql): processed inbox rows are kept, not deleted');
  }
  return keepColumn;
}

/** When this PNR's trip chat ends (3 h after the last drop); the latest trip if it has several. */
async function keepUntilFor(pnr: string): Promise<Date | null> {
  const b = await prisma.passengerBooking.findFirst({
    where: { pnrNumber: pnr }, orderBy: { journey: { estimatedEndTime: 'desc' } },
    select: { journey: { select: { purgeAt: true, estimatedEndTime: true, actualEndTime: true } } },
  });
  return b ? purgeTimeFor(b.journey) : null;
}

export function startInboxProcessor() {
  leaderInterval('abhibus-inbox', 3_000, async () => {
    for (let round = 0; round < 10; round++) if ((await processBatch()) < BATCH) break;
    if (Date.now() - lastCleanup > 60_000) { lastCleanup = Date.now(); await cleanup(); }
  });
}

export async function processBatch(): Promise<number> {
  const rows = await prisma.chatAbhibusInbox.findMany({
    select: COLS,
    where: { processedAt: null, attempts: { lt: MAX_ATTEMPTS } },
    orderBy: { id: 'asc' },
    take: BATCH,
  });
  const blocked = new Set<string>(); // PNRs with a failed row in this batch: keep their order
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (blocked.has(row.pnr)) continue;
    if (isState(row) && supersededLater(rows, i)) { await done(row, await keepUntilFor(row.pnr), 'superseded'); continue; }
    try {
      // Look the trip up before applying too: a full cancellation removes the PNR's seats.
      const before = await keepUntilFor(row.pnr);
      await apply(row);
      await done(row, (await keepUntilFor(row.pnr)) ?? before);
      metrics.inc('inbox_processed_total');
    } catch (err) {
      blocked.add(row.pnr);
      const permanent = err instanceof AdapterError || err instanceof SyntaxError || (err instanceof IngestError && err.status < 500);
      await prisma.chatAbhibusInbox.updateMany({
        where: { id: row.id },
        data: { attempts: permanent ? MAX_ATTEMPTS : { increment: 1 }, lastError: String((err as Error).message ?? err).slice(0, 500) },
      });
      metrics.inc('inbox_failed_total');
      logger.warn({ inboxId: String(row.id), type: row.eventType, err: (err as Error).message, permanent }, 'inbox row failed');
    }
  }
  return rows.length;
}

/** Rows that carry the full current state of a ticket. */
const isState = (r: Row) => r.eventType === 'BOOKING' || r.eventType === 'TICKET';

/** A later state row for the same PNR, with nothing else for that PNR in between, replaces this one. */
function supersededLater(rows: Row[], i: number) {
  for (let k = i + 1; k < rows.length; k++) {
    if (rows[k].pnr !== rows[i].pnr) continue;
    return isState(rows[k]);
  }
  return false;
}

async function apply(row: Row) {
  const body = JSON.parse(row.payload);
  if (isState(row)) {
    const booking = row.eventType === 'BOOKING' ? bookingFromHistory(body) : bookingFromGetTicket(body);
    if (booking.status === 'CONFIRMED' && !booking.seats.length) throw new AdapterError('SelectedSeats is empty on a live ticket.');
    await upsertBooking(booking);
    return;
  }
  if (row.eventType === 'CANCELLATION') {
    const c = cancellationFrom({ ...body, cancel_seats: row.cancelSeats || body.cancel_seats });
    if (c.apply) await cancelBooking(c.pnr, c.seats.length ? c.seats : undefined);
    return;
  }
  throw new AdapterError(`Unknown event_type "${row.eventType}" (expected BOOKING, CANCELLATION or TICKET).`);
}

/** Mark processed. The raw payload stays readable until keep_until (3 h after the trip). */
async function done(row: Row, keepUntil: Date | null, note: string | null = null) {
  const keep = keepUntil ?? new Date(Date.now() + UNMATCHED_KEEP_MS);
  await prisma.chatAbhibusInbox.updateMany({
    where: { id: row.id },
    data: { processedAt: new Date(), lastError: note, ...((await hasKeepUntil()) ? { keepUntil: keep } : {}) },
  });
}

async function cleanup() {
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000);
  // Parked rows (failed 5 times): a week to look into them.
  await prisma.chatAbhibusInbox.deleteMany({ where: { processedAt: null, attempts: { gte: MAX_ATTEMPTS }, createdAt: { lt: weekAgo } } });
  if (!(await hasKeepUntil())) return; // no keep_until yet: keep every processed row
  // Rows processed before the column existed: give them their trip's keep_until now.
  const unset = await prisma.chatAbhibusInbox.findMany({ where: { processedAt: { not: null }, keepUntil: null }, select: { id: true, pnr: true, processedAt: true }, take: 200 });
  for (const r of unset) {
    const keep = (await keepUntilFor(r.pnr)) ?? new Date(+r.processedAt! + UNMATCHED_KEEP_MS);
    await prisma.chatAbhibusInbox.updateMany({ where: { id: r.id }, data: { keepUntil: keep } });
  }
  // keep_until is the chat end at processing time; a trip that still has seats ends via the sweeper
  // (its end can move later as bookings come in), so only rows of PNRs with no seats left go here.
  const gone = await pnrsWithoutSeats();
  if (gone.length) await prisma.chatAbhibusInbox.deleteMany({ where: { processedAt: { not: null }, keepUntil: { lt: new Date() }, pnr: { in: gone } } });
}

/** PNRs with rows past keep_until that no longer hold any seat (fully cancelled, or never matched a trip). */
async function pnrsWithoutSeats() {
  const due = await prisma.chatAbhibusInbox.findMany({ where: { processedAt: { not: null }, keepUntil: { lt: new Date() } }, select: { pnr: true }, distinct: ['pnr'], take: 500 });
  if (!due.length) return [];
  const live = new Set((await prisma.passengerBooking.findMany({ where: { pnrNumber: { in: due.map((d) => d.pnr) } }, select: { pnrNumber: true }, distinct: ['pnrNumber'] })).map((l) => l.pnrNumber));
  return due.map((d) => d.pnr).filter((x) => !live.has(x));
}

/** Rows waiting to be applied (for /metrics). */
export const inboxPending = () => prisma.chatAbhibusInbox.count({ where: { processedAt: null, attempts: { lt: MAX_ATTEMPTS } } });
