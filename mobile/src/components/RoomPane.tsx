import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, FlatList, Pressable, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent, type ViewToken } from 'react-native';
import * as Haptics from 'expo-haptics';
import { chatEvents } from '../services/events';
import { personFrom } from '../hooks/usePeople';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { Txt } from './Txt';
import { MessageRow } from './MessageRow';
import { toast } from './Toast';
import type { GameMoveInput } from './GameCard';
import type { Rect } from './MessageMenu';
import { useChat, type UiMessage } from '../store/chatStore';
import { chatSocket } from '../services/socket';
import { useServerNow } from '../hooks/useNow';
import { palette, radius, roomTheme, themed } from '../theme/tokens';
import type { ReactionEmoji, RoomType } from '../shared/protocol';

/**
 * One room's message list (inverted FlatList: newest at the bottom, scroll
 * position anchored to the latest message). Both rooms stay mounted side by
 * side in a pager, so switching rooms keeps each room's scroll position.
 *
 * Read receipts: a message counts as "seen" once it is >=60% visible for the
 * active room while the app is in the foreground.
 */
interface Props {
  roomType: RoomType;
  width: number;
  onLongPress: (m: UiMessage, rect: Rect) => void;
  onOpenSeenBy: (m: UiMessage) => void;
  onOpenVotes: (m: UiMessage) => void;
  onOpenReactions: (m: UiMessage) => void;
}

/** How far from the newest message (px) still counts as "at the bottom". */
const BOTTOM_SLOP = 120;

export function RoomPane({ roomType, width, onLongPress, onOpenSeenBy, onOpenVotes, onOpenReactions }: Props) {
  const messages = useChat((s) => s.rooms[roomType].messages);
  const hasMore = useChat((s) => s.rooms[roomType].hasMore);
  const blocked = useChat((s) => s.blockedSeats);
  const mySeat = useChat((s) => s.session!.me.seat);
  const theme = roomTheme[roomType];

  const visible = useMemo(() => messages.filter((m) => !m.senderSeat || !blocked.includes(m.senderSeat)), [messages, blocked]);
  const data = useMemo(() => [...visible].reverse(), [visible]); // newest first for inverted list
  const latestMineId = useMemo(() => [...visible].reverse().find((m) => m.senderSeat === mySeat && m.status === 'sent')?.id, [visible, mySeat]);

  // ---- "jump to latest" (WhatsApp-style): the list is inverted, so offset 0 = newest ----
  const listRef = useRef<FlatList<UiMessage>>(null);
  const atBottom = useRef(true);
  const [awayFromBottom, setAway] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const newestId = data[0]?.id;
  const prevNewest = useRef(newestId);
  useEffect(() => {
    // Count messages from others that land while you're reading older ones.
    if (newestId && newestId !== prevNewest.current && !atBottom.current && data[0]?.senderSeat !== mySeat) setUnseen((n) => n + 1);
    prevNewest.current = newestId;
  }, [newestId]);
  const jumpToLatest = useCallback((animated = true) => {
    listRef.current?.scrollToOffset({ offset: 0, animated });
    atBottom.current = true;
    setAway(false);
    setUnseen(0);
  }, []);
  // Sending anything from this room always brings you to the end of the chat.
  useEffect(() => chatEvents.on('sent', (e) => { if (e.roomType === roomType) requestAnimationFrame(() => jumpToLatest(true)); }), [roomType]);
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const bottom = e.nativeEvent.contentOffset.y < BOTTOM_SLOP;
    if (bottom === atBottom.current) return;
    atBottom.current = bottom;
    setAway(!bottom);
    if (bottom) setUnseen(0);
  }, []);

  const viewability = useRef({ itemVisiblePercentThreshold: 60, minimumViewTime: 300 }).current;
  const onViewable = useRef(({ viewableItems }: { viewableItems: ViewToken<UiMessage>[] }) => {
    const st = useChat.getState();
    if (st.activeRoom !== roomType || AppState.currentState !== 'active') return;
    const ids = viewableItems
      .map((v) => v.item)
      .filter((m) => m && m.status === 'sent' && m.senderSeat && m.senderSeat !== st.session?.me.seat && !m.seenBy.includes(st.session!.me.seat))
      .map((m) => m.id);
    chatSocket.markSeen(roomType, ids);
  }).current;

  const onReact = useCallback((m: UiMessage, emoji: ReactionEmoji) => { void chatSocket.react(m.id, emoji); }, []);
  const onRetry = useCallback((m: UiMessage) => chatSocket.retry(m), []);
  const onVote = useCallback((m: UiMessage, opts: number[]) => { void chatSocket.votePoll(m, opts); }, []);
  const onGameMove = useCallback(async (m: UiMessage, move: GameMoveInput) => {
    const ack = await chatSocket.gameMove(m, move);
    if (!ack.ok && ack.code !== 'INTERNAL') toast(ack.message, 'danger');
  }, []);

  return (
    <View style={{ width, flex: 1 }}>
      <FlatList
        ref={listRef}
        data={data}
        onScroll={onScroll}
        scrollEventThrottle={64}
        inverted
        keyExtractor={(m) => m.clientMsgId ?? m.id}
        renderItem={({ item, index }) => (
          <MessageRow
            message={item}
            prev={data[index + 1]}
            next={data[index - 1]}
            mySeat={mySeat}
            roomType={roomType}
            isLatestMine={item.id === latestMineId}
            onLongPress={onLongPress}
            onOpenSeenBy={onOpenSeenBy}
            onReact={onReact}
            onRetry={onRetry}
            onVote={onVote}
            onGameMove={onGameMove}
            onOpenVotes={onOpenVotes}
            onOpenReactions={onOpenReactions}
          />
        )}
        onViewableItemsChanged={onViewable}
        viewabilityConfig={viewability}
        onEndReached={() => hasMore && chatSocket.loadOlder(roomType)}
        onEndReachedThreshold={0.4}
        ListHeaderComponent={<TypingLine roomType={roomType} />}
        ListFooterComponent={hasMore ? <View style={{ height: 24 }} /> : <RoomIntro roomType={roomType} />}
        contentContainerStyle={{ paddingTop: 8, paddingBottom: 8 }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        removeClippedSubviews
        windowSize={11}
        initialNumToRender={18}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        accessibilityLabel={`${theme.name} messages`}
      />
      {awayFromBottom && (
        <Animated.View entering={FadeIn.duration(150)} style={styles.jumpWrap}>
          <Pressable onPress={() => { Haptics.selectionAsync(); jumpToLatest(); }} style={({ pressed }) => [styles.jump, pressed && { opacity: 0.8 }]}
            accessibilityRole="button" accessibilityLabel={unseen ? `${unseen} new messages. Jump to latest` : 'Jump to latest message'}>
            <Ionicons name="chevron-down" size={22} color={palette.text} />
            {unseen > 0 && (
              <View style={[styles.jumpBadge, { backgroundColor: theme.accent }]}>
                <Txt v="micro" color={theme.onAccent} style={{ fontVariant: ['tabular-nums'] }}>{unseen > 9 ? '9+' : unseen}</Txt>
              </View>
            )}
          </Pressable>
        </Animated.View>
      )}
    </View>
  );
}

function RoomIntro({ roomType }: { roomType: RoomType }) {
  const theme = roomTheme[roomType];
  const women = roomType === 'WOMEN_ONLY';
  return (
    <View style={[styles.intro, { borderColor: theme.border }]}>
      <View style={[styles.introIcon, { backgroundColor: theme.tint }]}>
        <Ionicons name={women ? 'shield-checkmark' : 'bus-outline'} size={22} color={theme.accent} />
      </View>
      <Txt v="title" style={{ textAlign: 'center' }}>{women ? 'Women on this bus' : 'Everyone on this bus'}</Txt>
      <Txt v="small" color={palette.textSecondary} style={{ textAlign: 'center' }}>
        {women
          ? 'Only passengers booked as women on this trip can open this room. Others on the bus can’t see it exists.'
          : 'Everyone here is verified by their ticket (guests who joined via QR are marked). You appear by your first name and avatar. Seat numbers and phone numbers stay hidden.'}
      </Txt>
      <Txt v="meta" color={palette.textTertiary} style={{ textAlign: 'center' }}>Messages are deleted 2 hours after the bus arrives.</Txt>
    </View>
  );
}

function TypingLine({ roomType }: { roomType: RoomType }) {
  const typing = useChat((s) => s.rooms[roomType].typing);
  const now = useServerNow(1000);
  const seats = Object.entries(typing).filter(([, exp]) => exp > Date.now()).map(([seat]) => seat);
  void now;
  if (!seats.length) return <View style={{ height: 6 }} />;
  const names = seats.map((x) => personFrom(useChat.getState(), x).name);
  const label = names.length === 1 ? `${names[0]} is typing…` : names.length === 2 ? `${names[0]} and ${names[1]} are typing…` : `${seats.length} people are typing`;
  return (
    <Animated.View entering={FadeIn.duration(150)} style={styles.typing}>
      <Txt v="meta" color={palette.textTertiary}>{label}</Txt>
    </Animated.View>
  );
}

const styles = themed(() => ({
  intro: { margin: 16, marginBottom: 20, padding: 20, gap: 8, alignItems: 'center', borderRadius: radius.card, borderWidth: 1, borderStyle: 'dashed', backgroundColor: palette.surfaceSunk },
  introIcon: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  typing: { paddingHorizontal: 18, paddingVertical: 6 },
  jumpWrap: { position: 'absolute', right: 12, bottom: 12 },
  jump: {
    width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.surfaceRaised,
    borderWidth: 1, borderColor: palette.hairlineStrong, shadowColor: palette.shadow, shadowOpacity: 0.25, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 4,
  },
  jumpBadge: { position: 'absolute', top: -6, right: -4, minWidth: 20, height: 20, paddingHorizontal: 5, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
}));
