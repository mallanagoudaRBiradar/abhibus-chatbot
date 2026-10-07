import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useData } from '../lib/live';
import { href } from '../lib/router';
import { ago, fmtDateTime, fmtTime, SEV_HELP, SEV_TONE, SEV_WORD, STATE_LABEL, STATE_TONE, UNIT } from '../lib/format';
import { Btn, Chip, Choice, Empty, ErrorBox, Field, Loading, Modal, Panel, Ref, Seg, Steps, Switch, Tabs, useAction } from '../components/ui';
import { LivePhone } from '../components/LivePhone';
import { Icon } from '../components/Icon';
import { EditRoom } from './rooms-admin';
import { InboxItem, RoomFeed, Travellers, ROOM_EVENTS } from './ops';
import { EVENTS, GROUPS, REASONS, describeUpdate, type EventDef } from './events';

type Tab = 'chat' | 'route' | 'travellers' | 'history';

// ============================================================== room page ===
/**
 * One trip room, laid out as the job: what's wrong (top), what you can do (one row of actions),
 * then the detail in tabs. Every tab is a URL: #/ops/rooms/<id>/<tab>.
 */
export function OpsRoom({ id, tab = 'chat' }: { id: string; tab?: string }) {
  const { can, tenants } = useAuth();
  const d = useData<any>(`/rooms/${id}`, { refreshOn: ROOM_EVENTS, room: id, every: 20_000 });
  const [modal, setModal] = useState<null | 'update' | 'message' | 'controls' | 'manage'>(null);
  const back = <a className="btn sm ghost" href={href('/ops/rooms')}>‹ All rooms</a>;
  if (d.error) return <section className="cmain">{back}<ErrorBox msg={d.error} retry={d.reload} /></section>;
  if (!d.data) return <section className="cmain"><Loading /></section>;
  const { room, chips, location, stops, next_stop_idx, members, actions } = d.data;
  const updates: any[] = d.data.updates ?? []; // older servers don't send update history
  const brand = tenants.find((t) => t.id === room.tenant_id)?.theme.brand;
  const t = (['chat', 'route', 'travellers', 'history'].includes(tab) ? tab : 'chat') as Tab;
  const open = actions.filter((a: any) => a.status !== 'resolved');
  const travellers = members.filter((m: any) => !m.removed && m.role === 'traveller').length;
  const last = stops[stops.length - 1];
  const live = ['open', 'onboard', 'scheduled', 'dormant'].includes(room.state);
  const base = `/ops/rooms/${id}`;

  return (
    <>
      <section className="cmain">
        <div>{back}</div>
        {/* -------- who / what / where, in one glance -------- */}
        <header className="rhead">
          <div className="rh-top">
            <Ref code={room.ref} title="Room reference. Click to copy, paste it anywhere in the console search." />
            <Chip tone={STATE_TONE[room.state]}>{STATE_LABEL[room.state] ?? room.state}</Chip>
            {chips.filter((c: any) => c.label !== 'On time').map((c: any) => <Chip key={c.label} tone={`c-${c.tone}`}>{c.label}</Chip>)}
          </div>
          <h2>{room.title}</h2>
          <p className="muted">{room.subtitle} · {room.tenant_name} · {UNIT[room.vertical]}{room.meta?.vehicle_no ? ` · ${room.meta.vehicle_no}` : ''}</p>
          <dl className="facts">
            <div><dt>Departs</dt><dd>{fmtDateTime(room.schedule.departs_at)}</dd></div>
            <div><dt>Arrives</dt><dd>{last?.eta_label ?? fmtTime(room.schedule.arrives_at)}{room.delay_min > 0 && <small className="late"> +{room.delay_min} min</small>}</dd></div>
            <div><dt>Where now</dt><dd>{location.near}<small> {location.source}, {location.confidence}</small></dd></div>
            <div><dt>Next stop</dt><dd>{stops[next_stop_idx]?.name ?? '—'}<small> {stops[next_stop_idx]?.eta_label ?? ''}</small></dd></div>
            <div><dt>Travellers</dt><dd>{travellers}</dd></div>
          </dl>
          {(live || can('rooms.manage')) && (can('rooms.act') || can('campaigns.write') || can('rooms.manage')) && (
            <div className="actbar">
              {can('rooms.act') && live && <>
                <Btn kind="pri" className="big" onClick={() => setModal('update')}>Report a trip update</Btn>
                <Btn className="big" onClick={() => setModal('message')}>Message travellers</Btn>
              </>}
              {can('campaigns.write') && live && <a className={`btn big ${can('rooms.act') ? '' : 'pri'}`} href={href(`/marketing/new/${id}`)}>Run a campaign here</a>}
              {can('rooms.act') && live && <Btn kind="ghost" onClick={() => setModal('controls')}>Room controls{room.ops_only || room.slow_mode ? ' •' : ''}</Btn>}
              {can('rooms.manage') && <Btn kind="ghost" onClick={() => setModal('manage')}><Icon name="edit" size={15} /> Manage room</Btn>}
              <small className="hint">{can('rooms.act') ? <>Delay, breakdown, platform or gate change → <b>trip update</b>. Anything else → <b>message</b>. </> : null}{can('campaigns.write') ? <>A <b>campaign</b> started here targets this route and shows in this chat, in every app.</> : null}</small>
            </div>
          )}
        </header>

        {/* -------- problems first -------- */}
        {open.length ? (
          <Panel className="attn" title={<>Needs attention · {open.length}</>} right={<a className="lnk" href={href('/ops/inbox')}>All issues →</a>}>
            <div className="inb">{open.slice(0, 5).map((a: any) => <InboxItem key={a.id} a={a} reload={d.reload} compact />)}</div>
            {open.length > 5 && <p className="hint">+{open.length - 5} more in the <a className="lnk" href={href('/ops/inbox')}>inbox</a>.</p>}
          </Panel>
        ) : <div className="allgood">✓ Nothing needs attention in this room right now.</div>}

        <Tabs at={t} tabs={[
          { id: 'chat', label: 'Conversation', href: href(base) },
          { id: 'route', label: `Route & ETAs`, href: href(`${base}/route`) },
          { id: 'travellers', label: `Travellers · ${travellers}`, href: href(`${base}/travellers`) },
          { id: 'history', label: `Updates · ${updates.length}`, href: href(`${base}/history`) },
        ]} />

        {t === 'chat' && <RoomFeed id={id} canModerate={can('moderation.act')} members={members} reloadRoom={d.reload} />}
        {t === 'route' && <RouteView room={room} stops={stops} next={next_stop_idx} />}
        {t === 'travellers' && <Travellers data={d.data} reload={d.reload} />}
        {t === 'history' && <History updates={updates} actions={actions} />}
      </section>
      <LivePhone roomId={id} brand={brand} />
      {modal === 'update' && <ReportUpdate data={d.data} onClose={() => setModal(null)} onDone={() => { setModal(null); d.reload(); }} />}
      {modal === 'message' && <MessageTravellers room={room} templates={d.data.templates} travellers={travellers} onClose={() => setModal(null)} />}
      {modal === 'controls' && <RoomControls room={room} onClose={() => setModal(null)} reload={d.reload} />}
      {modal === 'manage' && <EditRoom id={id} onClose={() => setModal(null)} onDone={() => { setModal(null); d.reload(); }} />}
    </>
  );
}

function RouteView({ room, stops, next }: { room: any; stops: any[]; next: number }) {
  return (
    <Panel title={`Route · ${stops.length} stops`}>
      <div className="stops">{stops.map((s: any, i: number) => (
        <div key={s.code + i} className={`stop ${s.passed ? 'passed' : ''} ${i === next ? 'next' : ''}`}>
          <i /><div><b>{s.name}</b><small>{s.code}{s.type ? ` · ${s.type.replace('_', ' ')}` : ''}{s.terminal ? ` · T${String(s.terminal).replace(/^T/, '')}` : ''}{s.gate ? ` · gate ${s.gate}` : ''}</small></div>
          <span className="num">{s.eta_label}{i === next && <small style={{ color: 'var(--amber)' }}>next</small>}</span>
        </div>
      ))}</div>
      <p className="hint" style={{ marginTop: 8 }}>Opens {fmtDateTime(room.opens_at)} · becomes read-only {fmtDateTime(room.read_only_at)} · content deleted {fmtDateTime(room.purge_at)} · trip key <code>{room.trip_key}</code></p>
    </Panel>
  );
}

/** Every trip update and issue in this room, newest first, each with its reference. */
function History({ updates, actions }: { updates: any[]; actions: any[] }) {
  const rows = [
    ...updates.map((u) => ({ at: u.created_at, ref: u.ref, kind: 'Update', title: EVENTS[u.type]?.label ?? u.type, sub: describeUpdate(u.type, u.data), who: u.actor, tone: 'c-info' })),
    ...actions.map((a) => ({ at: a.created_at, ref: a.ref, kind: 'Issue', title: a.title, sub: `${SEV_WORD[a.severity]} · ${a.status}`, who: a.assignee ?? 'traveller', tone: SEV_TONE[a.severity] })),
  ].sort((a, b) => +new Date(b.at) - +new Date(a.at));
  if (!rows.length) return <Empty>No trip updates or issues yet. Use “Report a trip update” when something changes.</Empty>;
  return (
    <div className="tw"><table>
      <thead><tr><th>When</th><th>Ref</th><th>What</th><th>By</th></tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={r.ref}>
          <td className="num" title={r.at}>{fmtTime(r.at)}<small>{ago(r.at)}</small></td>
          <td><Ref code={r.ref} /></td>
          <td><Chip tone={r.tone}>{r.kind}</Chip> <b>{r.title}</b><small>{r.sub}</small></td>
          <td>{r.who}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

// ======================================================== report an update ===
/**
 * Guided: 1) what happened (plain words, grouped) → 2) only the details that type needs
 * → 3) review exactly what changes and what travellers will read (server dry run) → send.
 */
function ReportUpdate({ data, onClose, onDone }: { data: any; onClose: () => void; onDone: () => void }) {
  const { room, stops, event_types, next_stop_idx } = data;
  const travellers = data.members.filter((m: any) => !m.removed && m.role === 'traveller').length;
  const [step, setStep] = useState(0);
  const [type, setType] = useState<string | null>(null);
  const [vals, setVals] = useState<Record<string, any>>({});
  const [announce, setAnnounce] = useState(true);
  const [push, setPush] = useState(true);
  const [sms, setSms] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const [pErr, setPErr] = useState<string | null>(null);
  const { busy, run } = useAction();

  // Offer what makes sense now: "Back on time" only when late, "Breakdown fixed" only when broken down.
  const offered = useMemo(() => {
    const list: [string, EventDef][] = (event_types as string[]).filter((k) => EVENTS[k]).map((k) => [k, EVENTS[k]]);
    return list.filter(([k]) => (k === 'resolved' ? room.breakdown : k === 'breakdown' ? !room.breakdown : true));
  }, [event_types, room.breakdown]);
  const clearDelay = room.delay_min > 0 && event_types.includes('delay');
  const def = type === '__clear' ? { label: 'Back on time', desc: '', icon: '✓', group: 'Timing' as const, fields: [] } : type ? EVENTS[type] : null;
  const missing = def?.fields.filter((f) => f.required && (vals[f.key] === undefined || vals[f.key] === '')).map((f) => f.label) ?? [];

  const payload = () => {
    if (type === '__clear') return { type: 'delay', minutes: -room.delay_min, auto_announce: announce, channels: [...(push ? ['push'] : []), ...(sms ? ['sms'] : [])] };
    const b: any = { type, auto_announce: announce, channels: [...(push ? ['push'] : []), ...(sms ? ['sms'] : [])] };
    for (const f of def?.fields ?? []) if (vals[f.key] !== undefined && vals[f.key] !== '') b[f.key] = f.kind === 'minutes' || f.kind === 'restMinutes' ? Number(vals[f.key]) : vals[f.key];
    return b;
  };
  useEffect(() => {
    if (step !== 2) return;
    setPreview(null); setPErr(null);
    api(`/rooms/${room.id}/trip-events`, { body: payload(), query: { dry_run: 'true' } }).then(setPreview).catch((e) => setPErr(e.message));
  }, [step, announce]); // eslint-disable-line

  const choose = (k: string) => { setType(k); setVals(k === 'rest_stop_started' ? { minutes: 15, at_stop: stops[next_stop_idx]?.code } : k === 'stop_arrived' ? { at_stop: stops[next_stop_idx]?.code } : {}); setStep((k === '__clear' || !EVENTS[k]?.fields.length) ? 2 : 1); };
  const send = async () => {
    const r = await run('send', () => api<any>(`/rooms/${room.id}/trip-events`, { body: payload() }), (x: any) => `${def?.label} applied · ${x.ref}${x.announcement_id ? ` · ${travellers} travellers alerted` : ''}`);
    if (r) onDone();
  };
  const set = (k: string, v: any) => setVals((x) => ({ ...x, [k]: v }));

  return (
    <Modal wide title={<>Report a trip update <small className="muted" style={{ fontWeight: 400 }}>· {room.ref} {room.title}</small></>} onClose={onClose}>
      <Steps steps={['What happened?', 'Details', 'Review & send']} at={step} onGo={setStep} />

      {step === 0 && (
        <div className="choose">
          {clearDelay && <div className="cgroup"><h4>Suggested</h4><div className="choice-grid"><Choice icon="✓" title="Back on time" desc={`Clear the ${room.delay_min} min delay. ETAs return to the timetable.`} onClick={() => choose('__clear')} /></div></div>}
          {GROUPS.map((g) => {
            const items = offered.filter(([, e]) => e.group === g);
            return items.length ? (
              <div key={g} className="cgroup"><h4>{g}</h4>
                <div className="choice-grid">{items.map(([k, e]) => <Choice key={k} icon={e.icon} title={e.label} desc={e.desc} tone={e.tone} on={type === k} onClick={() => choose(k)} />)}</div>
              </div>
            ) : null;
          })}
          <p className="hint">Need to say something that isn’t a trip change? Close this and use <b>Message travellers</b>.</p>
        </div>
      )}

      {step === 1 && def && (
        <div className="f" style={{ gap: 14 }}>
          <div className="pickd"><span className="ci">{def.icon}</span><div><b>{def.label}</b><small>{def.desc}</small></div><Btn sm kind="ghost" onClick={() => setStep(0)}>Change</Btn></div>
          {def.fields.map((f) => (
            <Field key={f.key} label={<>{f.label}{f.required ? '' : <span className="hint"> · optional</span>}</>} hint={f.help}>
              {f.kind === 'minutes' && <div className="fil">{[15, 30, 45, 60, 90, 120].map((n) => <button type="button" key={n} className={`pickchip ${Number(vals[f.key]) === n ? 'on' : ''}`} onClick={() => set(f.key, n)}>{n} min</button>)}<input type="number" min={1} max={1440} className="num-in" placeholder="Other" value={[15, 30, 45, 60, 90, 120].includes(Number(vals[f.key])) ? '' : vals[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} /></div>}
              {f.kind === 'restMinutes' && <div className="fil">{[10, 15, 20, 30].map((n) => <button type="button" key={n} className={`pickchip ${Number(vals[f.key]) === n ? 'on' : ''}`} onClick={() => set(f.key, n)}>{n} min</button>)}</div>}
              {f.kind === 'stop' && <select value={vals[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)}><option value="">Choose a stop…</option>{stops.map((s: any, i: number) => <option key={s.code + i} value={s.code}>{s.name} · {s.eta_label}{i === next_stop_idx ? ' (next)' : s.passed ? ' (passed)' : ''}</option>)}</select>}
              {f.kind === 'text' && <input value={vals[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} placeholder={f.placeholder} />}
              {f.kind === 'reason' && <>
                {REASONS[type!] && <div className="fil">{REASONS[type!].map((r) => <button type="button" key={r} className={`pickchip ${vals[f.key] === r ? 'on' : ''}`} onClick={() => set(f.key, vals[f.key] === r ? '' : r)}>{r}</button>)}</div>}
                <input value={vals[f.key] ?? ''} maxLength={200} onChange={(e) => set(f.key, e.target.value)} placeholder="Or type your own" />
              </>}
            </Field>
          ))}
          <div className="modal-foot">
            <Btn kind="ghost" onClick={() => setStep(0)}>Back</Btn>
            <span className="hint">{missing.length ? `Still needed: ${missing.join(', ')}` : ''}</span>
            <Btn kind="pri" disabled={!!missing.length} onClick={() => setStep(2)}>Review</Btn>
          </div>
        </div>
      )}

      {step === 2 && def && (
        <div className="review">
          <div className="pickd"><span className="ci">{def.icon}</span><div><b>{def.label}</b><small>{type === '__clear' ? `Clears the ${room.delay_min} min delay` : describeUpdate(type!, payload())}</small></div><Btn sm kind="ghost" onClick={() => setStep(def.fields.length ? 1 : 0)}>Edit</Btn></div>
          {pErr ? <ErrorBox msg={pErr} /> : !preview ? <Loading /> : <>
            <div className="g2">
              <div>
                <h4 className="rv-h">What changes in the room</h4>
                {preview.changes.length ? <ul className="changes">{preview.changes.map((c: string) => <li key={c}>{c}</li>)}</ul> : <p className="hint">No trip facts change. This is recorded in the room’s history.</p>}
                <h4 className="rv-h">Tell travellers</h4>
                <div className="tog"><span>Post the standard alert in the room <small className="hint">pinned, English + Hindi</small></span><Switch on={announce} label="Post alert" onChange={setAnnounce} /></div>
                {announce && <div className="checks" style={{ marginTop: 8 }}><label><input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} /> Push notification</label><label><input type="checkbox" checked={sms} onChange={(e) => setSms(e.target.checked)} /> SMS</label></div>}
              </div>
              <div>
                <h4 className="rv-h">What {travellers} travellers will see</h4>
                {announce && preview.announcement ? <AlertPreview text={preview.announcement.text} hi={preview.announcement.hi} sev={preview.announcement.severity} /> : <p className="hint">{announce ? 'There’s no standard alert for this update. Send a message afterwards if travellers need to know.' : 'Nothing is posted. Only the trip facts change.'}</p>}
              </div>
            </div>
          </>}
          <div className="modal-foot">
            <Btn kind="ghost" onClick={() => setStep(def.fields.length ? 1 : 0)}>Back</Btn>
            <span />
            <Btn kind={def.tone === 'danger' ? 'danger' : 'pri'} className="big" busy={busy === 'send'} disabled={!preview} onClick={send}>
              {announce && preview?.announcement ? `Send update to ${travellers} travellers` : 'Apply update'}
            </Btn>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** How an alert looks pinned in the chat. */
function AlertPreview({ text, hi, sev }: { text: string; hi?: string | null; sev: string }) {
  return (
    <div className={`apv ${sev}`}>
      <div className="apv-h"><span className={`chip ${SEV_TONE[sev]}`}>{SEV_WORD[sev]}</span><small>Ops · pinned</small></div>
      <p>{text || <span className="hint">Your message appears here.</span>}</p>
      {hi && <p className="apv-hi">{hi}</p>}
    </div>
  );
}

// ======================================================== message travellers ===
function MessageTravellers({ room, templates, travellers, onClose }: { room: any; templates: { id: string; label: string; severity: string }[]; travellers: number; onClose: () => void }) {
  const [tpl, setTpl] = useState('');
  const [text, setText] = useState('');
  const [hi, setHi] = useState<string | null>(null);
  const [sev, setSev] = useState<'info' | 'warning' | 'critical'>('warning');
  const [push, setPush] = useState(true);
  const [sms, setSms] = useState(false);
  const { busy, run } = useAction();
  useEffect(() => {
    if (!tpl) { setHi(null); return; }
    api(`/rooms/${room.id}/template/${tpl}`).then((t: any) => { setText(t.text); setHi(t.hi); setSev(t.severity); setSms(t.severity === 'critical'); }).catch(() => {});
  }, [tpl, room.id]);
  const send = async () => {
    const r = await run('alert', () => api<any>(`/rooms/${room.id}/alerts`, { body: { text: text.trim(), severity: sev, push, sms, ...(hi && tpl ? { translations: { hi } } : {}) } }), (x: any) => `Posted & pinned · ${x.in_room} in room · ${x.push} push · ${x.sms} SMS`);
    if (r) onClose();
  };
  return (
    <Modal wide title={<>Message travellers <small className="muted" style={{ fontWeight: 400 }}>· {room.ref} {room.title}</small></>} onClose={onClose}>
      <div className="g2">
        <div className="f" style={{ gap: 12 }}>
          {templates.length > 0 && <Field label="Start from a template" hint="Filled with this trip’s stop names and times. Edit freely."><div className="fil">{templates.map((t) => <button type="button" key={t.id} className={`pickchip ${tpl === t.id ? 'on' : ''}`} onClick={() => setTpl(tpl === t.id ? '' : t.id)}>{t.label}</button>)}</div></Field>}
          <Field label="Message" hint={`${500 - text.length} characters left`}><textarea value={text} onChange={(e) => { setText(e.target.value); if (tpl) setHi(null); }} maxLength={500} placeholder="What should every traveller know?" /></Field>
          <Field label="How urgent?" hint={SEV_HELP[sev]}><Seg value={sev} onChange={(v) => { setSev(v); setSms(v === 'critical'); }} options={[['info', 'FYI'], ['warning', 'Important'], ['critical', 'Urgent']]} /></Field>
          <Field label="Also notify outside the app"><div className="checks"><label><input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} /> Push</label><label><input type="checkbox" checked={sms} onChange={(e) => setSms(e.target.checked)} /> SMS</label></div></Field>
        </div>
        <div>
          <h4 className="rv-h">What {travellers} travellers will see</h4>
          <AlertPreview text={text} hi={tpl ? hi : null} sev={sev} />
          <p className="hint" style={{ marginTop: 8 }}>Push and SMS go out through {room.tenant_name}’s own notification stack.</p>
        </div>
      </div>
      <div className="modal-foot"><Btn kind="ghost" onClick={onClose}>Cancel</Btn><span /><Btn kind="pri" className="big" busy={busy === 'alert'} disabled={!text.trim()} onClick={send}>Post & pin to {travellers} travellers</Btn></div>
    </Modal>
  );
}

// ============================================================ room controls ===
function RoomControls({ room, onClose, reload }: { room: any; onClose: () => void; reload: () => void }) {
  const [crew, setCrew] = useState('');
  const { busy, run } = useAction();
  const crewRole = room.vertical === 'flight' ? 'Cabin crew' : room.vertical === 'train' ? 'TTE' : 'Conductor';
  const mod = (action: string, enabled: boolean) => run(action, () => api(`/rooms/${room.id}/moderation`, { body: { action, enabled } }), `${action === 'ops_only' ? 'Ops-only mode' : 'Slow mode'} ${enabled ? 'on' : 'off'}`).then(reload);
  return (
    <Modal title={<>Room controls <small className="muted" style={{ fontWeight: 400 }}>· {room.ref}</small></>} onClose={onClose}>
      <div className="tools">
        <h4 className="rv-h">Calm the room</h4>
        <div className="tog"><span>Ops-only mode <small className="hint">travellers can read but not post. Use during an incident.</small></span><Switch on={room.ops_only} label="Ops-only mode" onChange={(v) => mod('ops_only', v)} /></div>
        <div className="tog"><span>Slow mode <small className="hint">one message per traveller every ~30 s</small></span><Switch on={room.slow_mode} label="Slow mode" onChange={(v) => mod('slow_mode', v)} /></div>
        <h4 className="rv-h">Say sorry</h4>
        <div className="f"><label>Delay voucher for every traveller</label><div className="row">{[50, 100, 200].map((n) => <Btn key={n} sm busy={busy === `v${n}`} onClick={() => confirm(`Give every traveller in ${room.ref} a ₹${n} voucher?`) && run(`v${n}`, () => api(`/rooms/${room.id}/vouchers`, { body: { amount: n } }), `₹${n} voucher posted`)}>₹{n}</Btn>)}</div></div>
        <h4 className="rv-h">Speak as the crew</h4>
        <div className="f"><label>Post as {crewRole}</label><div className="row">
          <input value={crew} onChange={(e) => setCrew(e.target.value)} placeholder="e.g. Snacks being served in 10 minutes" style={{ flex: 1 }} />
          <Btn sm disabled={!crew.trim()} busy={busy === 'crew'} onClick={() => run('crew', () => api(`/rooms/${room.id}/crew`, { body: { text: crew.trim() } }), `Posted as ${crewRole}`).then((r) => r && setCrew(''))}>Post</Btn>
        </div></div>
      </div>
    </Modal>
  );
}
