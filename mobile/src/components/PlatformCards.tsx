import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Ionicons } from './icons';
import { Txt } from './Txt';
import { clock } from '../utils/format';
import { palette, radius, themed } from '../theme/tokens';
import { api } from '../services/api';
import { useChat } from '../store/chatStore';
import { CARD_SURVEY_DONE, CARD_VOTE_PREFIX, type BroadcastPayload, type ChatMessage } from '../shared/protocol';

/**
 * Polls and surveys posted from the Trip Rooms console (by Ops or a sponsor). Same questions and
 * answer types as the hosted chat; answers go back to the platform, so results count every app.
 * The seat's own vote / "answered" state comes from server-written reactions, so it survives reloads.
 */
type PollP = Extract<BroadcastPayload, { kind: 'POLL_CARD' }>;
type SurveyP = Extract<BroadcastPayload, { kind: 'SURVEY_CARD' }>;

function useMe() {
  const token = useChat((s) => s.session?.token);
  const seat = useChat((s) => s.session?.me.seat);
  return { token, seat };
}

function Header({ icon, label, by, at, sponsored }: { icon: keyof typeof Ionicons.glyphMap; label: string; by: string; at: string; sponsored: boolean }) {
  return (
    <View style={styles.head}>
      <Ionicons name={icon} size={15} color={palette.cyan} />
      <Txt v="meta" color={palette.textSecondary} style={{ flex: 1 }}>{label} · {by} · {clock(at)}</Txt>
      {sponsored && <View style={styles.badge}><Txt v="micro" color={palette.textSecondary}>SPONSORED</Txt></View>}
    </View>
  );
}

// ------------------------------------------------------------------- poll ---
export function PollCard({ p, message }: { p: PollP; message: ChatMessage }) {
  const { token, seat } = useMe();
  const reactions = (message.reactions ?? {}) as Record<string, string[]>;
  const mine = p.options.findIndex((_, i) => (reactions[`${CARD_VOTE_PREFIX}${i}`] ?? []).includes(seat ?? ''));
  const [voted, setVoted] = useState<number>(mine);
  const [results, setResults] = useState<{ option: string; votes: number }[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const closed = !!p.closesAt && Date.parse(p.closesAt) < Date.now();
  const myVote = voted >= 0 ? voted : mine;
  // Live results after voting; before that (e.g. after a reload) fall back to this app's votes.
  const rows = results ?? p.options.map((o, i) => ({ option: o, votes: (reactions[`${CARD_VOTE_PREFIX}${i}`] ?? []).length }));
  const total = rows.reduce((n, r) => n + r.votes, 0);
  const vote = async (i: number) => {
    if (!token || busy !== null || closed) return;
    setBusy(i); setErr(null);
    try { const r = await api.pollVote(token, message.id, i); setVoted(i); setResults(r.results); }
    catch (e) { setErr((e as Error).message || 'Couldn’t record your vote. Try again.'); }
    finally { setBusy(null); }
  };
  return (
    <View style={styles.wrap} accessible={false}>
      <View style={styles.card}>
        <Header icon="stats-chart-outline" label="Poll" by={p.by} at={message.createdAt} sponsored={p.sponsored} />
        <Txt v="bodyStrong">{p.question}</Txt>
        {p.options.map((o, i) => {
          const pct = total ? Math.round((rows[i].votes * 100) / total) : 0;
          const showResult = myVote >= 0 || closed;
          return (
            <Pressable key={i} onPress={() => vote(i)} disabled={closed || busy !== null} accessibilityRole="button" accessibilityState={{ selected: myVote === i }}
              accessibilityLabel={`${o}${showResult ? `, ${pct} percent` : ''}`} style={[styles.opt, myVote === i && styles.optOn]}>
              {showResult && <View style={[styles.bar, { width: `${pct}%` }]} />}
              <Txt v="body" style={{ flex: 1 }}>{o}</Txt>
              {busy === i ? <ActivityIndicator size="small" color={palette.cyan} /> : showResult ? <Txt v="smallStrong" color={palette.textSecondary}>{pct}%</Txt> : null}
              {myVote === i && <Ionicons name="checkmark-circle" size={16} color={palette.cyan} />}
            </Pressable>
          );
        })}
        <Txt v="meta" color={palette.textSecondary}>
          {err ?? (closed ? `Poll closed · ${total} vote${total === 1 ? '' : 's'}` : myVote >= 0 ? `${total} vote${total === 1 ? '' : 's'} · tap another option to change` : 'Tap an option to vote')}
        </Txt>
      </View>
    </View>
  );
}

// ----------------------------------------------------------------- survey ---
export function SurveyCard({ p, message }: { p: SurveyP; message: ChatMessage }) {
  const { token, seat } = useMe();
  const done = ((message.reactions ?? {}) as Record<string, string[]>)[CARD_SURVEY_DONE]?.includes(seat ?? '');
  const [i, setI] = useState(0);
  const [answers, setAnswers] = useState<(string | number)[]>([]);
  const [text, setText] = useState('');
  const [state, setState] = useState<'asking' | 'sending' | 'done' | 'error'>(done ? 'done' : 'asking');
  const qs = p.questions;
  const q = qs[i];
  const next = async (value: string | number) => {
    const all = [...answers.slice(0, i), value];
    setAnswers(all); setText('');
    if (i < qs.length - 1) { setI(i + 1); return; }
    if (!token) return;
    setState('sending');
    try { await api.surveyAnswer(token, message.id, all); setState('done'); } catch { setState('error'); }
  };
  return (
    <View style={styles.wrap} accessible={false}>
      <View style={styles.card}>
        <Header icon="clipboard-outline" label={qs.length > 1 && state !== 'done' && !done ? `Quick survey · ${Math.min(i + 1, qs.length)} of ${qs.length}` : 'Quick survey'} by={p.by} at={message.createdAt} sponsored={p.sponsored} />
        {state === 'done' || done ? (
          <View style={styles.doneRow}><Ionicons name="checkmark-circle" size={18} color={palette.cyan} /><Txt v="body">Thanks, your answers are in.</Txt></View>
        ) : !q ? null : (
          <>
            <Txt v="bodyStrong">{q.q}</Txt>
            {q.type === 'rating' && (
              <View style={styles.stars} accessibilityRole="radiogroup" accessibilityLabel="Rate from 1 to 5 stars">
                {[1, 2, 3, 4, 5].map((n) => (
                  <Pressable key={n} onPress={() => next(n)} disabled={state === 'sending'} hitSlop={6} accessibilityRole="radio" accessibilityLabel={`${n} star${n > 1 ? 's' : ''}`}>
                    <Ionicons name={(answers[i] as number) >= n ? 'star' : 'star-outline'} size={30} color={palette.amber} />
                  </Pressable>
                ))}
              </View>
            )}
            {q.type === 'choice' && (q.options ?? ['Yes', 'No', 'Not sure']).map((o) => (
              <Pressable key={o} onPress={() => next(o)} disabled={state === 'sending'} accessibilityRole="button" style={styles.opt}><Txt v="body">{o}</Txt></Pressable>
            ))}
            {q.type === 'text' && (
              <View style={styles.textRow}>
                <TextInput value={text} onChangeText={setText} placeholder="Type your answer" placeholderTextColor={palette.textSecondary} maxLength={200} style={styles.input} />
                <Pressable onPress={() => text.trim() && next(text.trim())} disabled={!text.trim() || state === 'sending'} style={[styles.send, !text.trim() && { opacity: 0.4 }]} accessibilityRole="button" accessibilityLabel="Next">
                  <Ionicons name="arrow-forward" size={18} color="#fff" />
                </Pressable>
              </View>
            )}
            <Txt v="meta" color={palette.textSecondary}>
              {state === 'sending' ? 'Sending…' : state === 'error' ? 'Couldn’t send. Tap your answer again.' : qs.length > 1 ? 'Takes about 20 seconds' : 'One tap and you’re done'}
            </Txt>
          </>
        )}
      </View>
    </View>
  );
}

const styles = themed(() => ({
  wrap: { paddingHorizontal: 12, paddingVertical: 8 },
  card: { paddingHorizontal: 14, paddingVertical: 12, gap: 8, borderRadius: radius.chip + 2, backgroundColor: palette.surfaceSunk, borderWidth: 1, borderColor: palette.hairline, borderLeftWidth: 3, borderLeftColor: palette.cyan },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  badge: { paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, borderWidth: 1, borderColor: palette.hairline },
  opt: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: palette.hairline, overflow: 'hidden', backgroundColor: palette.surface },
  optOn: { borderColor: palette.cyan },
  bar: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: palette.cyanSoft },
  stars: { flexDirection: 'row', gap: 8, paddingVertical: 2 },
  doneRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  textRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: { flex: 1, borderWidth: 1, borderColor: palette.hairline, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, color: palette.text, backgroundColor: palette.surface },
  send: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.cyan },
}));
