import { Platform } from 'react-native';
import type { JoinResponse } from '../shared/protocol';

/**
 * ============================================================================
 *  Host bridge — the chat running inside the AbhiBus app's WebView.
 * ============================================================================
 *  The app injects `window.__TRIPCHAT_BOOT__` before the page loads (session,
 *  device id, theme, capabilities) and talks to us with small JSON messages:
 *
 *    { v: 1, type: 'close' | 'call' | 'voiceStart' | …, data: {…} }
 *
 *  web → app   iOS:     window.webkit.messageHandlers.tripChat.postMessage(msg)
 *              Android: window.ReactNativeWebView.postMessage(JSON.stringify(msg))
 *              Harness: window.parent.postMessage(msg, sameOrigin)   (test page only)
 *  app → web   window.TripChat.receive(msg)   (object or JSON string)
 *
 *  The full contract is in docs/WEBVIEW_PLAN.md §4. Outside a WebView (native
 *  demo app, plain browser, QR guests) `host.embedded` is false and nothing
 *  here does anything.
 * ============================================================================
 */
export const BRIDGE_VERSION = 1;

export type Capability = 'voice' | 'haptics' | 'location' | 'call' | 'openExternal';

export interface Boot {
  v: number;
  session: JoinResponse;
  deviceId: string;
  platform: 'ios' | 'android' | 'web';
  appVersion?: string;
  theme?: 'dark' | 'light';
  locale?: string;
  capabilities?: Capability[];
  /** The chat isn't open yet: the app can still open the page to show "Trip Chat opens on …" (no session needed). */
  locked?: TripLock;
}
export interface TripLock { opensAt: string; sourceCity?: string; destinationCity?: string; operatorName?: string }

type Msg = { v?: number; type: string; data?: any };
type Listener = (data: any) => void;

declare global {
  interface Window {
    __TRIPCHAT_BOOT__?: Boot;
    __TRIPCHAT_CONFIG__?: { apiUrl?: string };
    TripChat?: { receive: (msg: Msg | string) => void; version: number };
    webkit?: { messageHandlers?: { tripChat?: { postMessage: (m: unknown) => void } } };
    ReactNativeWebView?: { postMessage: (m: string) => void };
  }
}

const isWeb = Platform.OS === 'web' && typeof window !== 'undefined';
const inIframe = isWeb && window.parent !== window;
const transport: 'ios' | 'android' | 'harness' | null = !isWeb ? null
  : window.webkit?.messageHandlers?.tripChat ? 'ios'
  : window.ReactNativeWebView ? 'android'
  : inIframe ? 'harness'
  : null;

const listeners = new Map<string, Set<Listener>>();
let boot: Boot | null = isWeb ? window.__TRIPCHAT_BOOT__ ?? null : null;

function receive(raw: Msg | string) {
  let msg: Msg;
  try { msg = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return; }
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'boot' && !boot && (msg.data?.session || msg.data?.locked)) { boot = msg.data as Boot; }
  listeners.get(msg.type)?.forEach((fn) => { try { fn(msg.data ?? {}); } catch { /* a bad listener must not break the bridge */ } });
}

if (transport) {
  window.TripChat = { receive, version: BRIDGE_VERSION };
  // Test harness: same-origin parent page only (never trust another site framing us).
  if (transport === 'harness') {
    window.addEventListener('message', (e) => { if (e.origin === window.location.origin && e.source === window.parent) receive(e.data); });
  }
}

export const host = {
  /** Running inside the AbhiBus app (or the test harness). */
  embedded: transport !== null,
  transport,

  get boot(): Boot | null { return boot; },

  can(cap: Capability): boolean {
    return !!boot?.capabilities?.includes(cap);
  },

  post(type: string, data: Record<string, unknown> = {}) {
    if (!transport) return;
    const msg = { v: BRIDGE_VERSION, type, data };
    try {
      if (transport === 'ios') window.webkit!.messageHandlers!.tripChat!.postMessage(msg);
      else if (transport === 'android') window.ReactNativeWebView!.postMessage(JSON.stringify(msg));
      else window.parent.postMessage(msg, window.location.origin);
    } catch { /* the app went away; nothing to do */ }
  },

  on(type: string, fn: Listener): () => void {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(fn);
    return () => { listeners.get(type)?.delete(fn); };
  },

  /** Wait for the next message of `type` (e.g. the answer to a request), or null on timeout. */
  next<T = any>(type: string, timeoutMs: number): Promise<T | null> {
    return new Promise((resolve) => {
      const off = host.on(type, (d) => { clearTimeout(t); off(); resolve(d as T); });
      const t = setTimeout(() => { off(); resolve(null); }, timeoutMs);
    });
  },

  /**
   * The boot payload. WebViews inject it before load; the harness sends it as a
   * `boot` message after we say `hello`. Resolves null if nothing arrives.
   */
  async ready(timeoutMs = 4000): Promise<Boot | null> {
    if (boot || !transport) return boot;
    if (transport === 'harness') host.post('hello', { v: BRIDGE_VERSION });
    const b = await host.next<Boot>('boot', timeoutMs);
    return boot ?? b;
  },
};
