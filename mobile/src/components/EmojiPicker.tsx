import React, { Suspense, lazy, useEffect, useState, type ComponentProps } from 'react';
import type RNEmojiPicker from 'rn-emoji-keyboard';

export type { EmojiType } from 'rn-emoji-keyboard';

/**
 * rn-emoji-keyboard, loaded the first time it opens. Its emoji data is a large
 * share of the bundle and most passengers never open the picker, so the web
 * build fetches it on demand instead of on first paint.
 */
const Picker = lazy(() => import('rn-emoji-keyboard'));

export default function EmojiPicker(props: ComponentProps<typeof RNEmojiPicker>) {
  const [wanted, setWanted] = useState(props.open);
  useEffect(() => { if (props.open) setWanted(true); }, [props.open]);
  if (!wanted) return null;
  return <Suspense fallback={null}><Picker {...props} /></Suspense>;
}
