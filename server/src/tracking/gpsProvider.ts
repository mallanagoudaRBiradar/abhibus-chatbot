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
}
export interface JourneyLike { journeyId: string; startTime: Date; estimatedEndTime: Date }

export interface TrackingProvider {
  getPosition(j: JourneyLike): Promise<BusPosition | null>;
  getLandmarks(j: JourneyLike, progress: number): Landmark[];
  nextToll(j: JourneyLike, progress: number): { name: string; lat: number; lng: number; etaAt: Date } | null;
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
}

/**
 * Production adapter for the `abrs_tracking` DB (10.0.2.229).
 * TODO(tracking-team): map vehicle -> latest fix. The expected query shape is
 *   SELECT lat, lng, speed, recorded_at FROM <gps_table>
 *    WHERE vehicle_no = ? ORDER BY recorded_at DESC LIMIT 1
 * then reuse MockTracker's labelling (nearest waypoint) on the real fix.
 */
class AbrsTrackingProvider extends MockTracker {}

export const tracker: TrackingProvider = config.TRACKING_SOURCE === 'abrs_tracking' ? new AbrsTrackingProvider() : new MockTracker();

export const toProgressState = (p: BusPosition): ProgressState => ({
  progress: +p.progress.toFixed(4),
  placeLabel: p.placeLabel,
  highway: p.highway,
  nextStop: p.nextStop,
  etaToDestination: p.etaToDestination?.toISOString() ?? null,
  updatedAt: new Date().toISOString(),
});
