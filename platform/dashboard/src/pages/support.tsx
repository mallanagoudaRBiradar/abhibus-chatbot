import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useData } from '../lib/live';
import { go, href } from '../lib/router';
import { ago, fmtTime, SEV_COLOR, SEV_TONE, SEV_WORD, UNIT } from '../lib/format';
import { Btn, Chip, Empty, ErrorBox, Head, Loading, Panel, Ref, Seg, Switch, useAction } from '../components/ui';
import { careAlertsOn, setCareAlerts } from '../lib/careAlerts';

type View = 'waiting' | 'mine' | 'open' | 'resolved';
const CARE_EVENTS = ['care.', 'action.'];
const QUICK = [
  'Hi! I’m looking into this now.',
  'Could you share a few more details?',
  'We’ve asked the operator to fix this. I’ll update you here.',
  'Sorry about this. Your request is logged and you’ll get an update by SMS.',
];

// ============================================================ ticket queue ===
/**
 * The support desk. Travellers tag @<App> Care, @care or @support in a trip chat; each tag is a
 * ticket here. Left: the queue, urgent first then longest waiting. Right: the open ticket.
 * #/support/queue/<ticket id> deep-links straight to a ticket.
 */
export function SupportQueue({ id }: { id?: string }) {
  const { tenant } = useAuth();
  const [view, setView] = useState<View>('waiting');
  const q = useData<any>('/support/tickets', { query: { view, tenant }, refreshOn: CARE_EVENTS, every: 30_000 });
  const rows: any[] = q.data?.data ?? [];
  const c = q.data?.counts ?? { waiting: 0, mine: 0, open: 0 };
  // Open the first ticket in the list when nothing is selected (desktop only; the list is the page on mobile).
  useEffect(() => { if (!id && rows[0] && window.innerWidth > 900) go(`/support/queue/${rows[0].id}`); }, [id, rows[0]?.id]); // eslint-disable-line

  return (
    <section className="cmain">
      <Head title="Customer support" sub={<>Travellers tag {q.data ? <HandleList handles={q.data.handles} aliases={q.data.aliases} /> : '@care'} in any trip chat. Each tag becomes a ticket here; replies reach only that traveller.</>} right={<AlertsToggle />} />
      <Seg value={view} onChange={setView} options={[['waiting', `Waiting · ${c.waiting}`], ['mine', `Mine · ${c.mine}`], ['open', `All open · ${c.open}`], ['resolved', 'Resolved']]} />
      <div className="desk">
        <div className="queue">
          {q.error ? <ErrorBox msg={q.error} retry={q.reload} /> : !q.data ? <Loading /> : !rows.length ? (
            <Empty>{view === 'waiting' ? 'No one is waiting. New tickets appear here instantly.' : view === 'mine' ? 'Nothing assigned to you. Take a ticket from Waiting.' : view === 'resolved' ? 'Nothing resolved yet.' : 'No open tickets.'}</Empty>
          ) : rows.map((t) => (
            <a key={t.id} href={href(`/support/queue/${t.id}`)} className={`qi ${t.id === id ? 'on' : ''} ${t.severity === 'critical' && t.status !== 'resolved' ? 'crit' : ''}`}>
              <span className="sv" style={{ background: SEV_COLOR[t.severity] }} />
              <span className="qi-b">
                <span className="qi-h"><b>{t.who}</b>{t.thread.length > 1 && <small className="qi-n">{t.thread.filter((x: any) => x.from === 'traveller').length} msgs</small>}<time>{ago(t.updated_at)}</time></span>
                <span className="qi-t">{t.detail}</span>
                <small>{t.room?.ref} · {t.room?.title}{t.assignee ? ` · ${t.assignee.split('@')[0]}` : ''}{t.escalated ? ' · with Ops' : ''}</small>
              </span>
            </a>
          ))}
        </div>
        <div className="ticket">{id ? <Ticket id={id} reloadQueue={q.reload} /> : <Empty>Pick a ticket on the left.</Empty>}</div>
      </div>
    </section>
  );
}

function HandleList({ handles, aliases }: { handles: Record<string, string>; aliases: string[] }) {
  const own = [...new Set(Object.values(handles))].map((h) => `@${h}`);
  return <>{[...own, ...aliases.slice(0, 2)].map((h, i, a) => <span key={h}><code>{h}</code>{i < a.length - 1 ? ', ' : ''}</span>)}</>;
}

function AlertsToggle() {
  const [on, setOn] = useState(careAlertsOn());
  const blocked = typeof Notification !== 'undefined' && Notification.permission === 'denied';
  return (
    <label className="tog" title={blocked ? 'Your browser blocks notifications for this site. Allow them in the site settings.' : 'Sound and a desktop notification for every new ticket'}>
      <span>Alert me on new tickets{blocked && <small className="hint"> · blocked by browser</small>}</span>
      <Switch on={on} label="Alert me on new tickets" onChange={async (v) => setOn(await setCareAlerts(v))} />
    </label>
  );
}

// ================================================================== ticket ===
function Ticket({ id, reloadQueue }: { id: string; reloadQueue: () => void }) {
  const { user } = useAuth();
  const d = useData<any>(`/support/tickets/${id}`, { refreshOn: CARE_EVENTS, every: 20_000 });
  const [txt, setTxt] = useState('');
  const { busy, run } = useAction();
  useEffect(() => setTxt(''), [id]);
  if (d.error) return <ErrorBox msg={d.error} retry={d.reload} />;
  if (!d.data) return <Loading />;
  const { ticket: t, traveller, room, context, care_handle, support_phone } = d.data;
  const mine = t.assignee === user!.email;
  const done = t.status === 'resolved';
  const act = (key: string, body: any, ok: string) => run(key, () => api(`/support/tickets/${id}`, { method: 'PATCH', body }), `${t.ref} · ${ok}`).then((r) => { if (r) { d.reload(); reloadQueue(); } return r; });
  const reply = async (text: string, resolve = false) => { if (await act(resolve ? 'rr' : 'r', { private_reply: text, ...(resolve ? { status: 'resolved' } : {}) }, resolve ? 'Replied and resolved' : 'Reply sent')) setTxt(''); };

  return (
    <div className="stack">
      <Panel>
        <div className="tk-h">
          <div>
            <div className="rh-top"><Ref code={t.ref} /><Chip tone={SEV_TONE[t.severity]}>{SEV_WORD[t.severity]}</Chip><Chip tone={done ? 'c-ok' : t.assignee ? 'c-info' : 'c-warn'}>{done ? 'Resolved' : t.assignee ? (mine ? 'Yours' : `With ${t.assignee.split('@')[0]}`) : 'Waiting'}</Chip>{t.escalated && <Chip tone="c-crit">Handed to Ops</Chip>}</div>
            <div className="tk-t">{t.who} <span className="muted">needs help</span></div>
            <p className="muted" style={{ margin: 0 }}>In <a className="lnk" href={href(`/ops/rooms/${room.id}`)}>{room.ref} {room.title}</a> · {room.subtitle} · {room.tenant_name} · {UNIT[room.vertical]} · opened {ago(t.created_at)}</p>
          </div>
          {!done && <div className="fil">
            {!t.assignee && <Btn kind="pri" busy={busy === 'claim'} onClick={() => act('claim', { claim: true }, 'Assigned to you')}>Take this ticket</Btn>}
            {t.assignee && !mine && <Btn busy={busy === 'claim'} onClick={() => act('claim', { claim: true }, 'Assigned to you')}>Take over</Btn>}
            {mine && <Btn kind="ghost" busy={busy === 'rel'} onClick={() => act('rel', { release: true }, 'Back in the queue')}>Release</Btn>}
            {!t.escalated && <Btn kind="ghost" busy={busy === 'esc'} onClick={() => confirm('Hand this to Ops? It becomes Urgent in their Issues inbox. Use it for safety problems or anything only Ops can fix on the trip.') && act('esc', { escalate: true }, 'Handed to Ops')}>Hand over to Ops</Btn>}
            <Btn kind={mine ? 'pri' : undefined} busy={busy === 'res'} onClick={() => act('res', { status: 'resolved' }, 'Resolved')}>Resolve</Btn>
          </div>}
          {done && <Btn busy={busy === 'reo'} onClick={() => act('reo', { status: 'open' }, 'Reopened')}>Reopen</Btn>}
        </div>

        <div className="thread">
          {t.thread.map((m: any, i: number) => (
            <div key={i} className={`bub ${m.from === 'agent' ? 'agent' : ''}`}>
              <small>{m.from === 'agent' ? `${care_handle} · ${m.by?.split('@')[0]}` : t.who} · {fmtTime(m.at)}</small>
              <div>{m.text}</div>
            </div>
          ))}
        </div>

        {!done && (traveller?.removed ? <p className="hint">This traveller has left the room, so replies can’t reach them in the chat{support_phone ? `. Call from ${support_phone} using their booking via your CRM` : ''}.</p> : (
          <div className="reply">
            <div className="fil">{QUICK.map((qr) => <button type="button" key={qr} className="pickchip" onClick={() => setTxt(qr)}>{qr}</button>)}</div>
            <textarea value={txt} onChange={(e) => setTxt(e.target.value)} maxLength={500} placeholder={`Reply as ${care_handle}. Only ${t.who} sees this.`}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && txt.trim()) { e.preventDefault(); void reply(txt.trim()); } }} />
            <div className="modal-foot" style={{ marginTop: 6 }}>
              <small className="hint">Private: the rest of the room doesn’t see it. ⌘/Ctrl + Enter sends.</small>
              <div className="fil">
                <Btn kind="ghost" disabled={!txt.trim()} busy={busy === 'rr'} onClick={() => reply(txt.trim(), true)}>Send & resolve</Btn>
                <Btn kind="pri" disabled={!txt.trim()} busy={busy === 'r'} onClick={() => reply(txt.trim())}>Send reply</Btn>
              </div>
            </div>
          </div>
        ))}
      </Panel>

      <div className="g2">
        <Panel title="Traveller">
          {traveller ? <dl className="summary">
            <div><dt>Shown as</dt><dd>{traveller.shown_as}{traveller.removed && <> <Chip tone="c-crit">left the room</Chip></>}</dd></div>
            {traveller.segment.from && <div><dt>Journey</dt><dd>{traveller.segment.from} → {traveller.segment.to ?? '—'}</dd></div>}
            <div><dt>Party</dt><dd>{traveller.party_size} {traveller.party_size > 1 ? 'people' : 'person'}</dd></div>
            <div><dt>Language</dt><dd>{traveller.locale}</dd></div>
          </dl> : <Empty>Traveller not found.</Empty>}
          <p className="hint" style={{ marginTop: 8 }}>Names, phone numbers and booking details stay with {room.tenant_name}. Ops can reveal the booking if it’s a safety case.</p>
        </Panel>
        <Panel title="The trip right now">
          <dl className="summary">
            <div><dt>Status</dt><dd>{room.delay_min ? `${room.delay_min} min late` : 'On time'}{room.breakdown ? ' · broken down' : ''}</dd></div>
            <div><dt>Departs</dt><dd>{fmtTime(room.schedule.departs_at)}</dd></div>
            <div><dt>Arrives</dt><dd>{fmtTime(room.schedule.arrives_at)}</dd></div>
            <div><dt>Room</dt><dd><a className="lnk" href={href(`/ops/rooms/${room.id}`)}>Open {room.ref} →</a></dd></div>
          </dl>
        </Panel>
      </div>

      <Panel title="What was happening in the room">
        {!context.length ? <Empty>No messages around this time.</Empty> : <div className="ctx">{context.map((m: any) => (
          <div key={m.id} className={`ctx-m ${m.mine ? 'mine' : ''}`}><b>{m.mine ? t.who : m.senderHandle ?? m.contentType}</b><span>{m.payload?.text ?? `[${m.contentType.toLowerCase()}]`}</span><time>{fmtTime(m.createdAt)}</time></div>
        ))}</div>}
      </Panel>
    </div>
  );
}

// ========================================================= how it works ===
export function SupportSetup() {
  const { can, tenantName } = useAuth();
  const q = useData<any>('/support/tickets', { query: { view: 'open' } });
  return (
    <section className="cmain">
      <Head title="How travellers reach you" sub="Nothing to install: the tags below work in every trip chat on every app you can see." right={can('config.write') && <a className="btn" href={href('/developer/config')}>Change an app’s care handle</a>} />
      {!q.data ? <Loading /> : <>
        <Panel title="Tags that create a ticket">
          <div className="tw"><table>
            <thead><tr><th>App</th><th>Its own tag</th><th>Also works everywhere</th></tr></thead>
            <tbody>{Object.entries(q.data.handles as Record<string, string>).map(([t, h]) => (
              <tr key={t}><td>{tenantName(t)}</td><td><code>@{h}</code></td><td>{q.data.aliases.map((a: string) => <code key={a} style={{ marginRight: 8 }}>{a}</code>)}</td></tr>
            ))}</tbody>
          </table></div>
        </Panel>
        <Panel title="What happens">
          <div className="flow">
            <span className="s">Traveller writes “@care my AC isn’t working”</span><span className="a">→</span>
            <span className="s">Chat shows “Care has been notified”</span><span className="a">→</span>
            <span className="s">Ticket in Waiting · desk gets a sound + desktop alert</span><span className="a">→</span>
            <span className="s">Agent takes it, replies privately</span><span className="a">→</span>
            <span className="s">Resolve, or hand over to Ops</span>
          </div>
          <div className="prose" style={{ marginTop: 12 }}>
            <p><b>One ticket per traveller.</b> If they tag the desk again while their ticket is open, the new message joins the same ticket and it moves back to the top.</p>
            <p><b>Urgent automatically.</b> Messages mentioning safety, medical help, harassment, theft or an accident are marked Urgent and sorted first.</p>
            <p><b>Ops stay out of it</b> unless you hand a ticket over. It then appears in their Issues inbox as Urgent.</p>
            <p><b>Your app still hears about it.</b> Every ticket also fires the <code>care.mentioned</code> webhook, so your own CRM can open a case.</p>
          </div>
        </Panel>
      </>}
    </section>
  );
}
