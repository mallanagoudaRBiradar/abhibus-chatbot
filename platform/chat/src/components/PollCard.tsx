import React, { useEffect } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Txt } from './Txt';
import { palette, themed } from '../theme/tokens';
import { pollVotes, type PollPayload } from '../shared/protocol';

/**
 * WhatsApp-style poll bubble.
 *   📊 POLL · Select one
 *   Where should we stop for breakfast?
 *   (●) Anantapur ................ 5
 *       ███████████░░░░░
 *   ( ) Chikkaballapur ........... 2
 *   ─────────────────────────────
 *            View votes (7)
 * Tap an option to vote; tap your choice again to take the vote back.
 * Seats are already public in the chat, so votes show who voted (like WhatsApp).
 */
export function PollCard({ poll, reactions, mySeat, accent, pending, onVote, onOpenVotes }: {
  poll: PollPayload;
  reactions: Record<string, string[]>;
  mySeat: string;
  accent: string;
  pending: boolean;
  onVote: (options: number[]) => void;
  onOpenVotes: () => void;
}) {
  const votes = pollVotes(reactions, poll.options.length);
  const mine = votes.map((seats, i) => (seats.includes(mySeat) ? i : -1)).filter((i) => i >= 0);
  const voters = new Set(votes.flat()).size;
  const max = Math.max(1, ...votes.map((v) => v.length));

  const toggle = (i: number) => {
    if (pending) return;
    Haptics.selectionAsync();
    if (poll.multi) onVote(mine.includes(i) ? mine.filter((x) => x !== i) : [...mine, i].sort((a, b) => a - b));
    else onVote(mine.includes(i) ? [] : [i]);
  };

  return (
    <View style={styles.wrap} accessibilityLabel={`Poll: ${poll.question}`}>
      <View style={styles.head}>
        <MaterialCommunityIcons name="poll" size={14} color={palette.textTertiary} />
        <Txt v="micro" color={palette.textTertiary} style={{ letterSpacing: 0.6 }}>{`POLL · ${poll.multi ? 'SELECT ONE OR MORE' : 'SELECT ONE'}`}</Txt>
      </View>
      <Txt v="bodyStrong" style={{ marginBottom: 6 }}>{poll.question}</Txt>

      {poll.options.map((opt, i) => {
        const on = mine.includes(i);
        const n = votes[i].length;
        return (
          <Pressable key={i} onPress={() => toggle(i)} disabled={pending} style={({ pressed }) => [styles.option, pressed && { opacity: 0.7 }]}
            accessibilityRole={poll.multi ? 'checkbox' : 'radio'} accessibilityState={{ checked: on }}
            accessibilityLabel={`${opt}. ${n} vote${n === 1 ? '' : 's'}`}>
            <View style={[styles.mark, poll.multi && { borderRadius: 6 }, on && { backgroundColor: accent, borderColor: accent }]}>
              {on && <Ionicons name="checkmark" size={13} color={palette.navyDeep} />}
            </View>
            <View style={{ flex: 1, gap: 6 }}>
              <View style={styles.optRow}>
                <Txt v="body" style={{ flex: 1 }}>{opt}</Txt>
                <Txt v="smallStrong" color={n ? palette.text : palette.textTertiary} style={{ fontVariant: ['tabular-nums'] }}>{n}</Txt>
              </View>
              <Bar fraction={n / max} color={on ? accent : palette.textTertiary} />
            </View>
          </Pressable>
        );
      })}

      <Pressable onPress={onOpenVotes} disabled={!voters} hitSlop={6} style={({ pressed }) => [styles.footer, pressed && { opacity: 0.6 }]} accessibilityRole="button">
        <Txt v="smallStrong" color={voters ? accent : palette.textTertiary}>
          {pending ? 'Sending…' : voters ? `View votes · ${voters} ${voters === 1 ? 'person' : 'people'}` : 'No votes yet'}
        </Txt>
      </Pressable>
    </View>
  );
}

function Bar({ fraction, color }: { fraction: number; color: string }) {
  const w = useSharedValue(fraction);
  useEffect(() => { w.value = withTiming(fraction, { duration: 260 }); }, [fraction]);
  const st = useAnimatedStyle(() => ({ width: `${w.value * 100}%` }));
  return (
    <View style={styles.track}>
      <Animated.View style={[styles.fill, { backgroundColor: color }, st]} />
    </View>
  );
}

const styles = themed(() => ({
  wrap: { width: 280, maxWidth: '100%' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 4 },
  option: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 7 },
  mark: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, borderColor: palette.textTertiary, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  optRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  track: { height: 5, borderRadius: 3, backgroundColor: palette.track, overflow: 'hidden' },
  fill: { height: 5, borderRadius: 3 },
  footer: { alignItems: 'center', marginTop: 6, paddingTop: 10, borderTopWidth: 1, borderTopColor: palette.hairline },
}));
