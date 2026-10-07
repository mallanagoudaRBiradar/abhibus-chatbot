import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
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
  return <Row icon={<Ionicons name="megaphone-outline" size={16} color={palette.cyan} />} label={`Conductor · ${clock(message.createdAt)}`} text={p.text} />;
}

function Row({ icon, label, text }: { icon: React.ReactNode; label: string; text: string }) {
  return (
    <View style={styles.wrap} accessible accessibilityLabel={`${label}. ${text}`}>
      <View style={styles.card}>
        <View style={styles.head}>{icon}<Txt v="meta" color={palette.textSecondary}>{label}</Txt></View>
        <Txt v="body">{text}</Txt>
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
  sysWrap: { alignSelf: 'center', maxWidth: '86%', marginVertical: 10, paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.chip, backgroundColor: palette.surface },
}));
