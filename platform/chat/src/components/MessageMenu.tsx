import React, { useState } from 'react';
import { Modal, Pressable, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, ZoomIn } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import EmojiPicker, { type EmojiType } from 'rn-emoji-keyboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Txt } from './Txt';
import { toast } from './Toast';
import { useChat, type UiMessage } from '../store/chatStore';
import { chatSocket } from '../services/socket';
import { palette, radius, themed } from '../theme/tokens';
import { REACTIONS, isSystemReactionKey } from '../shared/protocol';

export type Rect = { x: number; y: number; w: number; h: number };
const BAR_W = 7 * 44 + 16;
const MENU_W = 230;

/**
 * WhatsApp / Instagram-style message menu, anchored to the bubble:
 *   [ ❤️ 😂 😮 😢 🙏 👍 + ]      ← quick reactions just above the message
 *        (message)
 *   [ 🚩 Report Kiran      ]      ← actions just below it
 *   [ ⊘  Block Kiran       ]
 * Opened by double-tap, long-press, or the 😊 hover button on desktop.
 */
export function MessageMenu({ target, onClose, onReport, onSeenBy }: {
  target: { message: UiMessage; rect: Rect } | null;
  onClose: () => void;
  onReport: (m: UiMessage) => void;
  onSeenBy: (m: UiMessage) => void;
}) {
  const { width: W, height: H } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const me = useChat((s) => s.session?.me.seat);
  const blocked = useChat((s) => s.blockedSeats);
  const [picker, setPicker] = useState(false);
  if (!target) return null;

  const { message: m, rect } = target;
  const mine = m.senderSeat === me;
  const seat = m.senderSeat;
  const name = m.senderHandle;
  const isBlocked = !!seat && blocked.includes(seat);
  const myReaction = Object.entries(m.reactions).find(([k, seats]) => !isSystemReactionKey(k) && seats.includes(me ?? ''))?.[0];
  const canAct = !mine && !!seat;

  const clampX = (x: number, w: number) => Math.min(Math.max(8, x), W - w - 8);
  const barLeft = clampX(mine ? rect.x + rect.w - BAR_W : rect.x, BAR_W);
  const menuLeft = clampX(mine ? rect.x + rect.w - MENU_W : rect.x, MENU_W);
  const menuH = canAct ? 104 : mine && m.seenBy.length ? 52 : 0;
  // Prefer bar above / menu below the bubble; flip when the bubble hugs a screen edge.
  let barTop = rect.y - 60;
  let menuTop = rect.y + rect.h + 8;
  if (barTop < insets.top + 8) barTop = Math.min(rect.y + rect.h + 8, H - 60 - menuH - 16);
  if (menuTop + menuH > H - 8) menuTop = Math.max(insets.top + 8, rect.y - 60 - menuH - 8);
  if (barTop >= rect.y && menuH) menuTop = barTop + 60;

  const react = (e: string) => { Haptics.selectionAsync(); void chatSocket.react(m.id, e); onClose(); };
  const block = async () => {
    if (!seat) return;
    onClose();
    const ack = await chatSocket.block(seat, !isBlocked);
    toast(ack.ok ? (isBlocked ? `${name} unblocked` : `${name} blocked. You won’t see their messages.`) : ack.message, ack.ok ? 'success' : 'danger');
  };

  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close menu" />
      {!picker && (
        <Animated.View entering={ZoomIn.duration(160)} style={[styles.bar, { top: barTop, left: barLeft }]} accessibilityRole="menu">
          {REACTIONS.map((e) => (
            <Pressable key={e} onPress={() => react(e)} style={({ pressed }) => [styles.emoji, myReaction === e && styles.emojiOn, pressed && { transform: [{ scale: 1.2 }] }]}
              accessibilityRole="button" accessibilityLabel={`React ${e}`} accessibilityState={{ selected: myReaction === e }}>
              <Txt style={{ fontSize: 26, lineHeight: 32 }}>{e}</Txt>
            </Pressable>
          ))}
          <Pressable onPress={() => setPicker(true)} style={({ pressed }) => [styles.emoji, styles.more, pressed && { opacity: 0.7 }]} accessibilityRole="button" accessibilityLabel="More reactions">
            <Ionicons name="add" size={22} color={palette.textSecondary} />
          </Pressable>
        </Animated.View>
      )}
      {!picker && menuH > 0 && (
        <Animated.View entering={FadeIn.duration(160)} style={[styles.menu, { top: menuTop, left: menuLeft }]}>
          {canAct ? (
            <>
              <MenuItem icon="flag-outline" label={`Report ${name}`} danger onPress={() => { onClose(); onReport(m); }} />
              <MenuItem icon={isBlocked ? 'person-add-outline' : 'remove-circle-outline'} label={isBlocked ? `Unblock ${name}` : `Block ${name}`} onPress={block} />
            </>
          ) : (
            <MenuItem icon="checkmark-done" label={`Seen by ${m.seenBy.length}`} onPress={() => { onClose(); onSeenBy(m); }} />
          )}
        </Animated.View>
      )}
      <EmojiPicker open={picker} onClose={() => { setPicker(false); onClose(); }} onEmojiSelected={(e: EmojiType) => { setPicker(false); react(e.emoji); }}
        enableSearchBar categoryPosition="top"
        theme={{ backdrop: palette.backdrop, knob: palette.textTertiary, container: palette.surface, header: palette.textSecondary, skinTonesContainer: palette.surfaceRaised,
          category: { icon: palette.textTertiary, iconActive: palette.cyan, container: palette.surfaceSunk, containerActive: palette.surfaceRaised },
          search: { text: palette.text, placeholder: palette.textTertiary, icon: palette.textTertiary, background: palette.surfaceSunk } }} />
    </Modal>
  );
}

function MenuItem({ icon, label, onPress, danger }: { icon: any; label: string; onPress: () => void; danger?: boolean }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.item, pressed && { backgroundColor: palette.surfaceRaised }]} accessibilityRole="menuitem">
      <Ionicons name={icon} size={18} color={danger ? palette.red : palette.textSecondary} />
      <Txt v="bodyStrong" color={danger ? palette.red : palette.text} numberOfLines={1} style={{ flex: 1 }}>{label}</Txt>
    </Pressable>
  );
}

const styles = themed(() => ({
  backdrop: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: palette.backdrop },
  bar: {
    position: 'absolute', flexDirection: 'row', alignItems: 'center', gap: 0, padding: 6, width: BAR_W, borderRadius: radius.pill,
    backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.hairlineStrong,
    shadowColor: palette.shadow, shadowOpacity: 0.3, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 10,
  },
  emoji: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  emojiOn: { backgroundColor: palette.surfaceRaised },
  more: { backgroundColor: palette.surfaceSunk },
  menu: {
    position: 'absolute', width: MENU_W, padding: 4, borderRadius: radius.card, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.hairlineStrong,
    shadowColor: palette.shadow, shadowOpacity: 0.3, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 10,
  },
  item: { flexDirection: 'row', alignItems: 'center', gap: 10, height: 46, paddingHorizontal: 12, borderRadius: radius.chip },
}));
