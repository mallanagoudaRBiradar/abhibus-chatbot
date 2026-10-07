import { useState } from 'react';
import { useAuth } from '../lib/auth';
import { useData, useLiveEvents, type PlatformEvent } from '../lib/live';
import { go, href } from '../lib/router';
import { ago, num, roomRef, TENANT_DOT, fmtTime } from '../lib/format';
import { ErrorBox, Kpi, Loading, Panel, Chip, Empty, Ref } from '../components/ui';
import { Icon } from '../components/Icon';
import { useNotifications } from '../components/Notifications';

/**
 * Today: the first screen for every role. It answers one question, "what needs me right now?",
 * then offers the two or three things this role does most, then the wider picture.
 */
export function Overview() {
  const { tenantName, can, user, setTenant } = useAuth();
  const { items, unread, open } = useNotifications();
  const dev = ['config.write', 'keys.manage', 'sandbox.use', 'webhooks.manage'].some(can);
  const ops = can('rooms.act') || can('inbox.act');
  const link = (path: string, ok = true) => (ok ? href(path) : undefined);
  const o = useData<any>('/overview', { refreshOn: ['sos.', 'action.', 'issue.', 'room.', 'member.', 'announcement.', 'wait_request.', 'campaign.', 'care.'] });
  const ev = useData<{ data: PlatformEvent[] }>(can('events.read') && (dev || can('users.manage')) ? '/events' : null, { query: { limit: 40 } });
  const [feed, setFeed] = useState<PlatformEvent[]>([]);
  useLiveEvents((e) => setFeed((f) => [e, ...f].slice(0, 60)));
  const events = [...feed, ...(ev.data?.data ?? []).filter((x) => !feed.some((f) => f.id === x.id))].slice(0, 40);

  if (o.error) return <section className="cmain"><ErrorBox msg={o.error} retry={o.reload} /></section>;
  if (!o.data) return <section className="cmain"><Loading /></section>;
  const d = o.data;
  const crit = d.open_by_severity.critical ?? 0;

  // What needs this person, in order of urgency. Only cards their role can act on.
  const cards = [
    ops && { key: 'sos', n: d.sos_open, label: 'SOS open', sub: d.sos_open ? 'Someone needs help now' : 'No one in danger', icon: 'sos', tone: d.sos_open ? 'critical' : 'ok', to: '/ops/inbox/sos', hot: d.sos_open > 0 },
    ops && { key: 'issues', n: d.open_actions, label: 'Open issues', sub: crit ? `${crit} urgent` : d.open_actions ? 'Waiting for Ops' : 'Inbox zero', icon: 'inbox', tone: crit ? 'critical' : d.open_actions ? 'warning' : 'ok', to: '/ops/inbox', hot: crit > 0 },
    can('support.handle') && { key: 'care', n: d.care_waiting ?? 0, label: 'Tickets waiting', sub: d.care_waiting ? 'Travellers tagged @care' : 'No one waiting', icon: 'headset', tone: d.care_waiting ? 'warning' : 'ok', to: '/support/queue', hot: false },
    { key: 'live', n: d.live_rooms, label: 'Live trips', sub: `${num(d.travellers_live)} travellers in rooms`, icon: 'bus', tone: 'info', to: '/ops/rooms', hot: false },
    can('campaigns.read') && { key: 'camp', n: d.campaigns_live, label: 'Live campaigns', sub: 'Showing in trip chats', icon: 'spark', tone: 'info', to: '/marketing/campaigns', hot: false },
  ].filter(Boolean) as { key: string; n: number; label: string; sub: string; icon: string; tone: string; to: string; hot: boolean }[];

  const quick = [
    { show: true, to: '/ops/rooms', icon: 'search', label: 'Find a trip' },
    { show: ops, to: '/ops/inbox', icon: 'inbox', label: 'Work the inbox' },
    { show: can('broadcast.send'), to: '/ops/broadcast', icon: 'megaphone', label: 'Broadcast to many trips' },
    { show: can('support.handle'), to: '/support/queue', icon: 'headset', label: 'Open ticket queue' },
    { show: can('campaigns.write'), to: '/marketing/new', icon: 'plus', label: 'New campaign' },
    { show: can('rooms.manage'), to: '/admin/rooms', icon: 'grid', label: 'Create or manage rooms' },
    { show: dev, to: '/developer/api', icon: 'code', label: 'API reference' },
  ].filter((q) => q.show);

  return (
    <section className="cmain">
      <div className="hello">
        <h2>Good {greet()}, {user!.name.split(' ')[0]}</h2>
        <p>{d.sos_open ? `${d.sos_open} SOS need${d.sos_open === 1 ? 's' : ''} attention right now.` : unread ? `You have ${unread} new notification${unread === 1 ? '' : 's'}.` : 'Nothing urgent. Everything is running.'}</p>
      </div>

      <div className="now-grid">
        {cards.map((c) => (
          <a key={c.key} className={`now-card ${c.hot ? 'hot' : ''}`} href={href(c.to)}>
            <span className={`nicon ${c.tone === 'ok' ? '' : c.tone}`}><Icon name={c.icon} /></span>
            <b>{num(c.n)}</b>
            <span>{c.label}</span>
            <small>{c.sub}</small>
          </a>
        ))}
      </div>

      <div className="two">
        <Panel title={<>For you {unread > 0 && <Chip tone="c-crit">{unread} new</Chip>}</>}>
          {!items.length ? <Empty>You’re all caught up. New SOS, issues, tickets and results for your role land here and in the bell.</Empty> : (
            <div className="nlist">{items.slice(0, 7).map((n) => (
              <button type="button" key={n.id} className={`nitem ${n.unread ? 'unread' : ''}`} onClick={() => open(n)}>
                <span className={`nicon ${n.severity}`}><Icon name={n.kind === 'SOS' ? 'sos' : n.kind === 'Support' ? 'headset' : n.kind === 'Response' || n.kind === 'Poll' ? 'chart' : n.kind === 'Room' ? 'bus' : 'bell'} /></span>
                <span><b>{n.title}</b>{n.body && <p>{n.body}</p>}{n.room && <span className="nmeta"><code className="ref static">{n.room.ref}</code><small className="hint">{n.room.title}</small></span>}</span>
                <time>{ago(n.created_at)}</time>
              </button>
            ))}</div>
          )}
        </Panel>
        <Panel title="Jump to">
          <div className="quick">{quick.map((q) => <a key={q.to} className="btn" href={href(q.to)}><Icon name={q.icon} size={16} />{q.label}</a>)}</div>
          <p className="hint" style={{ marginTop: 12 }}>Tip: press <b>⌘K</b> anywhere and type a key like <b>TR-8YO3GW</b>, a route or a bus number.</p>
        </Panel>
      </div>

      <h3 className="section-title">Platform at a glance</h3>
      <div className="kpis">
        <Kpi label="Travellers in rooms" value={num(d.travellers_live)} sub="right now" to={link('/ops/rooms')} />
        <Kpi label="Ops alerts (24 h)" value={num(d.alerts_24h)} to={link('/ops/audit', can('audit.read') && !can('users.manage')) ?? link('/admin/audit', can('users.manage'))} />
        <Kpi label="Platform events (1 h)" value={num(d.events_last_hour)} sub="webhooks fan out from these" to={link('/developer/events', dev && can('events.read'))} />
        <Kpi label="Apps connected" value={d.by_tenant.length} sub={d.by_tenant.map((t: any) => tenantName(t.tenant)).join(' · ')} to={can('tenants.manage') ? href('/admin/tenants') : link('/developer/config', dev && can('config.read'))} />
      </div>
      <div className={events.length ? 'two' : ''}>
        <Panel title="By app">
          <div className="tw"><table>
            <thead><tr><th>App</th><th className="num">Live trips</th><th className="num">All trips</th><th /></tr></thead>
            <tbody>{d.by_tenant.map((t: any) => (
              <tr key={t.tenant} className="click" onClick={() => { setTenant(t.tenant); go('/ops/rooms'); }} title={`Show ${tenantName(t.tenant)} trips`}><td><span className="dot" style={{ background: TENANT_DOT[t.tenant] ?? 'var(--primary)' }} />{tenantName(t.tenant)}</td><td className="num">{t.live}</td><td className="num">{t.total}</td>
                <td><span className="lnk">Trips →</span></td></tr>
            ))}</tbody>
          </table></div>
        </Panel>
        {events.length > 0 && (
          <Panel title="Live platform events" right={<Chip tone="c-ok">streaming</Chip>}>
            <div className="ticker">{events.map((e) => (
              <div key={e.id}><code>{e.type}</code><span>{e.room ? <Ref code={roomRef(e.room)} /> : tenantName(e.tenant)}</span><time title={e.created_at}>{fmtTime(e.created_at)}</time></div>
            ))}</div>
          </Panel>
        )}
      </div>
    </section>
  );
}
const greet = () => { const h = +new Date().toLocaleString('en-IN', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }); return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'; };
