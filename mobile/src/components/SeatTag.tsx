import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Txt } from './Txt';
import { berthOf, seatBg, seatColor } from '../utils/seat';
import { font, radius } from '../theme/tokens';

/**
 * A seat rendered as a berth tag instead of an avatar. A 2px bar marks the
 * berth: top = upper, bottom = lower, left = window. Tiny detail, but it lets
 * people read "who's above me" at a glance — which is how buses actually talk.
 */
export function SeatTag({ seat, size = 'sm', you = false }: { seat: string; size?: 'sm' | 'md' | 'lg'; you?: boolean }) {
  const berth = berthOf(seat);
  const color = seatColor(seat);
  const dims = { sm: { h: 22, px: 7, fs: 11 }, md: { h: 30, px: 9, fs: 13 }, lg: { h: 44, px: 12, fs: 16 } }[size];
  return (
    <View style={[styles.tag, { height: dims.h, paddingHorizontal: dims.px, backgroundColor: seatBg(seat), borderColor: you ? color : 'transparent' }]}>
      {berth === 'upper' && <View style={[styles.barH, { top: 0, backgroundColor: color }]} />}
      {berth === 'lower' && <View style={[styles.barH, { bottom: 0, backgroundColor: color }]} />}
      {berth === 'window' && <View style={[styles.barV, { backgroundColor: color }]} />}
      <Txt style={{ fontFamily: font.display, fontSize: dims.fs, lineHeight: dims.fs + 4 }} color={color}>{seat}</Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  tag: { borderRadius: radius.tag, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', borderWidth: 1 },
  barH: { position: 'absolute', left: 4, right: 4, height: 2, borderRadius: 1, opacity: 0.85 },
  barV: { position: 'absolute', left: 0, top: 4, bottom: 4, width: 2, borderRadius: 1, opacity: 0.85 },
});
