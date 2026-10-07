import { useEffect, useState } from 'react';

/** Hash router: #/ops/rooms/room_123 → ['ops','rooms','room_123']. Deep links survive refresh. */
const parse = () => (window.location.hash.replace(/^#\/?/, '').split('?')[0] || '').split('/').filter(Boolean);
export function useRoute() {
  const [r, set] = useState(parse);
  useEffect(() => { const f = () => set(parse()); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  return r;
}
export const go = (path: string) => { window.location.hash = path.startsWith('/') ? path : `/${path}`; };
export const href = (path: string) => `#${path.startsWith('/') ? path : `/${path}`}`;

/**
 * Query string inside the hash (#/ops/rooms?operator=VRL&from=Hyderabad): filters are shareable,
 * bookmarkable and survive refresh. Updates replace the history entry (no Back-button spam).
 */
const readQuery = () => new URLSearchParams(window.location.hash.split('?')[1] ?? '');
export function useQuery(): [URLSearchParams, (patch: Record<string, string | null | undefined>) => void] {
  const [q, setQ] = useState(readQuery);
  useEffect(() => { const f = () => setQ(readQuery()); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  const update = (patch: Record<string, string | null | undefined>) => {
    const next = readQuery();
    for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k);
    const path = window.location.hash.split('?')[0] || '#/';
    const qs = next.toString();
    history.replaceState(null, '', `${path}${qs ? `?${qs}` : ''}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  };
  return [q, update];
}
