import React, { forwardRef } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { BottomSheetScrollView, type BottomSheetModal } from '@gorhom/bottom-sheet';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from './icons';
import * as Haptics from '../services/haptics';
import { Sheet } from './Sheet';
import { Txt } from './Txt';
import { Avatar } from './Avatar';
import { ThemeSwitch } from './ThemeSwitch';
import { host } from '../services/host';
import { useChat } from '../store/chatStore';
import { DEFAULT_SETTINGS, TEXT_SCALE, WALLPAPERS, useSettings, type TextSize, type Wallpaper } from '../store/settings';
import { byMode, palette, radius, roomTheme, size, themed } from '../theme/tokens';

/**
 * ⋮ → Settings. Everything here stays on this phone.
 *   [ live preview: your background + text size with two sample bubbles ]
 *   Appearance        Auto · Light · Dark
 *   Chat background   Plain · Night highway · Dusk · Mint · Sunrise   (gradients, no downloads)
 *   Text size         A- · A · A+
 *   Quick replies · Enter to send (laptop) · Vibration · Data saver
 *   Privacy: your trip name, what others never see
 */
export const SettingsSheet = forwardRef<BottomSheetModal>((_, ref) => {
  const insets = useSafeAreaInsets();
  const st = useSettings();
  const me = useChat((s) => s.session?.me);
  const canVibrate = Platform.OS !== 'web' || host.can('haptics');
  const hasKeyboard = Platform.OS === 'web' && !host.embedded;
  const changed = (Object.keys(DEFAULT_SETTINGS) as (keyof typeof DEFAULT_SETTINGS)[]).some((k) => st[k] !== DEFAULT_SETTINGS[k]);

  return (
    <Sheet ref={ref} scrollable>
      <BottomSheetScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 4, paddingBottom: insets.bottom + 24 }}>
        <Txt v="h3">Settings</Txt>
        <Txt v="small" color={palette.textSecondary} style={{ marginTop: 2 }}>Saved on this phone only.</Txt>

        <Preview />

        <Label>Appearance</Label>
        <ThemeSwitch />

        <Label>Chat background</Label>
        <View style={styles.swatches}>
          {(['plain', ...Object.keys(WALLPAPERS)] as Wallpaper[]).map((w) => {
            const on = st.wallpaper === w;
            const colors = w === 'plain' ? null : byMode(WALLPAPERS[w as Exclude<Wallpaper, 'plain'>]);
            return (
              <Pressable key={w} onPress={() => { Haptics.selectionAsync(); st.set({ wallpaper: w }); }} style={styles.swatchWrap}
                accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={w === 'plain' ? 'Plain' : WALLPAPERS[w as Exclude<Wallpaper, 'plain'>].label}>
                <View style={[styles.swatch, on && styles.swatchOn]}>
                  {colors ? <LinearGradient colors={colors} style={styles.swatchFill} /> : <View style={[styles.swatchFill, { backgroundColor: palette.navy }]} />}
                  {on && <View style={styles.swatchCheck}><Ionicons name="checkmark" size={12} color="#FFFFFF" /></View>}
                </View>
                <Txt v="micro" color={on ? palette.text : palette.textSecondary} numberOfLines={1}>{w === 'plain' ? 'Plain' : WALLPAPERS[w as Exclude<Wallpaper, 'plain'>].label}</Txt>
              </Pressable>
            );
          })}
        </View>

        <Label>Text size</Label>
        <View style={styles.seg} accessibilityRole="radiogroup" accessibilityLabel="Text size">
          {(['sm', 'md', 'lg'] as TextSize[]).map((t) => {
            const on = st.textSize === t;
            return (
              <Pressable key={t} onPress={() => { Haptics.selectionAsync(); st.set({ textSize: t }); }} style={[styles.segOpt, on && styles.segOn]}
                accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={{ sm: 'Small', md: 'Normal', lg: 'Large' }[t]}>
                <Txt style={{ fontSize: 13 * TEXT_SCALE[t], lineHeight: 18 * TEXT_SCALE[t] }} color={on ? palette.text : palette.textSecondary}>A</Txt>
                <Txt v="smallStrong" color={on ? palette.text : palette.textSecondary}>{{ sm: 'Small', md: 'Normal', lg: 'Large' }[t]}</Txt>
              </Pressable>
            );
          })}
        </View>

        <Label>Chat</Label>
        <View style={styles.group}>
          <Toggle icon="flash-outline" title="Quick replies" sub="One-tap messages above the message box" value={st.quickReplies} onChange={(v) => st.set({ quickReplies: v })} />
          {hasKeyboard && <Toggle icon="return-down-back-outline" title="Enter to send" sub="Shift + Enter for a new line" value={st.enterToSend} onChange={(v) => st.set({ enterToSend: v })} divider />}
          {canVibrate && <Toggle icon="phone-portrait-outline" title="Vibration" sub="Buzz on taps, games and alerts" value={st.vibration} onChange={(v) => st.set({ vibration: v })} divider />}
          <Toggle icon="cellular-outline" title="Data saver" sub="Don’t load pickup photos on a weak signal" value={st.dataSaver} onChange={(v) => st.set({ dataSaver: v })} divider />
        </View>

        {me && (
          <>
            <Label>Privacy</Label>
            <View style={[styles.group, styles.privacy]}>
              <Avatar name={me.name} avatar={me.avatar} size={40} />
              <View style={{ flex: 1, gap: 2 }}>
                <Txt v="smallStrong">{`You’re ${me.name} on this trip`}</Txt>
                <Txt v="micro" color={palette.textSecondary}>Your real name, phone number and seat are never shown to other passengers. Messages are deleted 3 hours after the last drop.</Txt>
              </View>
            </View>
          </>
        )}

        {changed && (
          <Pressable onPress={() => { Haptics.selectionAsync(); st.set(DEFAULT_SETTINGS); }} style={styles.reset} accessibilityRole="button">
            <Ionicons name="refresh" size={14} color={palette.textSecondary} />
            <Txt v="smallStrong" color={palette.textSecondary}>Reset to default</Txt>
          </Pressable>
        )}
      </BottomSheetScrollView>
    </Sheet>
  );
});

/** A tiny chat that shows the chosen background and text size as you change them. */
function Preview() {
  const wallpaper = useSettings((s) => s.wallpaper);
  const scale = TEXT_SCALE[useSettings((s) => s.textSize)];
  const colors = wallpaper === 'plain' ? null : byMode(WALLPAPERS[wallpaper]);
  const t = { fontSize: size.body * scale, lineHeight: 21 * scale };
  return (
    <View style={styles.preview} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {colors ? <LinearGradient colors={colors} style={styles.previewBg} /> : <View style={[styles.previewBg, { backgroundColor: palette.navy }]} />}
      <View style={[styles.pBubble, { backgroundColor: palette.surface, alignSelf: 'flex-start', borderTopLeftRadius: 6 }]}>
        <Txt style={t}>Where is the bus now? 🚌</Txt>
      </View>
      <View style={[styles.pBubble, { backgroundColor: roomTheme.MAIN_COMMON.mine, alignSelf: 'flex-end', borderTopRightRadius: 6 }]}>
        <Txt style={t} color={roomTheme.MAIN_COMMON.onMine}>Near Kurnool, dinner in 20 min 🍛</Txt>
      </View>
    </View>
  );
}

function Label({ children }: { children: string }) {
  return <Txt v="micro" color={palette.textTertiary} style={styles.label}>{children.toUpperCase()}</Txt>;
}

function Toggle({ icon, title, sub, value, onChange, divider }: { icon: any; title: string; sub: string; value: boolean; onChange: (v: boolean) => void; divider?: boolean }) {
  return (
    <Pressable onPress={() => { Haptics.selectionAsync(); onChange(!value); }} style={({ pressed }) => [styles.toggleRow, divider && styles.divider, pressed && { backgroundColor: palette.pressTint }]}
      accessibilityRole="switch" accessibilityState={{ checked: value }} accessibilityLabel={`${title}. ${sub}`}>
      <Ionicons name={icon} size={18} color={palette.textSecondary} />
      <View style={{ flex: 1, gap: 1 }}>
        <Txt v="smallStrong">{title}</Txt>
        <Txt v="micro" color={palette.textSecondary}>{sub}</Txt>
      </View>
      <View style={[styles.switch, value && styles.switchOn]}>
        <View style={[styles.knob, value && styles.knobOn]} />
      </View>
    </Pressable>
  );
}

const styles = themed(() => ({
  label: { letterSpacing: 1, marginTop: 20, marginBottom: 8 },
  preview: { marginTop: 14, height: 132, borderRadius: radius.card - 4, overflow: 'hidden', padding: 12, gap: 8, justifyContent: 'center', borderWidth: 1, borderColor: palette.hairline },
  previewBg: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
  pBubble: { maxWidth: '80%', paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.bubble },
  swatches: { flexDirection: 'row', gap: 10 },
  swatchWrap: { flex: 1, alignItems: 'center', gap: 5 },
  swatch: { width: '100%', aspectRatio: 0.75, borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: palette.hairlineStrong },
  swatchOn: { borderWidth: 2, borderColor: palette.red },
  swatchFill: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
  swatchCheck: { position: 'absolute', right: 4, bottom: 4, width: 18, height: 18, borderRadius: 9, backgroundColor: palette.red, alignItems: 'center', justifyContent: 'center' },
  seg: { flexDirection: 'row', padding: 3, gap: 2, borderRadius: radius.pill, backgroundColor: palette.surfaceSunk, borderWidth: 1, borderColor: palette.hairline },
  segOpt: { flex: 1, flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center', gap: 6, height: 34, paddingTop: 7, borderRadius: radius.pill },
  segOn: { backgroundColor: palette.surfaceRaised, borderWidth: 1, borderColor: palette.hairlineStrong },
  group: { borderRadius: radius.card - 4, borderWidth: 1, borderColor: palette.hairline, backgroundColor: palette.surfaceSunk, overflow: 'hidden' },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 11 },
  divider: { borderTopWidth: 1, borderTopColor: palette.hairline },
  switch: { width: 42, height: 24, borderRadius: 12, padding: 2, backgroundColor: palette.hairlineStrong, justifyContent: 'center' },
  switchOn: { backgroundColor: palette.green },
  knob: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#FFFFFF' },
  knobOn: { alignSelf: 'flex-end' },
  privacy: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 },
  reset: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 18, height: 40 },
}));
