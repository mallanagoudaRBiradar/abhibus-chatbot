import React, { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, TextInput, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Txt } from './Txt';
import { Avatar } from './Avatar';
import { font, palette, radius, themed } from '../theme/tokens';
import { AVATAR_GROUPS, AVATARS, DISPLAY_NAME_RE, initialOf } from '../shared/protocol';

/**
 * "How should people on the bus see you?" — first name + an avatar, grouped by
 * age. Default avatar is the initial (Rahul → R). Seat, phone and booking name
 * are never shown.
 */
export function ProfileStep({ initial, busy, error, cta, note, onBack, onSubmit, title, subtitle }: {
  title?: string;
  subtitle?: string;
  initial: { name: string; avatar: string | null } | null;
  busy: boolean;
  error: string | null;
  cta: string;
  note?: string;
  onBack?: () => void;
  onSubmit: (p: { name: string; avatar: string | null }) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  // Saved avatars from an older catalogue may no longer exist — fall back to the initial.
  const saved = initial?.avatar && AVATARS[initial.avatar] ? initial.avatar : null;
  const [avatar, setAvatar] = useState<string | null>(saved);
  const [group, setGroup] = useState<string>(saved?.split('-')[0] ?? 'animal');
  const clean = name.trim().replace(/\s+/g, ' ');
  const valid = DISPLAY_NAME_RE.test(clean);
  const showNameHint = name.length > 0 && !valid;
  const avatars = AVATAR_GROUPS.find((g) => g.key === group)!;

  return (
    <Animated.View entering={FadeIn.duration(220)}>
      {onBack && (
        <Pressable onPress={onBack} hitSlop={10} style={styles.back} accessibilityRole="button" accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={20} color={palette.textSecondary} />
          <Txt v="smallStrong" color={palette.textSecondary}>Back</Txt>
        </Pressable>
      )}

      <Txt v="h2" style={{ marginTop: onBack ? 12 : 0 }}>{title ?? 'How should people see you?'}</Txt>
      <Txt v="body" color={palette.textSecondary} style={{ marginTop: 6 }}>
        {subtitle ?? 'Other travellers see your first name and avatar. Your seat number, phone and booking name stay hidden.'}
      </Txt>

      <View style={styles.preview}>
        <Avatar name={clean || '?'} avatar={avatar} size={64} />
        <View style={{ flex: 1 }}>
          <Txt v="micro" color={palette.textTertiary} style={{ letterSpacing: 0.8 }}>PREVIEW</Txt>
          <Txt v="h3" numberOfLines={1}>{clean || 'Your name'}</Txt>
        </View>
      </View>

      <Txt v="micro" color={palette.textTertiary} style={styles.label}>FIRST NAME</Txt>
      <TextInput value={name} onChangeText={setName} placeholder="e.g. Rahul" placeholderTextColor={palette.placeholder} maxLength={24}
        autoCapitalize="words" autoCorrect={false} returnKeyType="done" style={styles.input} selectionColor={palette.cyan} accessibilityLabel="First name"
        onSubmitEditing={() => valid && onSubmit({ name: clean, avatar })} />
      {showNameHint && <Txt v="meta" color={palette.amber} style={{ marginTop: 6 }}>Letters only — no numbers or symbols.</Txt>}

      <Txt v="micro" color={palette.textTertiary} style={styles.label}>AVATAR</Txt>
      <View style={styles.tabs} accessibilityRole="tablist">
        {AVATAR_GROUPS.map((g) => (
          <Pressable key={g.key} onPress={() => { Haptics.selectionAsync(); setGroup(g.key); }} style={[styles.tab, group === g.key && styles.tabOn]}
            accessibilityRole="tab" accessibilityState={{ selected: group === g.key }}>
            <Txt v="smallStrong" color={group === g.key ? palette.text : palette.textSecondary}>{g.label}</Txt>
          </Pressable>
        ))}
      </View>
      <View style={styles.grid}>
        <AvatarChoice selected={avatar === null} onPress={() => setAvatar(null)} label="Use my initial">
          <View style={styles.initial}><Txt style={{ fontFamily: font.displayBold, fontSize: 22, lineHeight: 28 }} color={palette.textSecondary}>{initialOf(clean || '?')}</Txt></View>
        </AvatarChoice>
        {avatars.avatars.map((emoji, i) => {
          const id = `${avatars.key}-${i}`;
          return (
            <AvatarChoice key={id} selected={avatar === id} onPress={() => setAvatar(id)} label={`${avatars.label} avatar ${i + 1}`}>
              <Txt style={{ fontSize: 30, lineHeight: 38 }} allowFontScaling={false}>{emoji}</Txt>
            </AvatarChoice>
          );
        })}
      </View>

      {error && (
        <View style={styles.error} accessibilityLiveRegion="assertive">
          <Ionicons name="alert-circle-outline" size={18} color={palette.red} />
          <Txt v="small" style={{ flex: 1 }}>{error}</Txt>
        </View>
      )}

      <Pressable onPress={() => onSubmit({ name: clean, avatar })} disabled={!valid || busy}
        style={({ pressed }) => [styles.cta, (!valid || busy) && { opacity: 0.5 }, pressed && { opacity: 0.85 }]} accessibilityRole="button" accessibilityState={{ disabled: !valid || busy }}>
        {busy ? <ActivityIndicator color={palette.navy} /> : <Txt v="bodyStrong" color={palette.navy}>{cta}</Txt>}
      </Pressable>
      {note && <Txt v="meta" color={palette.textTertiary} style={{ textAlign: 'center', marginTop: 10 }}>{note}</Txt>}
    </Animated.View>
  );
}

function AvatarChoice({ selected, onPress, label, children }: { selected: boolean; onPress: () => void; label: string; children: React.ReactNode }) {
  return (
    <Pressable onPress={() => { Haptics.selectionAsync(); onPress(); }} style={({ pressed }) => [styles.choice, selected && styles.choiceOn, pressed && { opacity: 0.7 }]}
      accessibilityRole="radio" accessibilityState={{ selected }} accessibilityLabel={label}>
      {children}
      {selected && <View style={styles.check}><Ionicons name="checkmark" size={11} color={palette.navyDeep} /></View>}
    </Pressable>
  );
}

const styles = themed(() => ({
  back: { flexDirection: 'row', alignItems: 'center', gap: 2, alignSelf: 'flex-start', marginTop: 8 },
  preview: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 20, padding: 14, borderRadius: radius.card, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.hairline },
  label: { marginTop: 20, marginBottom: 8, letterSpacing: 1 },
  input: {
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : null),
    height: 50, paddingHorizontal: 16, borderRadius: radius.chip, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.hairlineStrong,
    color: palette.text, fontFamily: font.bodySemi, fontSize: 17,
  },
  tabs: { flexDirection: 'row', gap: 6, marginBottom: 10, flexWrap: 'wrap' },
  tab: { paddingHorizontal: 12, height: 32, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.surfaceSunk, borderWidth: 1, borderColor: palette.hairline },
  tabOn: { backgroundColor: palette.surfaceRaised, borderColor: palette.hairlineStrong },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  choice: { width: 58, height: 58, borderRadius: 29, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.surface, borderWidth: 2, borderColor: 'transparent' },
  choiceOn: { borderColor: palette.cyan },
  initial: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.surfaceRaised },
  check: { position: 'absolute', right: -2, bottom: -2, width: 18, height: 18, borderRadius: 9, backgroundColor: palette.cyan, alignItems: 'center', justifyContent: 'center' },
  error: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 16, padding: 12, borderRadius: radius.chip, backgroundColor: palette.redSoft, borderWidth: 1, borderColor: palette.redBorder },
  cta: { marginTop: 22, height: 54, borderRadius: radius.pill, backgroundColor: palette.cyan, alignItems: 'center', justifyContent: 'center' },
}));
