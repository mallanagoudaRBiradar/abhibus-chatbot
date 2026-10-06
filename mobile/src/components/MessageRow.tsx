import React, { memo, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withSequence, withSpring, withTiming, useReducedMotion } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Txt } from './Txt';
import { seatHue } from '../utils/seat';
import { Avatar } from './Avatar';
import type { Rect } from './MessageMenu';
import { personFrom, nameList } from '../hooks/usePeople';
import { useChat } from '../store/chatStore';
import { TicketSticker } from './TicketSticker';
import { PollCard } from './PollCard';
import { GameCard, type GameMoveInput } from './GameCard';
import { LocationCard } from './LocationCard';
import { LandmarkCard } from './LandmarkCard';
import { BroadcastRow, SystemRow } from './BroadcastRow';
import { clock } from '../utils/format';
import { byMode, motion, palette, radius, roomTheme, themed } from '../theme/tokens';
import type { UiMessage } from '../store/chatStore';
import { MENTIONABLES, isSystemReactionKey, mentionsIn, type ReactionEmoji, type RoomType } from '../shared/protocol';

/**
 * One row in the chat. Handles:
 *  - identity: name + avatar (WhatsApp-group style: avatar beside the last
 *    message of a run, name on the first). Seat numbers are never shown.
 *  - grouping: consecutive messages from the same person within 3 min share one
 *    name and one avatar (less noise on a busy bus)
 *  - @AbhiBus Care mentions are highlighted with a "Care will be notified" line
 *  - double-tap / long-press / hover 😊 (desktop) = reaction bar + Report / Block,
 *    anchored to the bubble; reaction chips: tap to toggle, long-press for who reacted
 *  - time separators after 15+ min of silence
 *  - status: pending (clock) / sent (✓) / seen (✓✓ in room accent) / failed
 *  - "Seen by Seat 4W, Seat 18L and 5 others" under your latest message
 *  - reactions with a spring pop when counts change
 *  - a one-time entry animation for messages that arrive while you watch
 */
const animatedOnce = new Set<string>();
const GROUP_MS = 3 * 60_000;

export interface MessageRowProps {
  message: UiMessage;
  prev?: UiMessage;      // older neighbour
  next?: UiMessage;      // newer neighbour
  mySeat: string;
  roomType: RoomType;
  isLatestMine: boolean;
  onLongPress: (m: UiMessage, rect: Rect) => void;
  onOpenSeenBy: (m: UiMessage) => void;
  onReact: (m: UiMessage, emoji: ReactionEmoji) => void;
  onRetry: (m: UiMessage) => void;
  onVote: (m: UiMessage, options: number[]) => void;
  onOpenVotes: (m: UiMessage) => void;
  onGameMove: (m: UiMessage, move: GameMoveInput) => void;
  onOpenReactions: (m: UiMessage) => void;
}

const sameGroup = (a?: UiMessage, b?: UiMessage) =>
  !!a && !!b && !!a.senderSeat && a.senderSeat === b.senderSeat &&
  (a.contentType === 'TEXT' || a.contentType === 'STICKER') && (b.contentType === 'TEXT' || b.contentType === 'STICKER') &&
  Math.abs(Date.parse(a.createdAt) - Date.parse(b.createdAt)) < GROUP_MS;

function MessageRowImpl(props: MessageRowProps) {
  const { message: m, prev, next, mySeat, roomType } = props;
  const theme = roomTheme[roomType];
  const showSeparator = !prev || Date.parse(m.createdAt) - Date.parse(prev.createdAt) > 15 * 60_000;

  // ------------------------------------------------ entry animation ------
  const reduced = useReducedMotion();
  const fresh = !animatedOnce.has(m.id) && Date.now() - Date.parse(m.createdAt) < 8000;
  const enter = useSharedValue(fresh && !reduced ? 0 : 1);
  useEffect(() => {
    animatedOnce.add(m.id);
    if (m.clientMsgId) animatedOnce.add(`local-${m.clientMsgId}`);
    if (enter.value < 1) enter.value = withSpring(1, motion.spring);
  }, []);
  const enterStyle = useAnimatedStyle(() => ({
    opacity: enter.value,
    transform: [{ translateY: (1 - enter.value) * 14 }, { scale: 0.96 + enter.value * 0.04 }],
  }));

  const separator = showSeparator ? (
    <View style={styles.separator}><View style={styles.sepPill}><Txt v="micro" color={palette.textSecondary}>{clock(m.createdAt)}</Txt></View></View>
  ) : null;

  if (m.contentType === 'SYSTEM') return <View>{separator}<Animated.View style={enterStyle}><SystemRow text={m.payload.text} /></Animated.View></View>;
  if (m.contentType === 'BROADCAST') return <View>{separator}<Animated.View style={enterStyle}><BroadcastRow message={m} /></Animated.View></View>;

  const mine = m.senderSeat === mySeat;
  const firstInGroup = !sameGroup(prev, m) || showSeparator;
  const lastInGroup = !sameGroup(m, next);
  const seenCount = m.seenBy.length;
  const reactionEntries = Object.entries(m.reactions).filter(([k, seats]) => seats.length > 0 && !isSystemReactionKey(k)); // poll votes / game moves ride the reactions channel
  const showSender = !mine && firstInGroup && !!m.senderSeat;
  const showAvatar = !mine && lastInGroup && !!m.senderSeat;
  const senderColor = nameColor(m.senderHandle);
  const senderLabel = showSender ? (
    <View style={styles.senderRow}>
      <Txt v="smallStrong" color={senderColor} numberOfLines={1} style={{ flexShrink: 1 }}>{m.senderHandle}</Txt>
      {m.senderGuest && <View style={styles.guestTag}><Txt v="micro" color={palette.textSecondary}>🎟️ QR guest</Txt></View>}
    </View>
  ) : null;
  const careMentioned = m.contentType === 'TEXT' && (m.payload.mentions?.includes('CARE') || mentionsIn(m.payload.text ?? '').includes('CARE'));

  // Double-tap or long-press opens the reaction bar + actions, anchored to this bubble.
  const bubbleRef = useRef<View>(null);
  const lastTap = useRef(0);
  const [hover, setHover] = useState(false);
  const openMenu = () => {
    if (m.status !== 'sent') return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    bubbleRef.current?.measureInWindow((x, y, w, h) => props.onLongPress(m, { x, y, w, h }));
  };
  const onTap = () => {
    const now = Date.now();
    if (now - lastTap.current < 300) { lastTap.current = 0; openMenu(); } else lastTap.current = now;
  };

  const time = m.status === 'pending' ? 'Sending' : clock(m.createdAt);

  // Ticks for my own messages: pending (clock) / sent (✓) / seen (✓✓ in room accent).
  const ticks = mine && m.status !== 'failed' ? (
    <Pressable onPress={() => seenCount && props.onOpenSeenBy(m)} hitSlop={10} disabled={!seenCount}
      accessibilityRole="button" accessibilityLabel={m.status === 'pending' ? 'Sending' : seenCount ? `Seen by ${seenCount}. Show who.` : 'Sent'}>
      <Ionicons name={m.status === 'pending' ? 'time-outline' : seenCount ? 'checkmark-done' : 'checkmark'} size={14}
        color={seenCount ? theme.accent : palette.textTertiary} />
    </Pressable>
  ) : null;

  let content: React.ReactNode;
  if (m.contentType === 'TEXT') {
    // Time sits inside the bubble's last line (WhatsApp-style): an invisible
    // spacer reserves room so the absolutely-positioned stamp never overlaps text.
    content = (
      <View style={[
        styles.bubble,
        mine ? { backgroundColor: theme.tint, borderColor: theme.border } : styles.bubbleOther,
        mine ? (lastInGroup ? styles.tailMine : null) : (lastInGroup ? styles.tailOther : null),
        m.status === 'failed' && { borderColor: palette.red, backgroundColor: palette.redSoft },
      ]}>
        {senderLabel}
        {/* On web, double-click is the reaction gesture, so don't let it select a word. */}
        <Txt v="body" selectable={Platform.OS !== 'web'}>
          {withMentions(m.payload.text, theme.accent)}
          <Txt v="micro" style={styles.spacer}>{`\u2003${time}${mine ? '\u2003\u2002' : ''}`}</Txt>
        </Txt>
        <View style={styles.stamp}>
          <Txt v="micro" color={palette.textTertiary}>{time}</Txt>
          {ticks}
        </View>
      </View>
    );
  } else if (m.contentType === 'POLL') {
    content = (
      <View style={[styles.bubble, styles.pollBubble, mine ? { backgroundColor: theme.tint, borderColor: theme.border } : styles.bubbleOther]}>
        {senderLabel}
        <PollCard poll={m.payload} reactions={m.reactions} mySeat={mySeat} accent={theme.accent} pending={m.status !== 'sent'}
          onVote={(opts) => props.onVote(m, opts)} onOpenVotes={() => props.onOpenVotes(m)} />
      </View>
    );
  } else if (m.contentType === 'GAME') {
    content = (
      <View style={[styles.bubble, styles.pollBubble, mine ? { backgroundColor: theme.tint, borderColor: theme.border } : styles.bubbleOther]}>
        {senderLabel}
        <GameCard game={m.payload} reactions={m.reactions} mySeat={mySeat} accent={theme.accent} createdAt={m.createdAt}
          onMove={(mv) => props.onGameMove(m, mv)} />
      </View>
    );
  } else if (m.contentType === 'STICKER') {
    content = <TicketSticker id={m.payload.stickerId} />;
  } else if (m.contentType === 'BUS_LOCATION') {
    content = <LocationCard payload={m.payload} pending={m.status === 'pending'} mine={mine} />;
  } else if (m.contentType === 'LANDMARK') {
    content = <LandmarkCard payload={m.payload} />;
  }
  const isText = m.contentType === 'TEXT';
  const ownBubble = isText || m.contentType === 'POLL' || m.contentType === 'GAME'; // sender name drawn inside the bubble

  // One wrapping View: inverted lists can reverse sibling order inside a cell.
  return (
    <View>
      {separator}
      <Animated.View style={[styles.row, mine ? styles.rowMine : styles.rowOther, { marginTop: firstInGroup ? 10 : 3 }, enterStyle]}>
        {!mine && m.senderSeat && (
          <View style={styles.avatarCol}>
            {showAvatar && <Avatar name={m.senderHandle} avatar={m.senderAvatar} size={28} />}
          </View>
        )}
        <View style={[styles.col, mine ? { alignItems: 'flex-end' } : { alignItems: 'flex-start' }]}>
          {showSender && !ownBubble && <View style={styles.senderOutside}>{senderLabel}</View>}
          <View style={[styles.bubbleLine, mine && { flexDirection: 'row-reverse' }]}>
            <Pressable
              onPress={onTap}
              onLongPress={openMenu}
              delayLongPress={280}
              onHoverIn={() => setHover(true)}
              onHoverOut={() => setHover(false)}
              disabled={m.status !== 'sent'}
              accessibilityHint="Double-tap or long press to react, report or block"
              style={{ maxWidth: '100%', flexShrink: 1 }}
            >
              <View ref={bubbleRef} collapsable={false}>{content}</View>
            </Pressable>
            {/* Desktop: nobody long-presses with a mouse — show a react button on hover (WhatsApp Web style). */}
            {Platform.OS === 'web' && hover && m.status === 'sent' && (
              <Pressable onPress={openMenu} onHoverIn={() => setHover(true)} onHoverOut={() => setHover(false)} style={styles.hoverBtn}
                accessibilityRole="button" accessibilityLabel="React or report">
                <Ionicons name="happy-outline" size={18} color={palette.textSecondary} />
              </Pressable>
            )}
          </View>

          {careMentioned && (
            <View style={styles.careLine}>
              <Ionicons name="headset" size={12} color={palette.textSecondary} />
              <Txt v="micro" color={palette.textSecondary}>AbhiBus Care will be notified</Txt>
            </View>
          )}

          {reactionEntries.length > 0 && (
            <View style={[styles.reactions, mine && { justifyContent: 'flex-end' }]}>
              {reactionEntries.map(([emoji, seats]) => (
                <ReactionChip key={emoji} emoji={emoji} count={seats.length} active={seats.includes(mySeat)} accent={theme.accent}
                  onPress={() => props.onReact(m, emoji as ReactionEmoji)} onLongPress={() => props.onOpenReactions(m)} />
              ))}
            </View>
          )}

          {m.status === 'failed' && (
            <Pressable onPress={() => props.onRetry(m)} style={styles.failRow} accessibilityRole="button" accessibilityLabel={`Not sent. ${m.failReason}. Tap to retry.`}>
              <Ionicons name="alert-circle" size={13} color={palette.red} />
              <Txt v="meta" color={palette.red} style={{ flexShrink: 1 }}>{`${m.failReason ?? 'Not sent'} · Tap to retry`}</Txt>
            </Pressable>
          )}
          {!isText && lastInGroup && m.status !== 'failed' && (
            <View style={[styles.metaOutside, mine && { alignSelf: 'flex-end' }]}>
              <Txt v="micro" color={palette.textTertiary}>{time}</Txt>
              {ticks}
            </View>
          )}
          {mine && props.isLatestMine && seenCount > 0 && m.status === 'sent' && (
            <Pressable onPress={() => props.onOpenSeenBy(m)} hitSlop={8} accessibilityRole="button">
              <Txt v="micro" color={palette.textSecondary} style={styles.seenBy}>{`Seen by ${nameList(m.seenBy.map((x) => personFrom(useChat.getState(), x).name))}`}</Txt>
            </Pressable>
          )}
        </View>
      </Animated.View>
    </View>
  );
}

/** Highlight @AbhiBus Care (and any future mentionables) inside message text. */
function withMentions(text: string, accent: string): React.ReactNode {
  const handles = MENTIONABLES.map((x) => `@${x.handle}`);
  const re = new RegExp(`(${handles.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  const parts = text.split(re);
  if (parts.length === 1) return text;
  return parts.map((part, i) => (handles.some((h) => h.toLowerCase() === part.toLowerCase())
    ? <Txt key={i} v="bodyStrong" color={accent}>{part}</Txt>
    : part));
}

const nameColor = (name: string) => byMode({ dark: `hsl(${seatHue(name)}, 62%, 72%)`, light: `hsl(${seatHue(name)}, 58%, 36%)` });

function ReactionChip({ emoji, count, active, accent, onPress, onLongPress }: { emoji: string; count: number; active: boolean; accent: string; onPress: () => void; onLongPress: () => void }) {
  const s = useSharedValue(1);
  useEffect(() => {
    s.value = withSequence(withTiming(1.22, { duration: 110, easing: Easing.out(Easing.quad) }), withSpring(1, motion.spring));
  }, [count]);
  const st = useAnimatedStyle(() => ({ transform: [{ scale: s.value }] }));
  return (
    <Pressable onPress={() => { Haptics.selectionAsync(); onPress(); }} onLongPress={onLongPress} delayLongPress={300}
      accessibilityRole="button" accessibilityLabel={`${emoji} ${count}${active ? ', you reacted' : ''}`} accessibilityHint="Long press to see who reacted">
      <Animated.View style={[styles.reaction, active && { borderColor: accent, backgroundColor: palette.pressTint }, st]}>
        <Txt style={{ fontSize: 13, lineHeight: 17 }}>{emoji}</Txt>
        <Txt v="micro" color={active ? palette.text : palette.textSecondary}>{count}</Txt>
      </Animated.View>
    </Pressable>
  );
}

export const MessageRow = memo(MessageRowImpl, (a, b) =>
  a.message === b.message && a.prev === b.prev && a.next === b.next && a.isLatestMine === b.isLatestMine && a.roomType === b.roomType);

const styles = themed(() => ({
  separator: { alignItems: 'center', marginTop: 16, marginBottom: 4 },
  sepPill: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: radius.pill, backgroundColor: palette.surface },
  row: { paddingHorizontal: 10, flexDirection: 'row', alignItems: 'flex-end', gap: 6 },
  rowMine: { justifyContent: 'flex-end' },
  rowOther: { justifyContent: 'flex-start' },
  avatarCol: { width: 28, marginBottom: 2 },
  col: { maxWidth: '80%' },
  senderRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 1 },
  guestTag: { paddingHorizontal: 5, paddingVertical: 1, borderRadius: 5, backgroundColor: palette.surfaceRaised },
  senderOutside: { marginBottom: 4, marginLeft: 4 },
  bubbleLine: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '100%' },
  hoverBtn: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.surfaceRaised, borderWidth: 1, borderColor: palette.hairline },
  careLine: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3, marginHorizontal: 4 },
  bubble: { paddingHorizontal: 12, paddingTop: 7, paddingBottom: 7, borderRadius: radius.bubble, borderWidth: 1 },
  pollBubble: { paddingTop: 10, paddingBottom: 8 },
  bubbleOther: { backgroundColor: palette.surface, borderColor: palette.hairline },
  tailMine: { borderBottomRightRadius: 6 },
  tailOther: { borderBottomLeftRadius: 6 },
  spacer: { opacity: 0, color: 'transparent' },
  stamp: { position: 'absolute', right: 10, bottom: 6, flexDirection: 'row', alignItems: 'center', gap: 3 },
  reactions: { flexDirection: 'row', gap: 5, marginTop: 4, flexWrap: 'wrap' },
  reaction: {
    flexDirection: 'row', alignItems: 'center', gap: 4, height: 24, paddingHorizontal: 7,
    borderRadius: radius.pill, backgroundColor: palette.surfaceSunk, borderWidth: 1, borderColor: palette.hairline,
  },
  metaOutside: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4, marginHorizontal: 4 },
  failRow: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: 300, marginTop: 4 },
  seenBy: { marginTop: 3, marginRight: 4, textAlign: 'right' },
}));
