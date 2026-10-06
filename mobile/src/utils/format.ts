/** Locale-independent formatters (Hermes Intl differs across Android builds). */
export function clock(iso: string | number | Date): string {
  const d = new Date(iso);
  let h = d.getHours();
  const m = d.getMinutes();
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m.toString().padStart(2, '0')} ${ap}`;
}

export function ago(iso: string, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} hr ago`;
}

export function mmss(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export function seenSummary(seats: string[]): string {
  if (seats.length === 0) return '';
  const named = seats.slice(0, 2).map((s) => `Seat ${s}`);
  const rest = seats.length - named.length;
  if (rest <= 0) return `Seen by ${named.join(' and ')}`;
  return `Seen by ${named.join(', ')} and ${rest} other${rest > 1 ? 's' : ''}`;
}
