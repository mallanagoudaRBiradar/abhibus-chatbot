import { writeFileSync } from 'fs';
import { join } from 'path';
import { prisma } from '../db';
import { hashSecret, randomSecret } from '../lib/crypto';
import { defaultConfig } from '../shared/tenantConfig';
import { SCOPES } from '../shared/roles';
import { upsertRoom, type Stop } from '../core/rooms';
import { addMembers } from '../core/members';
import { postAlert } from '../core/alerts';
import { createMessage } from '../core/messages';
import { createAction } from '../core/actions';
import { audit } from '../core/audit';
import { createRoomPoll } from '../core/traveller';
import { config } from '../config';
import { logger } from '../lib/logger';

const MIN = 60_000;
export const DEMO_PASSWORD = 'TripRooms@2026';
const iso = (offsetMin: number) => new Date(Date.now() + offsetMin * MIN).toISOString();

/** Wipe every platform table (demo only). */
export async function resetAll() {
  await prisma.$transaction([
    prisma.reaction.deleteMany(), prisma.receipt.deleteMany(), prisma.message.deleteMany(), prisma.channel.deleteMany(), prisma.block.deleteMany(),
    prisma.report.deleteMany(), prisma.action.deleteMany(), prisma.issueReport.deleteMany(), prisma.auditLog.deleteMany(), prisma.locationFix.deleteMany(),
    prisma.tripEvent.deleteMany(), prisma.campaignDelivery.deleteMany(), prisma.campaign.deleteMany(), prisma.surveyResponse.deleteMany(), prisma.surveyTemplate.deleteMany(),
    prisma.eventLog.deleteMany(), prisma.member.deleteMany(), prisma.room.deleteMany(), prisma.webhook.deleteMany(), prisma.bot.deleteMany(), prisma.apiClient.deleteMany(),
    prisma.user.deleteMany(), prisma.tenant.deleteMany(),
  ]);
}

const TENANTS = [
  { id: 'abhibus', name: 'AbhiBus', verticals: ['bus'] as const, theme: { brand: '#d4373c', brandInk: '#ffffff', logoText: 'AbhiBus' }, identity: 'profile' as const, off: {} },
  { id: 'confirmtkt', name: 'ConfirmTkt', verticals: ['train', 'bus'] as const, theme: { brand: '#1d6fd8', brandInk: '#ffffff', logoText: 'ConfirmTkt' }, identity: 'handle' as const, off: { rest_stop: false } },
  { id: 'ixigo_trains', name: 'ixigo Trains', verticals: ['train'] as const, theme: { brand: '#ea6a1b', brandInk: '#ffffff', logoText: 'ixigo trains' }, identity: 'handle' as const, off: { wait_for_me: false, rest_stop: false } },
  { id: 'ixigo_flights', name: 'ixigo Flights', verticals: ['flight'] as const, theme: { brand: '#2b5ce6', brandInk: '#ffffff', logoText: 'ixigo flights' }, identity: 'handle' as const, off: { location_crowd: false, wait_for_me: false, rest_stop: false, women_channel: false } },
];

const USERS = [
  { email: 'admin@triprooms.local', name: 'Asha Admin', role: 'admin', tenants: [] },
  { email: 'ops@triprooms.local', name: 'Ravi Ops', role: 'ops', tenants: [] },
  { email: 'support@triprooms.local', name: 'Sana Support', role: 'support', tenants: [] },
  { email: 'marketing@triprooms.local', name: 'Priya Marketing', role: 'marketing', tenants: [] },
  { email: 'developer@triprooms.local', name: 'Dev Kumar', role: 'developer', tenants: [] },
  { email: 'viewer@triprooms.local', name: 'Leadership Viewer', role: 'viewer', tenants: [] },
  { email: 'abhibus.ops@triprooms.local', name: 'AbhiBus Ops (tenant-scoped)', role: 'ops', tenants: ['abhibus'] },
];

const BUS_LINES = ['Has it crossed Kukatpally?', 'Thanks! Waiting at Gachibowli, flyover side.', 'Is there a washroom break before Kurnool?', 'The bus is quite comfortable today.', 'AC is a bit cold at the back 🥶', 'Anyone getting down at Anantapur?'];

export async function seed() {
  for (const t of TENANTS) {
    await prisma.tenant.create({ data: { id: t.id, name: t.name, verticals: [...t.verticals], theme: t.theme, config: { ...defaultConfig(t.off, t.identity), support: { phone: '+91 40 0000 0000', care_handle: `${t.name} Care` } } } });
  }
  for (const u of USERS) await prisma.user.create({ data: { email: u.email, name: u.name, role: u.role as any, tenantIds: u.tenants, passwordHash: hashSecret(DEMO_PASSWORD) } });
  const creds: Record<string, { client_id: string; client_secret: string }> = {};
  for (const t of TENANTS) {
    const secret = `trs_${randomSecret(24)}`;
    const c = await prisma.apiClient.create({ data: { tenantId: t.id, name: `${t.name} backend (demo)`, clientId: `tnt_${t.id}_live`, secretHash: hashSecret(secret), secretHint: secret.slice(-4), scopes: [...SCOPES], createdBy: 'seed' } });
    creds[t.id] = { client_id: c.clientId, client_secret: secret };
    // Demo webhook receiver built into the server, so deliveries show up as 200s in the Developer portal.
    await prisma.webhook.create({ data: { id: `wh_${t.id}`, tenantId: t.id, url: `http://localhost:${config.PORT}/demo/webhook-sink/${t.id}`, events: ['*'], secret: `whsec_${randomSecret(18)}` } });
    await prisma.bot.create({ data: { id: `bot_tara_${t.id}`, tenantId: t.id, name: 'Tara', label: 'AI', triggers: ['mention', 'location_question', 'catch_up'] } });
  }
  writeFileSync(join(process.cwd(), '.demo-credentials.json'), JSON.stringify({ dashboard: { password: DEMO_PASSWORD, users: USERS.map((u) => ({ email: u.email, role: u.role })) }, api: creds }, null, 2));

  // ---------------------------------------------------------------- bus --
  const busStops: Stop[] = [
    { code: 'AMRP', name: 'Ameerpet', lat: 17.4375, lng: 78.4483, sched_dep: iso(-75), type: 'boarding' },
    { code: 'KPHB', name: 'KPHB', lat: 17.4933, lng: 78.3915, sched_dep: iso(-55), type: 'boarding' },
    { code: 'GCBW', name: 'Gachibowli', lat: 17.4401, lng: 78.3489, sched_dep: iso(-30), type: 'boarding' },
    { code: 'KRNL', name: 'Kurnool', lat: 15.8281, lng: 78.0373, sched_arr: iso(150), sched_dep: iso(170), type: 'rest_stop' },
    { code: 'ATP', name: 'Anantapur', lat: 14.6819, lng: 77.6006, sched_arr: iso(300) },
    { code: 'MJST', name: 'Bengaluru Majestic', lat: 12.9767, lng: 77.5713, sched_arr: iso(480), type: 'dropping' },
  ];
  const { room: bus } = await upsertRoom('abhibus', `bus:op_sunrise:svc-4412:${iso(0).slice(0, 10)}`, {
    vertical: 'bus', title: 'Hyderabad → Bengaluru', subtitle: 'Sunrise Travels · AC Sleeper 2+1',
    scope: { operator_id: 'op_sunrise', operator_name: 'Sunrise Travels', service_id: 'svc-4412', route: 'HYD-BLR', vehicle_no: 'TS 09 UB 4521' },
    schedule: { departs_at: busStops[0].sched_dep!, arrives_at: busStops[5].sched_arr! }, route: { stops: busStops }, location_feed: 'none',
  }, 'seed');
  await prisma.room.update({ where: { id: bus.id }, data: { delayMin: 25, state: 'onboard', meta: { vehicle_no: 'TS 09 UB 4521', lastStop: 2 } } });
  const busMembers = await addMembers(bus, Array.from({ length: 14 }, (_, i) => ({ external_user_id: `abhi_u_${1000 + i}`, booking_ref: `ABX${(7300 + Math.floor(i / 2)).toString(36).toUpperCase()}K`, gender: (i % 3 === 0 ? 'F' : 'M') as 'F' | 'M', segment: { from: i % 2 ? 'GCBW' : 'AMRP', to: i % 4 ? 'MJST' : 'ATP' }, display_name: ['Arjun', 'Priya', 'Vikram', 'Sneha', 'Imran', 'Lakshmi', 'Rohit', 'Ananya', 'Suresh', 'Kiran', 'Sam', 'Meera', 'Ravi', 'Divya'][i] })), 'seed');
  await prisma.member.updateMany({ where: { roomId: bus.id }, data: { profileSet: true } });
  const avatars = ['animal-1', 'animal-8', 'fun-6', null, 'animal-2', 'people-6', 'fun-0', 'fun-3', 'people-7', null, 'fun-1', 'animal-3', 'animal-5', 'fun-7'];
  for (const [i, m] of busMembers.entries()) await prisma.member.update({ where: { id: m.id }, data: { avatarId: avatars[i] } });
  for (const m of busMembers.slice(1, 4)) await prisma.member.update({ where: { id: m.id }, data: { sharingLocation: true } });
  await createMessage(bus.id, 'MAIN_COMMON', { senderName: 'System', contentType: 'SYSTEM', payload: { text: 'Room open. Only your first name and avatar are visible to others.' } });
  await postAlert(bus, { text: 'Bus is running 25 min late from Ameerpet. New time at Gachibowli: about 25 min after schedule.', severity: 'warning', translations: { hi: 'बस अमीरपेट से 25 मिनट देरी से चल रही है।' } }, 'ops@triprooms.local');
  await createMessage(bus.id, 'MAIN_COMMON', { senderId: busMembers[1].id, senderName: 'Priya', contentType: 'TEXT', payload: { text: BUS_LINES[0] } });
  await createMessage(bus.id, 'MAIN_COMMON', { senderName: 'Tara', contentType: 'TARA', payload: { text: 'Yes. 3 travellers on board are sharing location. The bus is past Gachibowli, heading towards Kurnool.', source: 'rules' } });
  await createMessage(bus.id, 'MAIN_COMMON', { senderId: busMembers[2].id, senderName: 'Vikram', contentType: 'TEXT', payload: { text: BUS_LINES[1] } });
  await createRoomPoll(bus, { question: 'Dinner stop at Kurnool: how long do you want?', options: ['15 min', '20 min', '30 min'], closes_in_min: 90, by: 'AbhiBus' });
  await createMessage(bus.id, 'WOMEN_ONLY', { senderId: busMembers[3].id, senderName: 'Sneha', contentType: 'TEXT', payload: { text: 'Travelling solo tonight. Glad this room exists 🙏' } });

  const chennaiStops: Stop[] = [
    { code: 'MYP', name: 'Miyapur', lat: 17.4968, lng: 78.3614, sched_dep: iso(-200) }, { code: 'KDD', name: 'Kodad', lat: 16.9984, lng: 79.9653, sched_arr: iso(-60) },
    { code: 'OGL', name: 'Ongole', lat: 15.5057, lng: 80.0499, sched_arr: iso(60) }, { code: 'NLR', name: 'Nellore', lat: 14.4426, lng: 79.9865, sched_arr: iso(160) },
    { code: 'CMBT', name: 'Chennai Koyambedu', lat: 13.0694, lng: 80.1948, sched_arr: iso(360) },
  ];
  const { room: b3 } = await upsertRoom('abhibus', `bus:op_bluecoast:svc-221:${iso(0).slice(0, 10)}`, { vertical: 'bus', title: 'Hyderabad → Chennai', subtitle: 'Blue Coast Travels · AC Sleeper', scope: { operator_id: 'op_bluecoast', operator_name: 'Blue Coast Travels', route: 'HYD-MAA' }, schedule: { departs_at: chennaiStops[0].sched_dep!, arrives_at: chennaiStops[4].sched_arr! }, route: { stops: chennaiStops } }, 'seed');
  await prisma.room.update({ where: { id: b3.id }, data: { state: 'onboard', delayMin: 120, breakdown: true } });
  const b3m = await addMembers(b3, Array.from({ length: 18 }, (_, i) => ({ external_user_id: `abhi_c_${i}`, booking_ref: `ABC${i}Q${i}`, gender: (i % 2 ? 'F' : 'M') as 'F' | 'M' })), 'seed');
  await postAlert(b3, { text: 'Our bus has a breakdown near Kodad. An alternate bus is on the way and should reach in about 60 min. Please stay near the bus.', severity: 'critical' }, 'ops@triprooms.local');
  await createMessage(b3.id, 'MAIN_COMMON', { senderId: b3m[0].id, senderName: b3m[0].handle, contentType: 'TEXT', payload: { text: 'Any update on the alternate bus?' } });

  const goaStops: Stop[] = [{ code: 'MJST', name: 'Majestic', sched_dep: iso(-120) }, { code: 'UBL', name: 'Hubballi', sched_arr: iso(240) }, { code: 'PNJ', name: 'Panaji', sched_arr: iso(540) }];
  const { room: b4 } = await upsertRoom('abhibus', `bus:op_wghats:svc-77:${iso(0).slice(0, 10)}`, { vertical: 'bus', title: 'Bengaluru → Goa', subtitle: 'Western Ghats Travels · Non-AC Sleeper', scope: { operator_id: 'op_wghats', operator_name: 'Western Ghats Travels', route: 'BLR-GOI' }, schedule: { departs_at: goaStops[0].sched_dep!, arrives_at: goaStops[2].sched_arr! }, route: { stops: goaStops } }, 'seed');
  await prisma.room.update({ where: { id: b4.id }, data: { state: 'onboard' } });
  await addMembers(b4, Array.from({ length: 6 }, (_, i) => ({ external_user_id: `abhi_g_${i}`, booking_ref: `ABG${i}`, gender: 'U' as const })), 'seed');
  await createAction(b4, { type: 'issue', severity: 'warning', title: 'Charging point not working', detail: '3 travellers reported this. Auto-escalated.', data: { label: 'Charging point not working', count: 3 } });

  const lateStops: Stop[] = [{ code: 'MYP', name: 'Miyapur', sched_dep: iso(90), type: 'boarding' }, { code: 'KRNL', name: 'Kurnool', sched_arr: iso(300) }, { code: 'MJST', name: 'Bengaluru Majestic', sched_arr: iso(615) }];
  const { room: b5 } = await upsertRoom('abhibus', `bus:op_sunrise:svc-4419:${iso(0).slice(0, 10)}`, { vertical: 'bus', title: 'Hyderabad → Bengaluru', subtitle: 'Sunrise Travels · Volvo Multi-axle', scope: { operator_id: 'op_sunrise', operator_name: 'Sunrise Travels', route: 'HYD-BLR' }, schedule: { departs_at: lateStops[0].sched_dep!, arrives_at: lateStops[2].sched_arr! }, route: { stops: lateStops } }, 'seed');
  await prisma.room.update({ where: { id: b5.id }, data: { state: 'open' } });
  const b5m = await addMembers(b5, Array.from({ length: 11 }, (_, i) => ({ external_user_id: `abhi_v_${i}`, booking_ref: `ABV${i}`, segment: { from: 'MYP', to: 'MJST' } })), 'seed');
  await createAction(b5, { type: 'wait_request', severity: 'warning', title: 'Wait for me · 10 min late', detail: `${b5m[2].handle} is 2.1 km from Miyapur boarding point.`, memberId: b5m[2].id, data: { minutes: 10 } });

  // -------------------------------------------------------------- trains --
  const trainStops = (shift: number): Stop[] => [
    { code: 'KCG', name: 'Kacheguda', sched_dep: iso(-95 + shift) }, { code: 'MBNR', name: 'Mahbubnagar', sched_arr: iso(-5 + shift), sched_dep: iso(-3 + shift) },
    { code: 'KRNT', name: 'Kurnool City', sched_arr: iso(140 + shift), sched_dep: iso(145 + shift) }, { code: 'DHNE', name: 'Dhone', sched_arr: iso(195 + shift), sched_dep: iso(197 + shift) },
    { code: 'ATP', name: 'Anantapur', sched_arr: iso(290 + shift), sched_dep: iso(292 + shift) }, { code: 'YPR', name: 'Yesvantpur', sched_arr: iso(530 + shift) },
  ];
  const ts = trainStops(0);
  const date = iso(0).slice(0, 10);
  const { room: tWide } = await upsertRoom('ixigo_trains', `train:12999:${date}`, { vertical: 'train', title: 'Kacheguda → Yesvantpur', subtitle: '12999 Deccan Example Express · Train-wide alerts', scope: { train_no: '12999', train_name: 'Deccan Example Express' }, schedule: { departs_at: ts[0].sched_dep!, arrives_at: ts[5].sched_arr! }, route: { stops: ts }, location_feed: 'running_status' }, 'seed');
  const { room: tB2 } = await upsertRoom('ixigo_trains', `train:12999:${date}:B2`, { vertical: 'train', title: 'Kacheguda → Yesvantpur', subtitle: '12999 Deccan Example Express · Coach B2 · 3A', scope: { train_no: '12999', train_name: 'Deccan Example Express', coach: 'B2', class: '3A', parent_trip_key: `train:12999:${date}` }, schedule: { departs_at: ts[0].sched_dep!, arrives_at: ts[5].sched_arr! }, route: { stops: ts }, location_feed: 'running_status' }, 'seed');
  for (const r of [tWide, tB2]) await prisma.room.update({ where: { id: r.id }, data: { state: 'onboard', delayMin: 10, meta: { platform: '2', lastStop: 1 } } });
  const tm = await addMembers(tB2, Array.from({ length: 22 }, (_, i) => ({ external_user_id: `ixi_t_${i}`, booking_ref: `45218733${String(i).padStart(2, '0')}`, seat_refs: [`B2-${i + 10}`], chart_status: 'charted' as const, gender: (i % 4 === 0 ? 'F' : 'M') as 'F' | 'M' })), 'seed');
  await addMembers(tWide, Array.from({ length: 6 }, (_, i) => ({ external_user_id: `ixi_w_${i}`, booking_ref: `WL${i}`, chart_status: 'waitlisted' as const })), 'seed');
  await prisma.locationFix.create({ data: { roomId: tB2.id, source: 'running_status', data: { last_station: 'MBNR', next_station: 'KRNT' } } });
  await createMessage(tB2.id, 'MAIN_COMMON', { senderName: 'System', contentType: 'SYSTEM', payload: { text: 'Coach B2 room. Before charting you were in the train-wide alerts room.' } });
  await postAlert(tB2, { text: 'Train is running 10 min late. Expected at Kurnool City on time from platform 2.', severity: 'info' }, 'ops@triprooms.local');
  await createMessage(tB2.id, 'MAIN_COMMON', { senderId: tm[3].id, senderName: tm[3].handle, contentType: 'TEXT', payload: { text: 'Is the pantry serving dinner?' } });
  await createMessage(tB2.id, 'MAIN_COMMON', { senderName: 'Tara', contentType: 'TARA', payload: { text: 'Pantry orders close after the next station. E-catering is available in your booking app.', source: 'rules' } });

  const hwh: Stop[] = [{ code: 'SC', name: 'Secunderabad', sched_dep: iso(-360) }, { code: 'BZA', name: 'Vijayawada', sched_arr: iso(-30), sched_dep: iso(-20) }, { code: 'VSKP', name: 'Visakhapatnam', sched_arr: iso(380), sched_dep: iso(400) }, { code: 'HWH', name: 'Howrah', sched_arr: iso(1200) }];
  const { room: t3 } = await upsertRoom('ixigo_trains', `train:12888:${date}:A1`, { vertical: 'train', title: 'Secunderabad → Howrah', subtitle: '12888 Example Mail · Coach A1 · 2A', scope: { train_no: '12888', train_name: 'Example Mail', coach: 'A1' }, schedule: { departs_at: hwh[0].sched_dep!, arrives_at: hwh[3].sched_arr! }, route: { stops: hwh }, location_feed: 'running_status' }, 'seed');
  await prisma.room.update({ where: { id: t3.id }, data: { state: 'onboard', delayMin: 45, meta: { platform: '5' } } });
  const t3m = await addMembers(t3, Array.from({ length: 12 }, (_, i) => ({ external_user_id: `ixi_h_${i}`, booking_ref: `88812${i}` })), 'seed');
  await postAlert(t3, { text: 'Train is running 45 min late after Vijayawada.', severity: 'warning' }, 'ops@triprooms.local');
  await createAction(t3, { type: 'lost_found', severity: 'info', title: 'Lost & found', detail: '“Left a grey jacket near the window side.”', memberId: t3m[1].id });
  await prisma.action.updateMany({ where: { roomId: t3.id }, data: { status: 'acknowledged' } });

  const ctk: Stop[] = trainStops(30);
  const { room: c1 } = await upsertRoom('confirmtkt', `train:12999:${date}:S5`, { vertical: 'train', title: 'Kacheguda → Yesvantpur', subtitle: '12999 Deccan Example Express · Coach S5 · SL', scope: { train_no: '12999', train_name: 'Deccan Example Express', coach: 'S5' }, schedule: { departs_at: ctk[0].sched_dep!, arrives_at: ctk[5].sched_arr! }, route: { stops: ctk }, location_feed: 'running_status' }, 'seed');
  await prisma.room.update({ where: { id: c1.id }, data: { state: 'onboard', delayMin: 10, meta: { platform: '2' } } });
  await addMembers(c1, Array.from({ length: 31 }, (_, i) => ({ external_user_id: `ctk_u_${i}`, booking_ref: `CTK${i}`, seat_refs: [`S5-${i + 1}`], gender: (i % 3 ? 'M' : 'F') as 'F' | 'M' })), 'seed');

  // ------------------------------------------------------------- flights --
  const f1Stops: Stop[] = [{ code: 'HYD', name: 'Hyderabad (HYD)', terminal: 'T1', sched_dep: iso(20) }, { code: 'BLR', name: 'Bengaluru (BLR)', terminal: 'T1', sched_arr: iso(95) }];
  const { room: f1 } = await upsertRoom('ixigo_flights', `flight:XY512:${date}`, { vertical: 'flight', title: 'Hyderabad → Bengaluru', subtitle: 'Flight XY 512 · Delay room', scope: { carrier: 'XY', flight_no: '512', origin: 'HYD', destination: 'BLR' }, schedule: { departs_at: f1Stops[0].sched_dep!, arrives_at: f1Stops[1].sched_arr! }, route: { stops: f1Stops }, activation: { mode: 'on_delay', min_delay_min: 45 }, location_feed: 'flight_status' }, 'seed');
  await prisma.room.update({ where: { id: f1.id }, data: { state: 'open', delayMin: 90, meta: { gate: '12', terminal: 'T1' } } });
  const fm = await addMembers(f1, Array.from({ length: 41 }, (_, i) => ({ external_user_id: `ixi_f_${i}`, booking_ref: `X7K${i}QP` })), 'seed');
  await prisma.locationFix.create({ data: { roomId: f1.id, source: 'flight_status', data: { status: 'delayed', gate: '12' } } });
  await createMessage(f1.id, 'MAIN_COMMON', { senderName: 'System', contentType: 'SYSTEM', payload: { text: 'This room opened because XY 512 is delayed more than 45 min.' } });
  await postAlert(f1, { text: 'XY 512 is delayed by 90 min due to late arrival of the incoming aircraft. New departure from gate 12.', severity: 'critical' }, 'ops@triprooms.local');
  await createMessage(f1.id, 'MAIN_COMMON', { senderId: fm[4].id, senderName: fm[4].handle, contentType: 'TEXT', payload: { text: 'Any meal vouchers for this delay?' } });
  await createMessage(f1.id, 'MAIN_COMMON', { senderName: 'Tara', contentType: 'TARA', payload: { text: 'The airline hasn’t announced meal vouchers yet. I’ll post here as soon as Ops confirms.', source: 'rules' } });

  const f2Stops: Stop[] = [{ code: 'BOM', name: 'Mumbai (BOM)', terminal: 'T2', sched_dep: iso(-60) }, { code: 'DEL', name: 'Delhi (DEL)', terminal: 'T3', sched_arr: iso(70) }];
  const { room: f2 } = await upsertRoom('ixigo_flights', `flight:XY220:${date}`, { vertical: 'flight', title: 'Mumbai → Delhi', subtitle: 'Flight XY 220 · Delay room', scope: { carrier: 'XY', flight_no: '220', origin: 'BOM', destination: 'DEL' }, schedule: { departs_at: f2Stops[0].sched_dep!, arrives_at: f2Stops[1].sched_arr! }, route: { stops: f2Stops }, activation: { mode: 'on_delay', min_delay_min: 45 }, location_feed: 'flight_status' }, 'seed');
  await prisma.room.update({ where: { id: f2.id }, data: { state: 'open', delayMin: 150, meta: { gate: '31', terminal: 'T2' } } });
  const f2m = await addMembers(f2, Array.from({ length: 63 }, (_, i) => ({ external_user_id: `ixi_m_${i}`, booking_ref: `MD${i}` })), 'seed');
  await postAlert(f2, { text: 'XY 220 is delayed by 150 min due to weather at Delhi. Meal vouchers at the counter near gate 31.', severity: 'critical' }, 'ops@triprooms.local');
  const bad = await createMessage(f2.id, 'MAIN_COMMON', { senderId: f2m[2].id, senderName: f2m[2].handle, contentType: 'TEXT', payload: { text: 'DM me for cheap upgrades, I can arrange' } });
  await prisma.message.update({ where: { id: bad.id }, data: { hidden: true } });
  await createAction(f2, { type: 'report', severity: 'info', title: 'Message hidden after 2 reports', detail: `“DM me for cheap upgrades…” by ${f2m[2].handle}`, memberId: f2m[2].id, data: { message_id: bad.id } });

  const f3Stops: Stop[] = [{ code: 'BLR', name: 'Bengaluru (BLR)', sched_dep: iso(240) }, { code: 'CCU', name: 'Kolkata (CCU)', sched_arr: iso(400) }];
  const { room: f3 } = await upsertRoom('ixigo_flights', `flight:XY901:${date}`, { vertical: 'flight', title: 'Bengaluru → Kolkata', subtitle: 'Flight XY 901', scope: { carrier: 'XY', flight_no: '901' }, schedule: { departs_at: f3Stops[0].sched_dep!, arrives_at: f3Stops[1].sched_arr! }, route: { stops: f3Stops }, activation: { mode: 'on_delay', min_delay_min: 45 }, location_feed: 'flight_status' }, 'seed');
  await addMembers(f3, Array.from({ length: 70 }, (_, i) => ({ external_user_id: `ixi_k_${i}`, booking_ref: `KC${i}` })), 'seed');

  // ----------------------------------------------------------- campaigns --
  const camp = (d: any) => prisma.campaign.create({ data: { createdBy: 'marketing@triprooms.local', ...d } });
  await camp({ id: 'cmp_kurnool', name: 'Kurnool dinner offer', advertiser: 'Dhaba Express (sample)', format: 'stop_offer', status: 'live', verticals: ['bus'], routes: ['HYD-BLR'], stops: ['Kurnool'], stages: ['onboard'], tenantIds: [], creative: { title: 'Dhaba Express, Kurnool', body: 'Free chai with any thali tonight', cta: 'Show coupon', tile: '#f07a2d', coupon: 'TRIP-CHAI-26' }, impressions: 1840, clicks: 212 });
  await camp({ id: 'cmp_snack', name: 'Road snack poll', advertiser: 'Sample Snacks', format: 'sponsored_poll', status: 'live', verticals: ['bus', 'train'], routes: [], stops: [], stages: ['open', 'onboard'], tenantIds: [], creative: { title: 'Sample Snacks' }, poll: { q: 'Best snack for a night journey?', opts: ['Chips', 'Biscuits', 'Fruit', 'Murukku'] }, impressions: 5210, responses: 1630 });
  await camp({ id: 'cmp_boarding', name: 'Boarding experience survey', advertiser: 'AbhiBus Research', format: 'survey', status: 'live', verticals: ['bus'], routes: [], stops: [], stages: ['read_only'], tenantIds: ['abhibus'], creative: { title: '2-question survey' }, survey: { questions: [{ type: 'rating', q: 'How easy was it to find your boarding point?' }, { type: 'choice', q: 'How did you find the bus?', options: ['Live tracking', 'Called the driver', 'Asked in the trip room', 'Other'] }] }, impressions: 2300, responses: 640 });
  await camp({ id: 'cmp_buds', name: 'Travel earbuds launch', advertiser: 'Sample Audio', format: 'card', status: 'live', verticals: ['train', 'flight'], routes: [], stops: [], stages: ['open', 'onboard'], tenantIds: [], creative: { title: 'Sample Audio Buds', body: '40-hour battery for long journeys. ₹999 today.', cta: 'View deal', tile: '#5b6cff' }, impressions: 880, clicks: 41 });
  await camp({ id: 'cmp_trivia', name: 'Trivia night', advertiser: 'Sample Cola', format: 'sponsored_game', status: 'paused', verticals: ['bus', 'train', 'flight'], routes: [], stops: [], stages: ['onboard'], tenantIds: [], creative: { title: 'Trip trivia', body: 'Sponsored by Sample Cola' } });

  await audit({ tenantId: 'abhibus', actor: 'ops@triprooms.local', action: 'member.revealed', roomId: b3.id, targetId: b3m[0].id, reason: 'sos' });
  logger.info({ tenants: TENANTS.length, users: USERS.length }, '🌱 demo data seeded');
  return { bus, creds };
}

if (require.main === module) {
  (async () => {
    if (process.argv.includes('--reset')) await resetAll();
    if (await prisma.tenant.count()) { console.log('Already seeded. Use --reset to start over.'); process.exit(0); }
    await seed();
    console.log(`Seeded. Dashboard password for every demo user: ${DEMO_PASSWORD}\nAPI credentials written to .demo-credentials.json`);
    process.exit(0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
