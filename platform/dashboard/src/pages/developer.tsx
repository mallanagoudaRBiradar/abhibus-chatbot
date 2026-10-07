import { useEffect, useMemo, useState } from 'react';
import { api, rawCall } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useData } from '../lib/live';
import { go, href } from '../lib/router';
import { ago, fmtTime } from '../lib/format';
import { Btn, Chip, Code, CopyCode, Empty, ErrorBox, Field, Head, Loading, Modal, Panel, SecretOnce, Seg, Switch, useAction, useToast } from '../components/ui';

type V = 'bus' | 'train' | 'flight';
const VT: [V, string][] = [['bus', 'Bus'], ['train', 'Train'], ['flight', 'Flight']];

// ================================================================= overview ===
export function DevOverview() {
  return (
    <section className="cmain">
      <Head title="Trip Rooms platform" sub="Temporary trip chat rooms that AbhiBus, ConfirmTkt, ixigo Trains and ixigo Flights create for a trip, fill with their travellers and open inside their own app. Everything lives here; your app only calls APIs and opens one screen." />
      <div className="g3">
        <Panel title="1 · Server APIs"><p className="prose">Create rooms, add travellers, report trip events, push location, post alerts, run polls and campaigns, moderate. OAuth client credentials, JSON over HTTPS.</p><a className="lnk" href={href('/developer/api')}>API reference →</a></Panel>
        <Panel title="2 · Webhooks"><p className="prose">SOS, group issues, wait requests, reports, push/SMS requests and state changes come back to your systems, signed with HMAC-SHA256.</p><a className="lnk" href={href('/developer/webhooks')}>Webhooks →</a></Panel>
        <Panel title="3 · Hosted chat screen"><p className="prose">One screen, already built: open <code>chat_url</code> in a WebView (Android, iOS, React Native) or an iframe (web). Your brand colour, your identity rules.</p><a className="lnk" href={href('/developer/sdk')}>Chat screen SDK →</a></Panel>
      </div>
      <Panel title="Plug in, four calls">
        <div className="flow"><span className="s">1 · PUT /v1/rooms/by-key/&#123;trip_key&#125;</span><span className="a">→</span><span className="s">2 · POST /v1/rooms/&#123;id&#125;/members</span><span className="a">→</span><span className="s">3 · POST …/members/&#123;mid&#125;/token</span><span className="a">→</span><span className="s">4 · Open chat_url in your app</span></div>
        <p className="hint" style={{ marginTop: 10 }}>All calls are idempotent: retry safely. Send <code>Idempotency-Key</code> on POSTs for exactly-once.</p>
      </Panel>
      <Panel title="What lives where">
        <div className="tw"><table>
          <thead><tr><th>Trip Rooms (this platform)</th><th>Your app (AbhiBus, ConfirmTkt, ixigo…)</th></tr></thead>
          <tbody>
            <tr><td>Rooms, members, messages, moderation, masking, reports</td><td>Bookings, users, PNRs — you send only IDs</td></tr>
            <tr><td>Realtime (WebSocket), chat screen, games, polls, Tara</td><td>A “Trip chat” button that opens <code>chat_url</code></td></tr>
            <tr><td>Location fusion: your feed + on-board travellers + timetable</td><td>Optional VTS / running status / flight status push</td></tr>
            <tr><td>Ops, Marketing, Developer consoles, audit</td><td>Push, SMS, WhatsApp delivery (via <code>notification.requested</code>)</td></tr>
            <tr><td>Ad rules, campaigns, delivery logs</td><td>Wallet credit on <code>voucher.claimed</code>, CRM on <code>member.revealed</code></td></tr>
          </tbody>
        </table></div>
      </Panel>
      <Panel title="Room scope by mode">
        <div className="tw"><table>
          <thead><tr><th>Mode</th><th>One room per</th><th>Opens</th><th>Location from</th><th>Special</th></tr></thead>
          <tbody>
            <tr><td>Bus</td><td>Service + journey date</td><td>3 h before first boarding</td><td>VTS GPS, else on-board travellers</td><td>Rest-stop timer, wait for me</td></tr>
            <tr><td>Train</td><td>Coach + train run (after charting); train-wide room before</td><td>3 h before departure</td><td>Running status, plus travellers</td><td>Platform and coach-position alerts; members move at charting</td></tr>
            <tr><td>Flight</td><td>Flight + date</td><td>Always, or only when delayed ≥ 45 min</td><td>Flight status</td><td>Gate, boarding, belt alerts</td></tr>
          </tbody>
        </table></div>
      </Panel>
    </section>
  );
}

// =============================================================== quickstart ===
const STEPS: Record<V, [string, string][]> = {
  bus: [['Booking confirmed', 'PUT /v1/rooms/by-key/bus:{operator}:{service}:{date}'], ['Add traveller', 'POST /v1/rooms/{id}/members'], ['Bus allocated', 'PATCH /v1/rooms/{id} with scope.vehicle_no; push VTS to /location/sources'], ['Delay or breakdown', 'POST /v1/rooms/{id}/trip-events'], ['User opens My Trip', 'POST …/members/{mid}/token → open chat_url'], ['Cancelled', 'DELETE …/members/{mid}?reason=cancelled']],
  train: [['Booking confirmed', 'PUT /v1/rooms/by-key/train:{train_no}:{date} (train-wide room)'], ['Add traveller', 'POST …/members with chart_status'], ['Chart prepared', 'PUT coach rooms train:{no}:{date}:{coach}, then POST /v1/members:move reason=charting'], ['Running status', 'POST /location/sources source=running_status'], ['Platform change', 'POST /trip-events type=platform_change'], ['User opens My Trip', 'token → chat_url']],
  flight: [['Booking confirmed', 'PUT /v1/rooms/by-key/flight:{carrier}{no}:{date} with activation on_delay'], ['Add traveller', 'POST …/members (room stays dormant)'], ['Delay ≥ 45 min reported', 'POST /location/sources flight_status or /trip-events delay → room opens, push sent'], ['Gate change, boarding', 'POST /trip-events'], ['Landed', 'trip-events landed, baggage_belt → read-only after 2 h']],
};
const TENANT_FOR: Record<V, string> = { bus: 'abhibus', train: 'confirmtkt', flight: 'ixigo_flights' };
export function DevQuickstart() {
  const [v, setV] = useState<V>('bus');
  const node = `// Node 18+ · runs on YOUR backend (never ship the secret in an app)
const BASE = '${location.origin.replace(':5180', ':4100')}';
const tok = await fetch(BASE + '/v1/oauth/token', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ grant_type: 'client_credentials', client_id: process.env.TR_CLIENT_ID, client_secret: process.env.TR_CLIENT_SECRET }) })
  .then(r => r.json());
const H = { 'content-type': 'application/json', authorization: 'Bearer ' + tok.access_token };

// 1. room for the trip (idempotent)
const room = await fetch(BASE + '/v1/rooms/by-key/${v === 'bus' ? 'bus:op_sunrise:svc-4412:2026-10-06' : v === 'train' ? 'train:12785:2026-10-06:B2' : 'flight:6E512:2026-10-06'}', { method: 'PUT', headers: H,
  body: JSON.stringify(${v === 'bus' ? `{ vertical: 'bus', title: 'Hyderabad → Bengaluru', subtitle: 'Sunrise Travels · AC Sleeper',
    scope: { operator_id: 'op_sunrise', route: 'HYD-BLR' },
    schedule: { departs_at: '2026-10-06T21:30:00+05:30', arrives_at: '2026-10-07T07:00:00+05:30' },
    route: { stops: [{ code: 'AMRP', name: 'Ameerpet', lat: 17.4375, lng: 78.4483, sched_dep: '2026-10-06T21:30:00+05:30' },
                     { code: 'MJST', name: 'Bengaluru Majestic', lat: 12.9767, lng: 77.5713, sched_arr: '2026-10-07T07:00:00+05:30' }] },
    location_feed: 'vts' }` : v === 'train' ? `{ vertical: 'train', title: 'Kacheguda → Yesvantpur', subtitle: '12785 · Coach B2 · 3A',
    scope: { train_no: '12785', coach: 'B2', parent_trip_key: 'train:12785:2026-10-06' },
    schedule: { departs_at: '2026-10-06T21:00:00+05:30', arrives_at: '2026-10-07T07:30:00+05:30' },
    route: { stops: [{ code: 'KCG', name: 'Kacheguda', sched_dep: '2026-10-06T21:00:00+05:30' }, { code: 'YPR', name: 'Yesvantpur', sched_arr: '2026-10-07T07:30:00+05:30' }] },
    location_feed: 'running_status' }` : `{ vertical: 'flight', title: 'Hyderabad → Bengaluru', subtitle: 'Flight 6E 512',
    scope: { carrier: '6E', flight_no: '512' },
    schedule: { departs_at: '2026-10-06T21:50:00+05:30', arrives_at: '2026-10-06T23:05:00+05:30' },
    route: { stops: [{ code: 'HYD', name: 'Hyderabad', sched_dep: '2026-10-06T21:50:00+05:30' }, { code: 'BLR', name: 'Bengaluru', sched_arr: '2026-10-06T23:05:00+05:30' }] },
    activation: { mode: 'on_delay', min_delay_min: 45 }, location_feed: 'flight_status' }`}) }).then(r => r.json());

// 2. traveller (idempotent per external_user_id)
const { added: [me] } = await fetch(BASE + '/v1/rooms/' + room.id + '/members', { method: 'POST', headers: { ...H, 'idempotency-key': bookingId },
  body: JSON.stringify({ members: [{ external_user_id: userId, booking_ref: pnr, gender /* optional, only gates women channel */ }] }) }).then(r => r.json());

// 3. short-lived member token → hand chat_url to the app
const { chat_url } = await fetch(BASE + '/v1/rooms/' + room.id + '/members/' + me.member_id + '/token', { method: 'POST', headers: H, body: '{}' }).then(r => r.json());
return { chat_url }; // the app opens this in a WebView`;
  return (
    <section className="cmain">
      <Head title="Quickstart by mode" sub="The calls your backend makes, in order. Your app never talks to Trip Rooms except to open chat_url." right={<Seg value={v} onChange={setV} options={VT} />} />
      <Panel><div className="tw"><table><thead><tr><th>When</th><th>Call</th></tr></thead><tbody>{STEPS[v].map((s) => <tr key={s[0]}><td>{s[0]}</td><td><code style={{ color: 'var(--amber)' }}>{s[1]}</code></td></tr>)}</tbody></table></div></Panel>
      <Panel title="Copy-paste backend code"><CopyCode text={node} /></Panel>
      <Panel title="Try it for real"><p className="prose">The sandbox gets a 1-hour token for your tenant and calls the real API. Rooms you create there show up in Operations immediately.</p><a className="btn pri" href={href('/developer/sandbox')} onClick={() => sessionStorage.setItem('tr.sandbox.tenant', TENANT_FOR[v])}>Open sandbox</a></Panel>
    </section>
  );
}

// ============================================================ API reference ===
interface Ep { id: string; group: string; method: string; path: string; title: string; scope?: string; description: string; params: [string, string, string, string][]; ex: Record<string, { req?: unknown; res: unknown }> }
function useSpec() { return useData<{ endpoints: Ep[]; webhooks: [string, string][] }>('/docs/spec'); }
export function DevApi({ ep: epId }: { ep?: string }) {
  const s = useSpec();
  const [v, setV] = useState<V>('bus');
  const { can } = useAuth();
  if (s.error) return <section className="cmain"><ErrorBox msg={s.error} /></section>;
  if (!s.data) return <section className="cmain"><Loading /></section>;
  const eps = s.data.endpoints;
  const ep = eps.find((e) => e.id === epId) ?? eps[0];
  const groups = [...new Set(eps.map((e) => e.group))];
  const ex = ep.ex.all ?? ep.ex[v] ?? ep.ex.bus ?? Object.values(ep.ex)[0];
  return (
    <section className="cmain">
      <div className="doc">
        <div className="eplist">{groups.map((g) => <div key={g} style={{ display: 'contents' }}><div className="g">{g}</div>{eps.filter((e) => e.group === g).map((e) => (
          <button key={e.id} type="button" aria-pressed={e.id === ep.id} onClick={() => go(`/developer/api/${e.id}`)}><span className={`mth m-${e.method}`}>{e.method}</span>{e.title}</button>
        ))}</div>)}</div>
        <div className="stack">
          <Panel>
            <div className="fil" style={{ marginBottom: 8 }}><span className={`mth m-${ep.method}`} style={{ fontSize: '.8rem' }}>{ep.method}</span><span className="ep-path">{ep.path}</span>{ep.scope && <Chip tone="c-info">scope {ep.scope}</Chip>}</div>
            <h2 style={{ font: '700 1.15rem var(--f-display)', margin: '0 0 6px' }}>{ep.title}</h2>
            <div className="prose"><p>{ep.description}</p></div>
            {can('sandbox.use') && ep.method !== 'WSS' && <Btn sm onClick={() => { sessionStorage.setItem('tr.sandbox.preset', JSON.stringify({ method: ep.method, path: ep.path, body: ex?.req && typeof ex.req === 'object' ? ex.req : undefined })); go('/developer/sandbox'); }}>Try this in the sandbox →</Btn>}
          </Panel>
          {ep.params.length > 0 && <div className="tw"><table><thead><tr><th>Field</th><th>Type</th><th>Required</th><th>Notes</th></tr></thead><tbody>{ep.params.map((p) => <tr key={p[0]}><td><code style={{ color: 'var(--amber)' }}>{p[0]}</code></td><td>{p[1]}</td><td>{p[2]}</td><td className="hint">{p[3]}</td></tr>)}</tbody></table></div>}
          {!ep.ex.all && Object.keys(ep.ex).length > 1 && <Seg value={v} onChange={setV} options={VT.filter(([k]) => ep.ex[k]).map(([k, l]) => [k, `${l} example`])} />}
          {ex && <div className="g2">{ex.req !== undefined && <div><div className="lbl" style={{ marginBottom: 6 }}>Request</div><Code value={ex.req} /></div>}<div><div className="lbl" style={{ marginBottom: 6 }}>Response</div><Code value={ex.res} /></div></div>}
        </div>
      </div>
    </section>
  );
}

// ================================================================= webhooks ===
const VERIFY = `// Node / Express — verify every delivery before trusting it
import crypto from 'node:crypto';
app.post('/trip-rooms/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.header('x-triprooms-signature') ?? '';           // "t=1791279938,v1=ab12…"
  const { t, v1 } = Object.fromEntries(sig.split(',').map(p => p.split('=')));
  const expected = crypto.createHmac('sha256', process.env.TR_WEBHOOK_SECRET)
    .update(\`\${t}.\${req.body}\`).digest('hex');
  const fresh = Math.abs(Date.now() / 1000 - Number(t)) < 300;     // 5-min replay window
  if (!fresh || !crypto.timingSafeEqual(Buffer.from(v1 ?? ''), Buffer.from(expected))) return res.sendStatus(400);
  const event = JSON.parse(req.body);                                // { id, type, created_at, tenant, data }
  queue.push(event);                                                 // dedupe on event.id, then work async
  res.sendStatus(200);                                               // reply 2xx within 5 s
});`;
export function DevWebhooks() {
  const { can, tenants } = useAuth();
  const s = useSpec();
  const hooks = useData<{ data: any[]; events: [string, string][] }>(can('webhooks.manage') ? '/webhooks' : null);
  const ev = useData<{ data: any[] }>(can('events.read') ? '/events' : null, { query: { limit: 25 }, refreshOn: ['*'] });
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<any>(null);
  const { busy, run } = useAction();
  const evNames = (s.data?.webhooks ?? []).flatMap(([n]) => n.split(' / ').map((x) => x.trim()));
  return (
    <section className="cmain">
      <Head title="Webhooks" sub="Signed POSTs to your endpoint. Verify X-TripRooms-Signature (t=timestamp, v1=HMAC-SHA256 of “t.body” with your secret). Reply 2xx within 5 s; we retry with backoff for 24 hours." right={can('webhooks.manage') && <Btn kind="pri" onClick={() => setAdding(true)}>Add endpoint</Btn>} />
      {can('webhooks.manage') && <Panel title="Your endpoints">
        {!hooks.data ? <Loading /> : !hooks.data.data.length ? <Empty>No endpoints yet.</Empty> : <div className="tw"><table>
          <thead><tr><th>App</th><th>URL</th><th>Events</th><th /></tr></thead>
          <tbody>{hooks.data.data.map((w) => (
            <tr key={w.id}><td>{tenants.find((t) => t.id === w.tenant)?.name ?? w.tenant}</td><td><code>{w.url}</code><small>{w.id}</small></td><td><small>{w.events.join(', ')}</small></td>
              <td><div className="fil">
                <Btn sm busy={busy === `t${w.id}`} onClick={() => run(`t${w.id}`, () => api<any>(`/webhooks/${w.id}/test`, { body: {} }), (r: any) => r.ok ? `Test delivered · HTTP ${r.status}` : `Test failed · HTTP ${r.status || 'no response'}`)}>Send test</Btn>
                <Btn sm kind="danger" onClick={() => confirm('Delete this endpoint?') && run(`d${w.id}`, () => api(`/webhooks/${w.id}`, { method: 'DELETE' }), 'Deleted').then(hooks.reload)}>Delete</Btn>
              </div></td></tr>
          ))}</tbody>
        </table></div>}
      </Panel>}
      <div className="two">
        <div className="tw"><table><thead><tr><th>Event</th><th>Notes</th></tr></thead><tbody>{(s.data?.webhooks ?? []).map((h) => <tr key={h[0]}><td><code style={{ color: 'var(--amber)' }}>{h[0]}</code></td><td className="hint">{h[1]}</td></tr>)}</tbody></table></div>
        <div className="stack">
          <div><div className="lbl" style={{ marginBottom: 6 }}>Example: sos.raised</div><Code value={{ id: 'evt_9a1', type: 'sos.raised', created_at: '2026-10-06T22:31:04+05:30', tenant: 'abhibus', data: { action_id: 'act_1', room_id: 'room_9f2k1', trip_key: 'bus:op_sunrise:svc-4412:2026-10-06', member_id: 'mem_3kd9', external_user_id: 'abhi_u_88213', booking_ref: 'ABX7F3K21', reason: 'I feel unsafe', location: { lat: 17.4421, lng: 78.3611, accuracy_m: 20 } } }} /></div>
          <div><div className="lbl" style={{ marginBottom: 6 }}>Verify the signature</div><CopyCode text={VERIFY} /></div>
          {can('events.read') && <Panel title="Live deliveries"><div className="log">{(ev.data?.data ?? []).map((e) => {
            const last = (e.deliveries ?? []).slice(-1)[0];
            return <div key={e.id} className={!last ? '' : last.ok ? 'ok' : 'no'}>{e.type} · {tenants.find((t) => t.id === e.tenant)?.name ?? 'platform'} · {last ? `${last.ok ? 'delivered' : 'failed'} HTTP ${last.status} (attempt ${last.attempt})` : 'no subscriber'} · {ago(e.created_at)}</div>;
          })}</div></Panel>}
        </div>
      </div>
      {adding && <NewWebhook events={evNames} onClose={() => setAdding(false)} onDone={(r) => { setCreated(r); setAdding(false); hooks.reload(); }} />}
      {created && <Modal title="Endpoint added" onClose={() => setCreated(null)}><SecretOnce label="Signing secret" value={created.secret} note={created.note} /></Modal>}
    </section>
  );
}
function NewWebhook({ events, onClose, onDone }: { events: string[]; onClose: () => void; onDone: (r: any) => void }) {
  const { tenants } = useAuth();
  const [tenant, setTenant] = useState(tenants[0]?.id ?? '');
  const [url, setUrl] = useState('https://');
  const [sel, setSel] = useState<string[]>(['sos.raised', 'issue.escalated', 'wait_request.raised', 'notification.requested', 'voucher.claimed']);
  const { busy, run } = useAction();
  return (
    <Modal title="Add webhook endpoint" onClose={onClose} wide>
      <div className="f" style={{ gap: 10 }}>
        <div className="frow"><Field label="App"><select value={tenant} onChange={(e) => setTenant(e.target.value)}>{tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field><Field label="HTTPS URL"><input value={url} onChange={(e) => setUrl(e.target.value)} /></Field></div>
        <Field label="Events" hint="Use * for everything, or room.* for a family."><div className="checks">{['*', ...events.filter((e) => !e.includes('<'))].map((e) => <label key={e}><input type="checkbox" checked={sel.includes(e)} onChange={() => setSel((x) => x.includes(e) ? x.filter((y) => y !== e) : [...x, e])} /> <code>{e}</code></label>)}</div></Field>
        <div><Btn kind="pri" busy={busy === 'w'} disabled={!sel.length} onClick={async () => { const r = await run('w', () => api('/webhooks', { body: { tenant, url, events: sel } })); if (r) onDone(r); }}>Add endpoint</Btn></div>
      </div>
    </Modal>
  );
}

// ====================================================================== SDK ===
export function DevSdk() {
  const chat = 'chat_url'; // from POST …/members/{mid}/token
  const rn = `// React Native (AbhiBus, ixigo apps) — npm i react-native-webview
import { WebView } from 'react-native-webview';

export function TripChat({ chatUrl, onClose }) {      // chatUrl = token response .${chat}
  return (
    <WebView
      source={{ uri: chatUrl }}
      geolocationEnabled                               // live location sharing (opt-in inside the room)
      mediaPlaybackRequiresUserAction
      onMessage={(e) => {
        const ev = JSON.parse(e.nativeEvent.data);    // { type: 'tr:ready' | 'tr:unread' | 'tr:close' | 'tr:token_expired' | 'tr:sos', ... }
        if (ev.type === 'tr:close') onClose();
        if (ev.type === 'tr:token_expired') refreshTokenFromYourBackend();
        if (ev.type === 'tr:unread') setBadge(ev.count);
      }}
    />
  );
}`;
  const android = `// Android (Kotlin) — ConfirmTkt
val web = WebView(this).apply {
  settings.javaScriptEnabled = true
  settings.domStorageEnabled = true
  settings.setGeolocationEnabled(true)
  addJavascriptInterface(object {
    @JavascriptInterface fun postMessage(json: String) { handleTripRoomsEvent(JSONObject(json)) }
  }, "TripRoomsHost")
}
web.loadUrl(chatUrl)   // from your backend: POST /v1/rooms/{id}/members/{mid}/token → chat_url`;
  const ios = `// iOS (Swift) — WKWebView
let cfg = WKWebViewConfiguration()
cfg.userContentController.add(handler, name: "TripRoomsHost")   // receives tr:* events
let web = WKWebView(frame: view.bounds, configuration: cfg)
web.load(URLRequest(url: URL(string: chatUrl)!))`;
  const web = `<!-- Web (abhibus.com, ixigo.com) -->
<iframe src="{chat_url}" allow="geolocation; camera; clipboard-write"
        style="width:100%;height:100%;border:0"></iframe>
<script>
  window.addEventListener('message', (e) => {
    if (e.origin !== new URL(chatUrl).origin) return;
    if (e.data?.type === 'tr:unread') badge(e.data.count);
  });
</script>`;
  return (
    <section className="cmain">
      <Head title="Hosted chat screen" sub="Drop the room into any app with one WebView. Realtime, offline retries, location consent, games, polls, Tara and every safety rule are inside the screen — you don’t build or maintain any of it." />
      <Panel title="How the screen gets your look and rules">
        <div className="flow"><span className="s">member token</span><span className="a">→</span><span className="s">GET /chat/v1/session</span><span className="a">→</span><span className="s">tenant theme (brand colour, logo text)</span><span className="a">+</span><span className="s">features & identity mode</span><span className="a">+</span><span className="s">room snapshot</span></div>
        <p className="hint" style={{ marginTop: 8 }}>Change colours, features or identity mode in Tenants &amp; config; open rooms pick it up on next open. Tokens are room-scoped and short-lived — mint one each time the user taps “Trip chat”.</p>
      </Panel>
      <div className="g2"><CopyCode text={rn} /><CopyCode text={android} /></div>
      <div className="g2"><CopyCode text={ios} /><CopyCode text={web} /></div>
      <Panel title="Events the screen sends to your app">
        <div className="tw"><table><thead><tr><th>Event</th><th>When</th></tr></thead><tbody>
          <tr><td><code>tr:ready</code></td><td>Room loaded</td></tr>
          <tr><td><code>tr:unread</code> &#123;count&#125;</td><td>Unread count changed (badge your “Trip chat” button)</td></tr>
          <tr><td><code>tr:close</code></td><td>Traveller tapped back / exit — close the WebView</td></tr>
          <tr><td><code>tr:token_expired</code></td><td>Mint a new token and reload</td></tr>
          <tr><td><code>tr:sos</code></td><td>SOS raised (you also get the <code>sos.raised</code> webhook)</td></tr>
        </tbody></table></div>
      </Panel>
      <Panel title="What the screen always enforces">
        <div className="prose"><p>No private DMs between travellers, no links or photos from travellers, automatic masking of phone numbers and IDs, report and mute, majority-report removal, private SOS, opt-in live location that stops at the drop point, quiet hours, women-only channel gated by the gender you send.</p></div>
      </Panel>
    </section>
  );
}

// ========================================================== tenants & config ===
export function DevConfig({ tenant: tParam }: { tenant?: string }) {
  const { tenants, can, refreshTenants } = useAuth();
  const t = tParam ?? tenants[0]?.id;
  const d = useData<any>(t ? `/config/${t}` : null);
  const [cfg, setCfg] = useState<any>(null);
  const [theme, setTheme] = useState<any>(null);
  const { busy, run } = useAction();
  useEffect(() => { if (d.data) { setCfg(structuredClone(d.data.config)); setTheme({ ...d.data.theme }); } }, [d.data]);
  const ro = !can('config.write');
  const dirty = d.data && cfg && (JSON.stringify(cfg) !== JSON.stringify(d.data.config) || JSON.stringify(theme) !== JSON.stringify(d.data.theme));
  const set = (path: string, v: any) => setCfg((c: any) => { const n = structuredClone(c); const ks = path.split('.'); let o = n; ks.slice(0, -1).forEach((k) => (o = o[k])); o[ks[ks.length - 1]] = v; return n; });
  const numIn = (path: string, label: string, hint?: string) => { const v = path.split('.').reduce((o, k) => o?.[k], cfg); return <Field label={label} hint={hint}><input type="number" className="num-in" disabled={ro} value={v} onChange={(e) => set(path, Number(e.target.value))} /></Field>; };
  return (
    <section className="cmain">
      <Head title="Tenants & config" sub="Per-app defaults. Rooms can still override features through the API. Saved changes apply to open rooms within seconds."
        right={<Seg value={t ?? ''} onChange={(x) => go(`/developer/config/${x}`)} options={tenants.map((x) => [x.id, x.name])} />} />
      {d.error ? <ErrorBox msg={d.error} /> : !cfg || !theme ? <Loading /> : <>
        <div className="split"><span className="hint">Config version <b>v{d.data.version}</b> · modes: {d.data.verticals.join(', ')}</span>
          {!ro && <div className="fil"><Btn kind="ghost" disabled={!dirty} onClick={() => { setCfg(structuredClone(d.data.config)); setTheme({ ...d.data.theme }); }}>Discard</Btn><Btn kind="pri" disabled={!dirty} busy={busy === 's'} onClick={() => run('s', () => api<any>(`/config/${t}`, { method: 'PATCH', body: { config: cfg, theme } }), (r: any) => `Saved · v${r.version}`).then(() => { d.reload(); void refreshTenants(); })}>Save changes</Btn></div>}
        </div>
        <div className="two">
          <Panel title="Features">
            <div className="cfg-grid">{Object.entries(d.data.feature_labels as Record<string, string>).map(([k, l]) => (
              <div key={k} className="tog"><span>{l}</span><Switch on={!!cfg.features[k]} disabled={ro} label={l} onChange={(v) => set(`features.${k}`, v)} /></div>
            ))}</div>
          </Panel>
          <div className="stack">
            <Panel title="Brand (chat screen)">
              <div className="frow">
                <Field label="Brand colour"><input type="color" disabled={ro} value={theme.brand} onChange={(e) => setTheme({ ...theme, brand: e.target.value })} style={{ height: 38, padding: 2 }} /></Field>
                <Field label="Text on brand"><input type="color" disabled={ro} value={theme.brandInk} onChange={(e) => setTheme({ ...theme, brandInk: e.target.value })} style={{ height: 38, padding: 2 }} /></Field>
                <Field label="Logo text"><input disabled={ro} value={theme.logoText ?? ''} maxLength={30} onChange={(e) => setTheme({ ...theme, logoText: e.target.value })} /></Field>
              </div>
              <div className="ph-app" style={{ background: theme.brand, color: theme.brandInk, borderRadius: 10, marginTop: 10 }}><span>‹</span><b>{theme.logoText || d.data.name}</b><small>Trip chat</small></div>
            </Panel>
            <Panel title="Identity">
              <Seg value={cfg.identity.mode} onChange={(v) => !ro && set('identity.mode', v)} options={[['handle', 'Random handles (private)'], ['profile', 'Profile names & avatars']]} />
              <p className="hint" style={{ marginTop: 8 }}>{cfg.identity.mode === 'handle' ? 'Travellers appear as “Quiet Tiger 🐯”. Nobody sees names, numbers, gender or seats.' : 'Travellers pick a first name and avatar the first time they open the room.'}</p>
            </Panel>
            <Panel title="Timing & quiet hours">
              <div className="frow">{numIn('timing.open_before_min', 'Opens before departure (min)')}{numIn('timing.readonly_after_min', 'Read-only after arrival (min)')}{numIn('timing.purge_days', 'Purge after (days)')}</div>
              <div className="frow">
                <Field label="Quiet from (IST)"><input type="time" disabled={ro} value={cfg.quiet.from} onChange={(e) => set('quiet.from', e.target.value)} /></Field>
                <Field label="Quiet to (IST)"><input type="time" disabled={ro} value={cfg.quiet.to} onChange={(e) => set('quiet.to', e.target.value)} /></Field>
              </div>
            </Panel>
          </div>
        </div>
        <div className="two">
          <Panel title="Ad rules">
            <div className="frow">{numIn('ads.gap_min', 'Min gap between ads (min)')}{numIn('ads.max_per_trip', 'Max ads per trip')}{numIn('ads.block_after_alert_min', 'Pause after an Ops alert (min)')}</div>
          </Panel>
          <Panel title="Safety & moderation">
            <div className="frow">{numIn('social_min', 'Chat unlocks at (travellers)', 'Below this the room is alerts-only')}{numIn('slow_mode_sec', 'Slow mode gap (sec)', 'Only when Ops turns slow mode on')}{numIn('report_hide_at', 'Hide message after (reports)')}{numIn('issue_escalate_at', 'Escalate issue after (me-toos)')}</div>
            <div className="frow">
              <Field label="Support phone"><input disabled={ro} value={cfg.support.phone ?? ''} onChange={(e) => set('support.phone', e.target.value || null)} /></Field>
              <Field label="@ mention handle"><input disabled={ro} value={cfg.support.care_handle} onChange={(e) => set('support.care_handle', e.target.value)} /></Field>
            </div>
          </Panel>
        </div>
      </>}
    </section>
  );
}

// ================================================================= API keys ===
export function DevKeys() {
  const { tenants } = useAuth();
  const d = useData<{ data: any[]; scopes: string[] }>('/keys');
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<any>(null);
  const { busy, run } = useAction();
  return (
    <section className="cmain">
      <Head title="API keys" sub="Client credentials for your backend. Secrets are hashed; we show them once. Rotate any time — the old secret stops working immediately." right={<Btn kind="pri" onClick={() => setAdding(true)}>Create key</Btn>} />
      {d.error ? <ErrorBox msg={d.error} /> : !d.data ? <Loading /> : (
        <div className="tw"><table>
          <thead><tr><th>Name</th><th>App</th><th>Client ID</th><th>Secret</th><th>Scopes</th><th>Last used</th><th /></tr></thead>
          <tbody>{d.data.data.map((k) => (
            <tr key={k.id} style={k.revoked_at ? { opacity: 0.5 } : undefined}>
              <td><b>{k.name}</b><small>by {k.created_by ?? 'seed'} · {ago(k.created_at)}</small></td>
              <td>{tenants.find((t) => t.id === k.tenant)?.name ?? k.tenant}</td>
              <td><code>{k.client_id}</code></td><td><code>{k.secret_hint}</code></td>
              <td><small>{k.scopes.join(' ')}</small></td>
              <td className="num">{k.last_used_at ? ago(k.last_used_at) : 'never'}</td>
              <td>{k.revoked_at ? <Chip tone="c-crit">revoked</Chip> : <div className="fil">
                <Btn sm busy={busy === `r${k.id}`} onClick={() => confirm('Rotate? The current secret stops working now.') && run(`r${k.id}`, () => api(`/keys/${k.id}/rotate`, { body: {} })).then((r) => { if (r) { setSecret(r); d.reload(); } })}>Rotate</Btn>
                <Btn sm kind="danger" onClick={() => confirm('Revoke this key? Calls using it will fail.') && run(`x${k.id}`, () => api(`/keys/${k.id}`, { method: 'DELETE' }), 'Revoked').then(d.reload)}>Revoke</Btn>
              </div>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {adding && d.data && <NewKey scopes={d.data.scopes} onClose={() => setAdding(false)} onDone={(r) => { setAdding(false); setSecret(r); d.reload(); }} />}
      {secret && <Modal title="Copy your secret now" onClose={() => setSecret(null)}>
        <div className="f" style={{ gap: 10 }}><Field label="Client ID"><code>{secret.client_id}</code></Field><SecretOnce label="Client secret" value={secret.client_secret} note={secret.note} /><p className="hint">Store it in your secret manager. Never put it in an app bundle.</p></div>
      </Modal>}
    </section>
  );
}
function NewKey({ scopes, onClose, onDone }: { scopes: string[]; onClose: () => void; onDone: (r: any) => void }) {
  const { tenants } = useAuth();
  const [tenant, setTenant] = useState(tenants[0]?.id ?? '');
  const [name, setName] = useState('Production backend');
  const [sel, setSel] = useState<string[]>(['rooms:write', 'rooms:read', 'members:write', 'announcements:write', 'location:write']);
  const { busy, run } = useAction();
  return (
    <Modal title="Create API key" onClose={onClose}>
      <div className="f" style={{ gap: 10 }}>
        <Field label="App"><select value={tenant} onChange={(e) => setTenant(e.target.value)}>{tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Scopes" hint="Give each backend only what it needs."><div className="checks">{scopes.map((s) => <label key={s}><input type="checkbox" checked={sel.includes(s)} onChange={() => setSel((x) => x.includes(s) ? x.filter((y) => y !== s) : [...x, s])} /> <code>{s}</code></label>)}</div></Field>
        <div><Btn kind="pri" busy={busy === 'k'} disabled={!name || !sel.length} onClick={async () => { const r = await run('k', () => api('/keys', { body: { tenant, name, scopes: sel } })); if (r) onDone(r); }}>Create</Btn></div>
      </div>
    </Modal>
  );
}

// ================================================================== sandbox ===
const PRESETS: { label: string; method: string; path: string; body?: unknown }[] = [
  { label: 'List live rooms', method: 'GET', path: '/v1/rooms?state=open,onboard' },
  { label: 'Create a bus room', method: 'PUT', path: '/v1/rooms/by-key/bus:op_sandbox:svc-1:{today}', body: { vertical: 'bus', title: 'Hyderabad → Vijayawada', subtitle: 'Sandbox Travels · AC Seater', scope: { operator_id: 'op_sandbox', route: 'HYD-VJA' }, schedule: { departs_at: '{now-20m}', arrives_at: '{now+5h}' }, route: { stops: [{ code: 'HYD', name: 'Hyderabad', lat: 17.385, lng: 78.4867, sched_dep: '{now-20m}', type: 'boarding' }, { code: 'SRPT', name: 'Suryapet', lat: 17.14, lng: 79.62, sched_arr: '{now+2h}', type: 'rest_stop' }, { code: 'VJA', name: 'Vijayawada', lat: 16.5062, lng: 80.648, sched_arr: '{now+5h}', type: 'dropping' }] }, location_feed: 'vts' } },
  { label: 'Add a traveller', method: 'POST', path: '/v1/rooms/{room_id}/members', body: { members: [{ external_user_id: 'sandbox_user_1', booking_ref: 'SBX1001', gender: 'F' }] } },
  { label: 'Mint member token', method: 'POST', path: '/v1/rooms/{room_id}/members/{member_id}/token', body: { ttl_sec: 3600 } },
  { label: 'Report a 25-min delay', method: 'POST', path: '/v1/rooms/{room_id}/trip-events', body: { type: 'delay', minutes: 25, reason: 'heavy traffic', channels: ['push'] } },
  { label: 'Post an Ops alert', method: 'POST', path: '/v1/rooms/{room_id}/announcements', body: { text: 'Water and snacks at the next stop.', severity: 'info' } },
  { label: 'Push VTS location', method: 'POST', path: '/v1/rooms/{room_id}/location/sources', body: { source: 'vts', points: [{ lat: 17.3, lng: 78.9, speed_kmph: 62 }] } },
  { label: 'Get best location', method: 'GET', path: '/v1/rooms/{room_id}/location' },
  { label: 'Start a poll', method: 'POST', path: '/v1/rooms/{room_id}/polls', body: { question: 'Dinner stop: dhaba or food court?', options: ['Dhaba', 'Food court'] } },
  { label: 'List open actions', method: 'GET', path: '/v1/actions?status=open' },
];
const fill = (s: string, vars: Record<string, string>) => s
  .replace(/\{today\}/g, new Date().toISOString().slice(0, 10))
  .replace(/\{now([+-]\d+)([mh])\}/g, (_m, n, u) => new Date(Date.now() + Number(n) * (u === 'h' ? 3600_000 : 60_000)).toISOString())
  .replace(/\{(room_id|member_id)\}/g, (m, k) => vars[k] ?? m);

export function DevSandbox() {
  const { tenants } = useAuth();
  const toast = useToast();
  const [tenant, setTenant] = useState(() => sessionStorage.getItem('tr.sandbox.tenant') ?? tenants[0]?.id ?? '');
  const [tok, setTok] = useState<{ access_token: string; at: number } | null>(null);
  const [method, setMethod] = useState('GET');
  const [path, setPath] = useState('/v1/rooms?state=open,onboard');
  const [body, setBody] = useState('');
  const [vars, setVars] = useState<Record<string, string>>({});
  const [res, setRes] = useState<{ status: number; ms: number; data: any } | null>(null);
  const [sending, setSending] = useState(false);
  useEffect(() => { setTok(null); }, [tenant]);
  useEffect(() => {
    const p = sessionStorage.getItem('tr.sandbox.preset');
    if (p) { sessionStorage.removeItem('tr.sandbox.preset'); const x = JSON.parse(p); load(x); }
  }, []); // eslint-disable-line
  const load = (p: { method: string; path: string; body?: unknown }) => { setMethod(p.method); setPath(p.path); setBody(p.body ? JSON.stringify(p.body, null, 2) : ''); setRes(null); };
  const token = async () => {
    if (tok && Date.now() - tok.at < 50 * 60_000) return tok.access_token;
    const r = await api<{ access_token: string }>('/sandbox/token', { body: { tenant } });
    setTok({ access_token: r.access_token, at: Date.now() });
    return r.access_token;
  };
  const send = async () => {
    setSending(true);
    try {
      const t = await token();
      const p = fill(path, vars), b = body.trim() ? fill(body, vars) : undefined;
      if (b) { try { JSON.parse(b); } catch { toast('Body isn’t valid JSON.', 'err'); return; } }
      const r = await rawCall(method, p, t, b);
      setRes(r);
      const d: any = r.data;
      const nv = { ...vars };
      if (d?.id?.startsWith?.('room_')) nv.room_id = d.id;
      if (d?.added?.[0]?.member_id) nv.member_id = d.added[0].member_id;
      setVars(nv);
    } catch (e: any) { toast(e.message, 'err'); } finally { setSending(false); }
  };
  const curl = `curl -X ${method} '${location.origin.replace(':5180', ':4100')}${fill(path, vars)}' \\\n  -H 'authorization: Bearer $TOKEN'${body.trim() ? ` \\\n  -H 'content-type: application/json' \\\n  -d '${fill(body, vars).replace(/\n\s*/g, ' ')}'` : ''}`;
  const chatUrl = res?.data?.chat_url as string | undefined;
  return (
    <section className="cmain">
      <Head title="Try it (sandbox)" sub="Real calls to the real API with a 1-hour token for the chosen app. Run the presets top to bottom: room → traveller → token → open the chat screen." right={<select className="tsel" value={tenant} onChange={(e) => setTenant(e.target.value)}>{tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>} />
      <div className="two">
        <div className="stack">
          <Panel title="Request">
            <div className="f" style={{ gap: 8 }}>
              <div className="fil"><select value={method} onChange={(e) => setMethod(e.target.value)} style={{ width: 110 }}>{['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m}>{m}</option>)}</select><input value={path} onChange={(e) => setPath(e.target.value)} style={{ flex: 1, fontFamily: 'var(--f-mono)' }} /></div>
              {method !== 'GET' && <textarea value={body} onChange={(e) => setBody(e.target.value)} style={{ minHeight: 220, fontFamily: 'var(--f-mono)', fontSize: '.78rem' }} placeholder="{ }" />}
              <div className="fil"><Btn kind="pri" busy={sending} onClick={send}>Send</Btn>{Object.entries(vars).map(([k, v]) => <span key={k} className="pill">{k} = <code>{v}</code></span>)}</div>
            </div>
          </Panel>
          <Panel title="Presets">
            <div className="fil">{PRESETS.map((p) => <Btn key={p.label} sm onClick={() => load(p)}><span className={`mth m-${p.method}`}>{p.method}</span>{p.label}</Btn>)}</div>
            <p className="hint" style={{ marginTop: 8 }}><code>{'{room_id}'}</code> and <code>{'{member_id}'}</code> fill in from earlier responses.</p>
          </Panel>
          <Panel title="Same call with curl"><CopyCode text={curl} /></Panel>
        </div>
        <Panel title={res ? <>Response · <span style={{ color: res.status < 300 ? 'var(--teal)' : 'var(--rose)' }}>HTTP {res.status || 'no response'}</span> · {res.ms} ms</> : 'Response'}>
          {res ? <><Code value={res.data} max={620} />{chatUrl && <div className="fil" style={{ marginTop: 10 }}><a className="btn pri" href={chatUrl} target="_blank" rel="noreferrer">Open the chat screen as this traveller ↗</a></div>}{res.data?.id?.startsWith?.('room_') && <div className="fil" style={{ marginTop: 10 }}><a className="btn" href={href(`/ops/rooms/${res.data.id}`)}>See it in Operations →</a></div>}</> : <Empty>Pick a preset and press Send.</Empty>}
        </Panel>
      </div>
    </section>
  );
}

// =============================================================== event log ===
export function DevEvents() {
  const { tenantName } = useAuth();
  const [type, setType] = useState('');
  const d = useData<{ data: any[] }>('/events', { query: { limit: 150 }, refreshOn: ['*'] });
  const [open, setOpen] = useState<any>(null);
  const rows = (d.data?.data ?? []).filter((e) => !type || e.type.startsWith(type));
  const types = useMemo(() => [...new Set((d.data?.data ?? []).map((e) => e.type.split('.')[0]))].sort(), [d.data]);
  return (
    <section className="cmain">
      <Head title="Event log" sub="Every platform event, newest first, with webhook delivery attempts. Streams live." right={<select className="tsel" value={type} onChange={(e) => setType(e.target.value)}><option value="">All events</option>{types.map((t) => <option key={t} value={`${t}.`}>{t}.*</option>)}</select>} />
      {d.error ? <ErrorBox msg={d.error} /> : !d.data ? <Loading /> : (
        <div className="tw"><table>
          <thead><tr><th>When</th><th>Event</th><th>App</th><th>Room</th><th>Webhook</th><th /></tr></thead>
          <tbody>{rows.map((e) => {
            const last = (e.deliveries ?? []).slice(-1)[0];
            return (
              <tr key={e.id}><td className="num">{fmtTime(e.created_at)}</td><td><code style={{ color: 'var(--amber)' }}>{e.type}</code></td><td>{tenantName(e.tenant)}</td>
                <td>{e.room ? <a className="lnk" href={href(`/ops/rooms/${e.room}`)}>{e.room}</a> : '—'}</td>
                <td>{last ? <Chip tone={last.ok ? 'c-ok' : 'c-warn'}>{last.ok ? `${last.status}` : `failed ${last.status || '—'}`} · try {last.attempt}</Chip> : <span className="hint">—</span>}</td>
                <td><Btn sm kind="ghost" onClick={() => setOpen(e)}>Payload</Btn></td></tr>
            );
          })}</tbody>
        </table></div>
      )}
      {open && <Modal title={open.type} onClose={() => setOpen(null)} wide><Code value={{ id: open.id, type: open.type, created_at: open.created_at, tenant: open.tenant, data: open.data }} /><div className="lbl" style={{ margin: '10px 0 6px' }}>Deliveries</div><Code value={open.deliveries ?? []} /></Modal>}
    </section>
  );
}

// ========================================================= errors & limits ===
export function DevErrors() {
  const ERR: [string, number, string][] = [
    ['invalid_request', 400, 'Body or query failed validation. The message names the field.'], ['unauthorized', 401, 'Missing/expired token. Get a new one from /v1/oauth/token.'],
    ['forbidden', 403, 'Token lacks the scope, or the room belongs to another app.'], ['feature_disabled', 403, 'Feature is off for this app or room (Tenants & config).'],
    ['not_found', 404, 'Unknown id, or not visible to your app.'], ['room_state', 409, 'Action not allowed in the room’s current state (e.g. posting to a closed room).'],
    ['trip_key_conflict', 409, 'trip_key already used for a different mode.'], ['moderation_blocked', 422, 'Message blocked by the safety filter (phone numbers, links, abuse).'],
    ['rate_limited', 429, 'Slow down. Honour Retry-After.'], ['internal', 500, 'Our fault. Safe to retry with the same Idempotency-Key.'],
  ];
  return (
    <section className="cmain">
      <Head title="Errors & limits" sub="Every error has the same shape: { error: { code, message, details? } }." />
      <div className="tw"><table><thead><tr><th>Code</th><th>HTTP</th><th>Meaning</th></tr></thead><tbody>{ERR.map((e) => <tr key={e[0]}><td><code style={{ color: 'var(--amber)' }}>{e[0]}</code></td><td className="num">{e[1]}</td><td className="hint">{e[2]}</td></tr>)}</tbody></table></div>
      <div className="two">
        <Panel title="Rate limits"><div className="tw"><table><thead><tr><th>What</th><th>Limit</th></tr></thead><tbody>
          <tr><td>Tenant API (per key)</td><td className="num">50 req/s, burst 100</td></tr>
          <tr><td>Broadcasts</td><td className="num">10 per minute</td></tr>
          <tr><td>Traveller messages</td><td className="num">burst 8, then ~1 per 1.25 s</td></tr>
          <tr><td>Reactions</td><td className="num">burst 20, 2/s</td></tr>
          <tr><td>Reports</td><td className="num">5, then 1 per minute</td></tr>
          <tr><td>SOS / wait / lost / issue</td><td className="num">4, then 1 per 30 s</td></tr>
          <tr><td>Dashboard sign-in</td><td className="num">8 tries, then 1 per 30 s</td></tr>
        </tbody></table></div></Panel>
        <Panel title="Good citizenship">
          <div className="prose"><p><b>Idempotency.</b> PUT by-key and member adds are naturally idempotent. Send <code>Idempotency-Key</code> on other POSTs; replays within 24 h return the first response.</p><p><b>Tokens.</b> Tenant tokens last 1 h — cache and refresh. Member tokens are room-scoped and never outlive the room’s purge time.</p><p><b>Webhooks.</b> Dedupe on <code>event.id</code>. Deliveries can arrive out of order.</p><p><b>Privacy.</b> Never send names or phone numbers. Send IDs and booking refs; Ops reveals them only with a logged reason.</p></div>
        </Panel>
      </div>
    </section>
  );
}
