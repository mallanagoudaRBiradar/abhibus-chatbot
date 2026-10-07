import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'crypto';

/** scrypt password / secret hashing: "scrypt$<salt>$<hash>". */
export function hashSecret(secret: string): string {
  const salt = randomBytes(16).toString('base64url');
  return `scrypt$${salt}$${scryptSync(secret, salt, 32).toString('base64url')}`;
}
export function verifySecret(secret: string, stored: string): boolean {
  const [alg, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const a = scryptSync(secret, salt, 32);
  const b = Buffer.from(hash, 'base64url');
  return a.length === b.length && timingSafeEqual(a, b);
}
export const randomSecret = (bytes = 24) => randomBytes(bytes).toString('base64url');
/** Webhook signature: X-TripRooms-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body"> */
export function signWebhook(secret: string, body: string, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}
export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
