import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { api } from '../services/api';
import { PollCard, SurveyCard } from './PlatformCards';
import { useChat } from '../store/chatStore';
import { Ionicons, MaterialCommunityIcons } from './icons';
import { Txt } from './Txt';
import { clock } from '../utils/format';
import { palette, radius, themed } from '../theme/tokens';
import type { BroadcastPayload, ChatMessage } from '../shared/protocol';

/** Conductor broadcasts sit centred, full-width, visually outside the conversation. */
export function BroadcastRow({ message }: { message: ChatMessage }) {
  const p = message.payload as BroadcastPayload;
  if (p.kind === 'REST_STOP') {
    return (
      <Row icon={<MaterialCommunityIcons name="silverware-fork-knife" size={16} color={palette.amber} />} label={`Conductor · ${clock(message.createdAt)}`}
        text={`${p.label} for ${Math.round(p.durationSec / 60)} minutes${p.place ? ` at ${p.place}` : ''}. Timer is pinned at the top.`} />
    );
  }
  if (p.kind === 'REST_STOP_ENDED') {
    return <Row icon={<MaterialCommunityIcons name="bus-clock" size={16} color={palette.red} />} label={`Conductor · ${clock(message.createdAt)}`} text={`${p.label} is over. The bus is leaving, please be on board.`} />;
  }
  if (p.kind === 'SPONSORED') return <SponsoredCard p={p} at={message.createdAt} />;
  if (p.kind === 'POLL_CARD') return <PollCard p={p} message={message} />;
  if (p.kind === 'SURVEY_CARD') return <SurveyCard p={p} message={message} />;
  if (p.kind === 'CARE_REPLY') {
    // Private support reply (Trip Rooms console). The server only ever sends it to this seat.
    return <Row icon={<Ionicons name="headset-outline" size={16} color={palette.cyan} />} label={`${p.from} · only you can see this · ${clock(message.createdAt)}`} text={p.text} accent={palette.cyan} />;
  }
  const from = p.from ?? 'Conductor';
  return <Row icon={<Ionicons name={p.from ? 'alert-circle-outline' : 'megaphone-outline'} size={16} color={p.severity === 'critical' ? palette.red : palette.cyan} />}
    label={`${from} · ${clock(message.createdAt)}`} text={p.hi ? `${p.text}\n${p.hi}` : p.text} accent={p.severity === 'critical' ? palette.red : undefined} />;
}

function Row({ icon, label, text, accent }: { icon: React.ReactNode; label: string; text: string; accent?: string }) {
  return (
    <View style={styles.wrap} accessible accessibilityLabel={`${label}. ${text}`}>
      <View style={[styles.card, accent ? { borderLeftColor: accent } : null]}>
        <View style={styles.head}>{icon}<Txt v="meta" color={palette.textSecondary}>{label}</Txt></View>
        <Txt v="body">{text}</Txt>
      </View>
    </View>
  );
}

/** Campaign content from Trip Rooms. Always labelled; the button reveals the coupon and counts the tap. */
function SponsoredCard({ p, at }: { p: Extract<BroadcastPayload, { kind: 'SPONSORED' }>; at: string }) {
  const token = useChat((s) => s.session?.token);
  const [coupon, setCoupon] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tap = async () => {
    if (!token || busy) return;
    setBusy(true);
    try { const r = await api.adClick(token, p.platformMessageId); setCoupon(r.coupon ?? p.coupon ?? 'Offer saved'); } catch { setCoupon(p.coupon ?? 'Try again in a moment'); } finally { setBusy(false); }
  };
  return (
    <View style={styles.wrap} accessible accessibilityLabel={`${p.label} from ${p.advertiser}. ${p.title}. ${p.body}`}>
      <View style={[styles.card, { borderLeftColor: p.tile }]}>
        <View style={styles.head}>
          <View style={styles.badge}><Txt v="micro" color={palette.textSecondary}>{p.label.toUpperCase()}</Txt></View>
          <Txt v="meta" color={palette.textSecondary}>{p.advertiser} · {clock(at)}</Txt>
        </View>
        <View style={styles.adRow}>
          <View style={[styles.tile, { backgroundColor: p.tile }]}><Txt v="bodyStrong" color="#fff">{(p.advertiser || p.title).slice(0, 1).toUpperCase()}</Txt></View>
          <View style={{ flex: 1, gap: 2 }}>
            <Txt v="bodyStrong">{p.title}</Txt>
            {!!p.body && <Txt v="small" color={palette.textSecondary}>{p.body}</Txt>}
            {p.options?.map((o, i) => <Txt key={i} v="small">• {o}</Txt>)}
          </View>
        </View>
        {p.cta && (coupon
          ? <View style={styles.coupon}><Txt v="small" color={palette.textSecondary}>Your code</Txt><Txt v="bodyStrong" selectable>{coupon}</Txt></View>
          : <Pressable onPress={tap} accessibilityRole="button" style={[styles.cta, { backgroundColor: p.tile }]}>{busy ? <ActivityIndicator color="#fff" /> : <Txt v="smallStrong" color="#fff">{p.cta}</Txt>}</Pressable>)}
      </View>
    </View>
  );
}

export function SystemRow({ text }: { text: string }) {
  return (
    <View style={styles.sysWrap} accessible accessibilityLabel={text}>
      <Txt v="meta" color={palette.textSecondary} style={{ textAlign: 'center' }}>{text}</Txt>
    </View>
  );
}

const styles = themed(() => ({
  wrap: { paddingHorizontal: 12, paddingVertical: 8 },
  card: { paddingHorizontal: 14, paddingVertical: 11, gap: 4, borderRadius: radius.chip + 2, backgroundColor: palette.surfaceSunk, borderWidth: 1, borderColor: palette.hairline, borderLeftWidth: 3, borderLeftColor: palette.amber },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  badge: { paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, borderWidth: 1, borderColor: palette.hairline },
  adRow: { flexDirection: 'row', gap: 10, alignItems: 'center', marginTop: 4 },
  tile: { width: 40, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  cta: { alignSelf: 'flex-start', marginTop: 8, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, minWidth: 96, alignItems: 'center' },
  coupon: { marginTop: 8, padding: 8, borderRadius: 8, borderWidth: 1, borderStyle: 'dashed', borderColor: palette.hairline, gap: 2 },
  sysWrap: { alignSelf: 'center', maxWidth: '86%', marginVertical: 10, paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.chip, backgroundColor: palette.surface },
}));
