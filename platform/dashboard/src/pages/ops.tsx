import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useData } from '../lib/live';
import { go, href, useQuery } from '../lib/router';
import { ago, fmtTime, num, roomRef, SEV_COLOR, SEV_TONE, SEV_WORD, STATE_LABEL, STATE_TONE, TENANT_DOT, UNIT } from '../lib/format';
import { Btn, Chip, Empty, ErrorBox, Field, Head, Loading, Modal, Panel, Ref, Seg, useAction } from '../components/ui';
import { MadeByLine, ResponsesView } from '../components/Responses';

export const ROOM_EVENTS = ['room.', 'member.', 'trip_event.', 'announcement.', 'action.', 'sos.', 'issue.', 'wait_request.', 'location.', 'message.', 'lost_found.', 'voucher.', 'poll.', 'care.', 'bot.', 'ad.', 'game.'];
const CONF_TONE: Record<string, string> = { high: 'c-ok', medium: 'c-warn', estimated: 'c-mute' };

// =============================================================== rooms list ===
const DEPARTS: [string, string][] = [['next2h', 'Departing in the next 2 hours'], ['departed', 'Already departed'], ['early', 'Early (12–5 am)'], ['morning', 'Morning (5 am–12 pm)'], ['afternoon', 'Afternoon (12–5 pm)'], ['evening', 'Evening (5–9 pm)'], ['night', 'Night (9 pm–12 am)']];
type Facet = { value: string; n: number };

/**
 * Live rooms, findable at real scale (a busy corridor runs 50+ buses a night): search, then narrow
 * by operator, from, to, departure time and status. Options come from the trips that exist, with
 * counts that react to the other filters. Filters live in the URL, so a view can be shared.
 */
export function OpsRooms() {
  const { tenant, tenantName } = useAuth();
  const [qs, setQs] = useQuery();
  const f = { filter: qs.get('status') ?? '', vertical: qs.get('mode') ?? '', operator: qs.get('operator') ?? '', from: qs.get('from') ?? '', to: qs.get('to') ?? '', departs: qs.get('departs') ?? '', sort: qs.get('sort') ?? 'attention', q: qs.get('q') ?? '' };
  const [text, setText] = useState(f.q);
  useEffect(() => { const t = setTimeout(() => { if (text !== f.q) setQs({ q: text.trim() || null }); }, 250); return () => clearTimeout(t); }, [text]); // eslint-disable-line
  const query = { tenant, filter: f.filter, vertical: f.vertical, operator: f.operator, from: f.from, to: f.to, departs: f.departs, sort: f.sort, q: f.q };
  const rooms = useData<{ data: any[]; total: number }>('/rooms', { query, refreshOn: ROOM_EVENTS, every: 30_000 });
  const facets = useData<{ operators: Facet[]; from: Facet[]; to: Facet[]; departs: Facet[]; next2h: number; total: number }>('/rooms/facets', { query: { ...query, filter: undefined, sort: undefined } });
  const rows = rooms.data?.data ?? [];
  const fc = facets.data;
  const depCount = (k: string) => (k === 'next2h' ? fc?.next2h : fc?.departs.find((d) => d.value === k)?.n) ?? 0;
  const active: [string, string][] = ([['operator', f.operator], ['from', f.from && `From ${f.from}`], ['to', f.to && `To ${f.to}`], ['departs', DEPARTS.find(([k]) => k === f.departs)?.[1] ?? ''], ['q', f.q && `“${f.q}”`]] as [string, string][]).filter(([, v]) => v);
  const clearAll = () => { setText(''); setQs({ operator: null, from: null, to: null, departs: null, q: null, status: null, mode: null }); };
  const sel = (key: string, label: string, list: Facet[] | undefined, value: string) => (
    <label className="fsel"><span>{label}</span>
      <select value={value} onChange={(e) => setQs({ [key]: e.target.value || null })}>
        <option value="">All</option>
        {(list ?? []).map((o) => <option key={o.value} value={o.value}>{o.value} ({o.n})</option>)}
        {value && !(list ?? []).some((o) => o.value === value) && <option value={value}>{value} (0)</option>}
      </select>
    </label>
  );
  return (
    <section className="cmain">
      <Head title="Live rooms" sub="Find any trip fast: search, or narrow by operator, route and departure time. Open a room to report an update, message travellers, run a campaign or handle an issue." />
      <div className="filters">
        <input className="fsearch" type="search" placeholder="Search TR- code, bus number, operator, route, trip key…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search rooms" />
        <div className="frow2">
          {sel('operator', 'Operator', fc?.operators, f.operator)}
          {sel('from', 'From', fc?.from, f.from)}
          {sel('to', 'To', fc?.to, f.to)}
          <label className="fsel"><span>Departure</span>
            <select value={f.departs} onChange={(e) => setQs({ departs: e.target.value || null })}>
              <option value="">Any time</option>
              {DEPARTS.map(([k, l]) => <option key={k} value={k}>{l}{k !== 'departed' ? ` (${depCount(k)})` : ''}</option>)}
            </select>
          </label>
          <label className="fsel"><span>Sort</span>
            <select value={f.sort} onChange={(e) => setQs({ sort: e.target.value === 'attention' ? null : e.target.value })}>
              <option value="attention">Needs attention first</option><option value="departs">Departure time</option><option value="travellers">Most travellers</option>
            </select>
          </label>
        </div>
        <div className="split">
          <Seg value={f.filter as any} onChange={(v: string) => setQs({ status: v || null })} options={[['', 'All'], ['action', 'Needs attention'], ['delayed', 'Running late'], ['nogps', 'No live location']]} />
          <Seg value={f.vertical as any} onChange={(v: string) => setQs({ mode: v || null })} options={[['', 'All modes'], ['bus', 'Bus'], ['train', 'Train'], ['flight', 'Flight']]} />
        </div>
        <div className="fstate">
          <b>{rooms.data ? `${rows.length < (rooms.data.total ?? rows.length) ? `${rows.length} of ` : ''}${rooms.data.total ?? rows.length} trip${(rooms.data.total ?? rows.length) === 1 ? '' : 's'}` : 'Loading…'}</b>
          {fc && <span className="hint"> · {fc.total} live or upcoming in total</span>}
          {active.map(([k, l]) => <button type="button" key={k} className="fchip" onClick={() => { if (k === 'q') setText(''); setQs({ [k]: null }); }} aria-label={`Remove filter ${l}`}>{l} ✕</button>)}
          {(active.length > 0 || f.filter || f.vertical) && <button type="button" className="lnk fclear" onClick={clearAll}>Clear all</button>}
        </div>
      </div>
      {rooms.error ? <ErrorBox msg={rooms.error} retry={rooms.reload} /> : !rooms.data ? <Loading /> : !rows.length ? <Empty>No trips match. <button type="button" className="lnk" onClick={clearAll}>Clear filters</button> or try the global search (⌘K) for closed rooms and issues.</Empty> : (
        <div className="tw"><table className="rooms">
          <thead><tr><th>Departs</th><th>Trip</th><th>Needs attention</th><th>Status</th><th>Where now</th><th className="num">Travellers</th><th>Last alert</th></tr></thead>
          <tbody>{rows.map((r) => {
            const attn = r.chips.filter((c: any) => c.tone === 'crit' || c.tone === 'warn');
            const other = r.chips.filter((c: any) => c.tone !== 'crit' && c.tone !== 'warn' && c.label !== 'On time');
            return (
              <tr key={r.id} className={`click ${attn.some((c: any) => c.tone === 'crit') ? 'hot' : ''}`} onClick={() => go(`/ops/rooms/${r.id}`)}>
                <td className="dep"><b>{fmtTime(r.schedule.departs_at)}</b><small>{fmtDay(r.schedule.departs_at)}</small></td>
                <td><div className="rcell"><b><span className="dot" style={{ background: TENANT_DOT[r.tenant_id] }} />{r.title}</b><Ref code={r.ref} /></div><small><b className="op">{r.facets?.operator}</b> · {r.subtitle.split('·').slice(1).join('·').trim() || r.subtitle}{r.facets?.vehicle ? ` · ${r.facets.vehicle}` : ''} · {tenantName(r.tenant_id)}</small></td>
                <td>{attn.length ? <div className="chips-row">{attn.map((c: any) => <Chip key={c.label} tone={`c-${c.tone}`}>{c.label}</Chip>)}</div> : <span className="ok-txt">All good</span>}{other.length > 0 && <small>{other.map((c: any) => c.label).join(' · ')}</small>}</td>
                <td><Chip tone={STATE_TONE[r.state]}>{STATE_LABEL[r.state] ?? r.state}</Chip></td>
                <td>{r.location?.near ?? '—'}<small><Chip tone={CONF_TONE[r.location?.confidence] ?? 'c-mute'}>{r.location?.confidence ?? '—'}</Chip> {r.location?.source}</small></td>
                <td className="num">{r.member_count}</td>
                <td className="num">{r.last_alert_at ? ago(r.last_alert_at) : '—'}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
    </section>
  );
}
const fmtDay = (iso: string) => { const d = new Date(iso), t = new Date(); const day = (x: Date) => x.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }); return day(d) === day(t) ? 'today' : day(d) === day(new Date(+t + 86_400_000)) ? 'tomorrow' : day(d) === day(new Date(+t - 86_400_000)) ? 'yesterday' : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }); };

// ============================================================== room feed ===
function body(m: any): { who: string; cls: string; text: string; badge?: [string, string] } {
  const p = m.payload ?? {};
  switch (m.contentType) {
    case 'TEXT': return { who: m.senderHandle, cls: m.hidden ? 'hid' : '', text: p.text, badge: p.via === 'tenant_app' ? ['via app', 'c-info'] : p.mentions?.includes('CARE') ? ['support ticket', 'c-warn'] : undefined };
    case 'ALERT': return { who: p.author ? `Ops · ${p.author}` : 'Ops', cls: 'ops', text: p.text + (p.translations?.hi ? `\n${p.translations.hi}` : ''), badge: [p.severity, p.severity === 'critical' ? 'c-crit' : p.severity === 'warning' ? 'c-warn' : 'c-info'] };
    case 'TARA': return { who: 'Tara', cls: 'tara', text: p.text, badge: ['AI', 'c-info'] };
    case 'PRIVATE': return { who: `Private · from ${p.from}`, cls: 'priv', text: p.text, badge: ['only 1 traveller sees this', 'c-mute'] };
    case 'SYSTEM': return { who: 'System', cls: '', text: p.text };
    case 'POLL': return { who: `Poll · ${m.senderHandle}`, cls: '', text: `${p.question}\n${(p.options ?? []).map((o: string, i: number) => `${o} · ${(m.reactions?.[`poll:${i}`] ?? []).length}`).join('  /  ')}` };
    case 'AD': return { who: `Ad · ${p.advertiser}`, cls: 'ad', text: `${p.title} — ${p.body}`, badge: ['ad', 'c-mute'] };
    case 'ISSUE': return { who: 'Group issue', cls: '', text: `${p.label} · ${p.count} reports${p.escalated ? ' · escalated to Ops' : ''}`, badge: p.escalated ? ['escalated', 'c-warn'] : undefined };
    case 'VOUCHER': return { who: 'Delay voucher', cls: '', text: `₹${p.amount} · valid ${p.validDays} days · ${(m.reactions?.['voucher:claimed'] ?? []).length} claimed` };
    case 'TIMER': return { who: 'Rest-stop timer', cls: '', text: `Leaves ${p.stop} at ${fmtTime(p.leaveAt)}` };
    case 'LOST': return { who: `Lost & found · ${m.senderHandle}`, cls: '', text: p.text };
    case 'CREW': return { who: p.role ?? 'Crew', cls: '', text: p.text, badge: ['crew', 'c-ok'] };
    case 'RATE': return { who: 'Trip rating card', cls: '', text: p.prompt };
    case 'SURVEY': { const n = (p.questions ?? []).length, a = (m.reactions?.['survey:done'] ?? []).length; return { who: `Survey · ${p.by}`, cls: '', text: `${(p.questions ?? []).map((q: any, i: number) => `${i + 1}. ${q.q} (${q.type === 'rating' ? '1–5 stars' : q.type === 'choice' ? 'choice' : 'short text'})`).join('\n')}\n${n} question${n === 1 ? '' : 's'} · ${a} answered here` }; }
    case 'GAME': return { who: `Game · ${m.senderHandle}`, cls: '', text: p.title ?? p.kind ?? 'Mini game' };
    case 'STICKER': return { who: m.senderHandle, cls: '', text: `[sticker ${p.stickerId}]` };
    case 'BUS_LOCATION': return { who: m.senderHandle, cls: '', text: `📍 ${p.placeLabel ?? 'Location shared'}` };
    default: return { who: m.senderHandle ?? m.contentType, cls: '', text: p.text ?? JSON.stringify(p).slice(0, 140) };
  }
}

/** Remove a member from the room (moderation.act): they're disconnected and can't rejoin with this booking. */
const removeMember = (run: ReturnType<typeof useAction>['run'], roomId: string, m: { id: string; shown_as: string }) =>
  confirm(`Remove ${m.shown_as} from this room? They'll be disconnected and can't post again.`)
    ? run(`r${m.id}`, () => api(`/rooms/${roomId}/moderation`, { body: { action: 'remove_member', member_id: m.id, reason: 'Removed by Ops' } }), `${m.shown_as} removed from the room`)
    : Promise.resolve(undefined);

export function RoomFeed({ id, canModerate, members, reloadRoom }: { id: string; canModerate: boolean; members: any[]; reloadRoom: () => void }) {
  const [channel, setChannel] = useState<'MAIN' | 'WOMEN'>('MAIN');
  const msgs = useData<{ data: any[] }>(`/rooms/${id}/messages`, { query: { channel }, refreshOn: ROOM_EVENTS, room: id, every: 4000 });
  const { busy, run } = useAction();
  const op = (mid: string, o: 'restore' | 'remove') => run(mid, () => api(`/rooms/${id}/messages/${mid}/${o}`, { body: {} }), o === 'restore' ? 'Message restored' : 'Message removed').then(() => msgs.reload());
  const byId = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const [resp, setResp] = useState<{ id: string; title: string } | null>(null);
  return (
    <Panel title="Conversation · everything travellers see, plus hidden and reported messages" right={<Seg value={channel} onChange={setChannel} options={[['MAIN', 'Everyone'], ['WOMEN', 'Women-only']]} />}>
      {msgs.error ? <ErrorBox msg={msgs.error} /> : !msgs.data ? <Loading /> : !msgs.data.data.length ? <Empty>No messages yet.</Empty> : (
        <div className="ofeed">{msgs.data.data.map((m) => {
          const b = body(m);
          const reacts = Object.entries(m.reactions ?? {}).filter(([k]) => !k.includes(':'));
          const sender = m.sender_member_id ? byId.get(m.sender_member_id) : undefined;
          return (
            <div key={m.id} className={`om ${b.cls}`}>
              <div className="h"><b>{b.who}</b>{b.badge && <Chip tone={b.badge[1]}>{b.badge[0]}</Chip>}{m.hidden && <Chip tone="c-warn">hidden · {m.reports} reports</Chip>}{!m.hidden && m.reports > 0 && <Chip tone="c-warn">{m.reports} report{m.reports > 1 ? 's' : ''}</Chip>}<time>{fmtTime(m.createdAt)}</time></div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{b.text}</div>
              {(reacts.length > 0 || m.seenBy?.length > 0) && <div className="meta">{reacts.map(([k, v]: any) => `${k} ${v.length}`).join('  ')}{m.seenBy?.length ? ` · seen by ${m.seenBy.length}` : ''}</div>}
              {canModerate && (m.contentType === 'TEXT' || (sender && !sender.removed)) && <div className="acts">
                {m.contentType === 'TEXT' && m.hidden && <Btn sm busy={busy === m.id} onClick={() => op(m.id, 'restore')}>Restore</Btn>}
                {m.contentType === 'TEXT' && <Btn sm kind="danger" busy={busy === m.id} onClick={() => confirm('Remove this message for everyone?') && op(m.id, 'remove')}>Remove message</Btn>}
                {sender && !sender.removed && <Btn sm kind="danger" busy={busy === `r${sender.id}`} onClick={() => removeMember(run, id, sender).then((r) => { if (r) reloadRoom(); })}>Remove {sender.shown_as} from room</Btn>}
              </div>}
              {sender?.removed && <div className="meta">{sender.shown_as} was removed from this room</div>}
              {(m.contentType === 'POLL' || m.contentType === 'SURVEY') && (() => {
                const n = m.contentType === 'SURVEY' ? (m.reactions?.['survey:done'] ?? []).length : new Set(Object.entries(m.reactions ?? {}).filter(([k]) => k.startsWith('poll:')).flatMap(([, v]: any) => v)).size;
                return <div className="resp-cta"><Btn sm onClick={() => setResp({ id: m.id, title: m.contentType === 'POLL' ? m.payload?.question : 'Survey responses' })}>View responses{n ? ` · ${n}` : ''}</Btn></div>;
              })()}
            </div>
          );
        })}</div>
      )}
      {resp && <ResponsesModal roomId={id} messageId={resp.id} title={resp.title} onClose={() => setResp(null)} />}
    </Panel>
  );
}

/** Live (updates as people answer) responses to one poll or survey in this room. */
function ResponsesModal({ roomId, messageId, title, onClose }: { roomId: string; messageId: string; title: string; onClose: () => void }) {
  const d = useData<any>(`/rooms/${roomId}/messages/${messageId}/responses`, { refreshOn: ['poll.', 'survey.', 'action.'], every: 5000 });
  return (
    <Modal wide title={title} onClose={onClose}>
      {d.error ? <ErrorBox msg={d.error} /> : !d.data ? <Loading /> : <><MadeByLine made={d.data.made} /><ResponsesView data={d.data} showRoom={false} /></>}
    </Modal>
  );
}

const REVEAL: [string, string][] = [['sos', 'SOS follow-up'], ['harassment', 'Harassment report'], ['lost_found', 'Lost & found'], ['legal', 'Legal request']];
export function Travellers({ data, reload }: { data: any; reload: () => void }) {
  const { can } = useAuth();
  const { room, members, identity_mode } = data;
  const [all, setAll] = useState(false);
  const [why, setWhy] = useState('sos');
  const [revealed, setRevealed] = useState<Record<string, any>>({});
  const [q, setQ] = useState('');
  const { busy, run } = useAction();
  const list = members.filter((m: any) => (!m.removed || all) && (!q || `${m.shown_as} ${m.handle} ${m.role}`.toLowerCase().includes(q.toLowerCase())));
  const shown = all || q ? list : list.slice(0, 12);
  return (
    <Panel title={`Travellers (${members.filter((m: any) => !m.removed && m.role === 'traveller').length})`} right={<Chip tone="c-mute">{identity_mode === 'handle' ? 'random handles' : 'profile names'}</Chip>}>
      {members.length > 6 && <input className="mem-q" type="search" placeholder="Find a traveller by name or handle…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a traveller" />}
      {q && !list.length && <Empty>No one matches “{q}”.</Empty>}
      {shown.map((m: any) => (
        <div key={m.id}>
          <div className="mem">
            <span>{m.shown_as}{m.role !== 'traveller' && <> <Chip tone="c-info">{m.role}</Chip></>}{m.muted && <> <Chip>muted</Chip></>}{m.removed && <> <Chip tone="c-crit">removed{m.removed_reason ? ` · ${m.removed_reason}` : ''}</Chip></>}{m.sharing_location && <> <Chip tone="c-ok">sharing location</Chip></>}
              <small className="hint">{m.segment?.from ?? '—'} → {m.segment?.to ?? '—'}{m.party_size > 1 ? ` · party of ${m.party_size}` : ''}</small></span>
            {!m.removed && can('moderation.act') && <Btn sm kind="ghost" busy={busy === `m${m.id}`} onClick={() => run(`m${m.id}`, () => api(`/rooms/${room.id}/members/${m.id}/mute`, { body: { muted: !m.muted } }), m.muted ? 'Unmuted' : 'Muted').then(reload)}>{m.muted ? 'Unmute' : 'Mute'}</Btn>}
            {!m.removed && can('moderation.act') && <Btn sm kind="danger" busy={busy === `r${m.id}`} onClick={() => removeMember(run, room.id, m).then((r) => { if (r) reload(); })}>Remove</Btn>}
            {m.removed && can('moderation.act') && <Btn sm busy={busy === `u${m.id}`} title="Removed by mistake? Let them back in, in every app." onClick={() => run(`u${m.id}`, () => api(`/rooms/${room.id}/members/${m.id}/restore`, { body: {} }), `${m.shown_as} can rejoin the chat`).then(reload)}>Restore</Btn>}
            {can('members.reveal') && <Btn sm kind="danger" busy={busy === `v${m.id}`} onClick={() => run(`v${m.id}`, () => api(`/rooms/${room.id}/members/${m.id}/reveal`, { body: { reason: why } }), 'Revealed · logged in audit').then((r) => r && setRevealed((x) => ({ ...x, [m.id]: r })))}>Reveal booking</Btn>}
          </div>
          {revealed[m.id] && <div className="reveal-box">Booking <b>{revealed[m.id].booking_ref}</b> · user <code>{revealed[m.id].external_user_id}</code>{revealed[m.id].seat_refs?.length ? ` · seats ${revealed[m.id].seat_refs.join(', ')}` : ''}<br />Segment {revealed[m.id].segment.from ?? '—'} → {revealed[m.id].segment.to ?? '—'} · reason: {REVEAL.find((r) => r[0] === why)?.[1]} · audit <code>{revealed[m.id].audit_id}</code><br /><small className="hint">Use your own CRM / masked calling with this booking ref. Trip Rooms never stores names or phone numbers.</small></div>}
        </div>
      ))}
      {!q && (all || list.length > 12 || members.some((m: any) => m.removed)) && <Btn sm kind="ghost" onClick={() => setAll((x) => !x)}>{all ? 'Show fewer' : `Show all ${members.length} (incl. removed)`}</Btn>}
      {can('members.reveal') && <div className="f" style={{ marginTop: 10 }}><label>Reason used for reveals (logged and reviewed weekly)</label><select value={why} onChange={(e) => setWhy(e.target.value)}>{REVEAL.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>}
    </Panel>
  );
}

// ==================================================================== inbox ===
const TYPE_LABEL: Record<string, string> = { sos: 'SOS', issue: 'Group issue', wait: 'Wait for me', wait_request: 'Wait for me', report: 'Report', lost: 'Lost & found', lost_found: 'Lost & found', care: 'Customer care', care_mention: 'Customer care' };
const QUICK: Record<string, string[]> = {
  sos: ['We’re calling you now on a masked line.', 'Help is on the way. Stay where you are.'],
  wait_request: ['We’ll wait up to 5 min. Please hurry.', 'Sorry, we can’t wait. Call us for options.'],
  issue: ['Thanks. We’ve asked the crew to fix this.'],
  lost_found: ['We’ve found it. The operator will hold it at the office.'],
  report: ['Thanks, we reviewed it.'],
};
export function OpsInbox({ initialType = '' }: { initialType?: string }) {
  const { tenant } = useAuth();
  const [status, setStatus] = useState<'open,acknowledged' | 'resolved' | ''>('open,acknowledged');
  const [type, setType] = useState(initialType);
  useEffect(() => setType(initialType), [initialType]);
  const d = useData<{ data: any[] }>('/inbox', { query: { tenant, status, type }, refreshOn: ['action.', 'sos.', 'issue.', 'wait_request.', 'lost_found.', 'message.reported', 'care.'], every: 30_000 });
  const types = useMemo(() => [...new Set((d.data?.data ?? []).map((a) => a.type))], [d.data]);
  return (
    <section className="cmain">
      <Head title="Issues inbox" sub="Everything travellers raised that needs a person: SOS, group issues, wait requests, reports, lost items. Urgent first, then oldest. Each has an IS- reference." />
      <div className="split">
        <Seg value={status} onChange={setStatus} options={[['open,acknowledged', 'To do'], ['resolved', 'Resolved'], ['', 'All']]} />
        <select className="tsel" value={type} onChange={(e) => setType(e.target.value)}><option value="">All types</option>{[...new Set([...types, 'sos', 'issue', 'wait_request', 'report', 'lost_found'])].map((t) => <option key={t} value={t}>{TYPE_LABEL[t] ?? t}</option>)}</select>
      </div>
      {d.error ? <ErrorBox msg={d.error} retry={d.reload} /> : !d.data ? <Loading /> : !d.data.data.length ? <Empty>{status === 'resolved' ? 'Nothing resolved yet.' : 'All clear. No traveller is waiting on you.'}</Empty> : (
        <div className="inb">{d.data.data.map((a) => <InboxItem key={a.id} a={a} reload={d.reload} />)}</div>
      )}
    </section>
  );
}

const STATUS_WORD: Record<string, string> = { open: 'New', acknowledged: 'Seen by Ops', resolved: 'Resolved' };
const STATUS_TONE: Record<string, string> = { open: 'c-warn', acknowledged: 'c-info', resolved: 'c-ok' };

/** One issue: what, how urgent, where (room ref), when, and the next step as buttons. */
export function InboxItem({ a, reload, compact }: { a: any; reload: () => void; compact?: boolean }) {
  const { can, tenantName } = useAuth();
  const [replying, setReplying] = useState(false);
  const [txt, setTxt] = useState('');
  const { busy, run } = useAction();
  const patch = (b: any, ok: string) => run(a.id + JSON.stringify(b), () => api(`/inbox/${a.id}`, { method: 'PATCH', body: b }), `${a.ref} · ${ok}`).then((r) => { if (r) { setReplying(false); setTxt(''); reload(); } });
  const canAct = can('inbox.act') && a.status !== 'resolved';
  const live = a.severity === 'critical' && a.status !== 'resolved';
  return (
    <div className={`ib ${live ? 'crit' : ''} ${a.status === 'resolved' ? 'done' : ''}`}>
      <span className="sv" style={{ background: SEV_COLOR[a.severity] }} />
      <div>
        <div className="ib-top"><Chip tone={SEV_TONE[a.severity]}>{SEV_WORD[a.severity]}</Chip><b>{TYPE_LABEL[a.type] ?? a.type}</b><Ref code={a.ref} /><Chip tone={STATUS_TONE[a.status]}>{STATUS_WORD[a.status] ?? a.status}</Chip><time title={a.created_at}>{ago(a.created_at)}</time></div>
        <h4>{a.title}</h4>
        {a.detail && <p>{a.detail}</p>}
        {!compact && a.room && <p className="ib-where">In <a className="lnk" href={href(`/ops/rooms/${a.room_id}`)} onClick={(e) => e.stopPropagation()}>{a.room.ref ?? ''} {a.room.title}</a> · {a.room.subtitle} · {tenantName(a.tenant_id)}</p>}
        {a.assignee && <p className="hint">Handled by {a.assignee}</p>}
        {a.data?.location && <p className="hint">Last location: {a.data.location.near ?? `${a.data.location.lat?.toFixed?.(4)}, ${a.data.location.lng?.toFixed?.(4)}`}</p>}
        {replying && (
          <div className="f" style={{ marginTop: 8 }}>
            <small className="hint">Only this traveller sees your reply. Pick one or write your own.</small>
            <div className="fil">{(QUICK[a.type] ?? ['Thanks, we’re on it.']).map((t) => <Btn key={t} sm onClick={() => patch({ private_reply: t, status: 'acknowledged' }, 'Reply sent')}>{t}</Btn>)}</div>
            <div className="fil"><input value={txt} onChange={(e) => setTxt(e.target.value)} placeholder="Write a private reply…" style={{ flex: 1 }} /><Btn sm kind="pri" disabled={!txt.trim()} onClick={() => patch({ private_reply: txt.trim(), status: 'acknowledged' }, 'Reply sent')}>Send</Btn></div>
          </div>
        )}
      </div>
      {canAct && <div className="acts">
        {a.member_id && <Btn sm onClick={() => setReplying((x) => !x)}>{replying ? 'Cancel reply' : 'Reply to traveller'}</Btn>}
        {a.status === 'open' && <Btn sm busy={!!busy} onClick={() => patch({ status: 'acknowledged' }, 'Marked as seen')} title="Tells your team someone is on it">I’m on it</Btn>}
        <Btn sm kind="pri" busy={!!busy} onClick={() => patch({ status: 'resolved' }, 'Resolved')}>Resolve</Btn>
      </div>}
    </div>
  );
}

// ================================================================ broadcast ===
export function OpsBroadcast() {
  const { tenants, tenant: tf } = useAuth();
  const [tenant, setTenant] = useState(tf || tenants[0]?.id || '');
  const opts = useData<any>(tenant ? '/broadcast-options' : null, { query: { tenant } });
  const [vertical, setVertical] = useState('');
  const [field, setField] = useState<'all' | 'operator_id' | 'route' | 'train_no' | 'flight_no'>('all');
  const [value, setValue] = useState('');
  const [text, setText] = useState('');
  const [sev, setSev] = useState('warning');
  const [push, setPush] = useState(true);
  const [sms, setSms] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const { busy, run } = useAction();
  const v = vertical || opts.data?.verticals?.[0] || '';
  const fields: [typeof field, string][] = v === 'bus' ? [['all', 'All bus rooms'], ['route', 'Route'], ['operator_id', 'Operator']] : v === 'train' ? [['all', 'All train rooms'], ['train_no', 'Train number']] : v === 'flight' ? [['all', 'All flight rooms'], ['flight_no', 'Flight']] : [['all', 'All rooms']];
  const values: string[] = field === 'all' ? [] : opts.data?.[field] ?? [];
  const selector = { vertical: v || undefined, ...(field !== 'all' && value ? { [field]: value } : {}) };
  useEffect(() => { if (field !== 'all' && values.length && !values.includes(value)) setValue(values[0]); }, [field, values.join()]); // eslint-disable-line
  useEffect(() => {
    if (!tenant || !v) return;
    api('/broadcasts', { body: { tenant, selector, dry_run: true } }).then(setPreview).catch(() => setPreview(null));
  }, [tenant, JSON.stringify(selector)]); // eslint-disable-line
  return (
    <section className="cmain">
      <Head title="Bulk broadcast" sub="One alert to many rooms at once: a highway closure, a station problem, an airport-wide delay. Every send is audited." />
      <div className="two">
        <Panel>
          <div className="f" style={{ gap: 10 }}>
            <div className="frow">
              <Field label="App"><select value={tenant} onChange={(e) => { setTenant(e.target.value); setVertical(''); setField('all'); }}>{tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
              <Field label="Mode"><select value={v} onChange={(e) => { setVertical(e.target.value); setField('all'); }}>{(opts.data?.verticals ?? []).map((x: string) => <option key={x} value={x}>{UNIT[x]}</option>)}</select></Field>
              <Field label="Match by"><select value={field} onChange={(e) => setField(e.target.value as any)}>{fields.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
              {field !== 'all' && <Field label="Value"><select value={value} onChange={(e) => setValue(e.target.value)}>{values.map((x) => <option key={x}>{x}</option>)}</select></Field>}
            </div>
            <Field label="Message"><textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={500} placeholder="e.g. NH44 is closed near Kurnool due to an accident. Buses are being diverted; expect 60–90 min delay." /></Field>
            <div className="frow">
              <Field label="Severity"><select value={sev} onChange={(e) => setSev(e.target.value)}>{['info', 'warning', 'critical'].map((s) => <option key={s}>{s}</option>)}</select></Field>
              <Field label="Also send"><div className="checks"><label><input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} /> Push</label><label><input type="checkbox" checked={sms} onChange={(e) => setSms(e.target.checked)} /> SMS</label></div></Field>
            </div>
            <div><Btn kind="pri" busy={busy === 'bc'} disabled={!text.trim() || !preview?.matched_rooms} onClick={() => confirm(`Send to ${preview.matched_rooms} rooms · ${preview.reach} travellers?`) && run('bc', () => api<any>('/broadcasts', { body: { tenant, selector, text: text.trim(), severity: sev, push, sms } }), (r: any) => `Sent to ${r.matched_rooms} rooms · ${r.reach} travellers`).then((r) => r && setText(''))}>
              Send to {preview?.matched_rooms ?? 0} rooms · {num(preview?.reach)} travellers</Btn></div>
          </div>
        </Panel>
        <Panel title="Matched rooms">
          {!preview ? <Loading /> : !preview.rooms.length ? <Empty>No rooms match.</Empty> : preview.rooms.map((r: any) => (
            <div key={r.id} className="mem"><span><span className="rcell"><Ref code={roomRef(r.id)} /><a className="lnk" href={href(`/ops/rooms/${r.id}`)}>{r.title}</a></span><small className="hint">{r.subtitle}</small></span></div>
          ))}
        </Panel>
      </div>
    </section>
  );
}

// ==================================================================== audit ===
export function AuditLog() {
  const { tenantName } = useAuth();
  const [q, setQ] = useState('');
  const d = useData<{ data: any[] }>('/audit', { refreshOn: ['member.revealed', 'member.muted', 'room.moderation', 'broadcast.', 'tenant.', 'campaign.'] });
  const rows = (d.data?.data ?? []).filter((a) => !q || JSON.stringify(a).toLowerCase().includes(q.toLowerCase()));
  const [open, setOpen] = useState<any>(null);
  return (
    <section className="cmain">
      <Head title="Audit log" sub="Every identity reveal, moderation action, broadcast, key and config change. Reviewed weekly." right={<input className="tsel" placeholder="Filter by agent, action, room…" value={q} onChange={(e) => setQ(e.target.value)} />} />
      {d.error ? <ErrorBox msg={d.error} /> : !d.data ? <Loading /> : (
        <div className="tw"><table>
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>App</th><th>Room</th><th>Reason</th><th /></tr></thead>
          <tbody>{rows.map((a) => (
            <tr key={a.id}>
              <td className="num" title={a.created_at}>{ago(a.created_at)}</td><td>{a.actor}</td>
              <td><Chip tone={a.action.includes('reveal') ? 'c-crit' : a.action.includes('remov') || a.action.includes('mute') ? 'c-warn' : 'c-mute'}>{a.action}</Chip></td>
              <td>{a.tenantId ? tenantName(a.tenantId) : 'Platform'}</td>
              <td>{a.roomId ? <div className="rcell"><Ref code={roomRef(a.roomId)} /><a className="lnk" href={href(`/ops/rooms/${a.roomId}`)}>{a.room_title ?? 'Open room'}</a></div> : '—'}</td>
              <td>{a.reason ?? '—'}</td>
              <td>{a.data && <Btn sm kind="ghost" onClick={() => setOpen(a)}>Details</Btn>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {open && <Modal title={open.action} onClose={() => setOpen(null)}><pre className="code">{JSON.stringify(open, null, 2)}</pre></Modal>}
    </section>
  );
}
