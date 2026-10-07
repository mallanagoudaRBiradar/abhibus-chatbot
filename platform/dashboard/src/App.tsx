import { useEffect, useState, type ReactNode } from 'react';
import { AuthProvider, useAuth } from './lib/auth';
import { useRoute, go, href } from './lib/router';
import { useLiveEvents, useLiveStatus } from './lib/live';
import { SupportQueue, SupportSetup } from './pages/support';
import { api } from './lib/api';
import { Btn, Field, Modal, ThemeSwitch, ToastHost, useAction } from './components/ui';
import { Overview } from './pages/Overview';
import { RoomManager } from './pages/rooms-admin';
import { Icon } from './components/Icon';
import { Bell, NotificationsProvider } from './components/Notifications';
import { OpsRooms, OpsInbox, OpsBroadcast, AuditLog } from './pages/ops';
import { OpsRoom } from './pages/room';
import { GlobalSearch } from './components/Search';
import { MktOverview, MktCampaigns, MktCampaign, MktNew, MktRules } from './pages/marketing';
import { DevOverview, DevQuickstart, DevApi, DevWebhooks, DevSdk, DevConfig, DevKeys, DevSandbox, DevEvents, DevErrors } from './pages/developer';
import { AdminUsers, AdminTenants } from './pages/admin';

interface Page { id: string; label: string; perm?: string; any?: string[]; render: (rest: string[]) => ReactNode; badge?: 'inbox' | 'care' }
interface Section { id: string; label: string; perm?: string; any?: string[]; pages: Page[]; blurb: string; badge?: 'care' }

const SECTIONS: Section[] = [
  { id: 'overview', label: 'Overview', perm: 'rooms.read', blurb: 'Everything live, all apps', pages: [{ id: '', label: 'Overview', render: () => <Overview /> }] },
  { id: 'ops', label: 'Operations', perm: 'rooms.read', blurb: 'Run live trips', pages: [
    { id: 'rooms', label: 'Live rooms', render: (r) => r[0] ? <OpsRoom id={r[0]} tab={r[1]} /> : <OpsRooms /> },
    { id: 'inbox', label: 'Issues inbox', render: (r) => <OpsInbox initialType={r[0]} />, badge: 'inbox' },
    { id: 'broadcast', label: 'Bulk broadcast', perm: 'broadcast.send', render: () => <OpsBroadcast /> },
    { id: 'audit', label: 'Audit log', perm: 'audit.read', render: () => <AuditLog /> },
  ] },
  { id: 'support', label: 'Customer support', perm: 'support.handle', badge: 'care', blurb: '@care tickets from trip chats', pages: [
    { id: 'queue', label: 'Ticket queue', render: (r) => <SupportQueue id={r[0]} />, badge: 'care' },
    { id: 'setup', label: 'How travellers reach you', render: () => <SupportSetup /> },
  ] },
  { id: 'marketing', label: 'Marketing', perm: 'campaigns.read', blurb: 'Campaigns & results', pages: [
    { id: 'overview', label: 'Overview', render: () => <MktOverview /> },
    { id: 'campaigns', label: 'Campaigns', render: (r) => r[0] ? <MktCampaign id={r[0]} /> : <MktCampaigns /> },
    { id: 'new', label: 'New campaign', perm: 'campaigns.write', render: (r) => <MktNew fromRoom={r[0]} /> },
    { id: 'rules', label: 'Ad rules', render: () => <MktRules /> },
  ] },
  { id: 'developer', label: 'Developer', any: ['config.write', 'keys.manage', 'sandbox.use', 'webhooks.manage'], blurb: 'Integrate your app', pages: [
    { id: 'overview', label: 'Overview', render: () => <DevOverview /> },
    { id: 'quickstart', label: 'Quickstart by vertical', render: () => <DevQuickstart /> },
    { id: 'api', label: 'API reference', render: (r) => <DevApi ep={r[0]} /> },
    { id: 'webhooks', label: 'Webhooks', render: () => <DevWebhooks /> },
    { id: 'sdk', label: 'Chat screen SDK', render: () => <DevSdk /> },
    { id: 'config', label: 'Tenants & config', perm: 'config.read', render: (r) => <DevConfig tenant={r[0]} /> },
    { id: 'keys', label: 'API keys', perm: 'keys.manage', render: () => <DevKeys /> },
    { id: 'sandbox', label: 'Try it (sandbox)', perm: 'sandbox.use', render: () => <DevSandbox /> },
    { id: 'events', label: 'Event log', perm: 'events.read', render: () => <DevEvents /> },
    { id: 'errors', label: 'Errors & limits', render: () => <DevErrors /> },
  ] },
  { id: 'admin', label: 'Admin', any: ['users.manage', 'rooms.manage'], blurb: 'People, roles, tenants', pages: [
    { id: 'rooms', label: 'Room manager', perm: 'rooms.manage', render: () => <RoomManager /> },
    { id: 'users', label: 'Users & roles', perm: 'users.manage', render: () => <AdminUsers /> },
    { id: 'tenants', label: 'Tenants', perm: 'tenants.manage', render: () => <AdminTenants /> },
    { id: 'audit', label: 'Audit log', perm: 'audit.read', render: () => <AuditLog /> },
  ] },
];
// Everyone starts on Today: what needs them right now, for their role.
const HOME: Record<string, string> = { ops: '/overview', support: '/overview', marketing: '/overview', developer: '/overview', admin: '/overview', viewer: '/overview' };

export default function App() {
  return <ToastHost><AuthProvider><Root /></AuthProvider></ToastHost>;
}

function Root() {
  const { user, ready } = useAuth();
  if (!ready) return <div className="boot"><span className="spin" /></div>;
  return user ? <Shell /> : <Login />;
}

// ------------------------------------------------------------------ login ---
function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState(false);
  useEffect(() => { fetch('/healthz').then((r) => r.json()).then((h) => setDemo(!!h.demo)).catch(() => setErr('Can’t reach the Trip Rooms server on :4100. Start it with `npm run dev` in platform/server.')); }, []);
  const submit = async (e?: React.FormEvent, em = email, pw = password) => {
    e?.preventDefault(); setBusy(true); setErr(null);
    try { await login(em, pw); } catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  };
  const DEMO = [['admin', 'Admin', 'Everything'], ['ops', 'Operations', 'Run live trips'], ['support', 'Support', 'Work the inbox'], ['marketing', 'Marketing', 'Campaigns'], ['developer', 'Developer', 'APIs & keys'], ['viewer', 'Viewer', 'Read-only'], ['abhibus.ops', 'AbhiBus Ops', 'One tenant only']];
  return (
    <div className="login">
      <div className="bg-layer bg-base" />
      <div className="login-theme"><ThemeSwitch /></div>
      <div className="login-card">
        <div className="brand"><i />Trip Rooms <small>Console</small></div>
        <h1>Sign in</h1>
        <p className="muted">One console for AbhiBus, ConfirmTkt, ixigo Trains and ixigo Flights. What you see depends on your role.</p>
        <form onSubmit={submit} className="f" style={{ gap: 12 }}>
          <Field label="Work email"><input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required autoFocus /></Field>
          <Field label="Password"><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
          {err && <div className="errbox">{err}</div>}
          <button className="btn pri big" disabled={busy || !email || !password}>{busy ? <span className="spin" /> : null}Sign in</button>
        </form>
        {demo && (
          <div className="demo-accts">
            <small>Demo accounts · password <code>TripRooms@2026</code></small>
            <div className="grid-demo">
              {DEMO.map(([k, l, d]) => (
                <button key={k} type="button" onClick={() => { const em = `${k}@triprooms.local`; setEmail(em); setPassword('TripRooms@2026'); void submit(undefined, em, 'TripRooms@2026'); }}>
                  <b>{l}</b><span>{d}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ shell ---
/**
 * One sidebar, organised by the job you came to do (not by department), with only what your role
 * can use. Routes are unchanged, so every existing link and bookmark still works.
 */
type NavItem = { to: string; label: string; icon: string; perm?: string; any?: string[]; badge?: 'inbox' | 'care'; active: (route: string[]) => boolean };
type NavGroup = { title?: string; items: NavItem[]; fold?: boolean };
const at = (sec: string, page?: string) => (r: string[]) => r[0] === sec && (page === undefined || (r[1] ?? '') === page);
const NAV: NavGroup[] = [
  { items: [{ to: '/overview', label: 'Today', icon: 'home', perm: 'rooms.read', active: at('overview') }] },
  { title: 'Operate', items: [
    { to: '/ops/rooms', label: 'Trips', icon: 'bus', perm: 'rooms.read', active: at('ops', 'rooms') },
    { to: '/ops/inbox', label: 'Issues inbox', icon: 'inbox', any: ['inbox.act', 'rooms.act'], badge: 'inbox', active: at('ops', 'inbox') },
    { to: '/ops/broadcast', label: 'Broadcast', icon: 'megaphone', perm: 'broadcast.send', active: at('ops', 'broadcast') },
  ] },
  { title: 'Support', items: [
    { to: '/support/queue', label: 'Ticket queue', icon: 'headset', perm: 'support.handle', badge: 'care', active: at('support', 'queue') },
    { to: '/support/setup', label: 'How travellers reach us', icon: 'book', perm: 'support.handle', active: at('support', 'setup') },
  ] },
  { title: 'Marketing', items: [
    { to: '/marketing/overview', label: 'Results', icon: 'chart', perm: 'campaigns.read', active: at('marketing', 'overview') },
    { to: '/marketing/campaigns', label: 'Campaigns', icon: 'spark', perm: 'campaigns.read', active: at('marketing', 'campaigns') },
    { to: '/marketing/new', label: 'New campaign', icon: 'plus', perm: 'campaigns.write', active: at('marketing', 'new') },
    { to: '/marketing/rules', label: 'Ad rules', icon: 'rules', perm: 'campaigns.read', active: at('marketing', 'rules') },
  ] },
  { title: 'Manage', items: [
    { to: '/admin/rooms', label: 'Room manager', icon: 'grid', perm: 'rooms.manage', active: at('admin', 'rooms') },
    { to: '/admin/users', label: 'People & roles', icon: 'users', perm: 'users.manage', active: at('admin', 'users') },
    { to: '/admin/tenants', label: 'Apps', icon: 'apps', perm: 'tenants.manage', active: at('admin', 'tenants') },
    { to: '/admin/audit', label: 'Audit log', icon: 'log', perm: 'users.manage', active: at('admin', 'audit') },
    { to: '/ops/audit', label: 'Audit log', icon: 'log', perm: 'audit.read', active: at('ops', 'audit') },
  ] },
  { title: 'Developer', fold: true, items: [
    { to: '/developer/overview', label: 'Overview', icon: 'code', any: ['config.write', 'keys.manage', 'sandbox.use', 'webhooks.manage'], active: at('developer', 'overview') },
    { to: '/developer/api', label: 'API reference', icon: 'book', any: ['config.write', 'keys.manage', 'sandbox.use', 'webhooks.manage'], active: at('developer', 'api') },
    { to: '/developer/config', label: 'Tenants & config', icon: 'apps', perm: 'config.write', active: at('developer', 'config') },
    { to: '/developer/keys', label: 'API keys', icon: 'key', perm: 'keys.manage', active: at('developer', 'keys') },
    { to: '/developer/webhooks', label: 'Webhooks', icon: 'arrow', perm: 'webhooks.manage', active: at('developer', 'webhooks') },
    { to: '/developer/sandbox', label: 'Sandbox', icon: 'play', perm: 'sandbox.use', active: at('developer', 'sandbox') },
    { to: '/developer/events', label: 'Event log', icon: 'log', perm: 'events.read', any: ['config.write', 'keys.manage', 'sandbox.use', 'webhooks.manage'], active: at('developer', 'events') },
    { to: '/developer/quickstart', label: 'Quickstart', icon: 'spark', any: ['config.write', 'keys.manage', 'sandbox.use', 'webhooks.manage'], active: at('developer', 'quickstart') },
    { to: '/developer/sdk', label: 'Chat screen SDK', icon: 'code', any: ['config.write', 'keys.manage', 'sandbox.use', 'webhooks.manage'], active: at('developer', 'sdk') },
    { to: '/developer/errors', label: 'Errors & limits', icon: 'alert', any: ['config.write', 'keys.manage', 'sandbox.use', 'webhooks.manage'], active: at('developer', 'errors') },
  ] },
];

function Shell() {
  const { user, can, tenants, tenant, setTenant, logout } = useAuth();
  const route = useRoute();
  const allowed = (x: { perm?: string; any?: string[] }) => (!x.perm || can(x.perm)) && (!x.any || x.any.some(can));
  const sections = SECTIONS.filter(allowed).map((s) => ({ ...s, pages: s.pages.filter(allowed) })).filter((s) => s.pages.length);
  const [secId, pageId = '', ...rest] = route;
  const sec = sections.find((s) => s.id === secId);
  const page = sec?.pages.find((p) => p.id === pageId) ?? (sec && !pageId ? sec.pages[0] : undefined);
  useEffect(() => { if (!sec || !page) go(HOME[user!.role] ?? `/${sections[0]?.id ?? 'overview'}`); }, [sec, page]); // eslint-disable-line

  const [inboxOpen, setInboxOpen] = useState(0);
  const [careWaiting, setCareWaiting] = useState(0);
  const loadCounts = () => api('/overview').then((o: any) => { setInboxOpen(o.open_actions); setCareWaiting(o.care_waiting ?? 0); }).catch(() => {});
  useEffect(() => {
    if (!can('rooms.read')) return;
    void loadCounts(); const t = setInterval(loadCounts, 20_000); return () => clearInterval(t);
  }, []); // eslint-disable-line
  useLiveEvents((e) => { if (e.type === 'action.updated' || e.type.startsWith('care.') || e.type.startsWith('sos.') || e.type.startsWith('issue.')) void loadCounts(); });
  const badge = (b?: 'inbox' | 'care') => (b === 'inbox' ? inboxOpen : b === 'care' ? careWaiting : 0);

  const [menu, setMenu] = useState(false);
  const [pw, setPw] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [devOpen, setDevOpen] = useState(() => route[0] === 'developer');
  const live = useLiveStatus();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => { setNavOpen(false); setMenu(false); }, [route.join('/')]);

  if (!sec || !page) return null;
  const wideRoom = sec.id === 'ops' && page.id === 'rooms' && rest[0];
  // Audit log appears once: the admin copy for admins, the ops copy for everyone else who can read it.
  const visible = (it: NavItem) => allowed(it) && !(it.to === '/ops/audit' && can('users.manage'));
  const groups = NAV.map((g) => ({ ...g, items: g.items.filter(visible) })).filter((g) => g.items.length);
  const time = new Date(now).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  return (
    <NotificationsProvider>
      <div className={`app ${navOpen ? 'nav-open' : ''}`} onClick={(e) => { if (navOpen && (e.target as HTMLElement).classList.contains('app')) setNavOpen(false); }}>
        <aside className="side" aria-label="Main navigation">
          <a className="side-brand" href={href(HOME[user!.role] ?? '/overview')}><span className="logo"><Icon name="route" size={17} /></span><span>Trip Rooms<small>Console</small></span></a>
          {groups.map((g, gi) => (
            <div className="side-group" key={g.title ?? gi}>
              {g.title && (g.fold
                ? <button type="button" onClick={() => setDevOpen((x) => !x)} aria-expanded={devOpen}><b>{g.title}<Icon name="chevron" size={14} className={devOpen ? 'rot' : ''} /></b></button>
                : <b>{g.title}</b>)}
              {(!g.fold || devOpen || g.items.some((it) => it.active(route))) && g.items.map((it) => (
                <a key={it.to} className="nav" href={href(it.to)} aria-current={it.active(route) ? 'page' : undefined}>
                  <Icon name={it.icon} />{it.label}{badge(it.badge) > 0 && <span className="count">{badge(it.badge)}</span>}
                </a>
              ))}
            </div>
          ))}
          <div className="side-foot">
            <div className="um">
              <button type="button" className="side-user" onClick={() => setMenu((m) => !m)} aria-expanded={menu}>
                <span className="av">{user!.name.slice(0, 1)}</span>
                <span style={{ minWidth: 0 }}><b>{user!.name}</b><small>{user!.role_label}{user!.tenants.length ? ` · ${user!.tenants.length} app${user!.tenants.length > 1 ? 's' : ''}` : ' · all apps'}</small></span>
              </button>
              {menu && (
                <div className="um-menu up" onMouseLeave={() => setMenu(false)}>
                  <div className="um-who"><b>{user!.name}</b><small>{user!.email}</small><small>{user!.tenants.length ? `Apps: ${user!.tenants.join(', ')}` : 'All apps'}</small></div>
                  <button type="button" onClick={() => { setPw(true); setMenu(false); }}><Icon name="key" size={15} /> Change password</button>
                  <button type="button" onClick={logout}><Icon name="logout" size={15} /> Sign out</button>
                </div>
              )}
            </div>
          </div>
        </aside>
        <div className="main">
          <header className="top">
            <button type="button" className="iconbtn menu-btn" onClick={() => setNavOpen((x) => !x)} aria-label="Menu"><Icon name="menu" /></button>
            <GlobalSearch />
            <span className="grow" />
            {tenants.length > 1 && (
              <select className="tsel" value={tenant} onChange={(e) => setTenant(e.target.value)} aria-label="Show one app">
                <option value="">All apps</option>
                {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            )}
            <span className={`livepill is-${live}`} title={live === 'live' ? 'Live updates on' : live === 'connecting' ? 'Reconnecting…' : 'Live updates off'}>{live === 'live' ? `Live · ${time} IST` : live === 'connecting' ? 'Connecting' : 'Offline'}</span>
            <ThemeSwitch />
            <Bell />
          </header>
          <main id="view">
            <div className={`page-grid ${wideRoom ? 'withlive' : ''}`}>{page.render(page.id === pageId ? rest : [])}</div>
          </main>
        </div>
      </div>
      {pw && <PasswordModal onClose={() => setPw(false)} />}
    </NotificationsProvider>
  );
}

function PasswordModal({ onClose }: { onClose: () => void }) {
  const [cur, setCur] = useState(''); const [next, setNext] = useState('');
  const { busy, run } = useAction();
  return (
    <Modal title="Change password" onClose={onClose}>
      <div className="f" style={{ gap: 12 }}>
        <Field label="Current password"><input type="password" value={cur} onChange={(e) => setCur(e.target.value)} /></Field>
        <Field label="New password" hint="At least 10 characters."><input type="password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
        <div><Btn kind="pri" busy={busy === 'pw'} disabled={next.length < 10} onClick={async () => { if (await run('pw', () => api('/me/password', { body: { current: cur, next } }), 'Password changed')) onClose(); }}>Save</Btn></div>
      </div>
    </Modal>
  );
}
