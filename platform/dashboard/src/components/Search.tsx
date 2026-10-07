import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { go } from '../lib/router';
import { ago, fmtDateTime, SEV_TONE, SEV_WORD, STATE_LABEL, UNIT } from '../lib/format';
import { Chip } from './ui';
import { EVENT_LABEL } from '../pages/events';

type Hit = { key: string; group: string; ref?: string; title: string; sub: string; chip?: [string, string]; to: string };
type Res = { rooms: any[]; issues: any[]; updates: any[]; campaigns: any[] };

/**
 * One search box for the whole console. Type a reference (TR-…, IS-…, UP-…, CM-…), a route,
 * a bus/train/flight number, a trip key or (for Ops) a booking ref. ⌘K / Ctrl+K focuses it.
 */
export function GlobalSearch() {
  const { tenantName } = useAuth();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [res, setRes] = useState<Res | null>(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const f = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); input.current?.focus(); input.current?.select(); setOpen(true); } };
    const out = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('keydown', f); document.addEventListener('mousedown', out);
    return () => { window.removeEventListener('keydown', f); document.removeEventListener('mousedown', out); };
  }, []);

  useEffect(() => {
    const s = q.trim();
    if (s.length < 2) { setRes(null); return; }
    setBusy(true);
    const t = setTimeout(() => {
      api<Res>('/search', { query: { q: s } }).then((r) => { setRes(r); setSel(0); }).catch(() => setRes({ rooms: [], issues: [], updates: [], campaigns: [] })).finally(() => setBusy(false));
    }, 180);
    return () => clearTimeout(t);
  }, [q]);

  const hits: Hit[] = res ? [
    ...res.rooms.map((r): Hit => ({ key: r.id, group: 'Trip rooms', ref: r.ref, title: r.title, sub: r.why ?? `${r.subtitle} · ${tenantName(r.tenant_id)} · ${UNIT[r.vertical]} · ${fmtDateTime(r.departs_at)}`, chip: [STATE_LABEL[r.state] ?? r.state, 'c-mute'], to: `/ops/rooms/${r.id}` })),
    ...res.issues.map((a): Hit => ({ key: a.id, group: 'Issues', ref: a.ref, title: a.title, sub: `${a.room ? `${a.room.ref} ${a.room.title} · ` : ''}${ago(a.created_at)} · ${a.status}`, chip: [SEV_WORD[a.severity], SEV_TONE[a.severity]], to: a.room ? `/ops/rooms/${a.room_id}` : '/ops/inbox' })),
    ...res.updates.map((u): Hit => ({ key: u.id, group: 'Trip updates', ref: u.ref, title: EVENT_LABEL[u.type] ?? u.type, sub: `${u.room ? `${u.room.ref} ${u.room.title} · ` : ''}${ago(u.created_at)}`, to: u.room ? `/ops/rooms/${u.room.id}/history` : '/ops/rooms' })),
    ...res.campaigns.map((c): Hit => ({ key: c.id, group: 'Campaigns', ref: c.ref, title: c.name, sub: c.advertiser, chip: [c.status, 'c-mute'], to: `/marketing/campaigns/${c.id}` })),
  ] : [];

  const pick = (h?: Hit) => { if (!h) return; go(h.to); setOpen(false); setQ(''); input.current?.blur(); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(hits.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(hits[sel]); }
    else if (e.key === 'Escape') { setOpen(false); input.current?.blur(); }
  };

  let lastGroup = '';
  return (
    <div className="gsearch" ref={box}>
      <span className="gs-ic" aria-hidden>⌕</span>
      <input ref={input} value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={onKey}
        placeholder="Find a room, issue or campaign…" aria-label="Search the console" role="combobox" aria-expanded={open && !!res} aria-controls="gs-list" />
      <kbd>⌘K</kbd>
      {open && q.trim().length >= 2 && (
        <div className="gs-pop" id="gs-list" role="listbox">
          {busy && !res ? <div className="gs-empty"><span className="spin" /> Searching…</div> : !hits.length ? (
            <div className="gs-empty">No match for “{q.trim()}”.<small>Try a reference like <b>TR-8YO3GW</b> or <b>IS-K2M9X1</b>, a route like <b>Hyderabad</b>, a train or flight number, or a trip key.</small></div>
          ) : hits.map((h, i) => {
            const head = h.group !== lastGroup ? (lastGroup = h.group) : null;
            return (
              <div key={h.key}>
                {head && <div className="gs-g">{head}</div>}
                <button type="button" role="option" aria-selected={i === sel} className="gs-hit" onMouseEnter={() => setSel(i)} onClick={() => pick(h)}>
                  {h.ref && <code className="gs-ref">{h.ref}</code>}
                  <span className="gs-t"><b>{h.title}</b><small>{h.sub}</small></span>
                  {h.chip && <Chip tone={h.chip[1]}>{h.chip[0]}</Chip>}
                </button>
              </div>
            );
          })}
          <div className="gs-foot"><span>↑↓ to move · Enter to open · Esc to close</span></div>
        </div>
      )}
      {open && q.trim().length < 2 && (
        <div className="gs-pop"><div className="gs-empty"><b>Search everything</b><small>Reference codes (<b>TR-</b> room, <b>IS-</b> issue, <b>UP-</b> trip update, <b>CM-</b> campaign), routes, operators, train or flight numbers, trip keys. Ops can also paste a booking reference.</small></div></div>
      )}
    </div>
  );
}
