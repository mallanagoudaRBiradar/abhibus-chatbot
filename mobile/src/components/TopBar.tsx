import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Txt } from './Txt';
import { LiveDot } from './LiveDot';
import { useChat } from '../store/chatStore';
import { clock, mmss } from '../utils/format';
import { useServerNow } from '../hooks/useNow';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { font, palette, radius, themed } from '../theme/tokens';

/**
 * One compact header row. Answers "which trip, when do I arrive" at a glance;
 * bus number / operator live in the trip sheet (tap the title).
 *   [‹] [Hyderabad → Bengaluru         ] [SOS] [⋮]
 *       [Arriving ~6:10 AM · ● 12 online ›]
 *   ‹ = back to the AbhiBus app (chat keeps running), ⋮ = trip details + Exit chat.
 */
export function TopBar({ onBack, onOpenPassengers, onOpenSos, onOpenMenu }: { onBack: () => void; onOpenPassengers: () => void; onOpenSos: () => void; onOpenMenu: () => void }) {
  const insets = useSafeAreaInsets();
  const journey = useChat((s) => s.session!.journey);
  const activeRoom = useChat((s) => s.activeRoom);
  const count = useChat((s) => s.rooms[s.activeRoom].presence.onlineSeats.length);
  const online = useChat((s) => s.connection === 'online');
  const eta = useChat((s) => s.progress?.etaToDestination ?? s.session!.journey.estimatedEndTime);
  const arrived = useChat((s) => s.progress?.progress === 1);
  // A tucked-away stop timer lives here as a chip (tap to bring the card back).
  const pinned = useChat((s) => s.rooms[s.activeRoom].pinned);
  const hidden = useChat((s) => s.hiddenPins);
  const hidePin = useChat((s) => s.hidePin);
  const now = useServerNow(1000);
  const left = pinned ? Math.max(0, Date.parse(pinned.payload.endsAt) - now) : 0;
  const stopHidden = !!pinned && hidden.includes(pinned.messageId) && left >= 120_000;

  return (
    <View style={[styles.wrap, { paddingTop: insets.top + 8 }]}>
      <Pressable onPress={onBack} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back"
        style={({ pressed }) => [styles.iconBtn, pressed && { backgroundColor: palette.surface }]}>
        <Ionicons name="chevron-back" size={24} color={palette.text} />
      </Pressable>
      <View style={styles.title}>
        <Pressable onPress={onOpenMenu} hitSlop={8} accessibilityRole="button" accessibilityLabel={`${journey.sourceCity} to ${journey.destinationCity}. Trip details`}
          style={({ pressed }) => [styles.cities, pressed && { opacity: 0.7 }]}>
          <Txt v="title" numberOfLines={1} style={styles.city}>{journey.sourceCity}</Txt>
          <Ionicons name="arrow-forward" size={13} color={palette.textTertiary} style={{ marginHorizontal: 6 }} />
          <Txt v="title" numberOfLines={1} style={styles.city}>{journey.destinationCity}</Txt>
        </Pressable>
        <View style={styles.subRow}>
          {stopHidden ? (
            <Pressable onPress={() => { Haptics.selectionAsync(); hidePin(pinned!.messageId, false); }} hitSlop={8}
              style={({ pressed }) => [styles.stopChip, pressed && { opacity: 0.7 }]} accessibilityRole="button" accessibilityLabel={`${pinned!.payload.label}, ${mmss(left)} left. Show timer`}>
              <MaterialCommunityIcons name="silverware-fork-knife" size={11} color={palette.amber} />
              <Txt v="micro" color={palette.amber} style={{ fontVariant: ['tabular-nums'] }}>{`${mmss(left)} left`}</Txt>
            </Pressable>
          ) : (
            <Txt v="meta" color={palette.textSecondary} numberOfLines={1} style={{ flexShrink: 1 }}>
              {arrived ? 'Arrived' : online ? `Arriving ~${clock(eta)}` : 'Reconnecting…'}
            </Txt>
          )}
          <Txt v="meta" color={palette.textTertiary}>·</Txt>
          <Pressable
            onPress={() => { Haptics.selectionAsync(); onOpenPassengers(); }}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={`${count} ${activeRoom === 'WOMEN_ONLY' ? 'women' : 'passengers'} online. Show list`}
            style={({ pressed }) => [styles.count, pressed && { opacity: 0.6 }]}
          >
            <LiveDot color={online ? palette.green : palette.textTertiary} size={6} />
            <Txt v="meta" color={palette.text} style={{ fontVariant: ['tabular-nums'] }}>{`${count} online`}</Txt>
            <Ionicons name="chevron-forward" size={11} color={palette.textTertiary} />
          </Pressable>
        </View>
      </View>

      <Pressable
        onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); onOpenSos(); }}
        accessibilityRole="button"
        accessibilityLabel="Emergency SOS"
        hitSlop={8}
        style={({ pressed }) => [styles.sos, pressed && { transform: [{ scale: 0.94 }] }]}
      >
        <Ionicons name="shield-half" size={13} color={palette.red} />
        <Txt style={styles.sosText} color={palette.red}>SOS</Txt>
      </Pressable>

      <Pressable onPress={() => { Haptics.selectionAsync(); onOpenMenu(); }} hitSlop={8} accessibilityRole="button" accessibilityLabel="Trip details and exit"
        style={({ pressed }) => [styles.iconBtn, pressed && { backgroundColor: palette.surface }]}>
        <Ionicons name="ellipsis-vertical" size={20} color={palette.text} />
      </Pressable>
    </View>
  );
}

const styles = themed(() => ({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 6, paddingRight: 8, paddingBottom: 8, backgroundColor: palette.navy },
  title: { flex: 1, minWidth: 0, gap: 2 },
  cities: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', maxWidth: '100%' },
  subRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  city: { flexShrink: 1 },
  count: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  stopChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, height: 20, borderRadius: radius.pill, backgroundColor: palette.amberSoft, borderWidth: 1, borderColor: palette.amberBorder },
  sos: {
    flexDirection: 'row', alignItems: 'center', gap: 4, height: 32, paddingHorizontal: 11,
    borderRadius: radius.pill, backgroundColor: palette.redSoft, borderWidth: 1, borderColor: palette.redBorder,
  },
  iconBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  sosText: { fontFamily: font.displayBold, fontSize: 12, letterSpacing: 0.8 },
}));
