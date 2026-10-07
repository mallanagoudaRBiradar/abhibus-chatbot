import React, { memo, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withSequence, withSpring, withTiming, useReducedMotion } from 'react-native-reanimated';
import { Ionicons } from './icons';
import * as Haptics from '../services/haptics';
import { Txt } from './Txt';
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
import { TEXT_SCALE, useSettings } from '../store/settings';
import { motion, palette, radius, roomTheme, themed, useThemeMode } from '../theme/tokens';
import type { UiMessage } from '../store/chatStore';
import { MENTIONABLES, isSystemReactionKey, mentionsIn, type ReactionEmoji, type RoomType } from '../shared/protocol';

/**
 * One row in the chat. Handles:
 *  - identity: avatar + name + "On board" pill above the first message of a run
 *    (grey bubbles; mine are solid red, right-aligned). Seat numbers are never shown.
 *  - time below the last bubble of a run
 *  - "where is the bus?" asks render as a card with a Share my location button
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
  /** "Share my location" on someone's where-is-the-bus request. */
  onShareLocation: () => void;
}

const sameGroup = (a?: UiMessage, b?: UiMessage) =>
  !!a && !!b && !!a.senderSeat && a.senderSeat === b.senderSeat &&
  (a.contentType === 'TEXT' || a.contentType === 'STICKER') && (b.contentType === 'TEXT' || b.contentType === 'STICKER') &&
  Math.abs(Date.parse(a.createdAt) - Date.parse(b.createdAt)) < GROUP_MS;

function MessageRowImpl(props: MessageRowProps) {
  const { message: m, prev, next, mySeat, roomType } = props;
  const textScale = TEXT_SCALE[useSettings((s) => s.textSize)];
  useThemeMode(); // memoized row: repaint on Light/Dark
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
  const showAvatar = showSender; // avatar sits beside the name, at the top of a run
  const senderLabel = showSender ? (
    <View style={styles.senderRow}>
      <Txt v="smallStrong" color={palette.text} numberOfLines={1} style={{ flexShrink: 1 }}>{m.senderHandle}</Txt>
      {m.senderGuest ? (
        <View style={styles.guestTag}><Txt v="micro" color={palette.textSecondary}>🎟️ QR guest</Txt></View>
      ) : m.senderOnBoard ? (
        <View style={styles.onBoard}><View style={styles.onBoardDot} /><Txt v="micro" color={palette.green}>On board</Txt></View>
      ) : null}
    </View>
  ) : null;
  const askLocation = m.contentType === 'TEXT' && m.payload.ask === 'LOCATION' && !mine;
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
  if (askLocation) {
    content = <LocationAsk name={m.senderHandle} waitingAt={m.payload.waitingAt ?? null} text={m.payload.text} onShare={props.onShareLocation} />;
  } else if (m.contentType === 'TEXT') {
    content = (
      <View style={[
        styles.bubble,
        mine ? { backgroundColor: theme.mine } : styles.bubbleOther,
        firstInGroup && (mine ? styles.headMine : styles.headOther),
        m.status === 'failed' && { borderWidth: 1, borderColor: palette.red, backgroundColor: palette.redSoft },
      ]}>
        {/* On web, double-click is the reaction gesture, so don't let it select a word. */}
        <Txt v="body" selectable={Platform.OS !== 'web'} color={mine && m.status !== 'failed' ? theme.onMine : palette.text}
          style={textScale !== 1 ? { fontSize: 15 * textScale, lineHeight: 21 * textScale } : undefined}>
          {withMentions(m.payload.text, mine ? theme.onMine : theme.accent)}
        </Txt>
      </View>
    );
  } else if (m.contentType === 'POLL') {
    content = (
      <View style={[styles.bubble, styles.pollBubble, mine ? { backgroundColor: theme.tint, borderWidth: 1, borderColor: theme.border } : styles.bubbleOther]}>
        <PollCard poll={m.payload} reactions={m.reactions} mySeat={mySeat} accent={theme.accent} pending={m.status !== 'sent'}
          onVote={(opts) => props.onVote(m, opts)} onOpenVotes={() => props.onOpenVotes(m)} />
      </View>
    );
  } else if (m.contentType === 'GAME') {
    content = (
      <View style={[styles.bubble, styles.pollBubble, mine ? { backgroundColor: theme.tint, borderWidth: 1, borderColor: theme.border } : styles.bubbleOther]}>
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

  // One wrapping View: inverted lists can reverse sibling order inside a cell.
  return (
    <View>
      {separator}
      <Animated.View style={[styles.row, mine ? styles.rowMine : styles.rowOther, { marginTop: firstInGroup ? 14 : 3 }, enterStyle]}>
        {!mine && m.senderSeat && (
          <View style={styles.avatarCol}>
            {showAvatar && <Avatar name={m.senderHandle} avatar={m.senderAvatar} size={34} />}
          </View>
        )}
        <View style={[styles.col, askLocation && styles.colWide, mine ? { alignItems: 'flex-end' } : { alignItems: 'flex-start' }]}>
          {showSender && <View style={styles.senderOutside}>{senderLabel}</View>}
          <View style={[styles.bubbleLine, mine && { flexDirection: 'row-reverse' }]}>
            <Pressable
              onPress={onTap}
              onLongPress={openMenu}
              delayLongPress={280}
              onHoverIn={() => setHover(true)}
              onHoverOut={() => setHover(false)}
              disabled={m.status !== 'sent'}
              accessibilityHint="Double-tap or long press to react, report or block"
              style={{ maxWidth: '100%', flexShrink: 1, ...(askLocation ? { flex: 1 } : null) }}
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
          {lastInGroup && m.status !== 'failed' && (
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

/** Someone waiting for the bus asked where it is: riders on board can answer with one tap. */
function LocationAsk({ name, waitingAt, text, onShare }: { name: string; waitingAt: string | null; text: string; onShare: () => void }) {
  return (
    <View style={styles.ask}>
      <View style={styles.askHead}>
        <View style={styles.askIcon}><Ionicons name="location" size={16} color={palette.red} /></View>
        <Txt v="bodyStrong" style={{ flex: 1 }}>
          {waitingAt ? `${name} is waiting at ${waitingAt} and asked for the bus’s live location` : `${name} asked for the bus’s live location`}
        </Txt>
      </View>
      <View style={styles.askQuote}><Txt v="body" color={palette.textSecondary}>{`“${text}”`}</Txt></View>
      <Txt v="meta" color={palette.textSecondary}>If you’re on the bus, your location shows them exactly where it is.</Txt>
      <Pressable onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onShare(); }} style={({ pressed }) => [styles.askBtn, pressed && { opacity: 0.85 }]}
        accessibilityRole="button" accessibilityLabel={`Share my location with ${name}`}>
        <Ionicons name="locate" size={17} color={palette.onCyan} />
        <Txt v="bodyStrong" color={palette.onCyan}>Share my location</Txt>
      </Pressable>
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
  row: { paddingHorizontal: 12, flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  rowMine: { justifyContent: 'flex-end' },
  rowOther: { justifyContent: 'flex-start' },
  avatarCol: { width: 34 },
  col: { maxWidth: '78%' },
  colWide: { flex: 1, maxWidth: '86%' },
  senderRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  guestTag: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: palette.surfaceRaised },
  onBoard: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: palette.greenSoft },
  onBoardDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: palette.green },
  senderOutside: { marginBottom: 5, marginLeft: 2 },
  bubbleLine: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '100%' },
  hoverBtn: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.surfaceRaised, borderWidth: 1, borderColor: palette.hairline },
  careLine: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3, marginHorizontal: 4 },
  bubble: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: radius.bubble },
  pollBubble: { paddingTop: 10, paddingBottom: 8 },
  bubbleOther: { backgroundColor: palette.surface },
  headMine: { borderTopRightRadius: 6 },
  headOther: { borderTopLeftRadius: 6 },
  ask: { padding: 14, gap: 10, borderRadius: radius.bubble, borderTopLeftRadius: 6, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.hairlineStrong },
  askHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  askIcon: { width: 30, height: 30, borderRadius: 15, backgroundColor: palette.redSoft, alignItems: 'center', justifyContent: 'center' },
  askQuote: { borderLeftWidth: 3, borderLeftColor: palette.hairlineStrong, paddingLeft: 10, paddingVertical: 2 },
  askBtn: { flexDirection: 'row', gap: 8, height: 44, borderRadius: radius.pill, backgroundColor: palette.red, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  reactions: { flexDirection: 'row', gap: 5, marginTop: 4, flexWrap: 'wrap' },
  reaction: {
    flexDirection: 'row', alignItems: 'center', gap: 4, height: 24, paddingHorizontal: 7,
    borderRadius: radius.pill, backgroundColor: palette.surfaceSunk, borderWidth: 1, borderColor: palette.hairline,
  },
  metaOutside: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 5, marginHorizontal: 4 },
  failRow: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: 300, marginTop: 4 },
  seenBy: { marginTop: 3, marginRight: 4, textAlign: 'right' },
}));
