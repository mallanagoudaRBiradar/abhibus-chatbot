import React from 'react';
import { Text, type TextProps, type TextStyle } from 'react-native';
import { font, palette, size } from '../theme/tokens';

type Variant = 'h1' | 'h2' | 'h3' | 'title' | 'body' | 'bodyStrong' | 'small' | 'smallStrong' | 'meta' | 'micro' | 'timer';

const variants: Record<Variant, TextStyle> = {
  h1: { fontFamily: font.displayBold, fontSize: size.h1, lineHeight: 36, letterSpacing: -0.6 },
  h2: { fontFamily: font.display, fontSize: size.h2, lineHeight: 30, letterSpacing: -0.4 },
  h3: { fontFamily: font.display, fontSize: size.h3, lineHeight: 26, letterSpacing: -0.2 },
  title: { fontFamily: font.display, fontSize: size.title, lineHeight: 22, letterSpacing: -0.2 },
  body: { fontFamily: font.body, fontSize: size.body, lineHeight: 21 },
  bodyStrong: { fontFamily: font.bodySemi, fontSize: size.body, lineHeight: 21 },
  small: { fontFamily: font.body, fontSize: size.small, lineHeight: 18 },
  smallStrong: { fontFamily: font.bodySemi, fontSize: size.small, lineHeight: 18 },
  meta: { fontFamily: font.bodyMedium, fontSize: size.meta, lineHeight: 16 },
  micro: { fontFamily: font.bodySemi, fontSize: size.micro, lineHeight: 14, letterSpacing: 0.1 },
  timer: { fontFamily: font.displayBold, fontSize: 24, lineHeight: 28, letterSpacing: -0.5, fontVariant: ['tabular-nums'] },
};

export function Txt({ v = 'body', color = palette.text, style, ...rest }: TextProps & { v?: Variant; color?: string }) {
  return <Text {...rest} allowFontScaling maxFontSizeMultiplier={1.4} style={[variants[v], { color }, style]} />;
}
