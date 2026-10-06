/**
 * ============================================================================
 *  "Night Highway" design tokens — dark + light
 * ============================================================================
 *  Principles
 *  1. Built for 2 AM: no large bright fills. Own bubbles are tinted, not solid,
 *     so a phone lit in a dark sleeper berth doesn't glare at neighbours.
 *  2. The accent (cyan at night, deep teal by day) means LIVE. It's reserved for
 *     real-time signals: the bus marker, online dots, "seen" ticks, send.
 *  3. AbhiBus red means SAFETY or DESTRUCTIVE. SOS, report, block, exit.
 *  4. The women-only room swaps the accent to rose across every surface, so
 *     nobody ever posts in the wrong room by mistake.
 *  5. Identity is a seat, never a face. Seats render as berth tags.
 *
 *  Theming: `palette`, `roomTheme` and `themed()` styles resolve against the
 *  active mode at read time. App.tsx sets the mode and remounts the tree when
 *  it changes, so components keep reading `palette.x` exactly as before.
 *  Key names are historical: `navy` = page background, `navyDeep` = chrome.
 * ============================================================================
 */
import { StyleSheet } from 'react-native';
import { create } from 'zustand';
import type { RoomType } from '../shared/protocol';

export type ThemeMode = 'dark' | 'light';
export type ThemePref = 'system' | ThemeMode;

const dark = {
  navy: '#0B132B',
  navyDeep: '#070D20',
  outer: '#04070F',
  bgClear: 'rgba(11,19,43,0)',
  surface: '#111C3D',
  surfaceRaised: '#18264F',
  surfaceSunk: '#0A1028',
  hairline: 'rgba(151,170,230,0.12)',
  hairlineStrong: 'rgba(151,170,230,0.22)',
  text: '#EEF2FF',
  textSecondary: '#A4AFD3',
  textTertiary: '#6A7499',
  placeholder: 'rgba(106,116,153,0.45)',
  cyan: '#00F5D4',
  cyanSoft: 'rgba(0,245,212,0.10)',
  cyanBorder: 'rgba(0,245,212,0.24)',
  red: '#E63946',
  redSoft: 'rgba(230,57,70,0.14)',
  redBorder: 'rgba(230,57,70,0.42)',
  sosHold: '#8E1D27',
  amber: '#FFC15E',
  amberSoft: 'rgba(255,193,94,0.12)',
  amberBorder: 'rgba(255,193,94,0.30)',
  rose: '#FF8FC8',
  roseSoft: 'rgba(255,143,200,0.12)',
  roseBorder: 'rgba(255,143,200,0.28)',
  green: '#3DDC97',
  greenSoft: 'rgba(61,220,151,0.12)',
  track: 'rgba(255,255,255,0.05)',
  dash: 'rgba(164,175,211,0.28)',
  pressTint: 'rgba(255,255,255,0.06)',
  backdrop: 'rgba(3,6,18,0.6)',
  shadow: '#000000',
};

const light: typeof dark = {
  navy: '#F2F4F9',
  navyDeep: '#FFFFFF',
  outer: '#DDE2EC',
  bgClear: 'rgba(242,244,249,0)',
  surface: '#FFFFFF',
  surfaceRaised: '#E8ECF5',
  surfaceSunk: '#F7F8FC',
  hairline: 'rgba(22,34,72,0.10)',
  hairlineStrong: 'rgba(22,34,72,0.18)',
  text: '#0E1530',
  textSecondary: '#4A5578',
  textTertiary: '#7C86A5',
  placeholder: 'rgba(124,134,165,0.6)',
  cyan: '#0A8C7B',
  cyanSoft: 'rgba(10,140,123,0.10)',
  cyanBorder: 'rgba(10,140,123,0.30)',
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
  track: 'rgba(22,34,72,0.07)',
  dash: 'rgba(22,34,72,0.20)',
  pressTint: 'rgba(22,34,72,0.05)',
  backdrop: 'rgba(10,16,40,0.35)',
  shadow: '#1A2550',
};

export type Palette = typeof dark;
const palettes: Record<ThemeMode, Palette> = { dark, light };

type RoomStyle = { accent: string; tint: string; border: string; onAccent: string; name: string; icon: 'people' | 'shield-checkmark' };
const roomThemes: Record<ThemeMode, Record<RoomType, RoomStyle>> = {
  dark: {
    MAIN_COMMON: { accent: dark.cyan, tint: 'rgba(0,245,212,0.10)', border: 'rgba(0,245,212,0.26)', onAccent: '#02261F', name: 'Bus lounge', icon: 'people' },
    WOMEN_ONLY: { accent: dark.rose, tint: 'rgba(255,143,200,0.11)', border: 'rgba(255,143,200,0.30)', onAccent: '#3A0B24', name: 'Women only', icon: 'shield-checkmark' },
  },
  light: {
    MAIN_COMMON: { accent: light.cyan, tint: 'rgba(10,140,123,0.10)', border: 'rgba(10,140,123,0.26)', onAccent: '#FFFFFF', name: 'Bus lounge', icon: 'people' },
    WOMEN_ONLY: { accent: light.rose, tint: 'rgba(194,51,122,0.08)', border: 'rgba(194,51,122,0.26)', onAccent: '#FFFFFF', name: 'Women only', icon: 'shield-checkmark' },
  },
};

// ------------------------------------------------------------ active mode ---
let activeMode: ThemeMode = 'dark';
export const currentMode = () => activeMode;
/** Called by App.tsx during render, before any themed child reads a colour. */
export function setActiveMode(m: ThemeMode) { activeMode = m; }

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
