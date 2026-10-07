import React from 'react';
import { View } from 'react-native';
import { Txt } from './Txt';
import { seatHue } from '../utils/seat';
import { byMode, font, palette } from '../theme/tokens';
import { AVATARS, initialOf } from '../shared/protocol';

/**
 * A passenger's face in the chat: the avatar they picked, or their initial on
 * a colour derived from their name (Rahul → "R"), so the same person always
 * looks the same.
 */
export function Avatar({ name, avatar, size = 32, online, guest }: { name: string; avatar: string | null | undefined; size?: number; online?: boolean; guest?: boolean }) {
  const hue = seatHue(name || '?');
  // Handle-mode travellers arrive as "emoji:🐯" (their random animal); profile mode uses the avatar catalogue.
  const emoji = avatar ? (avatar.startsWith('emoji:') ? avatar.slice(6) : AVATARS[avatar] ?? null) : null;
  const bg = byMode({ dark: `hsla(${hue}, 55%, 55%, 0.22)`, light: `hsla(${hue}, 60%, 50%, 0.16)` });
  const fg = byMode({ dark: `hsl(${hue}, 70%, 78%)`, light: `hsl(${hue}, 55%, 34%)` });
  return (
    <View style={{ width: size, height: size }} accessibilityLabel={`${name}${guest ? ', guest' : ''}`}>
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: bg, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        {emoji
          ? <Txt style={{ fontSize: size * 0.58, lineHeight: size * 0.72 }} allowFontScaling={false}>{emoji}</Txt>
          : <Txt style={{ fontFamily: font.displayBold, fontSize: size * 0.42, lineHeight: size * 0.52 }} color={fg} allowFontScaling={false}>{initialOf(name)}</Txt>}
      </View>
      {online != null && (
        <View style={{
          position: 'absolute', right: -1, bottom: -1, width: size * 0.3, height: size * 0.3, borderRadius: size,
          backgroundColor: online ? palette.green : palette.textTertiary, borderWidth: 2, borderColor: palette.surface,
        }} />
      )}
    </View>
  );
}
