import { Linking, Platform } from 'react-native';

/**
 * ============================================================================
 *  Host bridge — how this screen talks to the app that opened it
 * ============================================================================
 *  The tenant app (AbhiBus, ConfirmTkt, ixigo…) opens us with a member token:
 *    web / WebView:  https://rooms…/?token=eyJ…
 *    native deep link: triprooms://open?token=eyJ…
 *  We tell the host about things it should react to:
 *    tr:ready · tr:unread {count} · tr:close · tr:token_expired · tr:sos
 *  Delivered to whichever channel exists: React Native WebView, Android
 *  JavascriptInterface (TripRoomsHost), iOS WKScriptMessageHandler, or the
 *  parent window when embedded in an iframe.
 * ============================================================================
 */
export type HostEvent = 'tr:ready' | 'tr:unread' | 'tr:close' | 'tr:token_expired' | 'tr:sos';

export function notifyHost(type: HostEvent, data: Record<string, unknown> = {}) {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return;
  const msg = { type, ...data };
  const json = JSON.stringify(msg);
  const w = window as any;
  try { w.ReactNativeWebView?.postMessage(json); } catch { /* not in RN WebView */ }
  try { w.TripRoomsHost?.postMessage?.(json); } catch { /* not Android */ }
  try { w.webkit?.messageHandlers?.TripRoomsHost?.postMessage(msg); } catch { /* not iOS */ }
  try { if (window.parent && window.parent !== window) window.parent.postMessage(msg, '*'); } catch { /* not framed */ }
}

/** True when some host is listening (so “back” should close us instead of doing nothing). */
export function embedded() {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
  const w = window as any;
  return !!(w.ReactNativeWebView || w.TripRoomsHost || w.webkit?.messageHandlers?.TripRoomsHost || window.parent !== window);
}

const K = 'triprooms.chat.token';
/**
 * The member token from the launch URL. On web it is moved out of the address
 * bar into sessionStorage (so it isn't shared by accident with a screenshot or
 * copied link) and survives reloads of this tab.
 */
export async function launchToken(): Promise<string | null> {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get('token');
    if (fromUrl) {
      try { sessionStorage.setItem(K, fromUrl); } catch { /* private mode */ }
      url.searchParams.delete('token');
      window.history.replaceState(null, '', url.pathname + (url.search || '') + url.hash);
      return fromUrl;
    }
    try { return sessionStorage.getItem(K); } catch { return null; }
  }
  const initial = await Linking.getInitialURL();
  return initial ? new URL(initial).searchParams.get('token') : null;
}
export function forgetToken() { if (Platform.OS === 'web') { try { sessionStorage.removeItem(K); } catch { /* */ } } }
