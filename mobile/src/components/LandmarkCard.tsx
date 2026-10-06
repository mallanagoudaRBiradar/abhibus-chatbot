import React from 'react';
import { StyleSheet, View, type DimensionValue } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { Txt } from './Txt';
import { palette, radius, themed } from '../theme/tokens';
import type { LandmarkPayload } from '../shared/protocol';

/**
 * Pickup landmark photo. Photos are operator-curated (not passenger uploads),
 * which avoids moderating user images on a moving bus at night. When no photo
 * exists we draw a calm night-road illustration instead of a broken image.
 */
export function LandmarkCard({ payload, width = 264 }: { payload: LandmarkPayload; width?: DimensionValue }) {
  return (
    <View style={[styles.card, { width }]} accessible accessibilityLabel={`Pickup point ${payload.pointName}: ${payload.title}. ${payload.caption}`}>
      <View style={styles.photo}>
        {payload.imageUrl ? (
          <Image source={{ uri: payload.imageUrl }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} />
        ) : (
          <NightRoad />
        )}
        <View style={styles.pointTag}>
          <Ionicons name="location" size={12} color={palette.navy} />
          <Txt v="micro" color={palette.navy}>{payload.pointName}</Txt>
        </View>
      </View>
      <View style={styles.text}>
        <Txt v="bodyStrong" numberOfLines={2}>{payload.title}</Txt>
        <Txt v="small" color={palette.textSecondary} numberOfLines={3}>{payload.caption}</Txt>
      </View>
    </View>
  );
}

function NightRoad() {
  return (
    <View style={StyleSheet.absoluteFill}>
      <LinearGradient colors={['#13204A', '#1E2E63', '#2A3466']} style={StyleSheet.absoluteFill} />
      <View style={[styles.moon]} />
      <View style={styles.hills} />
      <View style={styles.road}>
        {Array.from({ length: 5 }).map((_, i) => <View key={i} style={[styles.lane, { opacity: 0.35 + i * 0.12, width: 6 + i * 4 }]} />)}
      </View>
      <View style={styles.pin}><Ionicons name="location" size={26} color={palette.cyan} /></View>
    </View>
  );
}

const styles = themed(() => ({
  card: { borderRadius: radius.card, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.hairline, overflow: 'hidden' },
  photo: { height: 128, backgroundColor: palette.surfaceRaised },
  pointTag: { position: 'absolute', left: 10, top: 10, flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, height: 22, borderRadius: 11, backgroundColor: palette.cyan },
  text: { padding: 12, gap: 4 },
  moon: { position: 'absolute', right: 24, top: 18, width: 18, height: 18, borderRadius: 9, backgroundColor: '#F5E9C9', opacity: 0.8 },
  hills: { position: 'absolute', left: -20, right: -20, bottom: 30, height: 40, borderTopLeftRadius: 120, borderTopRightRadius: 160, backgroundColor: '#0F1A3D' },
  road: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 34, backgroundColor: '#0A1230', alignItems: 'center', justifyContent: 'space-evenly', flexDirection: 'row' },
  lane: { height: 2, borderRadius: 1, backgroundColor: palette.amber },
  pin: { position: 'absolute', left: '50%', bottom: 30, marginLeft: -13 },
}));
