/** Thin client for the platform's dashboard API (/console/v1). */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

const KEY = 'tr.console.token';
let token: string | null = (() => { try { return localStorage.getItem(KEY); } catch { return null; } })();
const unauthorized = new Set<() => void>();

export const session = {
  get token() { return token; },
  set(t: string | null) {
    token = t;
    try { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY); } catch { /* private mode */ }
  },
  onUnauthorized(fn: () => void) { unauthorized.add(fn); return () => { unauthorized.delete(fn); }; },
  /** Another tab signed in or out: adopt its token. */
  onChange(fn: (t: string | null) => void) {
    const f = (e: StorageEvent) => { if (e.key === KEY || e.key === null) { token = e.newValue; fn(token); } };
    window.addEventListener('storage', f); return () => window.removeEventListener('storage', f);
  },
};

type Opts = { method?: string; body?: unknown; query?: Record<string, string | number | undefined | null>; bearer?: string; base?: string };

export async function api<T = any>(path: string, o: Opts = {}): Promise<T> {
  const q = o.query ? Object.entries(o.query).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&') : '';
  const url = `${o.base ?? '/console/v1'}${path}${q ? `?${q}` : ''}`;
  const bearer = o.bearer ?? token;
  const res = await fetch(url, {
    method: o.method ?? (o.body !== undefined ? 'POST' : 'GET'),
    headers: { ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    if (res.status === 401 && !o.bearer && path !== '/auth/login') unauthorized.forEach((f) => f());
    throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? (res.status === 0 || res.status >= 502 ? 'Can’t reach the Trip Rooms server. Is it running on :4100?' : `Request failed (${res.status}).`));
  }
  return data as T;
}

/** For the sandbox: raw call that never throws, returns status + body + timing. */
export async function rawCall(method: string, url: string, bearer: string | null, body?: string) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: body || undefined });
    const text = await res.text();
    let data: unknown = text;
    try { data = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, ms: Math.round(performance.now() - t0), data };
  } catch (e) {
    return { status: 0, ms: Math.round(performance.now() - t0), data: { error: { message: String(e) } } };
  }
}
