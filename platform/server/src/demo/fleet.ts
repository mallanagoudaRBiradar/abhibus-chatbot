import { prisma } from '../db';
import { logger } from '../lib/logger';
import { upsertRoom, type Stop } from '../core/rooms';
import { addMembers } from '../core/members';

/**
 * Demo only: a realistic fleet so filters can be judged at real scale (busy corridors run 50+
 * buses a night). Idempotent: trip keys carry today's IST date, so restarts don't duplicate
 * and each new day gets fresh trips. Never touches existing rooms, keys or webhooks.
 */
const OPS = [
  ['op_vrl', 'VRL Travels'], ['op_freshbus', 'FreshBus'], ['op_orange', 'Orange Travels'], ['op_srs', 'SRS Travels'],
  ['op_jabbar', 'Jabbar Travels'], ['op_kaveri', 'Kaveri Travels'], ['op_intrcity', 'IntrCity SmartBus'], ['op_morningstar', 'Morning Star'],
] as const;
const COACH = ['AC Sleeper 2+1', 'Volvo Multi-axle Semi-sleeper', 'Non-AC Sleeper', 'AC Seater/Sleeper', 'Bharat Benz AC Sleeper', 'Electric AC Seater'];
type Route = { code: string; from: [string, number, number]; mid: [string, number, number]; to: [string, number, number]; hours: number; departures: number[] };
const ROUTES: Route[] = [
  { code: 'HYD-BLR', from: ['Hyderabad', 17.4375, 78.4483], mid: ['Kurnool', 15.8281, 78.0373], to: ['Bengaluru', 12.9767, 77.5713], hours: 9, departures: [6, 7.5, 9, 11, 13, 14.5, 16, 17.5, 18, 18.75, 19.5, 20, 20.5, 21, 21.25, 21.5, 22, 22.25, 22.5, 23, 23.5] },
  { code: 'BLR-HYD', from: ['Bengaluru', 12.9767, 77.5713], mid: ['Anantapur', 14.6819, 77.6006], to: ['Hyderabad', 17.4375, 78.4483], hours: 9, departures: [8, 13, 19, 20.5, 21.5, 22, 22.5, 23] },
  { code: 'HYD-VJA', from: ['Hyderabad', 17.4375, 78.4483], mid: ['Suryapet', 17.1405, 79.6236], to: ['Vijayawada', 16.5062, 80.648], hours: 5, departures: [6.5, 9, 12, 15, 18, 21, 23] },
  { code: 'BLR-MAA', from: ['Bengaluru', 12.9767, 77.5713], mid: ['Vellore', 12.9165, 79.1325], to: ['Chennai', 13.0827, 80.2707], hours: 6, departures: [7, 10, 14, 18.5, 22] },
];

export async function ensureDemoFleet() {
  const now = new Date();
  const istDate = new Date(+now + 330 * 60_000).toISOString().slice(0, 10);
  const atIst = (h: number) => new Date(`${istDate}T${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}:00+05:30`);
  let created = 0, n = 0;
  for (const rt of ROUTES) for (const [i, dep] of rt.departures.entries()) {
    n++;
    const [opId, opName] = OPS[(i * 3 + rt.code.length) % OPS.length];
    const key = `bus:${opId}:fleet-${rt.code}-${i}:${istDate}`;
    if (await prisma.room.findFirst({ where: { tripKey: key }, select: { id: true } })) continue;
    const d = atIst(dep), a = new Date(+d + rt.hours * 3600_000), m = new Date(+d + (rt.hours / 2) * 3600_000);
    const stops: Stop[] = [
      { code: rt.code.slice(0, 3), name: rt.from[0], lat: rt.from[1], lng: rt.from[2], sched_dep: d.toISOString(), type: 'boarding' },
      { code: 'MID', name: rt.mid[0], lat: rt.mid[1], lng: rt.mid[2], sched_arr: m.toISOString(), sched_dep: new Date(+m + 15 * 60_000).toISOString(), type: 'rest_stop' },
      { code: rt.code.slice(4), name: rt.to[0], lat: rt.to[1], lng: rt.to[2], sched_arr: a.toISOString(), type: 'dropping' },
    ];
    const vehicle = `${rt.from[0] === 'Bengaluru' ? 'KA' : 'TS'} ${String(10 + (n % 80)).padStart(2, '0')} ${['AB', 'CD', 'EF', 'GH', 'JK'][n % 5]} ${String(1000 + n * 37).slice(-4)}`;
    const { room } = await upsertRoom('abhibus', key, {
      vertical: 'bus', title: `${rt.from[0]} → ${rt.to[0]}`, subtitle: `${opName} · ${COACH[(i + n) % COACH.length]}`,
      scope: { operator_id: opId, operator_name: opName, service_id: `fleet-${rt.code}-${i}`, route: rt.code, vehicle_no: vehicle },
      schedule: { departs_at: d.toISOString(), arrives_at: a.toISOString() }, route: { stops },
    }, 'demo-fleet');
    const seats = 6 + ((i * 7 + n * 5) % 28);
    await addMembers(room, Array.from({ length: seats }, (_, k) => ({ external_user_id: `fleet_${room.id}_${k}`, booking_ref: `FL${n}${k}${rt.code.slice(0, 1)}`, gender: (k % 3 === 0 ? 'F' : 'M') as 'F' | 'M' })), 'demo-fleet').catch(() => {});
    created++;
  }
  if (created) logger.info({ created, total: n, date: istDate }, 'demo: fleet topped up');
}
