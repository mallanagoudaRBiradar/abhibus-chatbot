import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Txt } from './Txt';
import { stickerById, stickerTone } from '../data/stickerStyle';
import { font, palette } from '../theme/tokens';
import type { StickerId } from '../shared/protocol';

/**
 * Stickers look like tear-off bus ticket stubs: a perforated edge with two
 * punched notches. It ties a playful feature back to what AbhiBus actually sells.
 * `cutout` must match whatever surface sits behind the sticker.
 */
export function TicketSticker({ id, size = 'message', cutout = palette.navy }: { id: StickerId; size?: 'message' | 'tray'; cutout?: string }) {
  const s = stickerById(id);
  const tone = stickerTone[s.tone];
  const big = size === 'message';
  const h = 60;
  return (
    <View style={[styles.ticket, { height: h, backgroundColor: tone.bg, borderColor: tone.edge }, big ? { width: 196 } : { flex: 1 }]}
      accessible accessibilityLabel={`Sticker: ${s.label}`}>
      <View style={[styles.stub, { width: 52 }]}>
        <Txt style={{ fontSize: 26, lineHeight: 32 }}>{s.emoji}</Txt>
      </View>
      <View style={styles.perf}>
        {Array.from({ length: 6 }).map((_, i) => <View key={i} style={[styles.perfDot, { backgroundColor: tone.edge }]} />)}
      </View>
      <View style={styles.body}>
        <Txt numberOfLines={2} style={{ fontFamily: font.display, fontSize: big ? 14 : 13, lineHeight: big ? 18 : 17 }} color={tone.text}>{s.label}</Txt>
      </View>
      <View style={[styles.notch, { top: -7, left: 52 - 7, backgroundColor: cutout }]} />
      <View style={[styles.notch, { bottom: -7, left: 52 - 7, backgroundColor: cutout }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  ticket: { flexDirection: 'row', borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
  stub: { alignItems: 'center', justifyContent: 'center' },
  perf: { width: 2, justifyContent: 'space-evenly', alignItems: 'center', paddingVertical: 8 },
  perfDot: { width: 2, height: 4, borderRadius: 1 },
  body: { flex: 1, justifyContent: 'center', paddingHorizontal: 12 },
  notch: { position: 'absolute', width: 14, height: 14, borderRadius: 7 },
});
