import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from './icons';
import * as Haptics from '../services/haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Txt } from './Txt';
import { useChat } from '../store/chatStore';
import { mmss } from '../utils/format';
import { useServerNow } from '../hooks/useNow';
import { MaterialCommunityIcons } from './icons';
import { palette, radius, themed } from '../theme/tokens';

/**
 * Header (reference: Trip Chat dark):
 *   [←] Hyderabad → Bengaluru             [🛡] [⋮]
 *       Sunrise Travels · 15 travellers
 *   ← = back to the AbhiBus app (chat keeps running), 🛡 = SOS, ⋮ = trip details + Exit chat.
 *   Subtitle taps open the traveller list; a tucked-away stop timer shows there as a chip.
 */
export function TopBar({ onBack, onOpenPassengers, onOpenSos, onOpenMenu }: { onBack: () => void; onOpenPassengers: () => void; onOpenSos: () => void; onOpenMenu: () => void }) {
  const insets = useSafeAreaInsets();
  const journey = useChat((s) => s.session!.journey);
  const online = useChat((s) => s.connection === 'online');
  const members = useChat((s) => s.rooms.MAIN_COMMON.presence.onlineSeats.length);
  const travellers = Math.max(journey.totalSeatsBooked ?? 0, members);
  const pinned = useChat((s) => s.rooms[s.activeRoom].pinned);
  const hidden = useChat((s) => s.hiddenPins);
  const hidePin = useChat((s) => s.hidePin);
  const now = useServerNow(1000);
  const left = pinned ? Math.max(0, Date.parse(pinned.payload.endsAt) - now) : 0;
  const stopHidden = !!pinned && hidden.includes(pinned.messageId) && left >= 120_000;

  return (
    <View style={[styles.wrap, { paddingTop: insets.top + 6 }]}>
      <Pressable onPress={onBack} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back"
        style={({ pressed }) => [styles.iconBtn, pressed && { backgroundColor: palette.surface }]}>
        <Ionicons name="arrow-back" size={22} color={palette.text} />
      </Pressable>
      <View style={styles.title}>
        <Pressable onPress={() => { Haptics.selectionAsync(); onOpenMenu(); }} hitSlop={6} accessibilityRole="button" accessibilityLabel={`${journey.sourceCity} to ${journey.destinationCity}. Trip details`}
          style={({ pressed }) => pressed && { opacity: 0.7 }}>
          <Txt v="title" numberOfLines={1}>{`${journey.sourceCity} → ${journey.destinationCity}`}</Txt>
        </Pressable>
        <View style={styles.subRow}>
          <Pressable onPress={() => { Haptics.selectionAsync(); onOpenMenu(); }} hitSlop={8} style={({ pressed }) => [styles.sub, pressed && { opacity: 0.6 }]}
            accessibilityRole="button" accessibilityLabel={`${journey.operatorName}, ${travellers} travellers. Trip details`}>
            <Txt v="meta" color={palette.textSecondary} numberOfLines={1} style={{ flexShrink: 1 }}>
              {online ? `${journey.operatorName} · ${travellers} traveller${travellers === 1 ? '' : 's'}` : 'Reconnecting…'}
            </Txt>
          </Pressable>
          {stopHidden && (
            <Pressable onPress={() => { Haptics.selectionAsync(); hidePin(pinned!.messageId, false); }} hitSlop={8}
              style={({ pressed }) => [styles.stopChip, pressed && { opacity: 0.7 }]} accessibilityRole="button" accessibilityLabel={`${pinned!.payload.label}, ${mmss(left)} left. Show timer`}>
              <MaterialCommunityIcons name="silverware-fork-knife" size={11} color={palette.amber} />
              <Txt v="micro" color={palette.amber} style={{ fontVariant: ['tabular-nums'] }}>{mmss(left)}</Txt>
            </Pressable>
          )}
        </View>
      </View>

      <Pressable
        onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); onOpenSos(); }}
        accessibilityRole="button" accessibilityLabel="Emergency SOS" hitSlop={6}
        style={({ pressed }) => [styles.iconBtn, styles.sos, pressed && { transform: [{ scale: 0.92 }] }]}
      >
        <Ionicons name="shield-half" size={17} color={palette.red} />
      </Pressable>
      <Pressable onPress={() => { Haptics.selectionAsync(); onOpenMenu(); }} hitSlop={8} accessibilityRole="button" accessibilityLabel="Trip details and exit"
        style={({ pressed }) => [styles.iconBtn, pressed && { backgroundColor: palette.surface }]}>
        <Ionicons name="ellipsis-vertical" size={20} color={palette.text} />
      </Pressable>
    </View>
  );
}

const styles = themed(() => ({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingLeft: 4, paddingRight: 6, paddingBottom: 10, backgroundColor: palette.navy },
  title: { flex: 1, minWidth: 0, gap: 1, marginLeft: 2 },
  subRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  sub: { flexShrink: 1 },
  stopChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, height: 20, borderRadius: radius.pill, backgroundColor: palette.amberSoft, borderWidth: 1, borderColor: palette.amberBorder },
  iconBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  sos: { backgroundColor: palette.redSoft },
}));
