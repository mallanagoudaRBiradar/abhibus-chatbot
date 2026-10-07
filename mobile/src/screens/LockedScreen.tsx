import React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '../components/icons';
import { Txt } from '../components/Txt';
import type { TripLock } from '../services/host';
import { clock } from '../utils/format';
import { palette, radius, themed } from '../theme/tokens';

/**
 * Before the room opens:
 *   ‹  Bengaluru → Hyderabad
 *      Trip Chat · Sunrise Travels
 *            (lock + clock)
 *   Trip Chat opens on Mon, 12 Oct at 12:00 AM
 *   [ What's inside … ]
 *   [ Back to my trips ]
 */
export function LockedScreen({ lock, onBack }: { lock: TripLock; onBack: () => void }) {
  const insets = useSafeAreaInsets();
  const route = lock.sourceCity && lock.destinationCity ? `${lock.sourceCity} → ${lock.destinationCity}` : 'Your trip';
  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.head}>
        <Pressable onPress={onBack} hitSlop={8} style={styles.iconBtn} accessibilityRole="button" accessibilityLabel="Back">
          <Ionicons name="arrow-back" size={22} color={palette.text} />
        </Pressable>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Txt v="title" numberOfLines={1}>{route}</Txt>
          <Txt v="meta" color={palette.textSecondary} numberOfLines={1}>{`Trip Chat${lock.operatorName ? ` · ${lock.operatorName}` : ''}`}</Txt>
        </View>
      </View>

      <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 24 }]}>
        <Animated.View entering={FadeInDown.duration(400)} style={styles.lockCircle}>
          <MaterialCommunityIcons name="lock-clock" size={40} color={palette.red} />
        </Animated.View>
        <Txt v="h2" style={styles.center}>{`Trip Chat opens on ${opensLabel(lock.opensAt)}`}</Txt>
        <Txt v="body" color={palette.textSecondary} style={styles.center}>
          Your bus’s chat room unlocks on the journey day, so you can connect with co-travellers before you board.
        </Txt>

        <Animated.View entering={FadeInDown.delay(100).duration(400)} style={styles.card}>
          <Txt v="smallStrong" color={palette.textSecondary} style={{ letterSpacing: 0.4 }}>What’s inside</Txt>
          <Item icon="chatbubbles-outline" text="Chat with co-travellers on your bus" />
          <Item icon="location-outline" text="Live bus location shared by fellow passengers" />
          <Item icon="game-controller-outline" text="Mini-games to pass the time" />
          <Item icon="shield-checkmark-outline" text="Women Zone, only for verified women travellers" />
        </Animated.View>

        <Pressable onPress={onBack} style={({ pressed }) => [styles.cta, pressed && { opacity: 0.85 }]} accessibilityRole="button">
          <Txt v="bodyStrong" color={palette.onCyan}>Back to my trips</Txt>
        </Pressable>
      </ScrollView>
    </View>
  );
}

function Item({ icon, text }: { icon: any; text: string }) {
  return (
    <View style={styles.item}>
      <View style={styles.itemIcon}><Ionicons name={icon} size={17} color={palette.red} /></View>
      <Txt v="body" style={{ flex: 1 }}>{text}</Txt>
    </View>
  );
}

/** "Mon, 12 Oct at 12:00 AM" in the phone's time zone (no Intl: Hermes builds differ). */
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function opensLabel(iso: string) {
  const d = new Date(iso);
  return `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} at ${clock(d)}`;
}

const styles = themed(() => ({
  root: { flex: 1, backgroundColor: palette.navy },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, paddingVertical: 10 },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  body: { paddingHorizontal: 24, paddingTop: 36, alignItems: 'center', gap: 12 },
  lockCircle: { width: 96, height: 96, borderRadius: 48, backgroundColor: palette.redSoft, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  center: { textAlign: 'center' },
  card: { alignSelf: 'stretch', marginTop: 20, padding: 16, gap: 14, borderRadius: radius.card, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.hairline },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  itemIcon: { width: 32, height: 32, borderRadius: 16, backgroundColor: palette.redSoft, alignItems: 'center', justifyContent: 'center' },
  cta: { alignSelf: 'stretch', marginTop: 24, height: 52, borderRadius: radius.pill, backgroundColor: palette.red, alignItems: 'center', justifyContent: 'center' },
}));
