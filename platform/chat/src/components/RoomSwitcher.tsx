import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { interpolateColor, useAnimatedStyle, withSpring, type SharedValue } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Txt } from './Txt';
import { useShallow } from 'zustand/react/shallow';
import { useChat } from '../store/chatStore';
import { motion, palette, radius, roomTheme, themed } from '../theme/tokens';
import type { RoomType } from '../shared/protocol';

/**
 * Two-room segmented control. Rendered by the screen ONLY when the passenger's
 * own booking gender is 'F'. The sliding pill shifts from cyan to rose, and so
 * does every accent in the room below — a deliberate "you are somewhere else
 * now" signal.
 */
export function RoomSwitcher({ roomIndex }: { roomIndex: SharedValue<number> }) {
  const active = useChat((s) => s.activeRoom);
  const unread = useChat(useShallow((s) => ({ MAIN_COMMON: s.rooms.MAIN_COMMON.unread, WOMEN_ONLY: s.rooms.WOMEN_ONLY.unread })));
  const setActive = useChat((s) => s.setActiveRoom);
  const [w, setW] = useState(0);

  const tints = [roomTheme.MAIN_COMMON.tint, roomTheme.WOMEN_ONLY.tint];
  const borders = [roomTheme.MAIN_COMMON.border, roomTheme.WOMEN_ONLY.border];
  const pill = useAnimatedStyle(() => ({
    transform: [{ translateX: roomIndex.value * (w / 2) }],
    backgroundColor: interpolateColor(roomIndex.value, [0, 1], tints),
    borderColor: interpolateColor(roomIndex.value, [0, 1], borders),
  }));

  const select = (rt: RoomType) => {
    if (rt === active) return;
    Haptics.selectionAsync();
    roomIndex.value = withSpring(rt === 'MAIN_COMMON' ? 0 : 1, motion.spring);
    setActive(rt);
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.track} onLayout={(e) => setW(e.nativeEvent.layout.width - 8)} accessibilityRole="tablist">
        {w > 0 && <Animated.View style={[styles.pill, { width: w / 2 }, pill]} />}
        {(['MAIN_COMMON', 'WOMEN_ONLY'] as RoomType[]).map((rt) => {
          const t = roomTheme[rt];
          const on = active === rt;
          const count = unread[rt];
          return (
            <Pressable key={rt} onPress={() => select(rt)} style={styles.tab} accessibilityRole="tab" accessibilityState={{ selected: on }}
              accessibilityLabel={`${t.name}${count ? `, ${count} unread` : ''}`}>
              <Ionicons name={on ? t.icon : (`${t.icon}-outline` as any)} size={15} color={on ? t.accent : palette.textTertiary} />
              <Txt v="smallStrong" color={on ? palette.text : palette.textSecondary}>{t.name}</Txt>
              {count > 0 && !on && (
                <View style={[styles.badge, { backgroundColor: t.accent }]}>
                  <Txt v="micro" color={t.onAccent}>{count > 9 ? '9+' : count}</Txt>
                </View>
              )}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = themed(() => ({
  wrap: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 0, backgroundColor: palette.navy },
  track: { flexDirection: 'row', height: 36, padding: 4, borderRadius: radius.pill, backgroundColor: palette.surfaceSunk, borderWidth: 1, borderColor: palette.hairline },
  pill: { position: 'absolute', top: 3, left: 4, bottom: 3, borderRadius: radius.pill, borderWidth: 1 },
  tab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  badge: { minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center' },
}));
