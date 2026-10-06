import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming, useReducedMotion } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Txt } from './Txt';
import { useChat } from '../store/chatStore';
import { palette, themed } from '../theme/tokens';

/**
 * THE signature element: a strip of highway under the header.
 * Covered road is a solid cyan line; road ahead is lane markings. The bus
 * marker glides when GPS updates arrive (every ~30s) and its glow breathes —
 * the only ambient animation on the screen, so it reads as "this is live".
 */
const DASH_COUNT = 40;
const nbsp = (s: string) => s.replace(/ /g, '\u00A0');

export function RouteStrip() {
  const progress = useChat((s) => s.progress);
  const [w, setW] = useState(0);
  const x = useSharedValue(0);
  const glow = useSharedValue(0);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (!w || !progress) return;
    x.value = withTiming(progress.progress * w, { duration: reduced ? 0 : 1200, easing: Easing.inOut(Easing.cubic) });
  }, [w, progress?.progress, reduced]);
  useEffect(() => {
    if (!reduced) glow.value = withRepeat(withTiming(1, { duration: 1800, easing: Easing.inOut(Easing.sin) }), -1, true);
  }, [reduced]);

  const covered = useAnimatedStyle(() => ({ width: x.value }));
  const marker = useAnimatedStyle(() => ({ transform: [{ translateX: x.value - 11 }] }));
  const halo = useAnimatedStyle(() => ({ opacity: 0.25 + glow.value * 0.35, transform: [{ scale: 1 + glow.value * 0.25 }] }));

  const pct = Math.round((progress?.progress ?? 0) * 100);
  // "Near X" and "X in 2 km" side by side reads as a contradiction — only name the next stop when it's a different place.
  const next = progress?.nextStop;
  const nextLabel = next && next.name !== progress?.placeLabel ? `Next: ${next.name} · ${next.distanceKm} km` : progress ? `${pct}% of trip done` : null;
  return (
    <View style={styles.wrap} accessible accessibilityLabel={progress ? `Bus is near ${progress.placeLabel} on ${progress.highway}. ${pct} percent of the trip done.` : 'Locating bus'}>
      <View style={styles.trackArea} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
        <View style={styles.dashes}>
          {Array.from({ length: DASH_COUNT }).map((_, i) => <View key={i} style={styles.dash} />)}
        </View>
        <Animated.View style={[styles.covered, covered]}>
          <LinearGradient colors={[palette.cyanSoft, palette.cyan]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
        </Animated.View>
        <Animated.View style={[styles.marker, marker]}>
          <Animated.View style={[styles.halo, halo]} />
          <View style={styles.busDot}><MaterialCommunityIcons name="bus-side" size={12} color={palette.navy} /></View>
        </Animated.View>
      </View>
      <View style={styles.labels}>
        <Txt v="meta" color={palette.text} numberOfLines={1} style={{ flexShrink: 1 }}>
          {progress ? `Near ${progress.placeLabel}` : 'Finding the bus…'}
          {progress ? <Txt v="meta" color={palette.textTertiary}>{` · ${nbsp(progress.highway)}`}</Txt> : null}
        </Txt>
        {nextLabel && <Txt v="meta" color={palette.textSecondary} numberOfLines={1}>{nextLabel}</Txt>}
      </View>
    </View>
  );
}

const styles = themed(() => ({
  wrap: { paddingHorizontal: 16, paddingTop: 0, paddingBottom: 8, backgroundColor: palette.navy, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.hairline },
  trackArea: { height: 22, justifyContent: 'center', marginHorizontal: 11 },
  dashes: { position: 'absolute', left: 0, right: 0, flexDirection: 'row', justifyContent: 'space-between' },
  dash: { width: 5, height: 2, borderRadius: 1, backgroundColor: palette.dash },
  covered: { position: 'absolute', left: 0, height: 3, borderRadius: 2, overflow: 'hidden' },
  marker: { position: 'absolute', left: 0, width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
  halo: { position: 'absolute', width: 22, height: 22, borderRadius: 11, backgroundColor: palette.cyan },
  busDot: { width: 20, height: 20, borderRadius: 10, backgroundColor: palette.cyan, alignItems: 'center', justifyContent: 'center' },
  labels: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, marginTop: 2 },
}));
