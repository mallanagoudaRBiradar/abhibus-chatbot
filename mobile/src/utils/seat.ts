import { byMode } from '../theme/tokens';
/** Seat identity helpers. Colour is derived from the seat code so it's stable for the whole trip. */
export function seatHue(seat: string): number {
  let h = 0;
  for (let i = 0; i < seat.length; i++) h = (h * 31 + seat.charCodeAt(i)) % 360;
  return (h + 190) % 360; // bias away from pure red, which means "safety" in this UI
}
// Light on dark at night; deeper, readable tones on a light background.
export const seatColor = (seat: string) => byMode({ dark: `hsl(${seatHue(seat)}, 62%, 72%)`, light: `hsl(${seatHue(seat)}, 58%, 36%)` });
export const seatBg = (seat: string) => byMode({ dark: `hsla(${seatHue(seat)}, 60%, 60%, 0.14)`, light: `hsla(${seatHue(seat)}, 60%, 45%, 0.11)` });

export type Berth = 'upper' | 'lower' | 'window' | 'seat';
export function berthOf(seat: string): Berth {
  const c = seat.slice(-1).toUpperCase();
  return c === 'U' ? 'upper' : c === 'L' ? 'lower' : c === 'W' ? 'window' : 'seat';
}
export const berthLabel: Record<Berth, string> = { upper: 'Upper berth', lower: 'Lower berth', window: 'Window seat', seat: 'Seat' };
