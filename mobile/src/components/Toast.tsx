import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeInUp, FadeOutUp } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from './icons';
import { Txt } from './Txt';
import { palette, radius, themed } from '../theme/tokens';

type Toast = { id: number; text: string; tone: 'info' | 'success' | 'danger' };
let listener: ((t: Toast) => void) | null = null;
let seq = 0;
export const toast = (text: string, tone: Toast['tone'] = 'info') => listener?.({ id: ++seq, text, tone });

export function ToastHost() {
  const [current, setCurrent] = useState<Toast | null>(null);
  const insets = useSafeAreaInsets();
  useEffect(() => {
    listener = (t) => setCurrent(t);
    return () => { listener = null; };
  }, []);
  useEffect(() => {
    if (!current) return;
    const id = setTimeout(() => setCurrent(null), 2800);
    return () => clearTimeout(id);
  }, [current]);
  if (!current) return null;
  const icon = current.tone === 'success' ? 'checkmark-circle' : current.tone === 'danger' ? 'alert-circle' : 'information-circle';
  const color = current.tone === 'success' ? palette.green : current.tone === 'danger' ? palette.red : palette.textSecondary;
  return (
    <View style={[styles.host, { top: insets.top + 8, pointerEvents: 'none' }]}>
      <Animated.View key={current.id} entering={FadeInUp.duration(220)} exiting={FadeOutUp.duration(180)} style={styles.toast} accessibilityLiveRegion="polite">
        <Ionicons name={icon} size={18} color={color} />
        <Txt v="smallStrong" style={{ flexShrink: 1 }}>{current.text}</Txt>
      </Animated.View>
    </View>
  );
}

const styles = themed(() => ({
  host: { position: 'absolute', left: 16, right: 16, alignItems: 'center', zIndex: 100 },
  toast: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 10,
    backgroundColor: palette.surfaceRaised, borderRadius: radius.chip, borderWidth: 1, borderColor: palette.hairlineStrong,
    shadowColor: palette.shadow, shadowOpacity: 0.25, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 8,
  },
}));
