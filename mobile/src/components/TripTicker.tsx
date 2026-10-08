import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { FadeInDown, FadeOutUp } from 'react-native-reanimated';
import { Ionicons } from './icons';
import * as Haptics from '../services/haptics';
import { Txt } from './Txt';
import { useChat, type UiMessage } from '../store/chatStore';
import { useServerNow } from '../hooks/useNow';
import { useTripInfo } from '../hooks/useTripInfo';
import { chatEvents } from '../services/events';
import { personFrom } from '../hooks/usePeople';
import { personaOf } from '../shared/personas';
import { snlState, tttState, type RoomType } from '../shared/protocol';
import { clock } from '../utils/format';
import { palette, radius, themed } from '../theme/tokens';

/**
 * "Up next": one slim row under the header that rotates through what matters
 * right now, most urgent first. Tap to act. Trip details live behind the
 * title / ⋮, rest stops and the arrival game in the pinned rail, so neither
 * repeats here.
 *   🎲 Your turn in Snakes & Ladders            Play ›
 *   🎲 Mr. Bean started Snakes & Ladders    Join ›
 *   📍 ~2 h 10 min to your stop · HSR Layout    11:00 AM ›
 *   📸 2 pickup points ahead · help people find the bus
 *   👋 3 co-travellers online · say hi
 *   🎭 You’re Mr. Bean tonight
 *   🌙 Quiet hours · keep calls and videos low
 */
type Item = { key: string; emoji: string; text: string; action?: string; tone?: string; onPress?: () => void };

const ROTATE_MS = 5500;

export function TripTicker({ onOpenTrip, onOpenLandmarks, onOpenPassengers }: { onOpenTrip: () => void; onOpenLandmarks: () => void; onOpenPassengers: () => void }) {
  const roomType = useChat((s) => s.activeRoom);
  const messages = useChat((s) => s.rooms[s.activeRoom].messages);
  const me = useChat((s) => s.session!.me);
  const online = useChat((s) => s.rooms[s.activeRoom].presence.onlineSeats.length);
  const landmarksAhead = useChat((s) => s.landmarks.filter((l) => !l.passed).length);
  const info = useTripInfo(60_000);
  const now = useServerNow(30_000);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    const jump = (m: UiMessage) => () => chatEvents.emit('jumpTo', { roomType: roomType as RoomType, messageId: m.id });

    // Games that are waiting for someone (newest first): your turn beats an invite.
    for (const m of [...messages].reverse().slice(0, 60)) {
      if (m.contentType !== 'GAME' || m.status !== 'sent' || 'pending' in m.payload) continue;
      const g = m.payload;
      const by = m.senderSeat === me.seat ? 'You' : personFrom(useChat.getState(), m.senderSeat).name;
      if (g.kind === 'SNL') {
        const st = snlState(g, m.reactions);
        if (st.turn === me.seat) { out.push({ key: `g${m.id}`, emoji: '🎲', text: 'Your turn in Snakes & Ladders', action: 'Play', tone: palette.purple, onPress: jump(m) }); break; }
        if (!st.started && now < Date.parse(g.expiresAt) && !st.players.includes(me.seat) && st.players.length < 4) { out.push({ key: `g${m.id}`, emoji: '🎲', text: `${by} started Snakes & Ladders`, action: 'Join', tone: palette.purple, onPress: jump(m) }); break; }
      } else if (g.kind === 'TTT') {
        const st = tttState(g, m.reactions);
        if (st.turn === me.seat) { out.push({ key: `g${m.id}`, emoji: '❌', text: 'Your move in tic-tac-toe', action: 'Play', tone: palette.purple, onPress: jump(m) }); break; }
        if (!st.opponent && now < Date.parse(g.expiresAt) && m.senderSeat !== me.seat) { out.push({ key: `g${m.id}`, emoji: '❌', text: `${by} wants a tic-tac-toe rival`, action: 'Play', tone: palette.purple, onPress: jump(m) }); break; }
      } else if (g.kind === 'RPS') {
        if (!g.opponent && now < Date.parse(g.expiresAt) && m.senderSeat !== me.seat) { out.push({ key: `g${m.id}`, emoji: '✊', text: `${by} challenged the bus to rock-paper-scissors`, action: 'Play', tone: palette.purple, onPress: jump(m) }); break; }
      } else if (g.kind === 'QUIZ') {
        if (g.correct == null && now < Date.parse(g.revealAt)) { out.push({ key: `g${m.id}`, emoji: '🧠', text: 'A Bus Quiz is live', action: 'Answer', tone: palette.purple, onPress: jump(m) }); break; }
      } else if (g.kind === 'EMOJI') {
        if (!g.solvedBy && now < Date.parse(g.expiresAt)) { out.push({ key: `g${m.id}`, emoji: '🎬', text: `Guess the movie: ${g.emojis}`, action: 'Guess', tone: palette.purple, onPress: jump(m) }); break; }
      }
    }

    // Your own stop: the countdown everyone on a night bus keeps checking.
    const my = info?.myStops;
    if (my?.droppingAt && my.dropping && Date.parse(my.droppingAt) > now) {
      const mins = Math.round((Date.parse(my.droppingAt) - now) / 60_000);
      const left = mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
      out.push({ key: 'drop', emoji: '📍', text: `~${left} to your stop · ${my.dropping}`, action: clock(my.droppingAt), onPress: onOpenTrip });
    } else if (my?.boardingAt && my.boarding && Date.parse(my.boardingAt) > now) {
      out.push({ key: 'board', emoji: '🚏', text: `Board at ${my.boarding}`, action: clock(my.boardingAt), onPress: onOpenTrip });
    }

    if (landmarksAhead > 0 && roomType === 'MAIN_COMMON')
      out.push({ key: 'photos', emoji: '📸', text: `${landmarksAhead} pickup point${landmarksAhead === 1 ? '' : 's'} ahead · help people find the bus`, action: 'Photos', onPress: onOpenLandmarks });

    const others = Math.max(0, online - 1);
    if (others > 0) out.push({ key: 'online', emoji: '👋', text: `${others} co-traveller${others === 1 ? '' : 's'} online · say hi`, action: 'See', onPress: onOpenPassengers });

    const persona = personaOf(me.avatar);
    if (persona) out.push({ key: 'me', emoji: persona.glyph.length <= 2 && /[A-Z]/.test(persona.glyph) ? '🦸' : persona.glyph, text: `You’re ${me.name} tonight` });

    const h = new Date(now).getHours();
    if (h >= 22 || h < 6) out.push({ key: 'night', emoji: '🌙', text: 'Quiet hours · keep calls and videos low' });
    return out;
  }, [messages, me, online, landmarksAhead, info, now, roomType]);

  // Rotate; an urgent game item stays put (it's first, and we restart at 0 whenever it changes).
  const [i, setI] = useState(0);
  const urgent = items[0]?.key.startsWith('g') ? items[0].key : null;
  useEffect(() => { setI(0); }, [urgent]);
  useEffect(() => {
    if (items.length < 2) return;
    const t = setInterval(() => setI((n) => (n + 1) % items.length), ROTATE_MS);
    return () => clearInterval(t);
  }, [items.length]);

  if (!items.length) return null;
  const item = items[i % items.length];
  return (
    <Pressable disabled={!item.onPress} onPress={() => { Haptics.selectionAsync(); item.onPress?.(); }}
      style={({ pressed }) => [styles.bar, pressed && { opacity: 0.8 }]} accessibilityRole={item.onPress ? 'button' : 'text'}
      accessibilityLabel={`Up next: ${item.text}`} accessibilityLiveRegion="polite">
      <Animated.View key={item.key} entering={FadeInDown.duration(260)} exiting={FadeOutUp.duration(180)} style={styles.row}>
        <View style={[styles.emoji, item.tone ? { backgroundColor: `${item.tone}22` } : null]}><Txt style={{ fontSize: 16, lineHeight: 20 }}>{item.emoji}</Txt></View>
        <Txt v="smallStrong" numberOfLines={1} style={{ flex: 1 }}>{item.text}</Txt>
        {item.action && (
          <View style={[styles.action, item.tone && { borderColor: item.tone }]}>
            <Txt v="micro" color={item.tone ?? palette.textSecondary}>{item.action}</Txt>
            {item.onPress && <Ionicons name="chevron-forward" size={11} color={item.tone ?? palette.textTertiary} />}
          </View>
        )}
      </Animated.View>
      {items.length > 1 && (
        <View style={styles.dots}>
          {items.map((it, k) => <View key={it.key} style={[styles.dot, k === i % items.length && styles.dotOn]} />)}
        </View>
      )}
    </Pressable>
  );
}

const styles = themed(() => ({
  bar: { marginHorizontal: 12, marginBottom: 8, paddingHorizontal: 10, paddingTop: 8, paddingBottom: 6, borderRadius: radius.card - 6, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.hairline, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 30 },
  emoji: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.surfaceRaised },
  action: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 8, height: 22, borderRadius: radius.pill, borderWidth: 1, borderColor: palette.hairlineStrong },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 4, marginTop: 5 },
  dot: { width: 4, height: 4, borderRadius: 2, backgroundColor: palette.hairlineStrong },
  dotOn: { width: 12, backgroundColor: palette.red },
}));
