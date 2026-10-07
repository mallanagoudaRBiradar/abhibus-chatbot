import { useEffect, useState } from 'react';
import { chatSocket } from '../services/socket';
import type { TripInfo } from '../shared/protocol';

/**
 * Trip details from the server (stops, your boarding/drop, bus position).
 * Mounted screens often ask before the socket connects, so failures retry
 * quickly; after that it refreshes every `refreshMs`.
 */
export function useTripInfo(refreshMs = 60_000) {
  const [info, setInfo] = useState<TripInfo | null>(null);
  useEffect(() => {
    let alive = true;
    let t: ReturnType<typeof setTimeout>;
    const load = async () => {
      const a = await chatSocket.tripInfo();
      if (!alive) return;
      if (a.ok) setInfo(a.data);
      t = setTimeout(load, a.ok ? refreshMs : 4_000);
    };
    void load();
    return () => { alive = false; clearTimeout(t); };
  }, [refreshMs]);
  return info;
}
