/**
 * Tiny in-memory token bucket keyed by `${memberId}:${action}` or the API client id.
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
  // traveller actions (key: memberId:action)
  message: new RateLimiter(8, 0.8),
  reaction: new RateLimiter(20, 2),
  report: new RateLimiter(5, 1 / 60),
  location: new RateLimiter(3, 1 / 10),
  action: new RateLimiter(4, 1 / 30),     // sos / wait / lost / issue
  // API (key: client id) — 50 req/s per tenant key
  api: new RateLimiter(100, 50),
  broadcast: new RateLimiter(10, 10 / 60),
  login: new RateLimiter(8, 1 / 30),      // dashboard login per IP+email
};
