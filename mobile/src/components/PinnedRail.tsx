import React, { useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  Easing, FadeIn, FadeOut, LinearTransition, interpolateColor, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming, useReducedMotion,
} from 'react-native-reanimated';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Txt } from './Txt';
import { useChat } from '../store/chatStore';
import { useCountdown, useServerNow } from '../hooks/useNow';
import { clock, mmss } from '../utils/format';
import { palette, radius, themed } from '../theme/tokens';

/**
 * "Act on this now" slot under the header. At most ONE compact card, so the
 * conversation keeps the screen:
 *   1. Arrived → when this chat gets deleted
 *   2. Rest-stop countdown (conductor) — the one thing nobody may miss
 *   3. Arrival-game invite (until you've guessed)
 * Everything else (pickup photos, the game after guessing, stickers) lives in
 * the composer's + menu. Cards can be tucked away: the stop timer then lives as
 * a chip in the header and pops back by itself for the last 2 minutes.
 */
export function PinnedRail({ onOpenGame }: { onOpenGame: () => void }) {
  const pinned = useChat((s) => s.rooms[s.activeRoom].pinned);
  const game = useChat((s) => s.game);
  const purgeAt = useChat((s) => s.purgeAt);
  const arrived = useChat((s) => s.progress?.progress === 1);

  const hidden = useChat((s) => s.hiddenPins);
  const hidePin = useChat((s) => s.hidePin);
  const remaining = useRemaining(pinned?.payload.endsAt);
  // Hidden cards stay hidden — except the stop timer in its last 2 minutes: nobody should miss the bus.
  const pinVisible = !!pinned && (!hidden.includes(pinned.messageId) || remaining < 120_000);
  const showGame = !pinVisible && game?.status === 'OPEN' && !game.myGuess && !hidden.includes(`game:${game.id}`);
  const showArrived = arrived && !!purgeAt;
  if (!showArrived && !pinVisible && !showGame) return null;

  return (
    <Animated.View layout={LinearTransition.duration(220)} style={styles.wrap}>
      {showArrived ? (
        <Animated.View entering={FadeIn} style={[styles.card, styles.row]}>
          <View style={[styles.icon, { backgroundColor: palette.surfaceRaised }]}><Ionicons name="moon-outline" size={17} color={palette.textSecondary} /></View>
          <View style={{ flex: 1 }}>
            <Txt v="smallStrong">You’ve arrived</Txt>
            <Txt v="meta" color={palette.textSecondary}>{`This chat is deleted at ${clock(purgeAt!)}`}</Txt>
          </View>
        </Animated.View>
      ) : pinVisible ? (
        <RestStopCard key={pinned!.messageId} onHide={remaining >= 120_000 ? () => { Haptics.selectionAsync(); hidePin(pinned!.messageId, true); } : undefined} />
      ) : game ? (
        <Animated.View entering={FadeIn.duration(260)} exiting={FadeOut.duration(160)}>
          {/* Two sibling buttons (never a button inside a button): the card opens the game, × tucks it away. */}
          <View style={[styles.card, styles.row, { borderColor: palette.amberBorder }]}>
            <Pressable onPress={() => { Haptics.selectionAsync(); onOpenGame(); }} style={({ pressed }) => [styles.gameMain, pressed && { opacity: 0.85 }]}
              accessibilityRole="button" accessibilityLabel={`Guess when we reach ${game.checkpointName}. Win ${game.rewardPoints} points.`}>
              <View style={[styles.icon, { backgroundColor: palette.amberSoft }]}><MaterialCommunityIcons name="flag-checkered" size={17} color={palette.amber} /></View>
              <View style={{ flex: 1 }}>
                <Txt v="smallStrong" numberOfLines={1}>{`Guess when we reach ${game.checkpointName}`}</Txt>
                <Txt v="meta" color={palette.textSecondary} numberOfLines={1}>{`Closest guess wins ${game.rewardPoints} AbhiBus points`}</Txt>
              </View>
              <View style={styles.cta}><Txt v="smallStrong" color={palette.navy}>Guess</Txt></View>
            </Pressable>
            <Pressable onPress={() => { Haptics.selectionAsync(); hidePin(`game:${game.id}`, true); }} hitSlop={10} style={styles.hide}
              accessibilityRole="button" accessibilityLabel="Hide. The game stays in plus, Games">
              <Ionicons name="close" size={16} color={palette.textTertiary} />
            </Pressable>
          </View>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

/** Live countdown. Calm cyan, amber + pulse under 2 minutes, red at zero. */
/** ms left on the pinned timer (ticks), Infinity when there's none. */
function useRemaining(endsAt: string | undefined) {
  const now = useServerNow(1000);
  return endsAt ? Math.max(0, Date.parse(endsAt) - now) : Infinity;
}

function RestStopCard({ onHide }: { onHide?: () => void }) {
  const pinned = useChat((s) => s.rooms[s.activeRoom].pinned)!;
  const { remainingMs, fraction, done } = useCountdown(pinned.payload.endsAt, pinned.payload.durationSec);
  const urgent = remainingMs > 0 && remainingMs < 120_000;
  const state = done ? 2 : urgent ? 1 : 0;
  const pulse = useSharedValue(1);
  const tone = useSharedValue(state);
  const reduced = useReducedMotion();

  useEffect(() => {
    tone.value = withTiming(state, { duration: 400 });
    if (state === 1 && !reduced) {
      pulse.value = withRepeat(withSequence(withTiming(1.06, { duration: 500, easing: Easing.out(Easing.quad) }), withTiming(1, { duration: 500 })), -1);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    } else pulse.value = withTiming(1);
  }, [state, reduced]);

  // Worklets can't read the theme proxy: capture plain colour strings first.
  const c0 = palette.cyanSoft, c1 = palette.amberSoft, c2 = palette.redSoft;
  const badge = useAnimatedStyle(() => ({
    transform: [{ scale: pulse.value }],
    backgroundColor: interpolateColor(tone.value, [0, 1, 2], [c0, c1, c2]),
  }));
  const color = done ? palette.red : urgent ? palette.amber : palette.cyan;
  const sub = done ? 'Please get back on the bus' : pinned.payload.place || 'Announced by the conductor';

  return (
    <Animated.View entering={FadeIn.duration(300)} exiting={FadeOut.duration(200)}
      style={[styles.card, { borderColor: done ? palette.redBorder : urgent ? palette.amberBorder : palette.hairlineStrong }]}
      accessible accessibilityLiveRegion="polite"
      accessibilityLabel={done ? `${pinned.payload.label} is over. Bus is leaving.` : `${pinned.payload.label}. ${Math.ceil(remainingMs / 60000)} minutes left.`}>
      <View style={styles.row}>
        <View style={[styles.icon, { backgroundColor: done ? palette.redSoft : palette.amberSoft }]}>
          <MaterialCommunityIcons name={done ? 'bus-alert' : 'silverware-fork-knife'} size={17} color={done ? palette.red : palette.amber} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Txt v="smallStrong" numberOfLines={1}>{done ? 'Bus is leaving now' : pinned.payload.label}</Txt>
          <Txt v="meta" color={palette.textSecondary} numberOfLines={1}>{sub}</Txt>
        </View>
        <Animated.View style={[styles.timer, badge]}>
          <Txt v="timer" color={color} style={{ fontSize: 20, lineHeight: 24 }}>{done ? '00:00' : mmss(remainingMs)}</Txt>
          <Txt v="micro" color={color} style={{ opacity: 0.85 }}>{done ? 'board now' : 'left'}</Txt>
        </Animated.View>
        {onHide && (
          <Pressable onPress={onHide} hitSlop={10} style={styles.hide} accessibilityRole="button" accessibilityLabel="Hide timer. It stays in the header and comes back in the last 2 minutes">
            <Ionicons name="chevron-up" size={18} color={palette.textTertiary} />
          </Pressable>
        )}
      </View>
      <View style={styles.track}><View style={[styles.fill, { width: `${fraction * 100}%`, backgroundColor: color }]} /></View>
    </Animated.View>
  );
}

const styles = themed(() => ({
  wrap: { paddingHorizontal: 12, paddingTop: 2, paddingBottom: 8, backgroundColor: palette.navy },
  card: { borderRadius: radius.chip + 2, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.hairline, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10, paddingVertical: 8 },
  icon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  timer: { alignItems: 'center', paddingHorizontal: 10, paddingVertical: 3, borderRadius: 10, minWidth: 72 },
  track: { height: 3, backgroundColor: palette.track },
  fill: { height: 3 },
  gameMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  hide: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.surfaceSunk, marginLeft: -2 },
  cta: { paddingHorizontal: 14, height: 30, borderRadius: radius.pill, backgroundColor: palette.amber, alignItems: 'center', justifyContent: 'center' },
}));
