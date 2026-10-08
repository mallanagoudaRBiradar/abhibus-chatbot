import React from 'react';
import { View } from 'react-native';
import { Txt } from './Txt';
import { seatHue } from '../utils/seat';
import { byMode, font, palette } from '../theme/tokens';
import { AVATARS, initialOf } from '../shared/protocol';
import { personaOf } from '../shared/personas';

/**
 * A passenger's face in the chat:
 *  - heroes (trip names like "Hulk"): an emblem badge, their symbol on
 *    their colour with a light ring, like a chest logo
 *  - film/comedy characters: their emoji face on a soft tile of their colour
 *  - older sessions: the emoji they picked, or their initial
 */
export function Avatar({ name, avatar, size = 32, online, guest }: { name: string; avatar: string | null | undefined; size?: number; online?: boolean; guest?: boolean }) {
  const persona = personaOf(avatar);
  const hue = seatHue(name || '?');
  let face: React.ReactNode;
  if (persona?.kind === 'hero') {
    const letters = /^[A-Z]{1,2}$/.test(persona.glyph);
    face = (
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: persona.color, alignItems: 'center', justifyContent: 'center',
        borderWidth: Math.max(1.5, size * 0.06), borderColor: 'rgba(255,255,255,0.85)', overflow: 'hidden' }}>
        {letters
          ? <Txt style={{ fontFamily: font.displayBold, fontSize: size * (persona.glyph.length > 1 ? 0.34 : 0.48), lineHeight: size * 0.6, color: '#FFD54F' }} allowFontScaling={false}>{persona.glyph}</Txt>
          : <Txt style={{ fontSize: size * 0.5, lineHeight: size * 0.64 }} allowFontScaling={false}>{persona.glyph}</Txt>}
      </View>
    );
  } else if (persona) {
    face = (
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: `${persona.color}44`, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        <Txt style={{ fontSize: size * 0.58, lineHeight: size * 0.72 }} allowFontScaling={false}>{persona.glyph}</Txt>
      </View>
    );
  } else if (avatar?.startsWith('p:')) {
    // A character that's no longer in the list (the server swaps it on the next connect): never show a bare letter.
    face = (
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: palette.surfaceRaised, alignItems: 'center', justifyContent: 'center' }}>
        <Txt style={{ fontSize: size * 0.56, lineHeight: size * 0.7 }} allowFontScaling={false}>🎭</Txt>
      </View>
    );
  } else {
    const emoji = avatar ? AVATARS[avatar] : null;
    const bg = byMode({ dark: `hsla(${hue}, 55%, 55%, 0.22)`, light: `hsla(${hue}, 60%, 50%, 0.16)` });
    const fg = byMode({ dark: `hsl(${hue}, 70%, 78%)`, light: `hsl(${hue}, 55%, 34%)` });
    face = (
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: bg, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        {emoji
          ? <Txt style={{ fontSize: size * 0.58, lineHeight: size * 0.72 }} allowFontScaling={false}>{emoji}</Txt>
          : <Txt style={{ fontFamily: font.displayBold, fontSize: size * 0.42, lineHeight: size * 0.52 }} color={fg} allowFontScaling={false}>{initialOf(name)}</Txt>}
      </View>
    );
  }
  return (
    <View style={{ width: size, height: size }} accessibilityLabel={`${name}${persona ? `, ${persona.name} from ${persona.from}` : ''}${guest ? ', guest' : ''}`}>
      {face}
      {online != null && (
        <View style={{
          position: 'absolute', right: -1, bottom: -1, width: size * 0.3, height: size * 0.3, borderRadius: size,
          backgroundColor: online ? palette.green : palette.textTertiary, borderWidth: 2, borderColor: palette.surface,
        }} />
      )}
    </View>
  );
}
