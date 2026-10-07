#!/usr/bin/env node
/**
 * End-to-end load test against a running server in partner mode.
 *
 *   BASE=http://localhost:4000 PARTNER_KEY=... JOURNEYS=2000 SEATS=36 SOCKETS_PER_JOURNEY=3 \
 *   DURATION_S=60 MSG_EVERY_S=20 node scripts/loadtest.mjs
 *
 * Phases (each prints timings):
 *   1. ingest   JOURNEYS × SEATS bookings through /v1/partner/bookings/batch
 *   2. open     wait until the room opener has opened every journey
 *   3. sessions mint SOCKETS_PER_JOURNEY chat sessions per journey (/v1/partner/chat-sessions)
 *   4. connect  open the sockets and room:join MAIN_COMMON
 *   5. chat     every socket sends a message every MSG_EVERY_S; measure ack latency and fan-out
 *   6. gps      one bulk GPS push for every journey
 * WS_BASES=http://a:4000,http://b:4000 spreads sockets over several instances.
 * Use a throwaway database: it creates real rows (purged by the sweeper after the trips "end").
 */
import { io } from 'socket.io-client';
import { randomUUID } from 'crypto';

const env = (k, d) => process.env[k] ?? d;
const BASE = env('BASE', 'http://localhost:4000');
const KEY = env('PARTNER_KEY', '');
const JOURNEYS = +env('JOURNEYS', 2000);
const SEATS = +env('SEATS', 36);
const PER = +env('SOCKETS_PER_JOURNEY', 3);
const DURATION_S = +env('DURATION_S', 60);
const MSG_EVERY_S = +env('MSG_EVERY_S', 20);
/** Comma-separated socket endpoints; sockets are spread round-robin (e.g. two instances, no affinity = worst case). */
const WS_BASES = env('WS_BASES', BASE).split(',');
const RUN = env('RUN_ID', Date.now().toString(36).toUpperCase().slice(-5));
if (!KEY) { console.error('PARTNER_KEY is required'); process.exit(1); }

const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const stats = (arr) => `n=${arr.length} p50=${pct(arr, 50)}ms p95=${pct(arr, 95)}ms p99=${pct(arr, 99)}ms max=${pct(arr, 100)}ms`;
const post = async (path, body) => {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j;
};
const pool = async (items, n, fn) => { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); })); };

// Synthetic route: 10 stops on a straight-ish line, different per journey.
const routeFor = (k) => Array.from({ length: 10 }, (_, i) => ({ name: `Stop ${i}`, lat: 12 + (k % 50) * 0.1 + i * 0.3, lng: 77 + Math.floor(k / 50) * 0.1 + i * 0.2, kind: i === 4 ? 'TOLL' : i === 0 ? 'PICKUP' : 'STOP' }));
const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const journey = (k) => ({
  serviceId: `LT${RUN}${k}`, journeyDate: today, busNumber: `KA01LT${k}`, operatorName: 'Load Test Travels',
  sourceCity: 'Hyderabad', destinationCity: 'Bengaluru',
  // Worst case: every journey departs within the next 20 minutes, so all rooms open in the same tick.
  startTime: new Date(Date.now() + 5 * 60_000 + (k % 15) * 60_000).toISOString(),
  estimatedEndTime: new Date(Date.now() + 9 * 3600_000).toISOString(),
  route: routeFor(k),
});
const seatName = (s) => `${Math.floor(s / 2) + 1}${s % 2 ? 'U' : 'L'}`;

async function main() {
  console.log(`run=${RUN} journeys=${JOURNEYS} seats=${SEATS} sockets=${JOURNEYS * PER}`);

  // 1. ingest -------------------------------------------------------------
  let t = Date.now();
  const bookings = [];
  for (let k = 0; k < JOURNEYS; k++)
    for (let s = 0; s < SEATS; s += 2) // two seats per PNR (couples/families)
      bookings.push({ pnr: `P${RUN}${k}X${s}`, customerId: `cust-${k}-${s}`, journey: journey(k), seats: [{ seat: seatName(s), gender: s % 4 ? 'M' : 'F' }, { seat: seatName(s + 1), gender: 'M' }] });
  const batchLat = [];
  const batches = [];
  for (let i = 0; i < bookings.length; i += 500) batches.push(bookings.slice(i, i + 500));
  let failed = 0;
  await pool(batches, 4, async (b) => { const t0 = Date.now(); const r = await post('/v1/partner/bookings/batch', { bookings: b }); failed += r.failed; batchLat.push(Date.now() - t0); });
  const ingestS = (Date.now() - t) / 1000;
  console.log(`1. ingest   ${bookings.length} bookings (${JOURNEYS * SEATS} seats) in ${ingestS.toFixed(1)}s = ${Math.round(bookings.length / ingestS)} bookings/s, failed=${failed}; batch(500) ${stats(batchLat)}`);

  // 2. rooms open ---------------------------------------------------------
  t = Date.now();
  const sample = [0, Math.floor(JOURNEYS / 2), JOURNEYS - 1].map((k) => `LT${RUN}${k}:${today}`);
  for (;;) {
    const st = await Promise.all(sample.map((id) => fetch(`${BASE}/v1/partner/journeys/${encodeURIComponent(id)}`, { headers: { 'x-api-key': KEY } }).then((r) => r.json())));
    if (st.every((s) => s.roomsOpenedAt)) break;
    if (Date.now() - t > 120_000) throw new Error('rooms did not open within 120s');
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`2. open     all rooms open ${((Date.now() - t) / 1000).toFixed(1)}s after ingest finished (ticker runs every 30s)`);

  // 3. chat sessions --------------------------------------------------------
  t = Date.now();
  const sessions = [];
  const sessLat = [];
  const want = [];
  for (let k = 0; k < JOURNEYS; k++) for (let p = 0; p < PER; p++) want.push({ k, s: p * 2 });
  await pool(want, 50, async ({ k, s }) => {
    const t0 = Date.now();
    const r = await post('/v1/partner/chat-sessions', { pnr: `P${RUN}${k}X${s}`, seat: seatName(s), deviceId: `dev-${RUN}-${k}-${s}`, customerId: `cust-${k}-${s}`, profile: { name: 'Rider', avatar: null } });
    sessLat.push(Date.now() - t0);
    sessions.push({ k, token: r.token, jid: r.journey.journeyId });
  });
  console.log(`3. sessions ${sessions.length} in ${((Date.now() - t) / 1000).toFixed(1)}s; ${stats(sessLat)}`);

  // 4. connect + join -------------------------------------------------------
  t = Date.now();
  const sockets = [];
  const joinLat = [];
  let received = 0, connectErrors = 0;
  let rr = 0;
  await pool(sessions, 100, (sess) => new Promise((resolve) => {
    const t0 = Date.now();
    const s = io(WS_BASES[rr++ % WS_BASES.length], { path: '/ws', transports: ['websocket'], auth: { token: sess.token }, query: { jid: sess.jid }, reconnection: false, timeout: 20_000 });
    s.on('message:new', () => { received++; });
    s.once('connect_error', () => { connectErrors++; resolve(); });
    s.once('connect', () => s.emit('room:join', { roomType: 'MAIN_COMMON' }, (ack) => {
      if (ack?.ok) { joinLat.push(Date.now() - t0); sockets.push(s); } else connectErrors++;
      resolve();
    }));
  }));
  console.log(`4. connect  ${sockets.length} sockets joined in ${((Date.now() - t) / 1000).toFixed(1)}s, errors=${connectErrors}; connect+join ${stats(joinLat)}`);

  // 5. chat ---------------------------------------------------------------
  received = 0;
  const ackLat = [];
  let sent = 0, sendErrors = 0;
  const end = Date.now() + DURATION_S * 1000;
  await Promise.all(sockets.map(async (s, i) => {
    await new Promise((r) => setTimeout(r, Math.random() * MSG_EVERY_S * 1000));
    while (Date.now() < end) {
      const t0 = Date.now();
      await new Promise((resolve) => s.timeout(15_000).emit('message:send', { roomType: 'MAIN_COMMON', clientMsgId: randomUUID(), contentType: 'TEXT', payload: { text: `hello from socket ${i}` } }, (err, ack) => {
        if (err || !ack?.ok) sendErrors++; else { ackLat.push(Date.now() - t0); sent++; }
        resolve();
      }));
      await new Promise((r) => setTimeout(r, MSG_EVERY_S * 1000));
    }
  }));
  await new Promise((r) => setTimeout(r, 2000));
  const expected = sent * PER; // every socket in the room (sender included) gets message:new
  console.log(`5. chat     ${sent} messages in ${DURATION_S}s = ${(sent / DURATION_S).toFixed(0)} msg/s, errors=${sendErrors}; ack ${stats(ackLat)}`);
  console.log(`            fan-out delivered ${received}/${expected} (${((received / Math.max(1, expected)) * 100).toFixed(2)}%)`);

  // 6. gps ----------------------------------------------------------------
  t = Date.now();
  const fixes = Array.from({ length: JOURNEYS }, (_, k) => ({ journeyId: `LT${RUN}${k}:${today}`, lat: routeFor(k)[3].lat, lng: routeFor(k)[3].lng, speedKmph: 60, recordedAt: new Date().toISOString() }));
  const g = await post('/v1/partner/locations', { fixes });
  console.log(`6. gps      ${g.updated}/${JOURNEYS} fixes in one call: ${Date.now() - t}ms`);

  for (const s of sockets) s.disconnect();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
