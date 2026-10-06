/**
 * Tiny in-memory token bucket keyed by `${journeyId}:${seat}:${action}`.
 * Per-instance only — acceptable because a seat's socket is sticky to one
 * node. Move to Redis (INCR + EXPIRE) if you drop sticky sessions.
 */
type Bucket = { tokens: number; updatedAt: number };

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(private capacity: number, private refillPerSec: number) {
    setInterval(() => this.gc(), 60_000).unref();
  }
  take(key: string, cost = 1): boolean {
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now };
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.updatedAt) / 1000) * this.refillPerSec);
    b.updatedAt = now;
    if (b.tokens < cost) { this.buckets.set(key, b); return false; }
    b.tokens -= cost;
    this.buckets.set(key, b);
    return true;
  }
  private gc() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [k, b] of this.buckets) if (b.updatedAt < cutoff) this.buckets.delete(k);
  }
}

export const limits = {
  message: new RateLimiter(8, 0.8),        // burst 8, then ~1 msg / 1.25s
  location: new RateLimiter(1, 1 / 30),    // 1 bus-location drop / 30s / seat
  qr: new RateLimiter(3, 1 / 20),          // QR invites: a few in a row, then 1 / 20s
  reaction: new RateLimiter(20, 2),
  typing: new RateLimiter(6, 1),
  seen: new RateLimiter(30, 5),
  report: new RateLimiter(5, 1 / 60),
  join: new RateLimiter(6, 0.1),           // HTTP join attempts per IP+PNR
  sos: new RateLimiter(3, 1 / 60),
};
