import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import type { ThemePref } from '../theme/tokens';

/** Small UI preferences. Not secret, but SecureStore is already a dependency on native; web uses localStorage. */
const K_THEME = 'abhibus.journeychat.theme';

export async function loadThemePref(): Promise<ThemePref> {
  try {
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
