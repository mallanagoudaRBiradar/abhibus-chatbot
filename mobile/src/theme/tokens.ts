/**
 * ============================================================================
 *  Trip Chat design tokens — dark + light
 * ============================================================================
 *  Principles
 *  1. Built for 2 AM: near-black page, dark-grey bubbles, no large bright fills
 *     except your own messages (AbhiBus red), so you can find them at a glance.
 *  2. AbhiBus red is the accent: own bubbles, primary buttons, active tab,
 *     quick replies. Green means LIVE / on board, amber means late.
 *  3. Safety actions (SOS, report, block, exit) use the same red, always with an icon.
 *  4. Women Zone swaps the accent to rose across every surface, so
 *     nobody ever posts in the wrong room by mistake.
 *  5. Identity is a seat, never a face. Seats render as berth tags.
 *
 *  Theming: `palette`, `roomTheme` and `themed()` styles resolve against the
 *  active mode at read time. App.tsx sets the mode and re-renders the tree when
 *  it changes (ThemeModeContext reaches memoized rows), so components keep
 *  reading `palette.x` exactly as before.
 *  Key names are historical: `navy` = page background, `navyDeep` = chrome.
 * ============================================================================
 */
import { createContext, useContext } from 'react';
import { StyleSheet } from 'react-native';
import { create } from 'zustand';
import type { RoomType } from '../shared/protocol';

export type ThemeMode = 'dark' | 'light';
export type ThemePref = 'system' | ThemeMode;

const dark = {
  navy: '#0E0E11',
  navyDeep: '#0A0A0C',
  outer: '#050506',
  bgClear: 'rgba(14,14,17,0)',
  surface: '#1E1E23',
  surfaceRaised: '#2A2A30',
  surfaceSunk: '#16161A',
  hairline: 'rgba(255,255,255,0.07)',
  hairlineStrong: 'rgba(255,255,255,0.14)',
  text: '#F5F5F7',
  textSecondary: '#A7A7B0',
  textTertiary: '#6F6F79',
  placeholder: 'rgba(111,111,121,0.5)',
  // Key name is historical: `cyan` is THE accent, now AbhiBus red.
  cyan: '#E5383B',
  cyanSoft: 'rgba(229,56,59,0.12)',
  cyanBorder: 'rgba(229,56,59,0.45)',
  onCyan: '#FFFFFF',
  red: '#E5383B',
  redSoft: 'rgba(229,56,59,0.14)',
  redBorder: 'rgba(229,56,59,0.45)',
  sosHold: '#8E1D27',
  amber: '#F5A524',
  amberSoft: 'rgba(245,165,36,0.12)',
  amberBorder: 'rgba(245,165,36,0.30)',
  rose: '#FF6FAE',
  roseSoft: 'rgba(255,111,174,0.12)',
  roseBorder: 'rgba(255,111,174,0.30)',
  green: '#2FCB7A',
  greenSoft: 'rgba(47,203,122,0.14)',
  purple: '#7B5CFA',
  track: 'rgba(255,255,255,0.05)',
  dash: 'rgba(255,255,255,0.18)',
  pressTint: 'rgba(255,255,255,0.06)',
  backdrop: 'rgba(0,0,0,0.6)',
  shadow: '#000000',
};

const light: typeof dark = {
  navy: '#F4F4F6',
  navyDeep: '#FFFFFF',
  outer: '#E2E2E6',
  bgClear: 'rgba(244,244,246,0)',
  surface: '#FFFFFF',
  surfaceRaised: '#ECECF0',
  surfaceSunk: '#F8F8FA',
  hairline: 'rgba(20,20,30,0.08)',
  hairlineStrong: 'rgba(20,20,30,0.16)',
  text: '#141418',
  textSecondary: '#55555F',
  textTertiary: '#8A8A94',
  placeholder: 'rgba(138,138,148,0.6)',
  cyan: '#D62839',
  cyanSoft: 'rgba(214,40,57,0.08)',
  cyanBorder: 'rgba(214,40,57,0.40)',
  onCyan: '#FFFFFF',
  red: '#D62839',
  redSoft: 'rgba(214,40,57,0.08)',
  redBorder: 'rgba(214,40,57,0.40)',
  sosHold: '#E9939B',
  amber: '#B26A00',
  amberSoft: 'rgba(230,150,20,0.13)',
  amberBorder: 'rgba(178,106,0,0.30)',
  rose: '#C2337A',
  roseSoft: 'rgba(194,51,122,0.09)',
  roseBorder: 'rgba(194,51,122,0.28)',
  green: '#1E9E6A',
  greenSoft: 'rgba(30,158,106,0.12)',
  purple: '#6A4BEA',
  track: 'rgba(20,20,30,0.07)',
  dash: 'rgba(20,20,30,0.20)',
  pressTint: 'rgba(20,20,30,0.05)',
  backdrop: 'rgba(10,10,20,0.35)',
  shadow: '#1A1A24',
};

export type Palette = typeof dark;
const palettes: Record<ThemeMode, Palette> = { dark, light };

/** `mine` = solid fill of my own bubbles, `onMine` = text on it. */
type RoomStyle = { accent: string; tint: string; border: string; onAccent: string; mine: string; onMine: string; name: string; icon: 'people' | 'shield-checkmark' };
const roomThemes: Record<ThemeMode, Record<RoomType, RoomStyle>> = {
  dark: {
    MAIN_COMMON: { accent: dark.cyan, tint: 'rgba(229,56,59,0.12)', border: 'rgba(229,56,59,0.40)', onAccent: '#FFFFFF', mine: '#D7333A', onMine: '#FFFFFF', name: 'Everyone', icon: 'people' },
    WOMEN_ONLY: { accent: dark.rose, tint: 'rgba(255,111,174,0.12)', border: 'rgba(255,111,174,0.32)', onAccent: '#2E0718', mine: '#B83A78', onMine: '#FFFFFF', name: 'Women Zone', icon: 'shield-checkmark' },
  },
  light: {
    MAIN_COMMON: { accent: light.cyan, tint: 'rgba(214,40,57,0.08)', border: 'rgba(214,40,57,0.30)', onAccent: '#FFFFFF', mine: '#D62839', onMine: '#FFFFFF', name: 'Everyone', icon: 'people' },
    WOMEN_ONLY: { accent: light.rose, tint: 'rgba(194,51,122,0.08)', border: 'rgba(194,51,122,0.26)', onAccent: '#FFFFFF', mine: '#C2337A', onMine: '#FFFFFF', name: 'Women Zone', icon: 'shield-checkmark' },
  },
};

// ------------------------------------------------------------ active mode ---
let activeMode: ThemeMode = 'dark';
export const currentMode = () => activeMode;
/** Called by App.tsx during render, before any themed child reads a colour. */
export function setActiveMode(m: ThemeMode) { activeMode = m; }
/**
 * The active mode as React context. App.tsx re-renders the tree on a Light/Dark
 * switch (no remount: sheets stay open, scroll and connection are kept). Parts
 * that skip re-renders (memoized rows, FlatList) read this so they repaint too.
 */
export const ThemeModeContext = createContext<ThemeMode>('dark');
export const useThemeMode = () => useContext(ThemeModeContext);

/** User preference (persisted by App.tsx). */
export const useThemePref = create<{ pref: ThemePref; setPref: (p: ThemePref) => void }>((set) => ({
  pref: 'system',
  setPref: (pref) => set({ pref }),
}));

/** Mode-aware value: pass both variants, get the active one. */
export const byMode = <T,>(v: Record<ThemeMode, T>): T => v[activeMode];

export const palette: Palette = new Proxy({} as Palette, { get: (_, k) => palettes[activeMode][k as keyof Palette] });
export const roomTheme: Record<RoomType, RoomStyle> = new Proxy({} as Record<RoomType, RoomStyle>, { get: (_, k) => roomThemes[activeMode][k as RoomType] });

/** StyleSheet whose colours follow the active mode (built lazily, cached per mode). */
export function themed<T extends StyleSheet.NamedStyles<T>>(factory: () => T): T {
  const cache: Partial<Record<ThemeMode, T>> = {};
  return new Proxy({} as T, {
    get: (_, k) => (cache[activeMode] ??= StyleSheet.create(factory()))[k as keyof T],
  });
}

// ----------------------------------------------------------------- scale ---
export const font = {
  display: 'Sora_600SemiBold',
  displayBold: 'Sora_700Bold',
  body: 'PlusJakartaSans_400Regular',
  bodyMedium: 'PlusJakartaSans_500Medium',
  bodySemi: 'PlusJakartaSans_600SemiBold',
  bodyBold: 'PlusJakartaSans_700Bold',
} as const;

/** Modular scale (~1.2) anchored on 15px body. */
export const size = { micro: 11, meta: 12, small: 13, body: 15, title: 17, h2: 24, h3: 20, h1: 30 } as const;
export const radius = { tag: 7, chip: 12, bubble: 18, card: 20, sheet: 28, pill: 999 } as const;
export const space = (n: number) => n * 4;
/** The app is a phone UI: on tablets / desktop browsers it sits in a centred column this wide. */
export const FRAME_MAX = 520;

export const motion = {
  spring: { damping: 18, stiffness: 220, mass: 0.9 },
  springSoft: { damping: 22, stiffness: 140 },
  fast: 160,
  base: 240,
} as const;
