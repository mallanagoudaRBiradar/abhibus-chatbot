import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import type { ThemePref } from '../theme/tokens';

/** Small UI preferences. Not secret, but SecureStore is already a dependency on native; web uses localStorage. */
const K_THEME = 'triprooms.chat.theme';
const K_PROFILE = 'triprooms.chat.profile';

export async function loadThemePref(): Promise<ThemePref> {
  try {
    // A host page (e.g. the console's live traveller view) can pin the theme with ?theme=light|dark. Not saved.
    if (Platform.OS === 'web') {
      const forced = new URL(window.location.href).searchParams.get('theme');
      if (forced === 'light' || forced === 'dark') return forced;
    }
    const v = Platform.OS === 'web' ? localStorage.getItem(K_THEME) : await SecureStore.getItemAsync(K_THEME);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch { return 'system'; }
}

export async function saveThemePref(p: ThemePref) {
  try {
    if (Platform.OS === 'web') localStorage.setItem(K_THEME, p);
    else await SecureStore.setItemAsync(K_THEME, p);
  } catch { /* preference only; ignore */ }
}

/** Last name + avatar used, so the next trip's profile step is pre-filled. */
export async function loadProfile(): Promise<{ name: string; avatar: string | null } | null> {
  try {
    const v = Platform.OS === 'web' ? localStorage.getItem(K_PROFILE) : await SecureStore.getItemAsync(K_PROFILE);
    return v ? JSON.parse(v) : null;
  } catch { return null; }
}

export async function saveProfile(p: { name: string; avatar: string | null }) {
  try {
    const v = JSON.stringify(p);
    if (Platform.OS === 'web') localStorage.setItem(K_PROFILE, v);
    else await SecureStore.setItemAsync(K_PROFILE, v);
  } catch { /* preference only */ }
}
