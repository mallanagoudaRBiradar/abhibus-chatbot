import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';

/**
 * Chat settings (⋮ → Settings). Kept on this device only, never sent anywhere.
 * Backgrounds are plain gradients drawn in code: no image downloads, so they
 * cost nothing on a weak highway signal.
 */
export type Wallpaper = 'plain' | 'highway' | 'dusk' | 'mint' | 'sunrise';
export type TextSize = 'sm' | 'md' | 'lg';
export interface Settings {
  wallpaper: Wallpaper;
  textSize: TextSize;
  /** Don't download pickup photos (show the illustration instead). */
  dataSaver: boolean;
  quickReplies: boolean;
  /** Laptop / keyboard: Enter sends, Shift+Enter is a new line. Off = Enter is a new line. */
  enterToSend: boolean;
  vibration: boolean;
}
export const DEFAULT_SETTINGS: Settings = { wallpaper: 'plain', textSize: 'md', dataSaver: false, quickReplies: true, enterToSend: true, vibration: true };

/** [top, middle, bottom] per theme. 'plain' = the page colour. */
export const WALLPAPERS: Record<Exclude<Wallpaper, 'plain'>, { label: string; dark: [string, string, string]; light: [string, string, string] }> = {
  highway: { label: 'Night highway', dark: ['#0E0E11', '#0F1A2A', '#14243A'], light: ['#F4F4F6', '#EAF1F8', '#DFEAF6'] },
  dusk: { label: 'Dusk', dark: ['#0E0E11', '#1A1426', '#26142C'], light: ['#F4F4F6', '#F2ECF8', '#F7E9F1'] },
  mint: { label: 'Mint', dark: ['#0E0E11', '#0E1F1A', '#112A22'], light: ['#F4F4F6', '#EAF6F0', '#DFF2E7'] },
  sunrise: { label: 'Sunrise', dark: ['#0E0E11', '#22160F', '#2E1C10'], light: ['#F4F4F6', '#FBF1E6', '#FCE6D4'] },
};
export const TEXT_SCALE: Record<TextSize, number> = { sm: 0.9, md: 1, lg: 1.15 };

const KEY = 'abhibus.journeychat.settings';


export const useSettings = create<Settings & { set: (patch: Partial<Settings>) => void }>((setState, get) => ({
  ...DEFAULT_SETTINGS,
  set: (patch) => {
    setState(patch);
    const { set: _s, ...all } = { ...get(), ...patch };
    void save(all);
  },
}));

export async function loadSettings() {
  try {
    const raw = Platform.OS === 'web' ? localStorage.getItem(KEY) : await SecureStore.getItemAsync(KEY);
    if (raw) useSettings.setState({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) });
  } catch { /* defaults */ }
}
async function save(s: Settings) {
  try {
    const v = JSON.stringify(s);
    if (Platform.OS === 'web') localStorage.setItem(KEY, v);
    else await SecureStore.setItemAsync(KEY, v);
  } catch { /* preference only */ }
}
