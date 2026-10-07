import React, { useState } from 'react';
import { Linking, Platform, Pressable, TextInput, View } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Txt } from './Txt';
import { toast } from './Toast';
import { useChat, type UiMessage } from '../store/chatStore';
import { chatSocket } from '../services/socket';
import { clock, mmss } from '../utils/format';
import { useServerNow } from '../hooks/useNow';
import { font, palette, radius, roomTheme, themed } from '../theme/tokens';
import { useTenant } from '../tenant';
import type { AdPayload, AlertPayload, CrewPayload, IssuePayload, LostPayload, PrivatePayload, RatePayload, SurveyPayload, TaraPayload, TimerPayload, VoucherPayload } from '../shared/protocol';

/**
 * ============================================================================
 *  Cards the platform posts into a room (not person-to-person chat)
 * ============================================================================
 *  ALERT    Ops announcement — the one thing everyone must read. Hindi toggle.
 *  TARA     the trip assistant's answer (rules today, LLM-ready).
 *  PRIVATE  only this traveller sees it (SOS ack, Ops reply, catch-up).
 *  ISSUE    group issue with "Me too" — escalates to Ops at a threshold.
 *  VOUCHER  delay credit, claim once.
 *  TIMER    rest stop: when we leave (the live countdown is pinned at the top).
 *  LOST     lost & found post (numbers masked by the server).
 *  CREW     conductor / TTE / cabin crew.
 *  RATE     end-of-trip stars.
 *  SURVEY   1–4 quick questions (research, not an ad).
 *  AD       always labelled. Never shown during SOS / breakdown / after alerts.
 *  "Mine" state (claimed, voted, answered) rides the reactions channel, so
 *  every card updates live without extra events.
 * ============================================================================
 */
const PLATFORM_KINDS = new Set(['ALERT', 'TARA', 'PRIVATE', 'ISSUE', 'VOUCHER', 'TIMER', 'LOST', 'CREW', 'RATE', 'SURVEY', 'AD']);
export const isPlatformCard = (t: string) => PLATFORM_KINDS.has(t);

const mineIn = (m: UiMessage, key: string, seat: string) => (m.reactions[key] ?? []).includes(seat);

export function PlatformCard({ message: m }: { message: UiMessage }) {
  const seat = useChat((s) => s.session!.me.seat);
  switch (m.contentType) {
    case 'ALERT': return <AlertCard m={m} />;
    case 'TARA': return <TaraCard m={m} />;
    case 'PRIVATE': return <PrivateCard m={m} />;
    case 'ISSUE': return <IssueCard m={m} seat={seat} />;
    case 'VOUCHER': return <VoucherCard m={m} seat={seat} />;
    case 'TIMER': return <TimerRow m={m} />;
    case 'LOST': return <LostCard m={m} />;
    case 'CREW': return <CrewCard m={m} />;
    case 'RATE': return <RateCard m={m} seat={seat} />;
    case 'SURVEY': return <SurveyCard m={m} seat={seat} />;
    case 'AD': return <AdCard m={m} seat={seat} />;
    default: return null;
  }
}

// ------------------------------------------------------------------ alert ---
const SEV = () => ({
  critical: { color: palette.red, soft: palette.redSoft, border: palette.redBorder, icon: 'alert-octagon' as const, label: 'Urgent' },
  warning: { color: palette.amber, soft: palette.amberSoft, border: palette.amberBorder, icon: 'alert' as const, label: 'Update' },
  info: { color: palette.cyan, soft: palette.cyanSoft, border: palette.cyanBorder, icon: 'information' as const, label: 'Info' },
});
export function AlertCard({ m, compact, onHide }: { m: UiMessage; compact?: boolean; onHide?: () => void }) {
  const p = m.payload as AlertPayload;
  const tenant = useTenant();
  const [hi, setHi] = useState(false);
  const s = SEV()[p.severity] ?? SEV().info;
  const text = hi && p.translations?.hi ? p.translations.hi : p.text;
  return (
    <View style={[styles.wide, compact && { paddingVertical: 0, paddingHorizontal: 0 }]} accessible accessibilityRole="alert" accessibilityLabel={`${tenant?.name ?? ''} alert. ${p.text}`}>
      <View style={[styles.alert, { borderColor: s.border, borderLeftColor: s.color, backgroundColor: compact ? palette.surface : s.soft }]}>
        <View style={styles.head}>
          <MaterialCommunityIcons name={s.icon} size={16} color={s.color} />
          <Txt v="smallStrong" color={s.color}>{`${tenant?.name ?? 'Ops'} · ${s.label}`}</Txt>
          <Txt v="micro" color={palette.textTertiary} style={{ marginLeft: 'auto' }}>{clock(m.createdAt)}</Txt>
          {onHide && (
            <Pressable onPress={onHide} hitSlop={10} accessibilityRole="button" accessibilityLabel="Hide alert. It stays in the chat">
              <Ionicons name="chevron-up" size={16} color={palette.textTertiary} />
            </Pressable>
          )}
        </View>
        <Txt v={compact ? 'small' : 'body'} numberOfLines={compact ? 3 : undefined}>{text}</Txt>
        {!!p.translations?.hi && (
          <Pressable onPress={() => setHi((x) => !x)} hitSlop={8} accessibilityRole="button" style={{ alignSelf: 'flex-start' }}>
            <Txt v="micro" color={palette.textSecondary} style={styles.link}>{hi ? 'Show in English' : 'हिन्दी में पढ़ें'}</Txt>
          </Pressable>
        )}
      </View>
    </View>
  );
}

// ------------------------------------------------------------------- tara ---
function TaraCard({ m }: { m: UiMessage }) {
  const p = m.payload as TaraPayload;
  return (
    <View style={styles.leftRow}>
      <View style={styles.taraAvatar}><Txt style={{ fontSize: 15, lineHeight: 20 }}>✨</Txt></View>
      <View style={[styles.bubble, styles.tara]}>
        <View style={styles.head}><Txt v="smallStrong" color={palette.text}>Tara</Txt><Badge label="Assistant" tone="violet" /></View>
        <Txt v="body">{p.text}</Txt>
        <Txt v="micro" color={palette.textTertiary} style={{ marginTop: 2 }}>{clock(m.createdAt)}</Txt>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- private ---
function PrivateCard({ m }: { m: UiMessage }) {
  const p = m.payload as PrivatePayload;
  return (
    <View style={styles.wide}>
      <View style={styles.private}>
        <View style={styles.head}>
          <Ionicons name="lock-closed" size={13} color={palette.textSecondary} />
          <Txt v="micro" color={palette.textSecondary}>{`Only you can see this · from ${p.from}`}</Txt>
          <Txt v="micro" color={palette.textTertiary} style={{ marginLeft: 'auto' }}>{clock(m.createdAt)}</Txt>
        </View>
        <Txt v="body">{p.text}</Txt>
      </View>
    </View>
  );
}

// ------------------------------------------------------------------ issue ---
function IssueCard({ m, seat }: { m: UiMessage; seat: string }) {
  const p = m.payload as IssuePayload;
  const mine = mineIn(m, 'issue:metoo', seat);
  const accent = roomTheme[m.roomType].accent;
  const [busy, setBusy] = useState(false);
  const metoo = async () => {
    setBusy(true); Haptics.selectionAsync();
    const a = await chatSocket.metoo(m.id);
    setBusy(false);
    if (!a.ok) toast(a.message, 'danger');
  };
  return (
    <View style={styles.wide}>
      <View style={styles.card}>
        <View style={styles.head}>
          <MaterialCommunityIcons name="wrench-outline" size={16} color={palette.amber} />
          <Txt v="smallStrong">Group issue</Txt>
          {p.escalated && <Badge label="Ops notified" tone="green" />}
        </View>
        <Txt v="bodyStrong">{p.label}</Txt>
        <Txt v="meta" color={palette.textSecondary}>
          {p.escalated ? `${p.count} travellers reported this. The team is on it.` : `${p.count} ${p.count === 1 ? 'traveller has' : 'travellers have'} reported this. Ops is alerted at ${p.threshold}.`}
        </Txt>
        <Pressable onPress={metoo} disabled={mine || busy} style={({ pressed }) => [styles.cta, mine ? styles.ctaDone : { backgroundColor: accent }, pressed && { opacity: 0.85 }]}
          accessibilityRole="button" accessibilityState={{ disabled: mine }}>
          <Txt v="smallStrong" color={mine ? palette.textSecondary : roomTheme[m.roomType].onAccent}>{mine ? '✓ You reported this' : 'Me too'}</Txt>
        </Pressable>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- voucher ---
function VoucherCard({ m, seat }: { m: UiMessage; seat: string }) {
  const p = m.payload as VoucherPayload;
  const claimed = mineIn(m, 'voucher:claimed', seat);
  const [code, setCode] = useState<string | null>(null);
  const claim = async () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const a = await chatSocket.claimVoucher(m.id);
    if (a.ok) setCode(a.data.code); else toast(a.message, 'danger');
  };
  return (
    <View style={styles.wide}>
      <View style={[styles.card, styles.voucher]}>
        <View style={styles.head}><MaterialCommunityIcons name="ticket-percent-outline" size={18} color={palette.green} /><Txt v="smallStrong" color={palette.green}>Sorry for the delay</Txt></View>
        <Txt style={{ fontFamily: font.displayBold, fontSize: 26, lineHeight: 32 }}>{`₹${p.amount}`}</Txt>
        <Txt v="meta" color={palette.textSecondary}>{`${p.note || 'Travel credit'} · valid ${p.validDays} days`}</Txt>
        {claimed || code ? (
          <View style={styles.codeBox}><Txt v="micro" color={palette.textSecondary}>Added to your wallet</Txt>{code && <Txt v="bodyStrong" style={{ letterSpacing: 1 }}>{code}</Txt>}</View>
        ) : (
          <Pressable onPress={claim} style={({ pressed }) => [styles.cta, { backgroundColor: palette.green }, pressed && { opacity: 0.85 }]} accessibilityRole="button">
            <Txt v="smallStrong" color={palette.navyDeep}>Claim voucher</Txt>
          </Pressable>
        )}
      </View>
    </View>
  );
}

// ------------------------------------------------------------------ timer ---
function TimerRow({ m }: { m: UiMessage }) {
  const p = m.payload as TimerPayload;
  const now = useServerNow(1000);
  const left = Date.parse(p.leaveAt) - now;
  return (
    <View style={styles.wide}>
      <View style={[styles.card, { borderLeftWidth: 3, borderLeftColor: palette.amber }]}>
        <View style={styles.head}><MaterialCommunityIcons name="silverware-fork-knife" size={16} color={palette.amber} /><Txt v="smallStrong">{`Rest stop · ${p.stop}`}</Txt></View>
        <Txt v="body">{left > 0 ? `We leave at ${clock(p.leaveAt)} — ${mmss(left)} left. The timer is pinned at the top.` : `Stop ended at ${clock(p.leaveAt)}.`}</Txt>
      </View>
    </View>
  );
}

// ------------------------------------------------------------------- lost ---
function LostCard({ m }: { m: UiMessage }) {
  const p = m.payload as LostPayload;
  return (
    <View style={styles.wide}>
      <View style={styles.card}>
        <View style={styles.head}><MaterialCommunityIcons name="bag-suitcase-outline" size={16} color={palette.rose} /><Txt v="smallStrong">Lost & found</Txt><Txt v="micro" color={palette.textTertiary} style={{ marginLeft: 'auto' }}>{`${m.senderHandle} · ${clock(m.createdAt)}`}</Txt></View>
        <Txt v="body">{p.text}</Txt>
        <Txt v="micro" color={palette.textTertiary}>Seen it? Reply here — numbers are hidden automatically. Ops has a copy.</Txt>
      </View>
    </View>
  );
}

// ------------------------------------------------------------------- crew ---
function CrewCard({ m }: { m: UiMessage }) {
  const p = m.payload as CrewPayload;
  return (
    <View style={styles.leftRow}>
      <View style={[styles.taraAvatar, { backgroundColor: palette.greenSoft }]}><MaterialCommunityIcons name="account-tie" size={17} color={palette.green} /></View>
      <View style={[styles.bubble, { backgroundColor: palette.greenSoft, borderColor: palette.hairline }]}>
        <View style={styles.head}><Txt v="smallStrong">{p.role}</Txt><Badge label="Crew" tone="green" /></View>
        <Txt v="body">{p.text}</Txt>
        <Txt v="micro" color={palette.textTertiary} style={{ marginTop: 2 }}>{clock(m.createdAt)}</Txt>
      </View>
    </View>
  );
}

// ------------------------------------------------------------------- rate ---
function RateCard({ m, seat }: { m: UiMessage; seat: string }) {
  const p = m.payload as RatePayload;
  const mine = Object.keys(m.reactions).find((k) => k.startsWith('rate:') && m.reactions[k].includes(seat));
  const [stars, setStars] = useState(mine ? Number(mine.split(':')[1]) : 0);
  const rate = async (n: number) => {
    setStars(n); Haptics.selectionAsync();
    const a = await chatSocket.rateTrip(m.id, n);
    if (!a.ok) toast(a.message, 'danger'); else toast('Thanks for rating your trip', 'success');
  };
  return (
    <View style={styles.wide}>
      <View style={[styles.card, { alignItems: 'center' }]}>
        <Txt v="bodyStrong" style={{ textAlign: 'center' }}>{p.prompt || 'How was your trip?'}</Txt>
        <View style={{ flexDirection: 'row', gap: 6 }}>
          {[1, 2, 3, 4, 5].map((n) => (
            <Pressable key={n} onPress={() => rate(n)} hitSlop={4} accessibilityRole="button" accessibilityLabel={`${n} star${n > 1 ? 's' : ''}`}>
              <Ionicons name={n <= stars ? 'star' : 'star-outline'} size={30} color={n <= stars ? palette.amber : palette.textTertiary} />
            </Pressable>
          ))}
        </View>
        {stars > 0 && <Txt v="micro" color={palette.textSecondary}>{stars >= 4 ? 'Glad you had a good trip!' : 'Sorry about that. Your feedback goes to the team.'}</Txt>}
      </View>
    </View>
  );
}

// ----------------------------------------------------------------- survey ---
function SurveyCard({ m, seat }: { m: UiMessage; seat: string }) {
  const p = m.payload as SurveyPayload;
  const done = mineIn(m, 'survey:done', seat);
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<(string | number)[]>([]);
  const [text, setText] = useState('');
  const [sent, setSent] = useState(false);
  const q = p.questions[step];
  const answer = async (v: string | number) => {
    Haptics.selectionAsync();
    const next = [...answers, v];
    setAnswers(next); setText('');
    if (step + 1 < p.questions.length) { setStep(step + 1); return; }
    const a = await chatSocket.answerSurvey(m.id, next);
    if (a.ok) setSent(true); else toast(a.message, 'danger');
  };
  return (
    <View style={styles.wide}>
      <View style={styles.card}>
        <View style={styles.head}><MaterialCommunityIcons name="clipboard-text-outline" size={16} color={palette.cyan} /><Txt v="smallStrong">{`Quick survey · ${p.by}`}</Txt>{!done && !sent && <Txt v="micro" color={palette.textTertiary} style={{ marginLeft: 'auto' }}>{`${step + 1} of ${p.questions.length}`}</Txt>}</View>
        {done || sent ? <Txt v="body" color={palette.textSecondary}>Thanks — your answers were sent.</Txt> : q && (
          <>
            <Txt v="bodyStrong">{q.q}</Txt>
            {q.type === 'rating' && <View style={{ flexDirection: 'row', gap: 6 }}>{[1, 2, 3, 4, 5].map((n) => <Pressable key={n} onPress={() => answer(n)} hitSlop={4} accessibilityRole="button" accessibilityLabel={`${n} stars`}><Ionicons name="star-outline" size={28} color={palette.amber} /></Pressable>)}</View>}
            {q.type === 'choice' && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{(q.options?.length ? q.options : ['Yes', 'No', 'Not sure']).map((o) => <Pressable key={o} onPress={() => answer(o)} style={({ pressed }) => [styles.chip, pressed && { opacity: 0.7 }]} accessibilityRole="button"><Txt v="smallStrong">{o}</Txt></Pressable>)}</View>}
            {q.type === 'text' && (
              <View style={{ flexDirection: 'row', gap: 6 }}>
                <TextInput value={text} onChangeText={setText} maxLength={200} placeholder="Type your answer" placeholderTextColor={palette.textTertiary} style={styles.input} />
                <Pressable onPress={() => text.trim() && answer(text.trim())} style={[styles.cta, { backgroundColor: palette.cyan, marginTop: 0, paddingHorizontal: 14 }]} accessibilityRole="button"><Txt v="smallStrong" color={palette.navyDeep}>Next</Txt></Pressable>
              </View>
            )}
          </>
        )}
      </View>
    </View>
  );
}

// --------------------------------------------------------------------- ad ---
function AdCard({ m, seat }: { m: UiMessage; seat: string }) {
  const p = m.payload as AdPayload;
  const clicked = mineIn(m, 'ad:clicked', seat);
  const [coupon, setCoupon] = useState<string | null>(null);
  const tap = async () => {
    Haptics.selectionAsync();
    const a = await chatSocket.adClick(m.id);
    if (a.ok) { if (a.data.url) void Linking.openURL(a.data.url); setCoupon(a.data.coupon ?? null); }
  };
  return (
    <View style={styles.wide}>
      <View style={styles.card}>
        <View style={styles.head}><Badge label={p.format === 'stop_offer' ? 'Offer' : 'Ad'} tone="mute" /><Txt v="micro" color={palette.textSecondary}>{`${p.advertiser}${p.stop ? ` · at ${p.stop}` : ''}`}</Txt></View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={[styles.tile, { backgroundColor: p.tile || palette.cyan }]}><Txt style={{ fontFamily: font.displayBold, fontSize: 16, color: '#fff' }}>{(p.title || p.advertiser || 'A').slice(0, 1)}</Txt></View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Txt v="bodyStrong" numberOfLines={1}>{p.title}</Txt>
            <Txt v="meta" color={palette.textSecondary} numberOfLines={2}>{p.body}</Txt>
          </View>
          {!(clicked || coupon) && (
            <Pressable onPress={tap} style={({ pressed }) => [styles.adCta, pressed && { opacity: 0.8 }]} accessibilityRole="button" accessibilityLabel={`${p.cta}. Sponsored`}>
              <Txt v="smallStrong" color={palette.text}>{p.cta || 'View'}</Txt>
            </Pressable>
          )}
        </View>
        {(clicked || coupon) && <View style={styles.codeBox}><Txt v="micro" color={palette.textSecondary}>Show this at the counter</Txt><Txt v="bodyStrong" style={{ letterSpacing: 1 }}>{coupon ?? p.coupon ?? 'Offer saved'}</Txt></View>}
      </View>
    </View>
  );
}

function Badge({ label, tone }: { label: string; tone: 'violet' | 'green' | 'mute' }) {
  const bg = tone === 'violet' ? 'rgba(124,108,240,0.18)' : tone === 'green' ? palette.greenSoft : palette.surfaceRaised;
  const fg = tone === 'violet' ? (Platform.OS === 'web' ? '#8b7cf6' : '#8b7cf6') : tone === 'green' ? palette.green : palette.textSecondary;
  return <View style={[styles.badge, { backgroundColor: bg }]}><Txt v="micro" color={fg} style={{ letterSpacing: 0.4 }}>{label.toUpperCase()}</Txt></View>;
}

const styles = themed(() => ({
  wide: { paddingHorizontal: 12, paddingVertical: 6 },
  leftRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 6, paddingHorizontal: 10, marginTop: 10 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  link: { textDecorationLine: 'underline' },
  alert: { padding: 12, gap: 6, borderRadius: radius.chip + 2, borderWidth: 1, borderLeftWidth: 4 },
  bubble: { maxWidth: '82%', paddingHorizontal: 12, paddingVertical: 8, gap: 3, borderRadius: radius.bubble, borderBottomLeftRadius: 6, borderWidth: 1 },
  tara: { backgroundColor: 'rgba(124,108,240,0.10)', borderColor: 'rgba(124,108,240,0.30)' },
  taraAvatar: { width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(124,108,240,0.18)', alignItems: 'center', justifyContent: 'center', marginBottom: 2 },
  private: { padding: 12, gap: 6, borderRadius: radius.chip + 2, borderWidth: 1, borderStyle: 'dashed', borderColor: palette.hairlineStrong, backgroundColor: palette.surfaceSunk },
  card: { padding: 12, gap: 6, borderRadius: radius.chip + 2, borderWidth: 1, borderColor: palette.hairline, backgroundColor: palette.surface },
  voucher: { borderStyle: 'dashed', borderColor: palette.green },
  cta: { marginTop: 4, height: 36, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, alignSelf: 'flex-start' },
  ctaDone: { backgroundColor: palette.surfaceRaised },
  codeBox: { marginTop: 4, padding: 10, borderRadius: radius.chip, backgroundColor: palette.surfaceSunk, borderWidth: 1, borderColor: palette.hairline, gap: 2 },
  chip: { paddingHorizontal: 14, height: 34, borderRadius: radius.pill, borderWidth: 1, borderColor: palette.hairlineStrong, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.surfaceSunk },
  input: { ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : null), flex: 1, height: 38, paddingHorizontal: 12, borderRadius: radius.chip, borderWidth: 1, borderColor: palette.hairlineStrong, color: palette.text, fontFamily: font.body, fontSize: 14, backgroundColor: palette.surfaceSunk },
  tile: { width: 42, height: 42, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  adCta: { paddingHorizontal: 12, height: 32, borderRadius: radius.pill, borderWidth: 1, borderColor: palette.hairlineStrong, alignItems: 'center', justifyContent: 'center' },
  badge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5 },
}));
