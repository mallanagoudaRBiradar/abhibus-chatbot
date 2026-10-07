import { href } from '../lib/router';
import { ago, fmtDateTime, num } from '../lib/format';
import { Chip, Empty, Panel, Ref } from './ui';

/**
 * Answers to a poll or survey, the way a person reads them: who made it, the headline numbers
 * (average rating, star spread, vote split) and then every response with a name.
 * Same view in the room and on the campaign page.
 */
type Who = { member_id: string; who: string; via: string; room: { id: string; ref: string; title: string } | null };
type SurveyQ = { type: 'rating' | 'choice' | 'text'; q: string; count: number; avg?: number | null; dist?: number[]; counts?: { option: string; n: number }[]; texts?: string[] };
export type ResponseData =
  | { kind: 'survey'; total: number; questions: SurveyQ[]; responses: (Who & { answers: unknown[]; at: string })[] }
  | { kind: 'poll'; total: number; options: { option: string; votes: number; voters: (Who & { at: string })[] }[] };
export type MadeBy = { by: string; at: string; campaign: { id: string; ref: string; name: string; advertiser: string; created_by: string | null } | null };

const pct = (n: number, d: number) => (d ? Math.round((n * 100) / d) : 0);
const Stars = ({ v }: { v: number }) => <span className="stars-ro" aria-label={`${v} out of 5`}>{'★'.repeat(Math.round(v))}<i>{'★'.repeat(5 - Math.round(v))}</i></span>;
const RoomLink = ({ r }: { r: Who['room'] }) => (r ? <a className="lnk" href={href(`/ops/rooms/${r.id}`)} onClick={(e) => e.stopPropagation()}>{r.ref}</a> : <>—</>);

export function MadeByLine({ made }: { made: MadeBy }) {
  return (
    <p className="made">
      {made.campaign
        ? <>Campaign <a className="lnk" href={href(`/marketing/campaigns/${made.campaign.id}`)}>{made.campaign.name}</a> <Ref code={made.campaign.ref} /> · advertiser <b>{made.campaign.advertiser}</b>{made.campaign.created_by ? <> · created by <b>{made.campaign.created_by}</b></> : null}</>
        : <>Posted by <b>{made.by}</b></>}
      {' '}· {fmtDateTime(made.at)}
    </p>
  );
}

export function ResponsesView({ data, showRoom = true }: { data: ResponseData | null; showRoom?: boolean }) {
  if (!data) return <Empty>No responses yet.</Empty>;
  if (data.kind === 'poll') {
    const max = Math.max(1, ...data.options.map((o) => o.votes));
    return (
      <div className="resp">
        <div className="resp-kpis"><div><b>{num(data.total)}</b><small>{data.total === 1 ? 'person voted' : 'people voted'}</small></div>{data.total > 0 && <div><b>{data.options.reduce((a, o) => (o.votes > a.votes ? o : a)).option}</b><small>leading</small></div>}</div>
        {data.options.map((o) => (
          <div key={o.option} className="resp-opt">
            <div className="bar"><span>{o.option}</span><span className="tr"><i style={{ width: `${(o.votes * 100) / max}%` }} /></span><span className="num">{o.votes} · {pct(o.votes, data.total)}%</span></div>
            {o.voters.length > 0 && <small className="voters">{o.voters.slice(0, 12).map((v) => `${v.who}${showRoom && v.room ? ` (${v.room.ref})` : ''}`).join(', ')}{o.voters.length > 12 ? ` +${o.voters.length - 12} more` : ''}</small>}
          </div>
        ))}
        {!data.total && <Empty>No votes yet. Votes appear here the moment travellers tap.</Empty>}
      </div>
    );
  }
  const rating = data.questions.find((q) => q.type === 'rating' && q.count);
  return (
    <div className="resp">
      <div className="resp-kpis">
        <div><b>{num(data.total)}</b><small>{data.total === 1 ? 'response' : 'responses'}</small></div>
        {rating?.avg != null && <div><b>{rating.avg.toFixed(1)} <Stars v={rating.avg} /></b><small>average · {rating.q}</small></div>}
      </div>
      {data.questions.map((q, i) => (
        <div key={i} className="resp-q">
          <h4>{i + 1}. {q.q} <Chip>{q.type === 'rating' ? '1–5 stars' : q.type === 'choice' ? 'choice' : 'short text'}</Chip> <span className="hint">{q.count} answered</span></h4>
          {q.type === 'rating' && q.dist && (
            <div className="bars">
              {q.avg != null && <p className="resp-avg"><b>{q.avg.toFixed(1)}</b> out of 5 <Stars v={q.avg} /></p>}
              {[5, 4, 3, 2, 1].map((s) => <div key={s} className="bar"><span>{s} ★</span><span className="tr"><i style={{ width: `${pct(q.dist![s - 1], q.count)}%` }} /></span><span className="num">{q.dist![s - 1]}</span></div>)}
            </div>
          )}
          {q.type === 'choice' && q.counts && <div className="bars">{q.counts.map((c) => <div key={c.option} className="bar"><span>{c.option}</span><span className="tr"><i style={{ width: `${pct(c.n, q.count)}%` }} /></span><span className="num">{c.n} · {pct(c.n, q.count)}%</span></div>)}</div>}
          {q.type === 'text' && (q.texts?.length ? <ul className="resp-texts">{q.texts.slice(0, 10).map((t, k) => <li key={k}>“{t}”</li>)}</ul> : <p className="hint">No answers yet.</p>)}
        </div>
      ))}
      {data.responses.length > 0 ? (
        <div className="tw"><table>
          <thead><tr><th>Who</th>{showRoom && <th>Trip</th>}<th>Answers</th><th>From</th><th>When</th></tr></thead>
          <tbody>{data.responses.map((r, i) => (
            <tr key={r.member_id + i}>
              <td><b>{r.who}</b></td>
              {showRoom && <td><RoomLink r={r.room} />{r.room && <small>{r.room.title}</small>}</td>}
              <td>{data.questions.map((q, k) => { const a = r.answers?.[k]; return a === undefined || a === null || a === '' ? null : <span key={k} className="ans">{q.type === 'rating' ? <Stars v={Number(a)} /> : String(a)}</span>; })}</td>
              <td><Chip tone={r.via.includes('app') ? 'c-info' : 'c-mute'}>{r.via}</Chip></td>
              <td className="num" title={r.at}>{ago(r.at)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ) : <Empty>No responses yet. They appear here as travellers answer, from every app.</Empty>}
    </div>
  );
}

export const ResponsesPanel = ({ title, data, made }: { title: string; data: ResponseData | null; made?: MadeBy }) => (
  <Panel title={title}>{made && <MadeByLine made={made} />}<ResponsesView data={data} /></Panel>
);
