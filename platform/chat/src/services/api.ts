import { Platform } from 'react-native';
import type { JoinResponse } from '../shared/protocol';

const ENV_API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4100').replace(/\/$/, '');
const LOCAL = /localhost|127\.0\.0\.1/;
/**
 * Trip Rooms platform URL. On web, if the page was opened from another device
 * (a phone on the same Wi-Fi), "localhost" would mean the phone itself — so
 * talk to the same host the page came from.
 */
export const API_URL =
  Platform.OS === 'web' && typeof window !== 'undefined' && LOCAL.test(ENV_API_URL) && !LOCAL.test(window.location.hostname)
    ? ENV_API_URL.replace(LOCAL, window.location.hostname)
    : ENV_API_URL;

export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 0) { super(message); }
}

async function request<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 12_000);
  try {
    const res = await fetch(`${API_URL}${path}`, { ...init, signal: ctrl.signal, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(body?.error?.code ?? 'internal', body?.error?.message ?? 'Something went wrong. Try again.', res.status);
    return body as T;
  } catch (e: any) {
    if (e instanceof ApiError) throw e;
    throw new ApiError('network', e?.name === 'AbortError' ? 'The network is slow right now. Try again in a moment.' : 'Can’t reach Trip Rooms. Check your connection and try again.');
  } finally {
    clearTimeout(t);
  }
}

export const api = {
  /** Bootstrap with the member token the tenant app opened us with: brand, features, room, me. */
  session: (token: string) => request<JoinResponse>('/chat/v1/session', { headers: { authorization: `Bearer ${token}` } }),
};
