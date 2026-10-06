import { useEffect, useState } from 'react';
import { serverNow } from '../store/chatStore';

/** Server-corrected "now" that ticks. Every phone on the bus agrees on the countdown. */
export function useServerNow(intervalMs = 1000) {
  const [now, setNow] = useState(serverNow());
  useEffect(() => {
    const id = setInterval(() => setNow(serverNow()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function useCountdown(endsAtIso: string | null | undefined, totalSec?: number) {
  const now = useServerNow(250);
  const remainingMs = endsAtIso ? Math.max(0, Date.parse(endsAtIso) - now) : 0;
  const fraction = totalSec ? Math.min(1, remainingMs / (totalSec * 1000)) : 0;
  return { remainingMs, fraction, done: !!endsAtIso && remainingMs === 0 };
}
