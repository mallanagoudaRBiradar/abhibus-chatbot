/**
 * Human reference codes for things people talk about on calls and in chat:
 *   room_8yo3gwaf → TR-8YO3GW   act_k2m9x… → IS-K2M9X…   evt_… → UP-…   cmp_… → CM-…
 * A code is just the id's first 6 characters with a readable prefix, so no storage
 * or migration is needed and search is a prefix match on the id.
 */
const PREFIX: Record<string, string> = { room: 'TR', act: 'IS', evt: 'UP', cmp: 'CM' };
const BACK: Record<string, string> = Object.fromEntries(Object.entries(PREFIX).map(([k, v]) => [v, k]));

export const toRef = (id: string) => {
  const [p, rest] = id.split('_');
  return PREFIX[p] && rest ? `${PREFIX[p]}-${rest.slice(0, 6).toUpperCase()}` : id;
};

/** "tr-8yo3gw", "TR 8YO3GW", "room_8yo3gw…" → { kind: 'room', idPrefix: 'room_8yo3gw' }. */
export function parseRef(q: string): { kind: string; idPrefix: string } | null {
  const s = q.trim();
  const m = /^(TR|IS|UP|CM)[\s-]?([A-Z0-9]{3,12})$/i.exec(s);
  if (m) return { kind: BACK[m[1].toUpperCase()], idPrefix: `${BACK[m[1].toUpperCase()]}_${m[2].toLowerCase()}` };
  const raw = /^(room|act|evt|cmp)_([a-z0-9]{3,12})$/i.exec(s);
  return raw ? { kind: raw[1].toLowerCase(), idPrefix: s.toLowerCase() } : null;
}
