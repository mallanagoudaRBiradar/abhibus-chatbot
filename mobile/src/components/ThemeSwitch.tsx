import React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from './icons';
import * as Haptics from '../services/haptics';
import { Txt } from './Txt';
import { saveThemePref } from '../services/prefs';
import { palette, radius, themed, useThemePref, type ThemePref } from '../theme/tokens';

const OPTIONS: { pref: ThemePref; label: string; icon: any }[] = [
  { pref: 'system', label: 'Auto', icon: 'phone-portrait-outline' },
  { pref: 'light', label: 'Light', icon: 'sunny-outline' },
  { pref: 'dark', label: 'Dark', icon: 'moon-outline' },
];

/** Auto / Light / Dark. "Auto" follows the phone (or OS) setting. */
export function ThemeSwitch({ compact = false }: { compact?: boolean }) {
  const pref = useThemePref((s) => s.pref);
  const setPref = useThemePref((s) => s.setPref);
  return (
    <View style={styles.track} accessibilityRole="radiogroup" accessibilityLabel="Appearance">
      {OPTIONS.map((o) => {
        const on = o.pref === pref;
        return (
          <Pressable key={o.pref} onPress={() => { if (on) return; Haptics.selectionAsync(); setPref(o.pref); void saveThemePref(o.pref); }}
            style={[styles.opt, compact && { paddingHorizontal: 8 }, on && styles.optOn]} accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={o.label}>
            <Ionicons name={o.icon} size={14} color={on ? palette.text : palette.textTertiary} />
            {!compact && <Txt v="smallStrong" color={on ? palette.text : palette.textSecondary}>{o.label}</Txt>}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = themed(() => ({
  track: { flexDirection: 'row', padding: 3, gap: 2, borderRadius: radius.pill, backgroundColor: palette.surfaceSunk, borderWidth: 1, borderColor: palette.hairline, alignSelf: 'flex-start' },
  opt: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 30, paddingHorizontal: 12, borderRadius: radius.pill },
  optOn: { backgroundColor: palette.surfaceRaised, borderWidth: 1, borderColor: palette.hairlineStrong },
}));
