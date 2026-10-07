import type { Room } from '@prisma/client';
import { prisma } from '../db';
import { haversineKm } from '../lib/geo';
import { etaOf, nextIdx, placeLabel, stopsOf, timetablePos } from './rooms';
import type { LocationEstimate } from '../shared/protocol';
import { UNIT } from '../shared/verticals';

const FRESH_MS = 3 * 60_000;

/**
 * Best current position for a room. Order of trust:
 *   1. an official feed (bus VTS / train running status / flight status) that is fresh
 *   2. on-board travellers sharing anonymously: 2+ = high, 1 = medium
 *   3. the timetable shifted by the known delay ("estimated")
 * Crowd and VTS fixes with lat/lng are snapped onto the route to get progress.
 */
export async function estimate(r: Room, now = Date.now()): Promise<LocationEstimate> {
  const since = new Date(now - FRESH_MS);
  const fixes = await prisma.locationFix.findMany({ where: { roomId: r.id, recordedAt: { gte: since } }, orderBy: { recordedAt: 'desc' }, take: 50 });
  const official = fixes.find((f) => f.source !== 'crowd');
  const crowd = new Map<string, (typeof fixes)[number]>();
  for (const f of fixes) if (f.source === 'crowd' && f.memberId && !crowd.has(f.memberId)) crowd.set(f.memberId, f);

  let pos = timetablePos(r, now);
  let source = 'Timetable + last known point';
  let confidence: LocationEstimate['confidence'] = 'estimated';
  let contributors = 0;
  const u = UNIT[r.vertical as keyof typeof UNIT];

  if (official) {
    source = official.source === 'vts' ? `${u.unit} GPS` : official.source === 'running_status' ? 'Running status' : 'Flight status';
    confidence = 'high';
    if (official.lat != null && official.lng != null) pos = snap(r, official.lat, official.lng) ?? pos;
    const d = official.data as { last_station?: string };
    if (d.last_station) { const i = stopsOf(r).findIndex((s) => s.code === d.last_station); if (i >= 0) pos = Math.max(pos, i); }
  } else if (crowd.size > 0 && r.vertical !== 'flight') {
    contributors = crowd.size;
    source = `${contributors} traveller${contributors > 1 ? 's' : ''} on board`;
    confidence = contributors >= 2 ? 'high' : 'medium';
    const snapped = [...crowd.values()].map((f) => (f.lat != null && f.lng != null ? snap(r, f.lat, f.lng) : null)).filter((x): x is number => x != null);
    if (snapped.length) pos = snapped.sort((a, b) => a - b)[Math.floor(snapped.length / 2)]; // median
  }

  const ni = nextIdx(r, pos);
  const stops = stopsOf(r);
  const last = stops.length - 1;
  return {
    near: r.vertical === 'flight' ? (pos > 0 && pos < last ? 'in the air' : pos >= last ? `at ${stops[last].name}` : `at ${stops[0].name}`) : placeLabel(r, pos),
    progress: last > 0 ? Math.min(1, pos / last) : 0,
    source, confidence, contributors,
    nextStop: pos >= last ? null : { code: stops[ni].code, name: stops[ni].name, eta: etaOf(r, ni)?.toISOString() ?? '' },
    updatedAt: new Date(official?.recordedAt ?? fixes[0]?.recordedAt ?? now).toISOString(),
  };
}

/** Project a lat/lng onto the stop polyline → position in stop units (only for stops that have coordinates). */
function snap(r: Room, lat: number, lng: number): number | null {
  const s = stopsOf(r).map((x, i) => ({ ...x, i })).filter((x) => x.lat != null && x.lng != null);
  if (s.length < 2) return null;
  let best: { d: number; pos: number } | null = null;
  for (let k = 0; k < s.length - 1; k++) {
    const a = s[k], b = s[k + 1];
    const ab = haversineKm({ lat: a.lat!, lng: a.lng! }, { lat: b.lat!, lng: b.lng! }) || 1e-6;
    const ap = haversineKm({ lat: a.lat!, lng: a.lng! }, { lat, lng });
    const bp = haversineKm({ lat: b.lat!, lng: b.lng! }, { lat, lng });
    const f = Math.max(0, Math.min(1, (ap * ap - bp * bp + ab * ab) / (2 * ab * ab)));
    const d = Math.min(ap, bp, Math.abs(ap + bp - ab));
    if (!best || d < best.d) best = { d, pos: a.i + (b.i - a.i) * f };
  }
  return best && best.d < 60 ? best.pos : null; // >60 km off-route = ignore (bad GPS / wrong trip)
}
