import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useData } from '../lib/live';
import { go, href, useQuery } from '../lib/router';
import { fmtDateTime, fmtTime, STATE_LABEL, STATE_TONE, UNIT } from '../lib/format';
import { Btn, Chip, Empty, ErrorBox, Field, Head, Loading, Modal, Ref, Seg, Steps, Switch, useAction, useToast } from '../components/ui';
import { Icon } from '../components/Icon';

/**
 * Room manager (admin). Everything about the life of a trip room in one place:
 * create one, create many (route × buses × days, previewed first), edit and save,
 * end the chat, close, reopen or delete — for one room or a selection.
 */
const STATES: [string, string, string][] = [
  ['active', 'Active', 'scheduled,dormant,open,onboard'],
  ['ended', 'Chat ended', 'read_only'],
  ['closed', 'Closed', 'closed'],
  ['all', 'All', 'scheduled,dormant,open,onboard,read_only,closed'],
];
type Action = 'end_chat' | 'close' | 'reopen' | 'delete';
const ACTION: Record<Action, { label: string; verb: string; icon: string; help: string; danger?: boolean }> = {
  end_chat: { label: 'End chat', verb: 'End chat for', icon: 'stop', help: 'Travellers can still read the chat but can’t post. Use it when the trip is over or the room is getting out of hand.' },
  close: { label: 'Close room', verb: 'Close', icon: 'x', help: 'Nobody can open the room any more. Messages are kept until the normal deletion time.', danger: true },
  reopen: { label: 'Reopen', verb: 'Reopen', icon: 'play', help: 'Travellers can open and post again. Use it if a room was ended or closed by mistake.' },
  delete: { label: 'Delete room', verb: 'Delete', icon: 'trash', help: 'All messages, members’ chat history and locations are deleted now and the room disappears from the console. The audit log keeps a record. This can’t be undone.', danger: true },
};

// IST helpers: the console always talks in Indian time.
export const toIstInput = (iso: string) => new Date(+new Date(iso) + 330 * 60_000).toISOString().slice(0, 16);
export const fromIstInput = (v: string) => new Date(`${v}:00+05:30`).toISOString();
const todayIst = (plusDays = 0) => new Date(Date.now() + 330 * 60_000 + plusDays * 86_400_000).toISOString().slice(0, 10);

export function RoomManager() {
  const [qs, setQs] = useQuery();
  const state = qs.get('state') ?? 'active';
  const [text, setText] = useState(qs.get('q') ?? '');
  useEffect(() => { const t = setTimeout(() => setQs({ q: text.trim() || null }), 250); return () => clearTimeout(t); }, [text]); // eslint-disable-line
  const { tenant } = useAuth();
  const rooms = useData<{ data: any[]; total: number }>('/rooms', { query: { tenant, state: STATES.find((s) => s[0] === state)?.[2], q: qs.get('q') ?? '', sort: 'departs', vertical: qs.get('mode') ?? '' }, refreshOn: ['room.'], every: 30_000 });
  const rows = rooms.data?.data ?? [];
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<null | { kind: 'create' } | { kind: 'bulk' } | { kind: 'edit'; id: string } | { kind: 'action'; action: Action; ids: string[] }>(null);
  const [menu, setMenu] = useState<string | null>(null);
  useEffect(() => setSel(new Set()), [state, qs.get('q')]); // eslint-disable-line
  const allOn = rows.length > 0 && rows.every((r) => sel.has(r.id));
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const picked = rows.filter((r) => sel.has(r.id));
  const done = () => { setModal(null); setSel(new Set()); rooms.reload(); };

  return (
    <section className="cmain">
      <Head title="Room manager" sub="Create trip rooms for any route, bus and day, edit them, or end, close and delete them. Every change is audited and connected apps follow along."
        right={<><Btn onClick={() => setModal({ kind: 'bulk' })}><Icon name="calendar" size={16} /> Create many</Btn><Btn kind="pri" onClick={() => setModal({ kind: 'create' })}><Icon name="plus" size={16} /> Create room</Btn></>} />
      <div className="filters">
        <input className="fsearch" type="search" placeholder="Search TR- key, bus number, operator, route, trip key…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search rooms" />
        <div className="split">
          <Seg value={state as any} onChange={(v: string) => setQs({ state: v === 'active' ? null : v })} options={STATES.map(([k, l]) => [k, l]) as any} />
          <Seg value={(qs.get('mode') ?? '') as any} onChange={(v: string) => setQs({ mode: v || null })} options={[['', 'All modes'], ['bus', 'Bus'], ['train', 'Train'], ['flight', 'Flight']]} />
        </div>
        <div className="fstate"><b>{rooms.data ? `${rooms.data.total ?? rows.length} room${(rooms.data.total ?? rows.length) === 1 ? '' : 's'}` : 'Loading…'}</b><span className="hint"> · tick rooms to act on several at once</span></div>
      </div>
      {rooms.error ? <ErrorBox msg={rooms.error} retry={rooms.reload} /> : !rooms.data ? <Loading /> : !rows.length ? (
        <Empty>No rooms here. <button type="button" className="lnk" onClick={() => setModal({ kind: 'create' })}>Create one</button> or <button type="button" className="lnk" onClick={() => setModal({ kind: 'bulk' })}>create many at once</button>.</Empty>
      ) : (
        <div className="tw"><table>
          <thead><tr>
            <th className="sel"><input type="checkbox" checked={allOn} aria-label="Select all" onChange={() => setSel(allOn ? new Set() : new Set(rows.map((r) => r.id)))} /></th>
            <th>Departs</th><th>Trip</th><th>Status</th><th className="num">Travellers</th><th>Trip key</th><th />
          </tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id} className={sel.has(r.id) ? 'picked' : ''}>
              <td className="sel"><input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Select ${r.ref}`} /></td>
              <td className="dep"><b>{fmtTime(r.schedule.departs_at)}</b><small>{fmtDateTime(r.schedule.departs_at).split(',')[0]}</small></td>
              <td><div className="rcell"><a className="lnk" href={href(`/ops/rooms/${r.id}`)}><b>{r.title}</b></a><Ref code={r.ref} /></div><small><b className="op">{r.facets?.operator}</b>{r.facets?.vehicle ? ` · ${r.facets.vehicle}` : ''} · {UNIT[r.vertical]}</small></td>
              <td><Chip tone={STATE_TONE[r.state]}>{STATE_LABEL[r.state] ?? r.state}</Chip></td>
              <td className="num">{r.member_count}</td>
              <td><code className="tk">{r.trip_key}</code></td>
              <td className="rowmenu">
                <button type="button" className="iconbtn" aria-label={`Actions for ${r.ref}`} aria-expanded={menu === r.id} onClick={() => setMenu(menu === r.id ? null : r.id)}><Icon name="dots" /></button>
                {menu === r.id && (
                  <div className="rowmenu-pop" onMouseLeave={() => setMenu(null)}>
                    <button type="button" onClick={() => go(`/ops/rooms/${r.id}`)}><Icon name="arrow" size={15} /> Open room</button>
                    <button type="button" onClick={() => { setMenu(null); setModal({ kind: 'edit', id: r.id }); }}><Icon name="edit" size={15} /> Edit</button>
                    <hr />
                    {['read_only', 'closed'].includes(r.state)
                      ? <button type="button" onClick={() => { setMenu(null); setModal({ kind: 'action', action: 'reopen', ids: [r.id] }); }}><Icon name="play" size={15} /> Reopen</button>
                      : <button type="button" onClick={() => { setMenu(null); setModal({ kind: 'action', action: 'end_chat', ids: [r.id] }); }}><Icon name="stop" size={15} /> End chat</button>}
                    {r.state !== 'closed' && <button type="button" onClick={() => { setMenu(null); setModal({ kind: 'action', action: 'close', ids: [r.id] }); }}><Icon name="x" size={15} /> Close room</button>}
                    <button type="button" className="danger" onClick={() => { setMenu(null); setModal({ kind: 'action', action: 'delete', ids: [r.id] }); }}><Icon name="trash" size={15} /> Delete</button>
                  </div>
                )}
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {picked.length > 0 && (
        <div className="bulkbar" role="toolbar" aria-label="Selected rooms">
          <b>{picked.length} selected</b>
          <button type="button" className="btn sm" onClick={() => setModal({ kind: 'action', action: 'end_chat', ids: picked.map((r) => r.id) })}><Icon name="stop" size={14} /> End chat</button>
          <button type="button" className="btn sm" onClick={() => setModal({ kind: 'action', action: 'close', ids: picked.map((r) => r.id) })}><Icon name="x" size={14} /> Close</button>
          <button type="button" className="btn sm" onClick={() => setModal({ kind: 'action', action: 'reopen', ids: picked.map((r) => r.id) })}><Icon name="play" size={14} /> Reopen</button>
          <button type="button" className="btn sm danger" onClick={() => setModal({ kind: 'action', action: 'delete', ids: picked.map((r) => r.id) })}><Icon name="trash" size={14} /> Delete</button>
          <button type="button" className="btn sm" onClick={() => setSel(new Set())}>Clear</button>
        </div>
      )}
      {modal?.kind === 'create' && <CreateRoom onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === 'bulk' && <BulkCreate onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === 'edit' && <EditRoom id={modal.id} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === 'action' && <ConfirmAction action={modal.action} rooms={rows.filter((r) => modal.ids.includes(r.id))} onClose={() => setModal(null)} onDone={done} />}
    </section>
  );
}

// ------------------------------------------------------------ confirm ---
export function ConfirmAction({ action, rooms, onClose, onDone }: { action: Action; rooms: { id: string; ref: string; title: string }[]; onClose: () => void; onDone: () => void }) {
  const a = ACTION[action];
  const [msg, setMsg] = useState(action === 'end_chat' ? 'This trip chat has now ended. Thank you for travelling with us.' : action === 'close' ? 'This trip chat is now closed.' : '');
  const [typed, setTyped] = useState('');
  const { busy, run } = useAction();
  const word = rooms.length === 1 ? rooms[0].ref : 'DELETE';
  const go = async () => {
    const one = rooms.length === 1;
    const r = await run('go', () => (one
      ? api(`/rooms/${rooms[0].id}/lifecycle`, { body: { action, ...(msg.trim() && action !== 'delete' ? { message: msg.trim() } : {}) } })
      : api('/rooms/bulk-action', { body: { ids: rooms.map((x) => x.id), action, ...(msg.trim() && action !== 'delete' ? { message: msg.trim() } : {}) } })),
    `${a.label}: ${one ? rooms[0].ref : `${rooms.length} rooms`}`);
    if (r) onDone();
  };
  return (
    <Modal title={`${a.verb} ${rooms.length === 1 ? rooms[0].ref : `${rooms.length} rooms`}?`} onClose={onClose}>
      <div className="f" style={{ gap: 14 }}>
        <p className="muted" style={{ margin: 0 }}>{a.help}</p>
        <div className="keyline">{rooms.slice(0, 8).map((r) => <span key={r.id}><Ref code={r.ref} /> {r.title}</span>)}{rooms.length > 8 && <span>+{rooms.length - 8} more</span>}</div>
        {action !== 'delete' && <Field label="Message to travellers (optional)" hint="Posted and pinned in the room first, so nobody is left wondering."><textarea value={msg} onChange={(e) => setMsg(e.target.value)} maxLength={500} /></Field>}
        {action === 'delete' && (
          <div className="danger-zone">
            <h4>This permanently deletes {rooms.length === 1 ? 'this room' : `${rooms.length} rooms`}.</h4>
            <Field label={<>Type <code>{word}</code> to confirm</>}><input className="confirm-input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={word} autoFocus /></Field>
          </div>
        )}
        <div className="modal-foot"><Btn kind="ghost" onClick={onClose}>Cancel</Btn><span /><Btn kind={a.danger ? 'danger' : 'pri'} busy={busy === 'go'} disabled={action === 'delete' && typed.trim().toUpperCase() !== word.toUpperCase()} onClick={go}><Icon name={a.icon} size={15} /> {a.label}{rooms.length > 1 ? ` (${rooms.length})` : ''}</Btn></div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------- shared route form ---
type Stop = { name: string; at_min: number; type: 'halt' | 'rest_stop' | 'boarding' | 'dropping' };
type RouteForm = { tenant: string; vertical: 'bus' | 'train' | 'flight'; from: string; to: string; hours: number; minutes: number; stops: Stop[]; activation: 'always' | 'on_delay' };
const blankRoute = (tenant: string): RouteForm => ({ tenant, vertical: 'bus', from: '', to: '', hours: 9, minutes: 0, stops: [], activation: 'always' });
const routeBody = (f: RouteForm) => ({ tenant: f.tenant, vertical: f.vertical, from: f.from.trim(), to: f.to.trim(), duration_min: f.hours * 60 + f.minutes, stops: f.stops.filter((s) => s.name.trim()).map((s) => ({ name: s.name.trim(), at_min: s.at_min, type: s.type })), activation: f.activation });
const routeMissing = (f: RouteForm) => [!f.tenant && 'app', !f.from.trim() && 'from', !f.to.trim() && 'to', f.hours * 60 + f.minutes < 15 && 'a journey time'].filter(Boolean) as string[];

function RouteFields({ f, set }: { f: RouteForm; set: (p: Partial<RouteForm>) => void }) {
  const { tenants } = useAuth();
  const t = tenants.find((x) => x.id === f.tenant);
  return (
    <div className="f" style={{ gap: 14 }}>
      <div className="formgrid">
        <Field label="App"><select value={f.tenant} onChange={(e) => set({ tenant: e.target.value })}>{tenants.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
        <Field label="Mode"><select value={f.vertical} onChange={(e) => set({ vertical: e.target.value as any })}>{(t?.verticals ?? ['bus']).filter((v) => v !== 'custom').map((v) => <option key={v} value={v}>{UNIT[v]}</option>)}</select></Field>
      </div>
      <div className="formgrid">
        <Field label="From"><input value={f.from} onChange={(e) => set({ from: e.target.value })} placeholder="e.g. Hyderabad" /></Field>
        <Field label="To"><input value={f.to} onChange={(e) => set({ to: e.target.value })} placeholder="e.g. Bengaluru" /></Field>
        <Field label="Journey time"><div className="fil"><input type="number" min={0} max={72} value={f.hours} onChange={(e) => set({ hours: Math.max(0, Number(e.target.value)) })} style={{ width: 80 }} /> h <input type="number" min={0} max={59} step={5} value={f.minutes} onChange={(e) => set({ minutes: Math.max(0, Number(e.target.value)) })} style={{ width: 80 }} /> min</div></Field>
      </div>
      <Field label="Stops on the way (optional)" hint="Minutes after departure. Rest stops get a 15-minute halt and the rest-stop timer.">
        <div className="stoplist">
          {f.stops.map((s, i) => (
            <div key={i} className="stoprow">
              <input value={s.name} onChange={(e) => set({ stops: f.stops.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} placeholder="Stop name, e.g. Kurnool" />
              <input type="number" min={1} value={s.at_min} onChange={(e) => set({ stops: f.stops.map((x, j) => (j === i ? { ...x, at_min: Number(e.target.value) } : x)) })} aria-label="Minutes after departure" />
              <select value={s.type} onChange={(e) => set({ stops: f.stops.map((x, j) => (j === i ? { ...x, type: e.target.value as any } : x)) })}><option value="halt">Halt</option><option value="rest_stop">Rest stop</option><option value="boarding">Boarding</option><option value="dropping">Dropping</option></select>
              <button type="button" className="iconbtn" aria-label="Remove stop" onClick={() => set({ stops: f.stops.filter((_, j) => j !== i) })}><Icon name="x" size={15} /></button>
            </div>
          ))}
          <div><Btn sm onClick={() => set({ stops: [...f.stops, { name: '', at_min: Math.round((f.hours * 60 + f.minutes) / 2), type: 'rest_stop' }] })}><Icon name="plus" size={14} /> Add stop</Btn></div>
        </div>
      </Field>
      <Field label="When the chat opens"><Seg value={f.activation} onChange={(v) => set({ activation: v })} options={[['always', 'Before departure, as usual'], ['on_delay', 'Only if the trip is delayed']]} /></Field>
    </div>
  );
}

// -------------------------------------------------------------- create ---
function CreateRoom({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { tenants } = useAuth();
  const toast = useToast();
  const [f, setF] = useState<RouteForm>(blankRoute(tenants[0]?.id ?? ''));
  const [bus, setBus] = useState({ operator_name: '', vehicle_no: '', coach: '', date: todayIst(), time: '21:30' });
  const { busy, run } = useAction();
  const missing = [...routeMissing(f), !bus.operator_name.trim() && 'operator'].filter(Boolean) as string[];
  const create = async () => {
    const r = await run('c', () => api<any>('/rooms', { body: { ...routeBody(f), operator_name: bus.operator_name.trim(), ...(bus.vehicle_no.trim() ? { vehicle_no: bus.vehicle_no.trim() } : {}), ...(bus.coach.trim() ? { coach: bus.coach.trim() } : {}), date: bus.date, time: bus.time } }));
    if (r) { toast(`Room ${r.ref} created`); onDone(); go(`/ops/rooms/${r.id}`); }
  };
  return (
    <Modal wide title="Create a room" onClose={onClose}>
      <RouteFields f={f} set={(p) => setF((x) => ({ ...x, ...p }))} />
      <h4 className="rv-h">Bus and time</h4>
      <div className="formgrid">
        <Field label="Operator"><input value={bus.operator_name} onChange={(e) => setBus({ ...bus, operator_name: e.target.value })} placeholder="e.g. VRL Travels" /></Field>
        <Field label="Bus number (optional)"><input value={bus.vehicle_no} onChange={(e) => setBus({ ...bus, vehicle_no: e.target.value })} placeholder="e.g. KA 01 AB 1234" /></Field>
        <Field label="Coach (optional)"><input value={bus.coach} onChange={(e) => setBus({ ...bus, coach: e.target.value })} placeholder="e.g. AC Sleeper 2+1" /></Field>
        <Field label="Date"><input type="date" value={bus.date} onChange={(e) => setBus({ ...bus, date: e.target.value })} /></Field>
        <Field label="Departure (IST)"><input type="time" value={bus.time} onChange={(e) => setBus({ ...bus, time: e.target.value })} /></Field>
      </div>
      <div className="modal-foot"><Btn kind="ghost" onClick={onClose}>Cancel</Btn><span className="hint">{missing.length ? `Still needed: ${missing.join(', ')}` : 'A unique TR- key is created for the room.'}</span><Btn kind="pri" busy={busy === 'c'} disabled={!!missing.length} onClick={create}><Icon name="plus" size={15} /> Create room</Btn></div>
    </Modal>
  );
}

// ---------------------------------------------------------- bulk create ---
type Bus = { operator_name: string; time: string; vehicle_no: string; coach: string };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function BulkCreate({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { tenants } = useAuth();
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [f, setF] = useState<RouteForm>(blankRoute(tenants[0]?.id ?? ''));
  const [buses, setBuses] = useState<Bus[]>([{ operator_name: '', time: '21:00', vehicle_no: '', coach: '' }]);
  const [paste, setPaste] = useState('');
  const [dates, setDates] = useState({ from: todayIst(), to: todayIst(6), weekdays: [0, 1, 2, 3, 4, 5, 6] });
  const [preview, setPreview] = useState<any>(null);
  const { busy, run } = useAction();
  const body = (dry: boolean) => ({ template: routeBody(f), buses: buses.filter((b) => b.operator_name.trim()).map((b) => ({ operator_name: b.operator_name.trim(), time: b.time, ...(b.vehicle_no.trim() ? { vehicle_no: b.vehicle_no.trim() } : {}), ...(b.coach.trim() ? { coach: b.coach.trim() } : {}) })), dates, dry_run: dry });
  const okBuses = buses.filter((b) => b.operator_name.trim() && /^\d{2}:\d{2}$/.test(b.time));
  const todo = [routeMissing(f), okBuses.length ? [] : ['at least one bus with an operator and time'], dates.weekdays.length && dates.from <= dates.to ? [] : ['a valid date range and at least one weekday'], []];
  useEffect(() => { if (step !== 3) return; setPreview(null); api('/rooms/bulk', { body: body(true) }).then(setPreview).catch((e) => setPreview({ error: e.message })); }, [step]); // eslint-disable-line
  const importPaste = () => {
    const rows = paste.split('\n').map((l) => l.split(/[,\t]/).map((x) => x.trim())).filter((x) => x[0]);
    const add = rows.map(([op, time, veh, coach]) => ({ operator_name: op, time: /^\d{1,2}:\d{2}$/.test(time ?? '') ? time.padStart(5, '0') : '21:00', vehicle_no: veh ?? '', coach: coach ?? '' }));
    if (add.length) { setBuses((b) => [...b.filter((x) => x.operator_name.trim()), ...add]); setPaste(''); }
  };
  const create = async () => {
    const r = await run('go', () => api<any>('/rooms/bulk', { body: body(false) }));
    if (r) { toast(`${r.created} room${r.created === 1 ? '' : 's'} created${r.skipped ? ` · ${r.skipped} already existed` : ''}`); onDone(); }
  };
  return (
    <Modal wide title="Create many rooms" onClose={onClose}>
      <Steps steps={['Route', 'Buses', 'Days', 'Review']} at={step} onGo={setStep} />
      {step === 0 && <RouteFields f={f} set={(p) => setF((x) => ({ ...x, ...p }))} />}
      {step === 1 && (
        <div className="f" style={{ gap: 12 }}>
          <p className="muted" style={{ margin: 0 }}>One row per bus that runs this route. Each one becomes a room on every day you pick.</p>
          <div className="busrow head"><small>Operator</small><small>Departs (IST)</small><small>Bus number</small><small>Coach</small><span /></div>
          {buses.map((b, i) => (
            <div key={i} className="busrow">
              <input value={b.operator_name} onChange={(e) => setBuses(buses.map((x, j) => (j === i ? { ...x, operator_name: e.target.value } : x)))} placeholder="e.g. FreshBus" />
              <input type="time" value={b.time} onChange={(e) => setBuses(buses.map((x, j) => (j === i ? { ...x, time: e.target.value } : x)))} />
              <input value={b.vehicle_no} onChange={(e) => setBuses(buses.map((x, j) => (j === i ? { ...x, vehicle_no: e.target.value } : x)))} placeholder="optional" />
              <input value={b.coach} onChange={(e) => setBuses(buses.map((x, j) => (j === i ? { ...x, coach: e.target.value } : x)))} placeholder="optional" />
              <button type="button" className="iconbtn" aria-label="Remove bus" disabled={buses.length === 1} onClick={() => setBuses(buses.filter((_, j) => j !== i))}><Icon name="x" size={15} /></button>
            </div>
          ))}
          <div className="fil"><Btn sm onClick={() => setBuses([...buses, { operator_name: buses[buses.length - 1]?.operator_name ?? '', time: '22:00', vehicle_no: '', coach: buses[buses.length - 1]?.coach ?? '' }])}><Icon name="plus" size={14} /> Add bus</Btn></div>
          <Field label="Or paste a list" hint="One bus per line: operator, departure, bus number, coach. Commas or tabs (straight from a spreadsheet).">
            <textarea value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={'VRL Travels, 21:30, KA 01 AB 1234, AC Sleeper\nFreshBus, 22:15'} />
            <div><Btn sm disabled={!paste.trim()} onClick={importPaste}>Add these buses</Btn></div>
          </Field>
        </div>
      )}
      {step === 2 && (
        <div className="f" style={{ gap: 14 }}>
          <div className="formgrid">
            <Field label="From date"><input type="date" value={dates.from} onChange={(e) => setDates({ ...dates, from: e.target.value })} /></Field>
            <Field label="To date"><input type="date" value={dates.to} onChange={(e) => setDates({ ...dates, to: e.target.value })} /></Field>
          </div>
          <Field label="Runs on"><div className="fil">{DAYS.map((d, i) => <button type="button" key={d} className={`pickchip ${dates.weekdays.includes(i) ? 'on' : ''}`} onClick={() => setDates({ ...dates, weekdays: dates.weekdays.includes(i) ? dates.weekdays.filter((x) => x !== i) : [...dates.weekdays, i].sort() })}>{d}</button>)}</div></Field>
          <div className="fil">
            <Btn sm onClick={() => setDates({ from: todayIst(), to: todayIst(), weekdays: [0, 1, 2, 3, 4, 5, 6] })}>Today only</Btn>
            <Btn sm onClick={() => setDates({ from: todayIst(1), to: todayIst(1), weekdays: [0, 1, 2, 3, 4, 5, 6] })}>Tomorrow</Btn>
            <Btn sm onClick={() => setDates({ from: todayIst(), to: todayIst(6), weekdays: [0, 1, 2, 3, 4, 5, 6] })}>Next 7 days</Btn>
            <Btn sm onClick={() => setDates({ from: todayIst(), to: todayIst(27), weekdays: [5, 6, 0] })}>Weekends, next 4 weeks</Btn>
          </div>
        </div>
      )}
      {step === 3 && (!preview ? <Loading /> : preview.error ? <ErrorBox msg={preview.error} /> : (
        <div className="f" style={{ gap: 12 }}>
          <div className="resp-kpis">
            <div><b>{preview.new}</b><small>new rooms will be created</small></div>
            <div><b>{preview.total - preview.new}</b><small>already exist (left as they are)</small></div>
            <div><b>{f.from} → {f.to}</b><small>{okBuses.length} bus{okBuses.length === 1 ? '' : 'es'} · {dates.from} to {dates.to}</small></div>
          </div>
          <div className="tw" style={{ maxHeight: 320, overflow: 'auto' }}><table>
            <thead><tr><th>Departs (IST)</th><th>Operator</th><th>Bus</th><th>Trip key</th><th /></tr></thead>
            <tbody>{preview.preview.map((p: any) => <tr key={p.trip_key}><td className="num">{fmtDateTime(p.departs_at)}</td><td>{p.operator}</td><td>{p.vehicle_no ?? '—'}</td><td><code className="tk">{p.trip_key}</code></td><td>{p.exists ? <Chip>exists</Chip> : <Chip tone="c-ok">new</Chip>}</td></tr>)}</tbody>
          </table></div>
          {preview.total > preview.preview.length && <p className="hint">Showing the first {preview.preview.length} of {preview.total}.</p>}
        </div>
      ))}
      <div className="modal-foot">
        {step > 0 ? <Btn kind="ghost" onClick={() => setStep(step - 1)}>Back</Btn> : <Btn kind="ghost" onClick={onClose}>Cancel</Btn>}
        <span className="hint">{todo[step]?.length ? `Still needed: ${todo[step].join(', ')}` : ''}</span>
        {step < 3 ? <Btn kind="pri" disabled={!!todo[step]?.length} onClick={() => setStep(step + 1)}>Next</Btn>
          : <Btn kind="pri" busy={busy === 'go'} disabled={!preview || preview.error || !preview.new} onClick={create}><Icon name="check" size={15} /> Create {preview?.new ?? ''} room{preview?.new === 1 ? '' : 's'}</Btn>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- edit ---
/** Edit a room. "Save changes" only lights up when something changed; Discard puts it back. */
export function EditRoom({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const d = useData<any>(`/rooms/${id}/admin`);
  const [f, setF] = useState<any>(null);
  const [act, setAct] = useState<Action | null>(null);
  const { busy, run } = useAction();
  useEffect(() => { if (d.data && !f) setF(init(d.data)); }, [d.data]); // eslint-disable-line
  const base = useMemo(() => (d.data ? init(d.data) : null), [d.data]);
  if (d.error) return <Modal title="Edit room" onClose={onClose}><ErrorBox msg={d.error} /></Modal>;
  if (!d.data || !f || !base) return <Modal title="Edit room" onClose={onClose}><Loading /></Modal>;
  const r = d.data;
  const changed = Object.keys(f).filter((k) => JSON.stringify(f[k]) !== JSON.stringify((base as any)[k]));
  const save = async () => {
    const body: any = {};
    for (const k of changed) {
      if (k === 'departs' || k === 'arrives') { body.departs_at = fromIstInput(f.departs); body.arrives_at = fromIstInput(f.arrives); }
      else if (k === 'features') body.features = Object.fromEntries(Object.entries(f.features).filter(([fk, v]) => base.features[fk] !== v));
      else body[k] = f[k];
    }
    const res = await run('save', () => api(`/rooms/${id}`, { method: 'PATCH', body }), `${r.ref} saved`);
    if (res) onDone();
  };
  if (act) return <ConfirmAction action={act} rooms={[{ id: r.id, ref: r.ref, title: r.title }]} onClose={() => setAct(null)} onDone={onDone} />;
  return (
    <Modal wide title={<>Edit room <Ref code={r.ref} /></>} onClose={onClose}>
      <div className="keyline"><Chip tone={STATE_TONE[r.state]}>{STATE_LABEL[r.state] ?? r.state}</Chip> trip key <code>{r.trip_key}</code> · chat opens {fmtDateTime(r.opens_at)} · ends {fmtDateTime(r.read_only_at)} · deleted {fmtDateTime(r.purge_at)}</div>
      <div className="f" style={{ gap: 14, marginTop: 14 }}>
        <div className="formgrid">
          <Field label="Title"><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Subtitle"><input value={f.subtitle} onChange={(e) => setF({ ...f, subtitle: e.target.value })} /></Field>
          <Field label="Operator"><input value={f.operator_name} onChange={(e) => setF({ ...f, operator_name: e.target.value })} /></Field>
          <Field label="Bus number"><input value={f.vehicle_no} onChange={(e) => setF({ ...f, vehicle_no: e.target.value })} /></Field>
          <Field label="Departs (IST)" hint="Moving it shifts every stop’s time too."><input type="datetime-local" value={f.departs} onChange={(e) => setF({ ...f, departs: e.target.value })} /></Field>
          <Field label="Arrives (IST)"><input type="datetime-local" value={f.arrives} onChange={(e) => setF({ ...f, arrives: e.target.value })} /></Field>
        </div>
        <Field label="When the chat opens"><Seg value={f.activation} onChange={(v) => setF({ ...f, activation: v })} options={[['always', 'Before departure, as usual'], ['on_delay', 'Only if the trip is delayed']]} /></Field>
        <Field label="What travellers can do in this room" hint="Overrides the app’s defaults for this room only.">
          <div className="cfg-grid">{Object.entries(r.feature_labels as Record<string, string>).map(([k, l]) => (
            <div key={k} className="tog"><span>{l}</span><Switch on={!!f.features[k]} label={l} onChange={(v) => setF({ ...f, features: { ...f.features, [k]: v } })} /></div>
          ))}</div>
        </Field>
        <div className="danger-zone">
          <h4>Stop or remove this room</h4>
          <div className="fil">
            {['read_only', 'closed'].includes(r.state) ? <Btn onClick={() => setAct('reopen')}><Icon name="play" size={15} /> Reopen</Btn> : <Btn onClick={() => setAct('end_chat')}><Icon name="stop" size={15} /> End chat</Btn>}
            {r.state !== 'closed' && <Btn onClick={() => setAct('close')}><Icon name="x" size={15} /> Close room</Btn>}
            <Btn kind="danger" onClick={() => setAct('delete')}><Icon name="trash" size={15} /> Delete room</Btn>
          </div>
        </div>
      </div>
      <div className="modal-foot">
        <Btn kind="ghost" onClick={onClose}>Close</Btn>
        <span>{changed.length ? <span className="dirty">{changed.length} unsaved change{changed.length === 1 ? '' : 's'}</span> : <span className="hint">No changes</span>}</span>
        <div className="fil"><Btn kind="ghost" disabled={!changed.length} onClick={() => setF(base)}>Discard</Btn><Btn kind="pri" busy={busy === 'save'} disabled={!changed.length} onClick={save}><Icon name="check" size={15} /> Save changes</Btn></div>
      </div>
    </Modal>
  );
}
const init = (r: any) => ({ title: r.title, subtitle: r.subtitle, operator_name: r.operator_name, vehicle_no: r.vehicle_no, departs: toIstInput(r.departs_at), arrives: toIstInput(r.arrives_at), activation: r.activation, features: { ...r.features } });
