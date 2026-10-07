import React, { useEffect } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { MaterialCommunityIcons, Ionicons } from '@expo/vector-icons';
import { Txt } from './Txt';
import { ago, mmss } from '../utils/format';
import { LiveDot } from './LiveDot';
import { useChat } from '../store/chatStore';
import { stopLiveShare } from '../services/liveLocation';
import { useServerNow } from '../hooks/useNow';
import { palette, radius, themed } from '../theme/tokens';
import type { BusLocationPayload } from '../shared/protocol';

/** "Bus is currently near Kurnool Highway (NH 44)". Always the bus, never a phone. */
export function LocationCard({ payload, pending, mine = false }: { payload: BusLocationPayload | null; pending: boolean; mine?: boolean }) {
  const now = useServerNow(30_000);
  if (pending || !payload) return <LocationSkeleton mine={(payload as any)?.source === 'PASSENGER'} />;
  if (payload.source === 'PASSENGER') return <PassengerLocation payload={payload} now={now} mine={mine} />;
  const pct = Math.round(payload.progress * 100);
  return (
    <View style={styles.card} accessible accessibilityLabel={`Bus location. Near ${payload.placeLabel}, ${payload.highway}.`}>
      <View style={styles.head}>
        <View style={styles.icon}><MaterialCommunityIcons name="bus-marker" size={18} color={palette.cyan} /></View>
        <View style={{ flex: 1 }}>
          <Txt v="meta" color={palette.textSecondary}>Our bus is near</Txt>
          <Txt v="title" numberOfLines={2}>{`${payload.placeLabel} (${payload.highway.replace(/ /g, '\u00A0')})`}</Txt>
        </View>
      </View>
      <View style={styles.mini}>
        <View style={[styles.miniFill, { width: `${pct}%` }]} />
        <View style={[styles.miniDot, { left: `${pct}%` }]} />
      </View>
      <View style={styles.facts}>
        {payload.speedKmph != null && <Fact icon="speedometer-outline" text={`${payload.speedKmph} km/h`} />}
        {payload.nextStop && <Fact icon="flag-outline" text={`${payload.nextStop.name} in ${payload.nextStop.distanceKm} km`} />}
        <Fact icon="time-outline" text={ago(payload.recordedAt, now)} />
      </View>
      <View style={styles.foot}>
        <Ionicons name="lock-closed-outline" size={11} color={palette.textTertiary} />
        <Txt v="micro" color={palette.textTertiary}>From the bus GPS, not anyone’s phone</Txt>
      </View>
    </View>
  );
}

function Fact({ icon, text }: { icon: any; text: string }) {
  return (
    <View style={styles.fact}>
      <Ionicons name={icon} size={12} color={palette.textSecondary} />
      <Txt v="meta" color={palette.textSecondary}>{text}</Txt>
    </View>
  );
}

/** A passenger's own one-time location: where they are, how far from the bus, and a way to navigate there. */
function PassengerLocation({ payload, now, mine }: { payload: BusLocationPayload; now: number; mine: boolean }) {
  if (payload.live) return <LiveLocation payload={payload} mine={mine} />;
  const dist = payload.distanceFromBusM;
  const distLabel = dist == null ? null : dist < 1000 ? `${Math.max(10, Math.round(dist / 10) * 10)} m from the bus` : `${(dist / 1000).toFixed(1)} km from the bus`;
  const open = () => Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${payload.lat},${payload.lng}`);
  return (
    <View style={[styles.card, { borderColor: palette.roseBorder }]} accessible accessibilityLabel={`Shared location. ${payload.placeLabel}. ${distLabel ?? ''}`}>
      <View style={styles.head}>
        <View style={[styles.icon, { backgroundColor: palette.roseSoft }]}><Ionicons name="person-circle-outline" size={20} color={palette.rose} /></View>
        <View style={{ flex: 1 }}>
          <Txt v="meta" color={palette.textSecondary}>{mine ? 'You shared your location' : 'Shared their location'}</Txt>
          <Txt v="title" numberOfLines={2}>{payload.placeLabel}</Txt>
        </View>
      </View>
      <View style={styles.facts}>
        {distLabel && <Fact icon="bus-outline" text={distLabel} />}
        {payload.accuracyM != null && <Fact icon="locate-outline" text={`±${payload.accuracyM} m`} />}
        <Fact icon="time-outline" text={ago(payload.recordedAt, now)} />
      </View>
      <Pressable onPress={open} style={({ pressed }) => [styles.mapBtn, pressed && { opacity: 0.7 }]} accessibilityRole="link" accessibilityLabel="Open in Maps">
        <Ionicons name="navigate-outline" size={15} color={palette.text} />
        <Txt v="smallStrong">Open in Maps</Txt>
      </Pressable>
      <View style={styles.foot}>
        <Ionicons name="lock-closed-outline" size={11} color={palette.textTertiary} />
        <Txt v="micro" color={palette.textTertiary}>Shared once, not live. Deleted with this chat.</Txt>
      </View>
    </View>
  );
}

/** Live location card: pulsing while active (ticks every second for the countdown), calm once it ends. */
function LiveLocation({ payload, mine }: { payload: BusLocationPayload; mine: boolean }) {
  const now = useServerNow(1000);
  const live = payload.live!;
  const endedAt = live.stoppedAt ?? (now >= Date.parse(live.until) ? live.until : null);
  const active = !endedAt;
  const left = Math.max(0, Date.parse(live.until) - now);
  const dist = payload.distanceFromBusM;
  const distLabel = dist == null ? null : dist < 1000 ? `${Math.max(10, Math.round(dist / 10) * 10)} m from the bus` : `${(dist / 1000).toFixed(1)} km from the bus`;
  const sharingThis = useChat((st) => st.liveShare?.messageId);
  return (
    <View style={[styles.card, { borderColor: active ? palette.roseBorder : palette.hairline }]} accessible accessibilityLabel={`Live location${active ? `, ${Math.ceil(left / 60000)} minutes left` : ', ended'}. ${payload.placeLabel}`}>
      <View style={styles.head}>
        <View style={[styles.icon, { backgroundColor: active ? palette.roseSoft : palette.surfaceRaised }]}>
          <MaterialCommunityIcons name="map-marker-radius" size={20} color={active ? palette.rose : palette.textTertiary} />
        </View>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {active && <LiveDot color={palette.rose} size={7} />}
            <Txt v="meta" color={active ? palette.rose : palette.textSecondary}>{active ? `Live · ${mmss(left)} left` : 'Live location ended'}</Txt>
          </View>
          <Txt v="title" numberOfLines={2}>{payload.placeLabel}</Txt>
        </View>
      </View>
      <View style={styles.facts}>
        {distLabel && <Fact icon="bus-outline" text={distLabel} />}
        {payload.accuracyM != null && <Fact icon="locate-outline" text={`±${payload.accuracyM} m`} />}
        <Fact icon="time-outline" text={`Updated ${ago(payload.recordedAt, now)}`} />
      </View>
      <Pressable onPress={() => Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${payload.lat},${payload.lng}`)} style={({ pressed }) => [styles.mapBtn, pressed && { opacity: 0.7 }]} accessibilityRole="link">
        <Ionicons name="navigate-outline" size={15} color={palette.text} />
        <Txt v="smallStrong">Open in Maps</Txt>
      </Pressable>
      {mine && active && sharingThis && (
        <Pressable onPress={() => void stopLiveShare()} style={({ pressed }) => [styles.mapBtn, { backgroundColor: palette.redSoft }, pressed && { opacity: 0.7 }]} accessibilityRole="button">
          <Ionicons name="stop-circle-outline" size={15} color={palette.red} />
          <Txt v="smallStrong" color={palette.red}>Stop sharing</Txt>
        </Pressable>
      )}
      <View style={styles.foot}>
        <Ionicons name="lock-closed-outline" size={11} color={palette.textTertiary} />
        <Txt v="micro" color={palette.textTertiary}>{`Live for ${live.minutes} min while the app is open. Deleted with this chat.`}</Txt>
      </View>
    </View>
  );
}

function LocationSkeleton({ mine }: { mine?: boolean }) {
  const o = useSharedValue(0.4);
  useEffect(() => { o.value = withRepeat(withTiming(1, { duration: 700 }), -1, true); }, []);
  const st = useAnimatedStyle(() => ({ opacity: o.value }));
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <View style={styles.icon}><MaterialCommunityIcons name="satellite-variant" size={18} color={palette.cyan} /></View>
        <Txt v="smallStrong" color={palette.textSecondary}>{mine ? 'Sharing your location' : 'Finding the bus'}</Txt>
      </View>
      <Animated.View style={[styles.skelLine, st]} />
      <Animated.View style={[styles.skelLine, { width: '55%' }, st]} />
    </View>
  );
}

const styles = themed(() => ({
  card: { width: 264, padding: 14, gap: 12, borderRadius: radius.card, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.cyanBorder },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  icon: { width: 34, height: 34, borderRadius: 10, backgroundColor: palette.cyanSoft, alignItems: 'center', justifyContent: 'center' },
  mini: { height: 4, borderRadius: 2, backgroundColor: palette.dash, justifyContent: 'center' },
  miniFill: { height: 4, borderRadius: 2, backgroundColor: palette.cyan, opacity: 0.7 },
  miniDot: { position: 'absolute', width: 10, height: 10, marginLeft: -5, borderRadius: 5, backgroundColor: palette.cyan, borderWidth: 2, borderColor: palette.surface },
  facts: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  fact: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  foot: { flexDirection: 'row', alignItems: 'center', gap: 5, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.hairline, paddingTop: 8 },
  mapBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, height: 36, borderRadius: radius.pill, backgroundColor: palette.surfaceRaised },
  skelLine: { height: 10, borderRadius: 5, backgroundColor: palette.surfaceRaised },
}));
