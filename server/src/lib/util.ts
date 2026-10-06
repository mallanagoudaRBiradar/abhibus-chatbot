import crypto from 'crypto';
import { config } from '../config';

export const hashPhone = (phone: string | null | undefined): string | null => {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '').slice(-10);
  if (digits.length < 10) return null;
  return crypto.createHmac('sha256', config.PHONE_HASH_PEPPER).update(digits).digest('hex');
};

export const maskPnr = (pnr: string) =>
  pnr.length <= 4 ? '••••' : `${pnr.slice(0, 4)}${'•'.repeat(Math.max(2, pnr.length - 6))}${pnr.slice(-2)}`;

export const normaliseSeat = (seat: string) => String(seat).trim().toUpperCase().replace(/\s+/g, '');
export const normalisePnr = (pnr: string) => String(pnr).trim().toUpperCase().replace(/\s+/g, '');

export const normaliseGender = (g: unknown): 'M' | 'F' | 'O' => {
  const v = String(g ?? '').trim().toLowerCase();
  if (['f', 'female', 'w', 'woman', 'lady', '2'].includes(v)) return 'F';
  if (['m', 'male', 'man', '1'].includes(v)) return 'M';
  return 'O';
};

export const safeEqual = (a: string, b: string) => {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
};

/** Natural seat sort: L2 < L10 < U1 */
export const seatSort = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });
