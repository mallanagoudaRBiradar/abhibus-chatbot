import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useData } from '../lib/live';
import { go, href } from '../lib/router';
import { ago, num, roomRef, UNIT } from '../lib/format';
import { Btn, Chip, Choice, Empty, ErrorBox, Field, Head, Kpi, Loading, Panel, Ref, Steps, useAction, useToast } from '../components/ui';
import { ResponsesPanel } from '../components/Responses';

const FMT: Record<string, string> = { card: 'Sponsored card', sponsored_poll: 'Sponsored poll', sponsored_game: 'Sponsored game', stop_offer: 'Stop offer', survey: 'Research survey' };
const STAGE: Record<string, string> = { open: 'Waiting', onboard: 'On the way', read_only: 'After trip' };
const STATUS_TONE: Record<string, string> = { live: 'c-ok', paused: 'c-mute', draft: 'c-info', ended: 'c-mute' };
const respFormat = (f: string) => f === 'sponsored_poll' || f === 'survey';

function CampTable({ rows, reload }: { rows: any[]; reload: () => void }) {
  const { can } = useAuth();
  const { busy, run } = useAction();
  if (!rows.length) return <Empty>No campaigns yet.</Empty>;
  return (
    <div className="tw"><table>
      <thead><tr><th>Campaign</th><th>Format</th><th>Where</th><th>Status</th><th>Impressions</th><th>Clicks / answers</th><th>CTR</th><th /></tr></thead>
      <tbody>{rows.map((c) => (
        <tr key={c.id} className="click" onClick={() => go(`/marketing/campaigns/${c.id}`)}>
          <td><div className="rcell"><b>{c.name}</b><Ref code={c.ref} /></div><small>{c.advertiser}</small></td>
          <td>{c.format_label ?? FMT[c.format]}</td>
          <td>{c.targeting.verticals.map((v: string) => UNIT[v]).join(', ')}<small>{c.targeting.routes.length ? c.targeting.routes.join(', ') : 'all routes'}{c.targeting.stops.length ? ` · near ${c.targeting.stops.join(', ')}` : ''}</small></td>
          <td><Chip tone={STATUS_TONE[c.status]}>{c.status}</Chip></td>
          <td className="num">{num(c.stats.impressions)}</td>
          <td className="num">{num(respFormat(c.format) ? c.stats.responses : c.stats.clicks)}</td>
          <td className="num">{respFormat(c.format) ? '—' : `${c.stats.ctr}%`}</td>
          <td onClick={(e) => e.stopPropagation()}>{can('campaigns.write') && c.status !== 'ended' && (
            <Btn sm kind="ghost" busy={busy === c.id} onClick={() => run(c.id, () => api(`/campaigns/${c.id}`, { method: 'PATCH', body: { status: c.status === 'live' ? 'paused' : 'live' } }), c.status === 'live' ? 'Paused' : 'Live').then(reload)}>{c.status === 'live' ? 'Pause' : 'Go live'}</Btn>
          )}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

export function MktOverview() {
  const d = useData<{ data: any[] }>('/campaigns', { refreshOn: ['ad.', 'campaign.', 'survey.', 'poll.'], every: 15_000 });
  if (d.error) return <section className="cmain"><ErrorBox msg={d.error} retry={d.reload} /></section>;
  if (!d.data) return <section className="cmain"><Loading /></section>;
  const cs = d.data.data;
  const imp = cs.reduce((a, c) => a + c.stats.impressions, 0);
  const adCs = cs.filter((c) => !respFormat(c.format));
  const adImp = adCs.reduce((a, c) => a + c.stats.impressions, 0), clk = adCs.reduce((a, c) => a + c.stats.clicks, 0);
  const resp = cs.reduce((a, c) => a + c.stats.responses, 0);
  return (
    <section className="cmain">
      <Head title="Marketing overview" sub="Real counts from live rooms across all four apps." right={<a className="btn pri" href={href('/marketing/new')}>New campaign</a>} />
      <div className="kpis">
        <Kpi label="Live campaigns" value={cs.filter((c) => c.status === 'live').length} sub={`of ${cs.length}`} />
        <Kpi label="Impressions" value={num(imp)} sub="all formats" />
        <Kpi label="Ad click rate" value={`${adImp ? ((clk * 100) / adImp).toFixed(1) : '0'}%`} sub="cards, stop offers, games" />
        <Kpi label="Poll & survey answers" value={num(resp)} sub="sponsored and research" />
      </div>
      <Panel title="Campaigns"><CampTable rows={cs} reload={d.reload} /></Panel>
      <Panel title="How delivery works">
        <div className="flow"><span className="s">Campaign is live</span><span className="a">→</span><span className="s">Room matches app, mode, route, stage</span><span className="a">→</span><span className="s">Ad rules pass</span><span className="a">→</span><span className="s">Card appears in the room</span><span className="a">→</span><span className="s">Views, clicks, answers counted</span><span className="a">→</span><span className="s"><code>ad.delivered</code> webhook for billing</span></div>
      </Panel>
    </section>
  );
}

export function MktCampaigns() {
  const d = useData<{ data: any[] }>('/campaigns', { refreshOn: ['ad.', 'campaign.'], every: 15_000 });
  const { can } = useAuth();
  return (
    <section className="cmain">
      <Head title="Campaigns" sub="Ads, sponsored polls and games, stop offers and research surveys across all apps." right={can('campaigns.write') && <a className="btn pri" href={href('/marketing/new')}>New campaign</a>} />
      {d.error ? <ErrorBox msg={d.error} retry={d.reload} /> : !d.data ? <Loading /> : <CampTable rows={d.data.data} reload={d.reload} />}
    </section>
  );
}

export function MktCampaign({ id }: { id: string }) {
  const { can } = useAuth();
  const d = useData<any>(`/campaigns/${id}`, { refreshOn: ['ad.', 'campaign.', 'survey.', 'poll.'], every: 10_000 });
  const { busy, run } = useAction();
  const [results, setResults] = useState<any[] | null>(null);
  if (d.error) return <section className="cmain"><Head title="Campaign" back={{ label: 'Campaigns', href: href('/marketing/campaigns') }} /><ErrorBox msg={d.error} /></section>;
  if (!d.data) return <section className="cmain"><Loading /></section>;
  const c = d.data;
  const held = Object.entries(c.held_back ?? {}) as [string, number][];
  const maxHeld = Math.max(1, ...held.map(([, v]) => v));
  return (
    <section className="cmain">
      <Head back={{ label: 'Campaigns', href: href('/marketing/campaigns') }} title={<>{c.name} <Ref code={c.ref} /></>}
        sub={<>Created by <b>{c.created_by ?? 'unknown'}</b> · {c.advertiser} · {c.format_label} · {c.targeting.verticals.map((v: string) => UNIT[v]).join(', ')}{c.targeting.routes.length ? ` · ${c.targeting.routes.join(', ')}` : ''}{c.targeting.stops.length ? ` · near ${c.targeting.stops.join(', ')}` : ''} · stages: {c.targeting.stages.map((s: string) => STAGE[s]).join(', ')}{c.cap ? ` · cap ${num(c.cap)}` : ''}</>}
        right={<>
          <Chip tone={STATUS_TONE[c.status]}>{c.status}</Chip>
          {can('campaigns.write') && c.status !== 'ended' && <Btn sm busy={busy === 'st'} onClick={() => run('st', () => api(`/campaigns/${id}`, { method: 'PATCH', body: { status: c.status === 'live' ? 'paused' : 'live' } })).then(d.reload)}>{c.status === 'live' ? 'Pause' : 'Go live'}</Btn>}
          {can('campaigns.write') && c.status !== 'ended' && <Btn sm kind="ghost" onClick={() => confirm('End this campaign? It can’t be restarted.') && run('end', () => api(`/campaigns/${id}`, { method: 'PATCH', body: { status: 'ended' } }), 'Campaign ended').then(d.reload)}>End</Btn>}
          {can('campaigns.write') && <Btn sm kind="pri" busy={busy === 'dl'} onClick={() => run('dl', () => api<any>(`/campaigns/${id}/deliver`, { body: {} }), (r: any) => `Delivered to ${r.delivered} rooms`).then((r: any) => { if (r) { setResults(r.results); d.reload(); } })}>Deliver to live rooms now</Btn>}
        </>} />
      <div className="kpis">
        <Kpi label="Impressions" value={num(c.stats.impressions)} sub={`${num(c.delivered_rooms)} room deliveries`} />
        <Kpi label="Clicks" value={num(c.stats.clicks)} />
        <Kpi label="Click rate" value={`${c.stats.ctr}%`} />
        <Kpi label="Responses" value={num(c.stats.responses)} />
      </div>
      <div className="two">
        <div className="stack">
          {(c.format === 'sponsored_poll' || c.format === 'survey') && <ResponsesPanel title={c.format === 'survey' ? 'Responses' : 'Votes'} data={c.results} />}
          {held.length > 0 && <Panel title="Why it was held back"><div className="bars">{held.map(([k, v]) => <div key={k} className="bar"><span title={k}>{k}</span><span className="tr"><i style={{ width: `${(v * 100) / maxHeld}%` }} /></span><span className="num">{v}</span></div>)}</div><p className="hint" style={{ marginTop: 8 }}>Ad rules protect travellers: frequency, quiet hours, pauses after Ops alerts and breakdowns.</p></Panel>}
          {results && <Panel title="Last manual delivery"><div className="log">{results.map((r: any) => <div key={r.room_id} className={r.ok ? 'ok' : 'no'}>{r.ok ? 'Delivered' : 'Held back'} · {roomRef(r.room_id)} {r.room} {r.reason ? `· ${r.reason}` : ''}</div>)}</div></Panel>}
          <Panel title="Delivery log"><div className="log">{c.log.length ? c.log.map((l: any, i: number) => (
            <div key={i} className={l.ok ? 'ok' : 'no'}>{l.ok ? 'Delivered' : 'Held back'} · <a className="lnk" href={href(`/ops/rooms/${l.room.id}`)}>{roomRef(l.room.id)}</a> {l.room.title ?? ''} ({UNIT[l.room.vertical] ?? ''}) {l.reason ? `· ${l.reason}` : ''} · {ago(l.at)}</div>
          )) : <div>No delivery attempts yet. Live rooms are checked every minute.</div>}</div></Panel>
        </div>
        <Panel title="Preview in a room"><Preview c={c} /><p className="hint" style={{ marginTop: 10 }}>Always labelled. Targeting uses app, route, time and stop only, never chat content.</p></Panel>
      </div>
    </section>
  );
}

function Preview({ c }: { c: any }) {
  const brand = '#d4373c';
  const cr = c.creative ?? {};
  let inner;
  if (c.format === 'sponsored_poll') inner = <div className="card"><div className="ct"><span className="bd ad">Sponsored</span> {c.advertiser}</div><b className="q">{c.poll?.q || 'Your question'}</b>{(c.poll?.opts ?? ['Option 1', 'Option 2']).map((o: string, i: number) => <div key={i} className="opt"><span>{o || `Option ${i + 1}`}</span><span>0</span></div>)}</div>;
  else if (c.format === 'survey') inner = <div className="card"><div className="ct"><span className="bd p2">Survey</span> {c.advertiser}</div><b className="q">{c.survey?.questions?.[0]?.q || 'Your question'}</b>{c.survey?.questions?.[0]?.type === 'rating' ? <div className="stars">{[1, 2, 3, 4, 5].map((n) => <button key={n} type="button">★</button>)}</div> : <div className="fil">{(c.survey?.questions?.[0]?.options ?? ['Yes', 'No', 'Not sure']).map((o: string) => <span key={o} className="cta out">{o}</span>)}</div>}<small style={{ color: 'var(--ph-muted)' }}>{c.survey?.questions?.length ?? 1} question{(c.survey?.questions?.length ?? 1) > 1 ? 's' : ''} · takes 20 seconds</small></div>;
  else inner = <div className="card"><div className="ct"><span className="bd ad">Ad</span> {c.advertiser}{c.format === 'stop_offer' && c.targeting?.stops?.[0] ? ` · at ${c.targeting.stops[0]}` : ''}</div><div className="adc"><span className="tile" style={{ background: cr.tile || '#2b9d74' }}>{(cr.title || c.advertiser || 'A').slice(0, 1)}</span><div style={{ flex: 1 }}><b>{cr.title || 'Your title'}</b><div style={{ color: 'var(--ph-muted)', fontSize: '.78rem' }}>{cr.body || 'Your one-line message'}</div>{cr.coupon && <div style={{ fontSize: '.72rem' }}>Code <b>{cr.coupon}</b></div>}</div><span className="cta">{cr.cta || (c.format === 'sponsored_game' ? 'Play' : 'View offer')}</span></div></div>;
  return <div className="phone" style={{ height: 'auto', width: '100%', maxWidth: 340, borderRadius: 24, ['--brand' as any]: brand }}><div className="scr" style={{ borderRadius: 18, padding: 12, gap: 8 }}><div className="sys">Ads never appear during SOS, breakdowns or right after an Ops alert</div>{inner}</div></div>;
}

const FMT_INFO: Record<string, { icon: string; desc: string; best: string }> = {
  card: { icon: '▣', desc: 'A brand message with a button.', best: 'Offers, app installs, coupons' },
  stop_offer: { icon: '📍', desc: 'Appears only in the hour before a chosen stop, and during it.', best: 'Food courts and shops at rest stops' },
  sponsored_poll: { icon: '◔', desc: 'A light question travellers vote on, with your name on it.', best: 'Engagement and brand recall' },
  sponsored_game: { icon: '◆', desc: 'A branded mini game for long, boring stretches.', best: 'Long trips, younger travellers' },
  survey: { icon: '✎', desc: 'Up to 4 questions. Not an ad, so it skips frequency limits.', best: 'Research and trip feedback' },
};
const STAGE_INFO: Record<string, string> = { open: 'Before departure, while people wait to board', onboard: 'During the trip', read_only: 'After arrival, while the room is read-only. Best for surveys.' };

/**
 * New campaign in four steps: what you're running → who sees it → what it says → when, then launch.
 * The live preview and a plain-English summary stay on the right the whole time.
 */
type RouteRow = { key: string; label: string; vertical: string; tenants: string[]; rooms: { id: string; ref: string; tenant: string; state: string; travellers: number }[] };

export function MktNew({ fromRoom }: { fromRoom?: string }) {
  const { tenants, user } = useAuth();
  const toast = useToast();
  const [step, setStep] = useState(0);
  const catalogue = useData<{ data: RouteRow[] }>('/campaigns/routes', { refreshOn: ['room.'] });
  const routes = catalogue.data?.data ?? [];
  const [picked, setPicked] = useState<string[]>([]);
  const origin = fromRoom ? routes.find((r) => r.rooms.some((x) => x.id === fromRoom)) : undefined;
  const originRoom = origin?.rooms.find((x) => x.id === fromRoom);
  // Started from a room: target its route, app, mode and current stage.
  useEffect(() => {
    if (!origin || !originRoom) return;
    setPicked([origin.key]);
    setD((x: any) => ({ ...x, verticals: [origin.vertical], tenants: [originRoom.tenant], stages: STAGE[originRoom.state] ? [originRoom.state] : x.stages }));
  }, [origin?.key]); // eslint-disable-line
  const [d, setD] = useState<any>({ name: '', advertiser: '', format: '', tenants: [] as string[], verticals: ['bus'], routes: '', stops: '', stages: ['onboard'], creative: { title: '', body: '', cta: 'View offer', tile: '#2b9d74', coupon: '' }, poll: { q: '', opts: ['', ''] }, survey: [{ type: 'rating', q: '' }], cap: '', start: '', end: '' });
  const { busy, run } = useAction();
  const up = (k: string, v: any) => setD((x: any) => ({ ...x, [k]: v }));
  const tog = (k: string, v: string) => setD((x: any) => ({ ...x, [k]: x[k].includes(v) ? x[k].filter((y: string) => y !== v) : [...x[k], v] }));
  const needsCreative = ['card', 'stop_offer', 'sponsored_game'].includes(d.format);
  const body = (status: 'live' | 'draft') => ({
    name: d.name.trim(), advertiser: d.advertiser.trim(), format: d.format, status,
    creative: needsCreative ? Object.fromEntries(Object.entries(d.creative).filter(([, v]) => v)) : {},
    ...(d.format === 'sponsored_poll' ? { poll: { q: d.poll.q, opts: d.poll.opts.filter((o: string) => o.trim()) } } : {}),
    ...(d.format === 'survey' ? { survey: { questions: d.survey.filter((q: any) => q.q.trim()).map((q: any) => ({ type: q.type, q: q.q, ...(q.type === 'choice' ? { options: ['Yes', 'No', 'Not sure'] } : {}) })) } } : {}),
    targeting: { ...(d.tenants.length ? { tenants: d.tenants } : {}), verticals: d.verticals, routes: [...new Set([...picked, ...split(d.routes)])], stops: split(d.stops), stages: d.stages },
    ...(d.start || d.end ? { schedule: { ...(d.start ? { start: new Date(d.start).toISOString() } : {}), ...(d.end ? { end: new Date(d.end).toISOString() } : {}) } } : {}),
    ...(d.cap ? { cap: { impressions: Number(d.cap) } } : {}),
  });
  const preview = { format: d.format || 'card', creative: d.creative, poll: d.poll, survey: { questions: d.survey }, targeting: { stops: split(d.stops) }, advertiser: d.advertiser || 'Advertiser' };

  // What's still missing on each step, in words, so "Next" never fails silently.
  const todo: string[][] = [
    [!d.format && 'pick a format', !d.name.trim() && 'campaign name', !d.advertiser.trim() && 'advertiser'].filter(Boolean) as string[],
    [!d.verticals.length && 'at least one mode', !d.stages.length && 'at least one trip stage', d.format === 'stop_offer' && !split(d.stops).length && 'the stop'].filter(Boolean) as string[],
    (needsCreative ? [!d.creative.title.trim() && 'title', !d.creative.body.trim() && 'one-line message']
      : d.format === 'sponsored_poll' ? [!d.poll.q.trim() && 'poll question', d.poll.opts.filter((o: string) => o.trim()).length < 2 && 'two options']
      : d.format === 'survey' ? [!d.survey.some((q: any) => q.q.trim()) && 'one question'] : []).filter(Boolean) as string[],
    [d.start && d.end && new Date(d.end) <= new Date(d.start) && 'an end time after the start'].filter(Boolean) as string[],
  ];
  const allRoutes: string[] = [...new Set([...picked, ...split(d.routes)])];
  // Who this reaches right now, from real rooms: same rules as delivery (app, mode, route, stage).
  const reach = (() => {
    const rooms = routes.filter((r) => d.verticals.includes(r.vertical) && (!allRoutes.length || allRoutes.includes(r.key)))
      .flatMap((r) => r.rooms.map((x) => ({ ...x, route: r.label })))
      .filter((x) => (!d.tenants.length || d.tenants.includes(x.tenant)) && (d.stages.includes(x.state) || x.state === 'scheduled' || x.state === 'dormant'));
    return { rooms, travellers: rooms.reduce((n, x) => n + x.travellers, 0) };
  })();
  const appsTxt = d.tenants.length ? d.tenants.map((t: string) => tenants.find((x) => x.id === t)?.name ?? t).join(', ') : 'all apps';
  const summary = [
    ['What', d.format ? `${FMT[d.format]}${d.advertiser ? ` for ${d.advertiser}` : ''}` : '—'],
    ['Where', `${d.verticals.map((v: string) => UNIT[v]).join(', ') || '—'} rooms on ${appsTxt}${allRoutes.length ? `, only ${allRoutes.map((k) => routes.find((r) => r.key === k)?.label ?? k).join(', ')}` : ', every route'}${d.format === 'stop_offer' && split(d.stops).length ? `, near ${split(d.stops).join(', ')}` : ''}`],
    ['Reach', `${reach.rooms.length} room${reach.rooms.length === 1 ? '' : 's'} · ${num(reach.travellers)} travellers right now`],
    ['When', `${d.stages.map((s: string) => STAGE[s]).join(', ') || '—'} · ${d.start ? `from ${new Date(d.start).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : 'starts at launch'}${d.end ? ` until ${new Date(d.end).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : ', no end date'}${d.cap ? ` · stops at ${num(Number(d.cap))} views` : ''}`],
  ];
  const save = async (status: 'live' | 'draft') => {
    const r = await run(status, () => api<any>('/campaigns', { body: body(status) }), status === 'draft' ? (x: any) => `${x.ref} saved as draft` : undefined);
    if (!r) return;
    if (status === 'live' && fromRoom) {
      // Back to the room it was started from, saying plainly whether it's showing there.
      const c = await api<any>(`/campaigns/${r.id}`).catch(() => null);
      const here = c?.log?.find((l: any) => l.room?.id === fromRoom);
      toast(here?.ok ? `${r.ref} is showing in ${originRoom?.ref ?? 'this room'} now, in every app` : `${r.ref} is live. Held back in ${originRoom?.ref ?? 'this room'} for now: ${here?.reason ?? 'waiting for the next check'}. It retries every minute.`);
      return go(`/ops/rooms/${fromRoom}`);
    }
    if (status === 'live') toast(`${r.ref} is live · in ${r.delivered_now} rooms right away`);
    go(`/marketing/campaigns/${r.id}`);
  };
  const next = <div className="modal-foot">
    {step > 0 ? <Btn kind="ghost" onClick={() => setStep(step - 1)}>Back</Btn> : <a className="btn ghost" href={href('/marketing/campaigns')}>Cancel</a>}
    <span className="hint">{todo[step].length ? `Still needed: ${todo[step].join(', ')}` : ''}</span>
    {step < 3 ? <Btn kind="pri" disabled={!!todo[step].length} onClick={() => setStep(step + 1)}>Next</Btn> : <span />}
  </div>;

  return (
    <section className="cmain">
      {fromRoom && origin && <div className="fromroom">Started from <b>{originRoom?.ref} {origin.label}</b>. It targets this route on {tenants.find((t) => t.id === originRoom?.tenant)?.name}, so it shows in this trip’s chat and every other trip on the route. <a className="lnk" href={href(`/ops/rooms/${fromRoom}`)}>Back to the room</a></div>}
      <Head title="New campaign" back={fromRoom ? { label: 'Back to the room', href: href(`/ops/rooms/${fromRoom}`) } : { label: 'Campaigns', href: href('/marketing/campaigns') }} sub="Ad rules (frequency, quiet hours, no ads after alerts or during breakdowns) apply automatically. You can’t override them here, so travellers are protected." />
      <Steps steps={['What', 'Who sees it', 'Content', 'Schedule & launch']} at={step} onGo={setStep} />
      <div className="two">
        <Panel>
          {step === 0 && <div className="f" style={{ gap: 14 }}>
            <h4 className="rv-h">What are you running?</h4>
            <div className="choice-grid">{Object.entries(FMT).map(([k, l]) => <Choice key={k} icon={FMT_INFO[k].icon} title={l} desc={<>{FMT_INFO[k].desc}<br /><i>Best for: {FMT_INFO[k].best}</i></>} on={d.format === k} onClick={() => up('format', k)} />)}</div>
            <div className="frow">
              <Field label="Campaign name" hint="Only your team sees this."><input value={d.name} onChange={(e) => up('name', e.target.value)} maxLength={80} placeholder="e.g. Diwali chai offer · HYD-BLR" /></Field>
              <Field label="Advertiser" hint="Shown to travellers next to the Ad label."><input value={d.advertiser} onChange={(e) => up('advertiser', e.target.value)} maxLength={80} placeholder="e.g. Chai Point" /></Field>
            </div>
            {next}
          </div>}

          {step === 1 && <div className="f" style={{ gap: 14 }}>
            <Field label={user!.tenants.length ? 'Apps' : 'Apps · leave all off to run on every app'}><div className="fil">{tenants.map((t) => <button type="button" key={t.id} className={`pickchip ${d.tenants.includes(t.id) ? 'on' : ''}`} onClick={() => tog('tenants', t.id)}>{t.name}</button>)}</div></Field>
            <Field label="Modes"><div className="fil">{['bus', 'train', 'flight'].map((v) => <button type="button" key={v} className={`pickchip ${d.verticals.includes(v) ? 'on' : ''}`} onClick={() => tog('verticals', v)}>{UNIT[v]}</button>)}</div></Field>
            <Field label={<>Routes <span className="hint">· pick from trips running now, or leave empty for every route</span></>}>
              {!catalogue.data ? <Loading /> : <div className="route-grid">{routes.filter((r) => d.verticals.includes(r.vertical)).map((r) => {
                const on = picked.includes(r.key);
                const live = r.rooms.filter((x) => x.state === 'open' || x.state === 'onboard');
                return (
                  <button type="button" key={r.key} className={`route-pick ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => setPicked((p) => (on ? p.filter((k) => k !== r.key) : [...p, r.key]))}>
                    <b>{r.label}</b>
                    <small>{UNIT[r.vertical]} · {live.length} live of {r.rooms.length} · {num(r.rooms.reduce((n, x) => n + x.travellers, 0))} travellers · {r.rooms.map((x) => x.ref).slice(0, 2).join(', ')}{r.rooms.length > 2 ? '…' : ''}</small>
                  </button>
                );
              })}</div>}
              <input value={d.routes} onChange={(e) => up('routes', e.target.value)} placeholder="Other routes, train or flight numbers (comma-separated), e.g. 12785, 6E512" />
            </Field>
            {d.format === 'stop_offer' && <Field label="Which stop?" hint="Shown only in the 60 minutes before the stop, and during it."><input value={d.stops} onChange={(e) => up('stops', e.target.value)} placeholder="e.g. Kurnool" /></Field>}
            <div className="reach"><b>{reach.rooms.length ? `Reaches ${reach.rooms.length} room${reach.rooms.length === 1 ? '' : 's'} · ${num(reach.travellers)} travellers right now` : 'No trip matches this right now'}</b>
              <small>{reach.rooms.length ? reach.rooms.slice(0, 6).map((x) => `${x.ref} ${x.route}`).join(' · ') + (reach.rooms.length > 6 ? ` +${reach.rooms.length - 6} more` : '') : 'It will still show in matching trips as they start.'}</small></div>
            <Field label="When in the trip"><div className="choice-grid tight">{Object.entries(STAGE).map(([k, l]) => <Choice key={k} title={l} desc={STAGE_INFO[k]} on={d.stages.includes(k)} onClick={() => tog('stages', k)} />)}</div></Field>
            {next}
          </div>}

          {step === 2 && <div className="f" style={{ gap: 12 }}>
            {needsCreative && <>
              <Field label="Title"><input value={d.creative.title} maxLength={60} onChange={(e) => up('creative', { ...d.creative, title: e.target.value })} placeholder="Brand or offer name" /></Field>
              <Field label={`One-line message · ${70 - d.creative.body.length} left`}><input value={d.creative.body} maxLength={70} onChange={(e) => up('creative', { ...d.creative, body: e.target.value })} placeholder="e.g. Free chai with any snack at the Kurnool stop" /></Field>
              <div className="frow">
                <Field label="Button text"><input value={d.creative.cta} maxLength={24} onChange={(e) => up('creative', { ...d.creative, cta: e.target.value })} /></Field>
                <Field label="Coupon code" hint="Optional"><input value={d.creative.coupon} maxLength={24} onChange={(e) => up('creative', { ...d.creative, coupon: e.target.value })} /></Field>
                <Field label="Tile colour"><input type="color" value={d.creative.tile} onChange={(e) => up('creative', { ...d.creative, tile: e.target.value })} style={{ height: 38, padding: 2 }} /></Field>
              </div>
            </>}
            {d.format === 'sponsored_poll' && <Field label="Poll question and options">
              <input value={d.poll.q} maxLength={200} placeholder="e.g. What’s your go-to travel snack?" onChange={(e) => up('poll', { ...d.poll, q: e.target.value })} />
              {d.poll.opts.map((o: string, i: number) => <input key={i} value={o} maxLength={60} placeholder={`Option ${i + 1}`} onChange={(e) => up('poll', { ...d.poll, opts: d.poll.opts.map((x: string, j: number) => (j === i ? e.target.value : x)) })} />)}
              <div><Btn sm disabled={d.poll.opts.length >= 4} onClick={() => up('poll', { ...d.poll, opts: [...d.poll.opts, ''] })}>Add option</Btn></div>
            </Field>}
            {d.format === 'survey' && <Field label="Questions" hint="Keep it under 20 seconds: 1–4 short questions.">
              {d.survey.map((q: any, i: number) => <div key={i} className="frow"><input value={q.q} maxLength={200} placeholder={`Question ${i + 1}`} onChange={(e) => up('survey', d.survey.map((x: any, j: number) => (j === i ? { ...x, q: e.target.value } : x)))} /><select value={q.type} onChange={(e) => up('survey', d.survey.map((x: any, j: number) => (j === i ? { ...x, type: e.target.value } : x)))}><option value="rating">1–5 stars</option><option value="choice">Yes / No / Not sure</option><option value="text">Short text</option></select></div>)}
              <div><Btn sm disabled={d.survey.length >= 4} onClick={() => up('survey', [...d.survey, { type: 'rating', q: '' }])}>Add question</Btn></div>
            </Field>}
            {next}
          </div>}

          {step === 3 && <div className="f" style={{ gap: 14 }}>
            <div className="frow">
              <Field label="Start" hint="Empty = as soon as you launch"><input type="datetime-local" value={d.start} onChange={(e) => up('start', e.target.value)} /></Field>
              <Field label="End" hint="Empty = runs until you end it"><input type="datetime-local" value={d.end} onChange={(e) => up('end', e.target.value)} /></Field>
              <Field label="Stop after" hint="Impressions. Empty = no cap"><input type="number" min={1} value={d.cap} onChange={(e) => up('cap', e.target.value)} placeholder="No cap" /></Field>
            </div>
            <h4 className="rv-h">Check before launch</h4>
            <dl className="summary">{summary.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
            <p className="hint">Launching makes it eligible right away; rooms are checked every minute. A draft does nothing until you press “Go live” on the campaign page.</p>
            <div className="modal-foot">
              <Btn kind="ghost" onClick={() => setStep(2)}>Back</Btn>
              <span className="hint">{todo[3].length ? `Still needed: ${todo[3].join(', ')}` : ''}</span>
              <div className="fil"><Btn kind="ghost" busy={busy === 'draft'} disabled={todo.some((t) => t.length)} onClick={() => save('draft')}>Save as draft</Btn><Btn kind="pri" className="big" busy={busy === 'live'} disabled={todo.some((t) => t.length)} onClick={() => save('live')}>Launch campaign</Btn></div>
            </div>
          </div>}
        </Panel>
        <div className="stack sticky">
          <Panel title="Preview in a room"><Preview c={preview} /><p className="hint" style={{ marginTop: 10 }}>Always labelled “Ad” or “Sponsored”. Never shown during SOS, breakdowns or right after an Ops alert.</p></Panel>
          <Panel title="Summary"><dl className="summary">{summary.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl></Panel>
        </div>
      </div>
    </section>
  );
}
const split = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

export function MktRules() {
  const { can } = useAuth();
  const d = useData<any>('/ad-rules', { refreshOn: ['tenant.config_updated'] });
  return (
    <section className="cmain">
      <Head title="Ad rules" sub="Set per app in Developer → Tenants & config. Every campaign obeys them." right={can('config.write') && <a className="btn" href={href('/developer/config')}>Edit in Developer portal</a>} />
      {d.error ? <ErrorBox msg={d.error} /> : !d.data ? <Loading /> : (
        <div className="tw"><table>
          <thead><tr><th>App</th><th>Frequency</th><th>Max per trip</th><th>Quiet hours (IST)</th><th>Pause after Ops alert</th><th>Ads</th></tr></thead>
          <tbody>{d.data.data.map((r: any) => (
            <tr key={r.tenant}><td>{r.name}</td><td className="num">1 per {r.ads.gap_min} min</td><td className="num">{r.ads.max_per_trip}</td><td className="num">{r.quiet.from}–{r.quiet.to}{r.quiet_now && <> <Chip tone="c-info">now</Chip></>}</td><td className="num">{r.ads.block_after_alert_min} min</td><td>{r.ads_on ? <Chip tone="c-ok">on</Chip> : <Chip>off</Chip>}</td></tr>
          ))}</tbody>
        </table></div>
      )}
      <Panel title="Always true">
        <div className="prose"><p>Ads are never shown during a breakdown, never inside SOS or private messages, and always carry an “Ad” label.</p><p>Stop offers appear only within 60 minutes before the stop and during it. Research surveys are not ads: they skip frequency limits but still respect quiet hours and room stage.</p></div>
      </Panel>
    </section>
  );
}
