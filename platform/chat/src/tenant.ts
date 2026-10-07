import { useChat } from './store/chatStore';
import type { Vertical } from './shared/protocol';
import { CARE_ALIASES, isCareMention } from './shared/moderation';

/**
 * Words and icons that change with the trip's mode and the host app.
 * One place, so "bus" never shows up in a flight room.
 */
export const UNIT: Record<Vertical, { noun: string; lounge: string; crowd: string; icon: 'bus-side' | 'train' | 'airplane' | 'map-marker-path' }> = {
  bus: { noun: 'bus', lounge: 'Bus lounge', crowd: 'passengers on this bus', icon: 'bus-side' },
  train: { noun: 'train', lounge: 'Coach lounge', crowd: 'travellers in this coach', icon: 'train' },
  flight: { noun: 'flight', lounge: 'Gate lounge', crowd: 'travellers on this flight', icon: 'airplane' },
  custom: { noun: 'trip', lounge: 'Trip lounge', crowd: 'travellers on this trip', icon: 'map-marker-path' },
};

export const useVertical = (): Vertical => useChat((s) => (s.session?.journey.vertical ?? 'bus') as Vertical);
export const useUnit = () => UNIT[useVertical()];
export const useTenant = () => useChat((s) => s.tenant);
export const useFeature = (k: string) => useChat((s) => s.tenant?.features[k] !== false);
export const feature = (k: string) => useChat.getState().tenant?.features[k] !== false;
export const tenantName = () => useChat.getState().tenant?.name ?? 'Trip Rooms';
export const careHandle = () => useChat.getState().tenant?.careHandle ?? 'Customer Care';

/** @-mentionable handles for this tenant: its care desk and Tara. */
export function mentionables() {
  const t = useChat.getState().tenant;
  const list: { id: 'CARE' | 'TARA'; handle: string; title: string; subtitle: string }[] = [];
  if (t?.features.mentions !== false) list.push({ id: 'CARE', handle: t?.careHandle ?? 'Customer Care', title: `${t?.name ?? ''} Customer Care`.trim(), subtitle: 'Get help from the support team' });
  if (t?.features.tara !== false) list.push({ id: 'TARA', handle: 'Tara', title: 'Tara', subtitle: 'Trip assistant · answers in seconds' });
  return list;
}
export const mentionedIn = (text: string) => mentionables().filter((m) => (m.id === 'CARE' ? isCareMention(text, m.handle) : text.toLowerCase().includes(`@${m.handle.toLowerCase()}`))).map((m) => m.id);
/** Every @word that reaches the support desk (the app's handle plus @care, @support…), longest first for highlighting. */
export const careTags = () => (feature('mentions') ? [`@${careHandle()}`, ...CARE_ALIASES.map((a) => `@${a}`)].sort((a, b) => b.length - a.length) : []);
