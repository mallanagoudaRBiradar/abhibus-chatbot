import { config } from '../config';
import { Polyline, haversineKm } from '../lib/geo';
import { NH44_PICKUP_POINTS, NH44_TOLLS, NH44_WAYPOINTS } from './routeData';
import type { Landmark, ProgressState } from '../shared/protocol';

/**
 * BUS-LEVEL location only. This module never touches a passenger's phone GPS —
 * "Share location" in the app shares where the BUS is, from the operator's
 * vehicle tracker. That is a deliberate privacy decision.
 */
export interface BusPosition {
  lat: number; lng: number; speedKmph: number | null; recordedAt: Date;
  progress: number; placeLabel: string; highway: string;
  nextStop: { name: string; distanceKm: number } | null;
  etaToDestination: Date | null;
  /** true = no fresh GPS fix: position is estimated from the timetable along the route. */
  estimated?: boolean;
}
export interface JourneyLike {
  journeyId: string; startTime: Date; estimatedEndTime: Date;
  destinationCity?: string; route?: unknown;
  lastLat?: number | null; lastLng?: number | null; lastSpeedKmph?: number | null; lastFixAt?: Date | null;
}

/** One stop on a journey's route, as pushed by the booking system. Validated at ingestion (http/partner.ts). */
export interface RouteStop {
  name: string; lat: number; lng: number;
  kind?: 'STOP' | 'PICKUP' | 'DROP' | 'TOLL' | 'REST';
  at?: string; id?: string; title?: string; caption?: string; imageUrl?: string | null;
}
export const routeOf = (j: JourneyLike): RouteStop[] => (Array.isArray(j.route) ? (j.route as RouteStop[]) : []);

export interface TrackingProvider {
  getPosition(j: JourneyLike): Promise<BusPosition | null>;
  getLandmarks(j: JourneyLike, progress: number): Landmark[];
  nextToll(j: JourneyLike, progress: number): { name: string; lat: number; lng: number; etaAt: Date } | null;
  /** Coarse label for a passenger's own shared location ("Near Kurnool"), or null when far from every stop. */
  nearestPlace(j: JourneyLike, p: { lat: number; lng: number }): string | null;
}

const line = new Polyline(NH44_WAYPOINTS);

/** Interpolates the bus along NH 44 by elapsed time. Used in demo and for dev. */
class MockTracker implements TrackingProvider {
  async getPosition(j: JourneyLike): Promise<BusPosition> {
    const now = Date.now();
    const total = +j.estimatedEndTime - +j.startTime;
    const progress = Math.max(0, Math.min(1, (now - +j.startTime) / total));
    const pos = line.at(progress);
    const near = line.nearest(pos);
    const next = NH44_WAYPOINTS[Math.min(pos.segment, NH44_WAYPOINTS.length - 1)];
    const wobble = 62 + Math.round(Math.sin(now / 90_000) * 9); // believable highway speed
    return {
      lat: +pos.lat.toFixed(5), lng: +pos.lng.toFixed(5),
      speedKmph: progress >= 1 ? 0 : wobble,
      recordedAt: new Date(now - 20_000),
      progress,
      placeLabel: near.point.name,
      highway: 'NH 44',
      nextStop: progress >= 1 ? null : { name: next.name, distanceKm: Math.max(1, Math.round(haversineKm(pos, next))) },
      etaToDestination: progress >= 1 ? null : j.estimatedEndTime,
    };
  }
  getLandmarks(_j: JourneyLike, progress: number): Landmark[] {
    return NH44_PICKUP_POINTS.map(({ frac, ...l }) => ({ ...l, passed: frac < progress - 0.01 }));
  }
  nextToll(j: JourneyLike, progress: number) {
    const t = NH44_TOLLS.find((x) => x.frac > progress + 0.03);
    if (!t) return null;
    const p = line.at(t.frac);
    const etaAt = new Date(+j.startTime + t.frac * (+j.estimatedEndTime - +j.startTime));
    return { name: t.name, lat: p.lat, lng: p.lng, etaAt };
  }
  nearestPlace(_j: JourneyLike, p: { lat: number; lng: number }) {
    const near = line.nearest(p);
    return near.km < 30 ? `Near ${near.point.name}` : null;
  }
}

/** A GPS fix older than this is ignored and progress falls back to the timetable. */
export const FIX_STALE_MS = 10 * 60_000;

/**
 * Production tracker. Uses only what the booking/tracking systems push in:
 *  - the journey's route (ordered stops with coordinates), and
 *  - the latest bus GPS fix (POST /v1/partner/journeys/:id/location).
 * Fresh fix  -> real position, progress = projection onto the route.
 * No fix     -> position interpolated along the route by the timetable.
 * No route   -> fix or nothing; progress by the timetable.
 * Works for any route in the country; nothing is hard-coded.
 */
class PushTracker implements TrackingProvider {
  private line(j: JourneyLike) {
    const stops = routeOf(j);
    return stops.length >= 2 ? new Polyline(stops) : null;
  }
  private timeProgress(j: JourneyLike) {
    const total = +j.estimatedEndTime - +j.startTime;
    return total > 0 ? Math.max(0, Math.min(1, (Date.now() - +j.startTime) / total)) : 0;
  }
  async getPosition(j: JourneyLike): Promise<BusPosition | null> {
    const line = this.line(j);
    const fresh = j.lastFixAt && j.lastLat != null && j.lastLng != null && Date.now() - +j.lastFixAt < FIX_STALE_MS;
    let lat: number, lng: number, progress: number, recordedAt: Date, speedKmph: number | null;
    if (fresh) {
      lat = j.lastLat!; lng = j.lastLng!; recordedAt = j.lastFixAt!; speedKmph = j.lastSpeedKmph ?? null;
      progress = line ? line.project({ lat, lng }).frac : this.timeProgress(j);
    } else if (line) {
      progress = this.timeProgress(j);
      ({ lat, lng } = line.at(progress));
      recordedAt = new Date(); speedKmph = null;
    } else {
      return null;
    }
    const stops = routeOf(j);
    const near = line?.nearest({ lat, lng });
    const nextIdx = line ? stops.findIndex((_, i) => line.fracOf(i) > progress + 0.001) : -1;
    const next = nextIdx >= 0 ? stops[nextIdx] : null;
    const done = progress >= 0.995;
    return {
      lat: +lat.toFixed(5), lng: +lng.toFixed(5), speedKmph: done ? 0 : speedKmph, recordedAt, progress,
      placeLabel: near && near.km < 30 ? near.point.name : `On the way to ${j.destinationCity ?? 'your destination'}`,
      highway: '',
      nextStop: done || !next ? null : { name: next.name, distanceKm: Math.max(1, Math.round(haversineKm({ lat, lng }, next))) },
      etaToDestination: done ? null : j.estimatedEndTime,
      estimated: !fresh,
    };
  }
  getLandmarks(j: JourneyLike, progress: number): Landmark[] {
    const stops = routeOf(j), line = this.line(j);
    if (!line) return [];
    return stops.flatMap((s, i) => s.kind === 'PICKUP'
      ? [{ id: s.id ?? `stop-${i}`, pointName: s.name, title: s.title ?? s.name, caption: s.caption ?? '', imageUrl: s.imageUrl ?? null, passed: line.fracOf(i) < progress - 0.01 }]
      : []);
  }
  nextToll(j: JourneyLike, progress: number) {
    const stops = routeOf(j), line = this.line(j);
    if (!line) return null;
    const i = stops.findIndex((s, k) => s.kind === 'TOLL' && line.fracOf(k) > progress + 0.03);
    if (i < 0) return null;
    const t = stops[i];
    const etaAt = t.at ? new Date(t.at) : new Date(+j.startTime + line.fracOf(i) * (+j.estimatedEndTime - +j.startTime));
    return { name: t.name, lat: t.lat, lng: t.lng, etaAt };
  }
  nearestPlace(j: JourneyLike, p: { lat: number; lng: number }) {
    const near = this.line(j)?.nearest(p);
    return near && near.km < 30 ? `Near ${near.point.name}` : null;
  }
}

/**
 * Production adapter for the `abrs_tracking` DB (10.0.2.229).
 * TODO(tracking-team): map vehicle -> latest fix. The expected query shape is
 *   SELECT lat, lng, speed, recorded_at FROM <gps_table>
 *    WHERE vehicle_no = ? ORDER BY recorded_at DESC LIMIT 1
 * then reuse MockTracker's labelling (nearest waypoint) on the real fix.
 */
class AbrsTrackingProvider extends MockTracker {}

export const tracker: TrackingProvider =
  config.TRACKING_SOURCE === 'push' ? new PushTracker()
  : config.TRACKING_SOURCE === 'abrs_tracking' ? new AbrsTrackingProvider()
  : new MockTracker();

export const toProgressState = (p: BusPosition): ProgressState => ({
  progress: +p.progress.toFixed(4),
  placeLabel: p.placeLabel,
  highway: p.highway,
  nextStop: p.nextStop,
  etaToDestination: p.etaToDestination?.toISOString() ?? null,
  updatedAt: (p.estimated ? new Date() : p.recordedAt).toISOString(),
  source: p.estimated ? 'SCHEDULE' : 'GPS',
});
