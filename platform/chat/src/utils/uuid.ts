import * as Crypto from 'expo-crypto';

/**
 * UUID v4 that works everywhere. Browsers only expose crypto.randomUUID on
 * secure (https/localhost) pages — a phone opening the chat over plain http on
 * the Wi-Fi (e.g. after scanning a QR in the demo) doesn't have it, but
 * getRandomValues is always available.
 */
export function uuid(): string {
  try { return Crypto.randomUUID(); } catch { /* insecure context */ }
  const b = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') globalThis.crypto.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
