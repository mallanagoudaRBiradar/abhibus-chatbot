#!/usr/bin/env node
/**
 * Functional checks for the partner API against a running server (BOOKING_SOURCE=partner).
 *   BASE=http://localhost:4000 PARTNER_KEY=... node scripts/test-partner.mjs
 * Creates one throwaway journey and cancels it at the end.
 */
import { io } from 'socket.io-client';
import assert from 'assert/strict';

const BASE = process.env.BASE ?? 'http://localhost:4000';
const KEY = process.env.PARTNER_KEY ?? '';
const RUN = Date.now().toString(36).toUpperCase().slice(-6);
const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const journey = {
  serviceId: `T${RUN}`, journeyDate: today, busNumber: 'TS09T1234', operatorName: 'Test Travels',
  sourceCity: 'Hyderabad', destinationCity: 'Vijayawada',
  startTime: new Date(Date.now() + 10 * 60_000).toISOString(), estimatedEndTime: new Date(Date.now() + 5 * 3600_000).toISOString(),
  route: [{ name: 'Hyderabad', lat: 17.38, lng: 78.48, kind: 'PICKUP' }, { name: 'Panthangi Toll', lat: 17.2, lng: 79.0, kind: 'TOLL' }, { name: 'Vijayawada', lat: 16.5, lng: 80.64 }],
};
const JID = `T${RUN}:${today}`;

const call = async (method, path, body, key = KEY) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', 'x-api-key': key }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const session = (pnr, seat, device) => call('POST', '/v1/partner/chat-sessions', { pnr, seat, deviceId: device, customerId: 'c1', profile: { name: 'Asha', avatar: null } });
const connect = (token, jid = JID) => new Promise((resolve, reject) => {
  const s = io(BASE, { path: '/ws', transports: ['websocket'], auth: { token }, query: { jid }, reconnection: false });
  s.removed = new Promise((r) => s.on('moderation:removed', r));
  s.once('connect', () => resolve(s));
  s.once('connect_error', reject);
});
const join = (s, roomType) => new Promise((r) => s.emit('room:join', { roomType }, r));
const removedWithin = (s, ms = 3000) => Promise.race([s.removed.then(() => true), new Promise((r) => setTimeout(() => r(false), ms))]);

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`✔ ${name}`); };

await check('rejects a missing or wrong API key', async () => {
  assert.equal((await call('POST', '/v1/partner/bookings', {}, 'nope')).status, 401);
});

await check('ingests a booking (idempotent on repeat)', async () => {
  const b = { pnr: `A${RUN}`, customerId: 'c1', journey, seats: [{ seat: '1L', gender: 'F' }, { seat: '1U', gender: 'M' }] };
  const first = await call('POST', '/v1/partner/bookings', b);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.added, 2);
  const again = await call('POST', '/v1/partner/bookings', b);
  assert.equal(again.body.added, 0);
});

await check('rejects bad payloads with field errors', async () => {
  const r = await call('POST', '/v1/partner/bookings', { pnr: 'X', journey: { ...journey, journeyDate: '07-10-2026' }, seats: [] });
  assert.equal(r.status, 400);
  assert.ok(r.body.issues.length >= 1);
});

let womanSocket, manSocket;
await check('woman gets a session and enters the women-only room', async () => {
  const r = await session(`A${RUN}`, '1L', 'device-woman');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  womanSocket = await connect(r.body.token);
  assert.equal((await join(womanSocket, 'WOMEN_ONLY')).ok, true);
});

await check('man on the same PNR is refused the women-only room', async () => {
  const r = await session(`A${RUN}`, '1U', 'device-man');
  manSocket = await connect(r.body.token);
  const ack = await join(manSocket, 'WOMEN_ONLY');
  assert.equal(ack.code, 'FORBIDDEN');
  assert.equal((await join(manSocket, 'MAIN_COMMON')).ok, true);
});

await check('a second phone cannot take a claimed seat', async () => {
  const r = await session(`A${RUN}`, '1L', 'device-intruder');
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'SEAT_CLAIMED');
});

await check('support release frees the seat and drops the old phone', async () => {
  const r = await call('POST', `/v1/partner/journeys/${encodeURIComponent(JID)}/seats/1L/release`);
  assert.equal(r.status, 200);
  assert.equal(await removedWithin(womanSocket), true);
  assert.equal((await session(`A${RUN}`, '1L', 'device-woman-new')).status, 200);
});

await check('seat resold to another PNR: old passenger is dropped and can no longer join', async () => {
  const r = await call('POST', '/v1/partner/bookings', { pnr: `B${RUN}`, customerId: 'c2', journey, seats: [{ seat: '1U', gender: 'M' }] });
  assert.equal(r.status, 200);
  assert.equal(await removedWithin(manSocket), true);
  assert.equal((await session(`A${RUN}`, '1U', 'device-man')).status, 404);
  assert.equal((await session(`B${RUN}`, '1U', 'device-buyer')).status, 200);
});

await check('partial cancellation removes only that seat', async () => {
  const r = await call('POST', `/v1/partner/bookings/A${RUN}/cancel`, { seats: ['1L'] });
  assert.equal(r.body.cancelled, 1);
  assert.equal((await session(`A${RUN}`, '1L', 'device-woman-new')).status, 404);
  assert.equal((await session(`B${RUN}`, '1U', 'device-buyer')).status, 200);
});

await check('gender change on a joined seat forces a rejoin (women-room re-gate)', async () => {
  await call('POST', '/v1/partner/bookings', { pnr: `C${RUN}`, journey, seats: [{ seat: '2L', gender: 'F' }] });
  const s = await connect((await session(`C${RUN}`, '2L', 'device-c')).body.token);
  await call('POST', '/v1/partner/bookings', { pnr: `C${RUN}`, journey, seats: [{ seat: '2L', gender: 'M' }] });
  assert.equal(await removedWithin(s), true);
});

await check('GPS: newer fix is stored, an older one is ignored', async () => {
  const at = Date.now();
  assert.equal((await call('POST', '/v1/partner/locations', { fixes: [{ journeyId: JID, lat: 17.3, lng: 78.7, speedKmph: 55, recordedAt: new Date(at).toISOString() }] })).body.updated, 1);
  assert.equal((await call('POST', '/v1/partner/locations', { fixes: [{ journeyId: JID, lat: 1, lng: 1, recordedAt: new Date(at - 60_000).toISOString() }] })).body.updated, 0);
  const j = (await call('GET', `/v1/partner/journeys/${encodeURIComponent(JID)}`)).body;
  assert.equal(new Date(j.lastFixAt).getTime(), at);
});

await check('journey status reports bookings and joins', async () => {
  const j = (await call('GET', `/v1/partner/journeys/${encodeURIComponent(JID)}`)).body;
  assert.equal(j.seatsBooked, 2); // 1U (B) and 2L (C) remain
  assert.ok(j.seatsJoined >= 1);
});

await check('reactions keep different emoji apart (database collation)', async () => {
  await call('POST', '/v1/partner/bookings', { pnr: `D${RUN}`, journey, seats: [{ seat: '3L', gender: 'M' }, { seat: '3U', gender: 'M' }] });
  const a = await connect((await session(`D${RUN}`, '3L', 'device-d1')).body.token);
  const b = await connect((await session(`D${RUN}`, '3U', 'device-d2')).body.token);
  await join(a, 'MAIN_COMMON'); await join(b, 'MAIN_COMMON');
  const sent = await new Promise((r) => a.emit('message:send', { roomType: 'MAIN_COMMON', clientMsgId: `react-${RUN}`, contentType: 'TEXT', payload: { text: 'hello bus' } }, r));
  const latest = () => new Promise((r) => a.once('reactions:update', (u) => r(u.reactions)));
  const react = (s, emoji) => new Promise((r) => s.emit('message:react', { messageId: sent.data.id, emoji }, r));
  let next = latest(); await react(a, '👍'); await next;
  next = latest(); await react(b, '❤️');
  assert.deepEqual(Object.keys(await next).sort(), ['❤️', '👍'].sort());
  next = latest(); await react(a, '😂'); // switching replaces only a's own reaction
  assert.deepEqual(await next, { '❤️': ['3U'], '😂': ['3L'] });
  a.disconnect(); b.disconnect();
});

// ------------------------------------------------ AbhiBus raw adapter ---
import { readFileSync } from 'fs';
const OPS_KEY = process.env.OPS_KEY ?? '';
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const ist = (msFromNow) => new Date(Date.now() + msFromNow + 5.5 * 3600_000).toISOString().replace('T', ' ').slice(0, 16); // "YYYY-MM-DD HH:MM" IST
/** The real GetTicket sample, made live: confirmed, departing soon, two passengers. */
function liveTicket({ pnr, serviceKey, seats, passengers = [], boarding, status = 'Confirmed', file = 'abhibus-getTicket.json' }) {
  const g = fixture(file);
  const t = g.ticketList[0];
  const ai = JSON.parse(t.additional_info);
  const today = ist(0).slice(0, 10);
  Object.assign(t, { PNR: pnr, Status: status, ServiceKey: serviceKey, serviceId: serviceKey, SelectedSeats: seats.join(','), passengerdetails: [],
    JourneyDate: today.split('-').reverse().join('-'), boardingDateTime: ist(20 * 60_000), droppingDateTime: ist(8 * 3600_000) });
  passengers.forEach((p, i) => { t[`Passenger${i + 1}`] = `(${p.name},${p.gender})`; });
  if (boarding) { const { bpId, ...rest } = boarding; Object.assign(t, rest); if (bpId) ai.bpId = bpId; }
  ai.origin_date_time = ist(10 * 60_000);
  t.additional_info = JSON.stringify(ai);
  return g;
}
const SK = `T${RUN}`;
const ABJID = `2291_7_${SK}:${ist(0).slice(0, 10)}`;

await check('AbhiBus GetTicket (raw) → booking with passengers, boarding/dropping, tracking id', async () => {
  const r = await call('POST', '/v1/partner/abhibus/ticket', liveTicket({ pnr: `AB${RUN}`, serviceKey: SK, seats: ['11L', '11U'], passengers: [{ name: 'Asha', gender: 'F' }, { name: 'Ravi', gender: 'M' }] }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.journeyId, ABJID);
  assert.equal(r.body.added, 2);
  const j = (await call('GET', `/v1/partner/journeys/${encodeURIComponent(ABJID)}`)).body;
  assert.equal(j.seatsBooked, 2);
  assert.equal(j.routeStops, 2); // KPHB pickup + HSR Layout drop, from the ticket's coordinates
  assert.equal(j.routeSource, 'bookings');
  assert.match(j.trackingRef ?? '', /^MjI5MV83/);
  assert.equal(j.operatorName, 'Fresh Bus');
  assert.equal(j.operatorHelpline, '9676266294');           // busPartnerDetails "Bus partner helpline"
  assert.equal(j.firstBoarding.name, 'KPHB');
  assert.equal(j.droppingPoints[0].name, 'HSR Layout');
  assert.equal(j.droppingPoints[0].seats, 2);
  globalThis.kphbStart = j.startTime;
});

await check('second PNR boarding elsewhere extends the auto route', async () => {
  const r = await call('POST', '/v1/partner/abhibus/ticket', liveTicket({ pnr: `AC${RUN}`, serviceKey: SK, seats: ['12L'], passengers: [{ name: 'Meena', gender: 'F' }],
    boarding: { bpId: '2', Boarding_At: 'Ameerpet', Landmark: 'Metro pillar 1102', boardingLatLong: '17.4375, 78.4483', boardingDateTime: ist(5 * 60_000) } }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const j = (await call('GET', `/v1/partner/journeys/${encodeURIComponent(ABJID)}`)).body;
  assert.equal(j.routeStops, 3);
  // Ameerpet boards 15 min before KPHB: it is now the first pickup, and the room's start follows it.
  assert.equal(j.firstBoarding.name, 'Ameerpet');
  assert.deepEqual(j.boardingPoints.map((p) => p.name), ['Ameerpet', 'KPHB']);
  assert.ok(Date.parse(j.startTime) < Date.parse(globalThis.kphbStart), 'start must move to the earliest boarding');
  assert.equal(new Date(j.startTime).getTime(), new Date(j.firstBoarding.at).getTime());
});

await check('the woman from the AbhiBus ticket can open chat and the women-only room', async () => {
  const r = await call('POST', '/v1/partner/chat-sessions', { pnr: `AB${RUN}`, seat: '11L', deviceId: 'device-ab-1', profile: { name: 'Asha', avatar: null } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.me.gender, 'F');
  assert.equal(r.body.journey.operatorHelpline, '9676266294'); // shown in the SOS sheet
  const s = await connect(r.body.token, r.body.journey.journeyId);
  assert.equal((await join(s, 'WOMEN_ONLY')).ok, true);
  s.disconnect();
});

await check('Ops contact lookup returns the decrypted name and phone (needs a reason)', async () => {
  if (!OPS_KEY) { console.log('   (skipped: set OPS_KEY)'); return; }
  const url = (q) => `${BASE}/v1/ops/journeys/${encodeURIComponent(ABJID)}/seats/11L/contact${q}`;
  assert.equal((await fetch(url(''), { headers: { 'x-api-key': OPS_KEY } })).status, 400);
  const r = await fetch(url('?reason=issue%20follow-up'), { headers: { 'x-api-key': OPS_KEY } });
  const b = await r.json();
  assert.equal(r.status, 200, JSON.stringify(b));
  assert.equal(b.name, 'Asha');
  assert.equal(b.phone, '9000000001');
  assert.equal(b.boarding.name, 'KPHB');
});

await check('AbhiBus ConfirmCancellation (raw) removes only the cancelled seat', async () => {
  const c = { ...fixture('abhibus-cancelTicket.json'), ticket_num: `AB${RUN}`, cancel_seats: '11U', status: 'success', is_already_cancelled: 'no' };
  const r = await call('POST', '/v1/partner/abhibus/cancellation', c);
  assert.equal(r.body.cancelled, 1, JSON.stringify(r.body));
  assert.equal((await session(`AB${RUN}`, '11U', 'device-ab-2')).status, 404);
  assert.equal((await session(`AB${RUN}`, '11L', 'device-ab-1')).status, 200);
});

await check('a failed cancellation response changes nothing', async () => {
  const c = { ...fixture('abhibus-cancelTicket.json'), ticket_num: `AB${RUN}`, cancel_seats: '11L', status: 'fail', is_already_cancelled: 'no', cancelstatus: 'N', message: 'Cancellation window closed' };
  const r = await call('POST', '/v1/partner/abhibus/cancellation', c);
  assert.equal(r.body.ignored, true);
  assert.equal((await session(`AB${RUN}`, '11L', 'device-ab-1')).status, 200);
});

await check('rescheduled to another bus (same PNR): leaves the old journey', async () => {
  const r = await call('POST', '/v1/partner/abhibus/ticket', liveTicket({ pnr: `AC${RUN}`, serviceKey: `${SK}X`, seats: ['5L'], passengers: [{ name: 'Meena', gender: 'F' }] }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const old = (await call('GET', `/v1/partner/journeys/${encodeURIComponent(ABJID)}`)).body;
  assert.equal(old.seatsBooked, 1); // only 11L (AB) left; AC moved
  assert.equal(old.routeStops, 2);  // Ameerpet pickup gone with it
  assert.equal(old.firstBoarding.name, 'KPHB');
  assert.equal(old.startTime, globalThis.kphbStart); // start moves back to the next-earliest boarding
});

await check('GetTicket with Status "Cancelled" cancels the whole PNR', async () => {
  const r = await call('POST', '/v1/partner/abhibus/ticket', liveTicket({ pnr: `AB${RUN}`, serviceKey: SK, seats: ['11L'], passengers: [{ name: 'Asha', gender: 'F' }], status: 'Cancelled' }));
  assert.equal(r.body.status, 'CANCELLED');
  assert.equal(r.body.cancelled, 1);
  await call('POST', `/v1/partner/journeys/${encodeURIComponent(ABJID)}/events`, { type: 'CANCELLED' });
  await call('POST', `/v1/partner/journeys/${encodeURIComponent(`2291_7_${SK}X:${ist(0).slice(0, 10)}`)}/events`, { type: 'CANCELLED' });
});

// 3 passengers; names/genders only in haltEvents (as in real tickets), numbered in booking order.
const SK3 = `P${RUN}`;
const JID3 = `2291_7_${SK3}:${ist(0).slice(0, 10)}`;
const ticket3 = (seats, status) => liveTicket({ file: 'abhibus-getTicket-3pax.json', pnr: `TP${RUN}`, serviceKey: SK3, seats, status });
const enter = async (seat, device) => {
  const r = await call('POST', '/v1/partner/chat-sessions', { pnr: `TP${RUN}`, seat, deviceId: device, profile: { name: 'Pat', avatar: null } });
  if (r.status !== 200) return { status: r.status };
  const s = await connect(r.body.token, r.body.journey.journeyId);
  const ack = await join(s, 'WOMEN_ONLY');
  s.disconnect();
  return { status: 200, gender: r.body.me.gender, women: ack.ok ? 'in' : ack.code };
};

await check('3-passenger ticket: genders from haltEvents; only the woman (8U) gets the women-only room', async () => {
  const r = await call('POST', '/v1/partner/abhibus/ticket', ticket3(['4U', '8U', '16'], 'Confirmed'));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.seats, ['4U', '8U', '16']);
  assert.deepEqual(await enter('8U', 'device-8u-x'), { status: 200, gender: 'F', women: 'in' });
  assert.deepEqual(await enter('16', 'device-16-x'), { status: 200, gender: 'M', women: 'FORBIDDEN' });
});

await check('partial cancellation (8U gone from SelectedSeats): 8U leaves, seat 16 stays male, not re-mapped to her', async () => {
  const r = await call('POST', '/v1/partner/abhibus/ticket', ticket3(['4U', '16'], 'Confirmed'));
  assert.equal(r.body.removed, 1, JSON.stringify(r.body));
  assert.equal((await enter('8U', 'device-8u-x')).status, 404);
  assert.deepEqual(await enter('16', 'device-16-x'), { status: 200, gender: 'M', women: 'FORBIDDEN' });
});

await check('full cancellation response (all seats) empties the PNR', async () => {
  const c = { ...fixture('abhibus-cancelTicket-3pax.json'), ticket_num: `TP${RUN}` }; // "already cancelled", Adult_Seats 4U,8U,16
  const r = await call('POST', '/v1/partner/abhibus/cancellation', c);
  assert.equal(r.body.cancelled, 2, JSON.stringify(r.body)); // 4U and 16 were left
  assert.equal((await call('GET', `/v1/partner/journeys/${encodeURIComponent(JID3)}`)).body.seatsBooked, 0);
  await call('POST', `/v1/partner/journeys/${encodeURIComponent(JID3)}/events`, { type: 'CANCELLED' });
});

await check('a ticket first seen as Cancelled adds nobody and creates no room', async () => {
  const g = liveTicket({ file: 'abhibus-getTicket-3pax.json', pnr: `TQ${RUN}`, serviceKey: `${SK3}Q`, seats: ['4U', '8U', '16'], status: 'Cancelled' });
  const r = await call('POST', '/v1/partner/abhibus/ticket', g);
  assert.equal(r.body.status, 'CANCELLED');
  assert.equal(r.body.cancelled, 0);
  assert.equal((await call('GET', `/v1/partner/journeys/${encodeURIComponent(`2291_7_${SK3}Q:${ist(0).slice(0, 10)}`)}`)).status, 404);
});

await check('journey cancellation closes the chat', async () => {
  const r = await call('POST', `/v1/partner/journeys/${encodeURIComponent(JID)}/events`, { type: 'CANCELLED' });
  assert.equal(r.status, 200);
  assert.ok(r.body.closingAt);
});

console.log(`\n${passed} checks passed`);
process.exit(0);
