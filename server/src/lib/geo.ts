export type LatLng = { lat: number; lng: number };

export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Pre-computes cumulative distance so we can map 0..1 <-> position along a polyline. */
export class Polyline<T extends LatLng & { name: string }> {
  readonly cumKm: number[] = [0];
  readonly totalKm: number;
  constructor(readonly points: T[]) {
    for (let i = 1; i < points.length; i++) this.cumKm.push(this.cumKm[i - 1] + haversineKm(points[i - 1], points[i]));
    this.totalKm = this.cumKm[this.cumKm.length - 1];
  }
  at(frac: number): LatLng & { segment: number } {
    const target = Math.max(0, Math.min(1, frac)) * this.totalKm;
    let i = 1;
    while (i < this.cumKm.length - 1 && this.cumKm[i] < target) i++;
    const segLen = this.cumKm[i] - this.cumKm[i - 1] || 1;
    const t = (target - this.cumKm[i - 1]) / segLen;
    const a = this.points[i - 1], b = this.points[i];
    return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t, segment: i };
  }
  fracOf(index: number) { return this.cumKm[index] / this.totalKm; }
  nearest(p: LatLng) {
    let best = 0, bestD = Infinity;
    this.points.forEach((w, i) => { const d = haversineKm(p, w); if (d < bestD) { bestD = d; best = i; } });
    return { index: best, point: this.points[best], km: bestD };
  }
}
