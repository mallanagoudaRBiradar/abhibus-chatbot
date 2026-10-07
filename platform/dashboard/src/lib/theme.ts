import { useEffect, useState } from 'react';

/** Console colour theme. `system` follows the OS; the resolved mode is written to <html data-theme>. */
export type ThemePref = 'system' | 'light' | 'dark';
export type ThemeMode = 'light' | 'dark';
const KEY = 'tr.console.theme';
const media = window.matchMedia('(prefers-color-scheme: light)');

const read = (): ThemePref => { try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'system'; } catch { return 'system'; } };
const resolve = (p: ThemePref): ThemeMode => (p === 'system' ? (media.matches ? 'light' : 'dark') : p);

let pref = read();
const subs = new Set<() => void>();
const apply = () => { document.documentElement.dataset.theme = resolve(pref); subs.forEach((f) => f()); };
apply();
media.addEventListener('change', () => { if (pref === 'system') apply(); });
window.addEventListener('storage', (e) => { if (e.key === KEY) { pref = read(); apply(); } });

export function setThemePref(p: ThemePref) {
  pref = p;
  try { p === 'system' ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, p); } catch { /* private mode */ }
  apply();
}

export function useTheme() {
  const [, tick] = useState(0);
  useEffect(() => { const f = () => tick((n) => n + 1); subs.add(f); return () => { subs.delete(f); }; }, []);
  return { pref, mode: resolve(pref), setPref: setThemePref };
}
