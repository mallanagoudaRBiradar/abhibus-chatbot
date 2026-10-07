import { useEffect, useRef, useState, useCallback } from 'react';
import { api, session } from './api';

/**
 * One Server-Sent Events connection per signed-in dashboard (GET /console/v1/stream).
 * Screens subscribe by event-type prefix and refetch when something relevant happens,
 * so nothing polls and the console reacts within a second.
 */
export interface PlatformEvent { id: string; type: string; tenant: string | null; room: string | null; data: any; created_at: string }
type Fn = (e: PlatformEvent) => void;
const subs = new Set<Fn>();
const statusSubs = new Set<(s: LiveStatus) => void>();
export type LiveStatus = 'connecting' | 'live' | 'offline';
let es: EventSource | null = null;
let status: LiveStatus = 'offline';
const setStatus = (s: LiveStatus) => { status = s; statusSubs.forEach((f) => f(s)); };

export function connectLive() {
  disconnectLive();
  if (!session.token) return;
  setStatus('connecting');
  es = new EventSource(`/console/v1/stream?access_token=${encodeURIComponent(session.token)}`);
  es.addEventListener('ready', () => setStatus('live'));
  es.addEventListener('platform', (m) => { try { const e = JSON.parse((m as MessageEvent).data); subs.forEach((f) => f(e)); } catch { /* ignore */ } });
  es.onerror = () => setStatus(es?.readyState === EventSource.CLOSED ? 'offline' : 'connecting');
}
export function disconnectLive() { es?.close(); es = null; setStatus('offline'); }

export function useLiveStatus() {
  const [s, set] = useState<LiveStatus>(status);
  useEffect(() => { statusSubs.add(set); return () => { statusSubs.delete(set); }; }, []);
  return s;
}
export function useLiveEvents(fn: Fn) {
  const ref = useRef(fn); ref.current = fn;
  useEffect(() => { const f: Fn = (e) => ref.current(e); subs.add(f); return () => { subs.delete(f); }; }, []);
}

const matches = (type: string, prefixes: string[]) => prefixes.some((p) => p === '*' || type === p || type.startsWith(p));

/**
 * Fetch + keep fresh. `refreshOn` = event type prefixes (e.g. ['sos.', 'action.']) and/or
 * a room id filter. Refetches are debounced so a burst of events = one request.
 */
export function useData<T = any>(path: string | null, opts: { query?: Record<string, any>; refreshOn?: string[]; room?: string; every?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const key = JSON.stringify([path, opts.query]);
  const timer = useRef<number | null>(null);
  const load = useCallback(async () => {
    if (!path) return;
    try { setData(await api<T>(path, { query: opts.query })); setError(null); } catch (e: any) { setError(e.message); } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => { setLoading(true); void load(); }, [load]);
  useEffect(() => { if (!opts.every) return; const t = setInterval(() => void load(), opts.every); return () => clearInterval(t); }, [load, opts.every]);
  useLiveEvents((e) => {
    if (!opts.refreshOn?.length || !matches(e.type, opts.refreshOn)) return;
    if (opts.room && e.room && e.room !== opts.room) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void load(), 400);
  });
  return { data, error, loading, reload: load, setData };
}
