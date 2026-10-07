import { Platform } from 'react-native';
import type { JoinResponse, QrJoinCheck } from '../shared/protocol';
import './host'; // declares window.__TRIPCHAT_CONFIG__

export type ProfileInput = { name: string; avatar: string | null };

const ENV_API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const LOCAL = /localhost|127\.0\.0\.1/;
/**
 * On web, if the page was opened from another device (e.g. a phone that scanned a
 * QR pointing at this laptop's Wi-Fi IP), "localhost" would mean the phone itself —
 * so talk to the same host the page came from.
 */
/** Hosted web build: `/config.js` (written by the web container at start-up) sets the API per environment. */
const RUNTIME_API_URL = Platform.OS === 'web' && typeof window !== 'undefined' ? window.__TRIPCHAT_CONFIG__?.apiUrl?.replace(/\/$/, '') : undefined;
export const API_URL = RUNTIME_API_URL
  || (Platform.OS === 'web' && typeof window !== 'undefined' && LOCAL.test(ENV_API_URL) && !LOCAL.test(window.location.hostname)
    ? ENV_API_URL.replace(LOCAL, window.location.hostname)
    : ENV_API_URL);

export class ApiError extends Error {
  constructor(public code: string, message: string, public meta?: Record<string, any>) { super(message); }
}

async function request<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 12_000);
  try {
    const res = await fetch(`${API_URL}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(body.code ?? 'INTERNAL', body.message ?? 'Something went wrong. Try again.', body.meta);
    return body as T;
  } catch (e: any) {
    if (e instanceof ApiError) throw e;
    throw new ApiError('NETWORK', e?.name === 'AbortError' ? 'The network is slow right now. Try again in a moment.' : 'Can’t reach AbhiBus. Check your connection and try again.');
  } finally {
    clearTimeout(t);
  }
}

export const api = {
  /**
   * In the real AbhiBus app, pass the logged-in customer's session token as
   * `appSession` — the server verifies the PNR belongs to that account.
   */
  join: (body: { pnr: string; seat: string; deviceId: string }, appSession?: string) =>
    request<JoinResponse>('/v1/journey-chat/join', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: appSession ? { authorization: `Bearer ${appSession}` } : {},
    }),
  /** Guest join from a fellow passenger's QR (booked on another app). Location proves you're on this bus. */
  joinQr: (body: { token: string; deviceId: string; coords: { lat: number; lng: number } | null }) =>
    request<JoinResponse & { qrCheck: QrJoinCheck }>('/v1/journey-chat/join-qr', { method: 'POST', body: JSON.stringify(body) }),
  demoTickets: () => request<{ tickets: { pnr: string; label: string; seats: string[] }[] }>('/v1/demo/tickets', { timeoutMs: 5000 }),
  pollVote: (token: string, messageId: string, option: number) =>
    request<{ results: { option: string; votes: number }[] }>('/v1/journey-chat/poll-vote', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ messageId, option }), timeoutMs: 8000 }),
  surveyAnswer: (token: string, messageId: string, answers: (string | number)[]) =>
    request<{ recorded: boolean }>('/v1/journey-chat/survey-answer', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ messageId, answers }), timeoutMs: 8000 }),
  /** Tap on a sponsored card: counted on the campaign (once per passenger); returns the coupon to show. */
  adClick: (token: string, messageId: string) =>
    request<{ coupon: string | null }>('/v1/journey-chat/ad-click', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ messageId }), timeoutMs: 8000 }),
  sos: (token: string) =>
    request<{ incidentId: string; placeLabel: string | null; supportPhone: string | null; operatorHelpline: string | null; emergencyNumber: string }>('/v1/journey-chat/sos', {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, timeoutMs: 15_000,
    }),
};
