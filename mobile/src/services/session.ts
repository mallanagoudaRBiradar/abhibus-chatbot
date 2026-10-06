import { uuid } from '../utils/uuid';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type { JoinResponse } from '../shared/protocol';

/**
 * Token + device id live in the OS keychain/keystore, never AsyncStorage.
 * The device id binds a seat to this phone (server rejects a second device).
 */
const K_SESSION = 'abhibus.journeychat.session';
const K_DEVICE = 'abhibus.journeychat.device';

// expo-secure-store has no web implementation — the web demo falls back to localStorage.
const store = Platform.OS === 'web'
  ? {
      getItemAsync: async (k: string) => localStorage.getItem(k),
      setItemAsync: async (k: string, v: string) => localStorage.setItem(k, v),
      deleteItemAsync: async (k: string) => localStorage.removeItem(k),
    }
  : SecureStore;

export async function getDeviceId(): Promise<string> {
  let id = await store.getItemAsync(K_DEVICE);
  if (!id) { id = uuid(); await store.setItemAsync(K_DEVICE, id); }
  return id;
}

function tokenExpired(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now() + 30_000;
  } catch { return true; }
}

export async function saveSession(s: JoinResponse) { await store.setItemAsync(K_SESSION, JSON.stringify(s)); }
export async function clearSession() { await store.deleteItemAsync(K_SESSION); }
export async function loadSession(): Promise<JoinResponse | null> {
  const raw = await store.getItemAsync(K_SESSION);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as JoinResponse;
    if (tokenExpired(s.token)) { await clearSession(); return null; }
    return s;
  } catch { return null; }
}
