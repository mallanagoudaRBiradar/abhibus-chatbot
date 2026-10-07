import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { useLiveEvents } from '../lib/live';
import { go } from '../lib/router';
import { ago } from '../lib/format';
import { alertsOn, ring, setAlerts } from '../lib/careAlerts';
import { Icon } from './Icon';

/**
 * Notification centre: the bell (unread count, grouped list, mark read) and live pop-ups for new
 * items with an "Open" button that takes you straight there. What each role sees is decided on the
 * server (core/notifications.ts); this only listens, shows and remembers.
 */
export interface Notif { id: string; type: string; severity: 'critical' | 'warning' | 'info'; title: string; body: string; kind: string; room: { id: string; ref: string; title: string } | null; link: string; created_at: string; unread: boolean }
type Ctx = { items: Notif[]; unread: number; loaded: boolean; open: (n: Notif) => void; markAll: () => void; reload: () => void };
const NCtx = createContext<Ctx>({ items: [], unread: 0, loaded: false, open: () => {}, markAll: () => {}, reload: () => {} });
export const useNotifications = () => useContext(NCtx);

// Event types that can produce a notification (kept in step with the server's RULES).
const LIVE_TYPES = ['sos.', 'issue.escalated', 'wait_request.', 'lost_found.', 'message.reported', 'care.', 'action.updated', 'trip_event.breakdown', 'trip_event.cancelled', 'survey.response', 'poll.completed', 'campaign.created', 'room.created', 'room.state_changed', 'room.deleted'];
const ICON: Record<string, string> = { SOS: 'sos', Support: 'headset', Handover: 'headset', Breakdown: 'alert', Cancelled: 'alert', Response: 'chart', Poll: 'chart', Campaign: 'megaphone', Room: 'bus' };

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Notif[]>([]);
  const [unread, setUnread] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [pops, setPops] = useState<Notif[]>([]);
  const known = useRef<Set<string> | null>(null);
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ data: Notif[]; unread: number }>('/notifications');
      // Pop up only what's new since we last looked (never the backlog on first load).
      if (known.current) {
        const fresh = r.data.filter((n) => n.unread && !known.current!.has(n.id));
        for (const n of fresh.slice(0, 3)) ring(n);
        if (fresh.length) setPops((p) => [...fresh.slice(0, 3), ...p].slice(0, 4));
      }
      known.current = new Set(r.data.map((n) => n.id));
      setItems(r.data); setUnread(r.unread); setLoaded(true);
    } catch { /* offline: keep what we have */ }
  }, []);
  useEffect(() => { void load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);
  useLiveEvents((e) => {
    if (!LIVE_TYPES.some((p) => e.type.startsWith(p))) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void load(), 500);
  });

  const markRead = (ids: string[]) => {
    setItems((x) => x.map((n) => (ids.includes(n.id) ? { ...n, unread: false } : n)));
    setUnread((u) => Math.max(0, u - items.filter((n) => n.unread && ids.includes(n.id)).length));
    void api('/notifications/read', { body: { ids } }).catch(() => {});
  };
  const open = (n: Notif) => { if (n.unread) markRead([n.id]); setPops((p) => p.filter((x) => x.id !== n.id)); go(n.link); };
  const markAll = () => { setItems((x) => x.map((n) => ({ ...n, unread: false }))); setUnread(0); void api('/notifications/read', { body: { all: true } }).catch(() => {}); };

  return (
    <NCtx.Provider value={{ items, unread, loaded, open, markAll, reload: load }}>
      {children}
      <AlertStack pops={pops} onOpen={open} onClose={(id) => setPops((p) => p.filter((x) => x.id !== id))} />
    </NCtx.Provider>
  );
}

/** Pop-ups: urgent ones stay until handled; others fade after a few seconds. */
function AlertStack({ pops, onOpen, onClose }: { pops: Notif[]; onOpen: (n: Notif) => void; onClose: (id: string) => void }) {
  useEffect(() => {
    const ts = pops.filter((p) => p.severity !== 'critical').map((p) => setTimeout(() => onClose(p.id), p.severity === 'warning' ? 12_000 : 6_000));
    return () => ts.forEach(clearTimeout);
  }, [pops]); // eslint-disable-line
  if (!pops.length) return null;
  return (
    <div className="alerts" role="region" aria-label="New alerts" aria-live="assertive">
      {pops.map((n) => (
        <div key={n.id} className={`alertpop ${n.severity}`} role="alert">
          <span className={`nicon ${n.severity}`}><Icon name={ICON[n.kind] ?? 'bell'} /></span>
          <div>
            <b>{n.title}</b>
            {n.body && <p>{n.body}</p>}
            <div className="acts">
              <button type="button" className="btn pri sm" onClick={() => onOpen(n)}>{n.kind === 'Support' ? 'Open ticket' : n.room ? `Open ${n.room.ref}` : 'Open'} <Icon name="arrow" size={14} /></button>
              <button type="button" className="btn ghost sm" onClick={() => onClose(n.id)}>Later</button>
            </div>
          </div>
          <button type="button" className="iconbtn" style={{ width: 28, height: 28 }} onClick={() => onClose(n.id)} aria-label="Dismiss"><Icon name="x" size={14} /></button>
        </div>
      ))}
    </div>
  );
}

const dayOf = (iso: string) => { const d = new Date(iso), t = new Date(); return d.toDateString() === t.toDateString() ? 'Today' : d.toDateString() === new Date(+t - 86_400_000).toDateString() ? 'Yesterday' : 'Earlier'; };

export function Bell() {
  const { items, unread, open, markAll } = useNotifications();
  const [show, setShow] = useState(false);
  const [tab, setTab] = useState<'all' | 'unread' | 'urgent'>('all');
  const [sound, setSound] = useState(alertsOn());
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!show) return;
    const out = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setShow(false); };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setShow(false);
    document.addEventListener('mousedown', out); window.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', out); window.removeEventListener('keydown', esc); };
  }, [show]);
  const list = items.filter((n) => (tab === 'unread' ? n.unread : tab === 'urgent' ? n.severity === 'critical' : true));
  const urgentUnread = items.some((n) => n.unread && n.severity === 'critical');
  let last = '';
  return (
    <div className="bell-wrap" ref={box}>
      <button type="button" className="iconbtn" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} aria-expanded={show} onClick={() => setShow((s) => !s)}>
        <Icon name="bell" />
        {unread > 0 && <span className={`dotcount ${urgentUnread ? 'pulse' : ''}`}>{unread > 99 ? '99+' : unread}</span>}
      </button>
      {show && (
        <div className="npanel" role="dialog" aria-label="Notifications">
          <header><h4>Notifications</h4>{unread > 0 && <button type="button" className="btn ghost sm" onClick={markAll}><Icon name="check" size={14} /> Mark all read</button>}</header>
          <div className="ntabs">{([['all', 'All'], ['unread', `Unread${unread ? ` · ${unread}` : ''}`], ['urgent', 'Urgent']] as const).map(([k, l]) => <button type="button" key={k} aria-pressed={tab === k} onClick={() => setTab(k)}>{l}</button>)}</div>
          <div className="nlist">
            {!list.length ? (
              <div className="nempty"><Icon name="check" size={28} /><div><b>You’re all caught up</b></div><small>New SOS, issues, tickets and results for your role appear here the moment they happen.</small></div>
            ) : list.map((n) => {
              const g = dayOf(n.created_at); const head = g !== last ? (last = g) : null;
              return (
                <div key={n.id}>
                  {head && <div className="ngroup">{head}</div>}
                  <button type="button" className={`nitem ${n.unread ? 'unread' : ''}`} onClick={() => { setShow(false); open(n); }}>
                    <span className={`nicon ${n.severity}`}><Icon name={ICON[n.kind] ?? 'bell'} /></span>
                    <span><b>{n.title}</b>{n.body && <p>{n.body}</p>}{n.room && <span className="nmeta"><code className="ref static">{n.room.ref}</code><small className="hint">{n.room.title}</small></span>}</span>
                    <time title={n.created_at}>{ago(n.created_at)}</time>
                  </button>
                </div>
              );
            })}
          </div>
          <div className="nfoot">
            <label><input type="checkbox" checked={sound} onChange={async (e) => setSound(await setAlerts(e.target.checked))} /> Sound & desktop alerts</label>
            <span>Last 7 days</span>
          </div>
        </div>
      )}
    </div>
  );
}
