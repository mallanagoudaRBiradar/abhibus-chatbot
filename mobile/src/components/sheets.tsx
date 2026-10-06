import React, { forwardRef, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { BottomSheetScrollView, BottomSheetTextInput, type BottomSheetModal } from '@gorhom/bottom-sheet';
import Animated, { Easing, FadeIn, useAnimatedStyle, useSharedValue, withSpring, withTiming, runOnJS, ZoomIn } from 'react-native-reanimated';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import QRCode from 'react-native-qrcode-svg';
import { currentCoords, LocationError } from '../services/location';
import { startLiveShare, stopLiveShare } from '../services/liveLocation';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Sheet } from './Sheet';
import { ThemeSwitch } from './ThemeSwitch';
import { Txt } from './Txt';
import { Avatar } from './Avatar';
import { personFrom, usePeople } from '../hooks/usePeople';
import { LandmarkCard } from './LandmarkCard';
import { toast } from './Toast';
import { useChat, type UiMessage } from '../store/chatStore';
import { chatSocket } from '../services/socket';
import { api } from '../services/api';
import { berthLabel, berthOf } from '../utils/seat';
import { clock } from '../utils/format';
import { useServerNow } from '../hooks/useNow';
import { font, motion, palette, radius, roomTheme, themed } from '../theme/tokens';
import { type GameKind, type QrInvite, LIVE_LOCATION_MINUTES, isSystemReactionKey, POLL_LIMITS, REACTIONS, REPORT_REASONS, pollVotes, type PollPayload, type ReactionEmoji, type ReportReason } from '../shared/protocol';

type Ref = BottomSheetModal;
// The sheet's input keeps the sheet above the keyboard on phones, but relies on a
// focus API react-native-web doesn't have — use the plain input on web.
const SheetInput = (Platform.OS === 'web' ? TextInput : BottomSheetTextInput) as typeof TextInput;
const NO_SEATS: string[] = [];

// ============================================================ Passengers ===
/**
 * Everyone who has joined this room: avatar + name, online first.
 * Gender is shown as room totals only — never per person, so nobody can pick
 * out a solo woman traveller by name.
 */
export const PassengerSheet = forwardRef<Ref, { onOpenPerson: (seat: string) => void }>(({ onOpenPerson }, ref) => {
  const roomType = useChat((s) => s.activeRoom);
  const presence = useChat((s) => s.rooms[s.activeRoom].presence);
  const me = useChat((s) => s.session!.me.seat);
  const blocked = useChat((s) => s.blockedSeats);
  const insets = useSafeAreaInsets();
  const online = presence.members.filter((m) => m.online).length;
  const parts = [
    roomType === 'WOMEN_ONLY' ? null : `${presence.men} men`,
    `${presence.women} women`,
    presence.guests ? `${presence.guests} joined via QR` : null,
  ].filter(Boolean).join(' · ');
  return (
    <Sheet ref={ref} scrollable>
      <BottomSheetScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 20 }}>
        <Txt v="h3">{`${presence.count} on board`}</Txt>
        <Txt v="small" color={palette.textSecondary} style={{ marginTop: 4 }}>{`${online} online now · ${parts}`}</Txt>
        <View style={styles.genderRow}>
          {roomType !== 'WOMEN_ONLY' && <CountPill icon="man" label="Men" value={presence.men} />}
          <CountPill icon="woman" label="Women" value={presence.women} />
          {presence.guests > 0 && <CountPill icon="qr-code-outline" label="Guests" value={presence.guests} />}
        </View>
        <View style={{ marginTop: 6 }}>
          {presence.members.map((m) => (
            <Pressable key={m.seat} disabled={m.seat === me} onPress={() => onOpenPerson(m.seat)}
              style={({ pressed }) => [styles.personRow, pressed && { backgroundColor: palette.surfaceRaised }]} accessibilityRole="button"
              accessibilityLabel={`${m.name}${m.seat === me ? ', you' : ''}. ${personStatus(m)}${blocked.includes(m.seat) ? ', blocked' : ''}`}>
              <Avatar name={m.name} avatar={m.avatar} size={40} online={m.online} />
              <View style={{ flex: 1 }}>
                <Txt v="bodyStrong" numberOfLines={1}>{m.seat === me ? `${m.name} (You)` : m.name}</Txt>
                <Txt v="meta" color={palette.textTertiary} numberOfLines={1}>{[personStatus(m), blocked.includes(m.seat) ? 'Blocked' : null].filter(Boolean).join(' · ')}</Txt>
              </View>
              {m.seat !== me && <Ionicons name="chevron-forward" size={16} color={palette.textTertiary} />}
            </Pressable>
          ))}
        </View>
        <Txt v="meta" color={palette.textTertiary} style={{ marginTop: 14 }}>Tap someone to report or block them. Phone numbers, seat numbers and booking names are never shown.</Txt>
      </BottomSheetScrollView>
    </Sheet>
  );
});

/**
 * Everyone here is on this bus, so offline never means "away" — it means asleep
 * or the screen is off. Guests show who let them in.
 */
export function personStatus(m: { online: boolean; guest: boolean; invitedBy?: string | null }) {
  const presence = m.online ? 'In the chat' : 'Catching some Zzz 😴';
  return m.guest ? `${presence} · Hopped on with ${m.invitedBy ? `${m.invitedBy}’s` : 'a passenger’s'} QR 🎟️` : presence;
}

function CountPill({ icon, label, value }: { icon: any; label: string; value: number }) {
  return (
    <View style={styles.countPill}>
      <Ionicons name={icon} size={16} color={palette.textSecondary} />
      <Txt v="bodyStrong" style={{ fontVariant: ['tabular-nums'] }}>{value}</Txt>
      <Txt v="meta" color={palette.textSecondary}>{label}</Txt>
    </View>
  );
}

// ================================================================ Seen by ===
export const SeenBySheet = forwardRef<Ref, { message: UiMessage | null }>(({ message }, ref) => {
  const live = useChat((s) => (message ? s.rooms[message.roomType].messages.find((m) => m.id === message.id) ?? message : null));
  const online = useChat((s) => (message ? s.rooms[message.roomType].presence.onlineSeats : NO_SEATS));
  const me = useChat((s) => s.session!.me.seat);
  const person = usePeople();
  const seen = live?.seenBy ?? [];
  const notYet = online.filter((s) => s !== me && !seen.includes(s));
  return (
    <Sheet ref={ref}>
      <Txt v="h3">{`Seen by ${seen.length}`}</Txt>
      <Txt v="small" color={palette.textSecondary} style={{ marginTop: 4 }}>{live ? `Your message at ${clock(live.createdAt)}` : ''}</Txt>
      <View style={{ marginTop: 8 }}>
        {seen.map((seat) => {
          const p = person(seat);
          return (
            <View key={seat} style={styles.personRow}>
              <Avatar name={p.name} avatar={p.avatar} size={36} />
              <Txt v="bodyStrong" style={{ flex: 1 }} numberOfLines={1}>{p.name}</Txt>
              <Ionicons name="checkmark-done" size={16} color={palette.cyan} />
            </View>
          );
        })}
      </View>
      {notYet.length > 0 && <Txt v="meta" color={palette.textTertiary} style={{ marginTop: 14 }}>{`${notYet.length} online haven’t seen it yet`}</Txt>}
    </Sheet>
  );
});

// ============================================================== Reactions ===
/** Who reacted with what (Slack / WhatsApp). Tap your own row to remove it. */
export const ReactionsSheet = forwardRef<Ref, { message: UiMessage | null; onClose: () => void }>(({ message, onClose }, ref) => {
  const live = useChat((s) => (message ? s.rooms[message.roomType].messages.find((m) => m.id === message.id) ?? message : null));
  const me = useChat((s) => s.session!.me.seat);
  const person = usePeople();
  const entries = live ? Object.entries(live.reactions).filter(([k, seats]) => seats.length && !isSystemReactionKey(k)) : [];
  const rows = entries.flatMap(([emoji, seats]) => seats.map((seat) => ({ emoji, seat })));
  return (
    <Sheet ref={ref}>
      <Txt v="h3">{`${rows.length} reaction${rows.length === 1 ? '' : 's'}`}</Txt>
      <View style={styles.reactSummary}>
        {entries.map(([emoji, seats]) => (
          <View key={emoji} style={styles.countPill}><Txt style={{ fontSize: 16, lineHeight: 20 }}>{emoji}</Txt><Txt v="smallStrong">{seats.length}</Txt></View>
        ))}
      </View>
      {rows.map(({ emoji, seat }) => {
        const p = person(seat);
        const mine = seat === me;
        return (
          <Pressable key={`${emoji}-${seat}`} disabled={!mine} onPress={() => { void chatSocket.react(live!.id, emoji); onClose(); }} style={styles.personRow}
            accessibilityLabel={`${p.name} reacted ${emoji}${mine ? '. Tap to remove' : ''}`}>
            <Avatar name={p.name} avatar={p.avatar} size={36} />
            <View style={{ flex: 1 }}>
              <Txt v="bodyStrong" numberOfLines={1}>{mine ? 'You' : p.name}</Txt>
              {mine && <Txt v="meta" color={palette.textTertiary}>Tap to remove</Txt>}
            </View>
            <Txt style={{ fontSize: 22, lineHeight: 28 }}>{emoji}</Txt>
          </Pressable>
        );
      })}
    </Sheet>
  );
});

// ================================================================= Report ===
export type ReportTarget = { kind: 'message'; message: UiMessage } | { kind: 'person'; seat: string; name: string };

/**
 * One report flow for a message or a whole person. Reports are anonymous; when
 * more than half of the room reports the same person, they're removed for good.
 */
export const ReportSheet = forwardRef<Ref, { target: ReportTarget | null; onClose: () => void }>(({ target, onClose }, ref) => {
  const roomType = useChat((s) => s.activeRoom);
  const members = useChat((s) => s.rooms[s.activeRoom].presence.count);
  const name = target ? (target.kind === 'message' ? target.message.senderHandle : target.name) : '';
  const needed = Math.max(2, Math.floor(members / 2) + 1);
  const report = async (reason: ReportReason) => {
    if (!target) return;
    const ack = target.kind === 'message'
      ? await chatSocket.report(target.message.id, reason)
      : await chatSocket.reportPerson(target.seat, roomType, reason);
    onClose();
    toast(ack.ok ? `Thanks — ${name} has been reported. It’s anonymous.` : ack.message, ack.ok ? 'success' : 'danger');
  };
  return (
    <Sheet ref={ref}>
      <Txt v="h3">{target?.kind === 'message' ? `Report this message from ${name}` : `Report ${name}`}</Txt>
      {target?.kind === 'message' && (
        <View style={styles.quote}><Txt v="small" color={palette.textSecondary} numberOfLines={2}>{previewOf(target.message)}</Txt></View>
      )}
      <Txt v="small" color={palette.textSecondary} style={{ marginTop: 8, marginBottom: 10 }}>
        {`Reports are anonymous. If ${needed} of the ${members} people in this chat report ${name}, they’re removed from the trip chat for good.`}
      </Txt>
      {REPORT_REASONS.map((r) => <Action key={r} icon="chevron-forward" label={REPORT_COPY[r]} onPress={() => report(r)} trailing />)}
    </Sheet>
  );
});

const previewOf = (m: UiMessage) =>
  m.contentType === 'TEXT' ? `“${m.payload.text}”` : m.contentType === 'STICKER' ? 'A sticker' : m.contentType === 'POLL' ? `Poll: ${m.payload.question}` : 'A shared item';

// ============================================================ Person card ===
/** Tap anyone in the people list: who they are, how they got here, and Report / Block. */
export const PersonSheet = forwardRef<Ref, { seat: string | null; onReport: (seat: string, name: string) => void; onClose: () => void }>(({ seat, onReport, onClose }, ref) => {
  const member = useChat((s) => (seat ? s.rooms[s.activeRoom].presence.members.find((m) => m.seat === seat) ?? s.rooms.MAIN_COMMON.presence.members.find((m) => m.seat === seat) : undefined));
  const blocked = useChat((s) => s.blockedSeats);
  if (!seat || !member) return <Sheet ref={ref}><View /></Sheet>;
  const isBlocked = blocked.includes(seat);
  const block = async () => {
    const ack = await chatSocket.block(seat, !isBlocked);
    onClose();
    toast(ack.ok ? (isBlocked ? `${member.name} unblocked` : `${member.name} blocked. You won’t see their messages.`) : ack.message, ack.ok ? 'success' : 'danger');
  };
  return (
    <Sheet ref={ref}>
      <View style={{ alignItems: 'center', gap: 6, marginTop: 4 }}>
        <Avatar name={member.name} avatar={member.avatar} size={76} online={member.online} />
        <Txt v="h3" style={{ marginTop: 6 }}>{member.name}</Txt>
        <Txt v="small" color={palette.textSecondary} style={{ textAlign: 'center' }}>{personStatus(member)}</Txt>
        {member.guest && <Txt v="meta" color={palette.textTertiary} style={{ textAlign: 'center' }}>Booked on another app, so their ticket isn’t verified by AbhiBus.</Txt>}
      </View>
      <View style={styles.actions}>
        <Action icon="flag-outline" label={`Report ${member.name}`} danger onPress={() => onReport(seat, member.name)} />
        <Action icon={isBlocked ? 'person-add-outline' : 'remove-circle-outline'} label={isBlocked ? `Unblock ${member.name}` : `Block ${member.name}`} onPress={block} />
      </View>
      <Txt v="meta" color={palette.textTertiary} style={{ marginTop: 6 }}>Blocking hides their messages for you only. Reporting tells the AbhiBus safety team and counts toward removing them.</Txt>
    </Sheet>
  );
});

const REPORT_COPY: Record<ReportReason, string> = {
  HARASSMENT: 'Harassment or unwanted attention',
  ABUSE: 'Abusive or hateful language',
  CONTACT_SHARING: 'Asking for or sharing contact details',
  SPAM: 'Spam or promotion',
  OTHER: 'Something else',
};

function Action({ icon, label, onPress, danger, trailing }: { icon: any; label: string; onPress: () => void; danger?: boolean; trailing?: boolean }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.action, pressed && { backgroundColor: palette.surfaceRaised }]} accessibilityRole="button">
      {!trailing && <Ionicons name={icon} size={20} color={danger ? palette.red : palette.textSecondary} />}
      <Txt v="bodyStrong" color={danger ? palette.red : palette.text} style={{ flex: 1 }}>{label}</Txt>
      {trailing && <Ionicons name={icon} size={18} color={palette.textTertiary} />}
    </Pressable>
  );
}

// ==================================================================== SOS ===
/**
 * Hold-to-send (1.5s) prevents pocket and mis-taps without slowing a real
 * emergency much. The 112 call is always one tap, no hold, because nothing
 * should stand between someone and the police.
 */
export const SosSheet = forwardRef<Ref>((_, ref) => {
  const token = useChat((s) => s.session!.token);
  const supportPhone = useChat((s) => s.session!.supportPhone);
  const isWoman = useChat((s) => s.session!.me.gender === 'F');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [place, setPlace] = useState<string | null>(null);
  const fill = useSharedValue(0);
  const fillStyle = useAnimatedStyle(() => ({ transform: [{ scaleX: fill.value }] }));

  const fire = async () => {
    setState('sending');
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    try {
      const r = await api.sos(token);
      setPlace(r.placeLabel);
      setState('sent');
    } catch { setState('error'); }
  };
  const pressIn = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    fill.value = withTiming(1, { duration: 1500, easing: Easing.linear }, (done) => { if (done) runOnJS(fire)(); });
  };
  const pressOut = () => { if (state === 'idle') fill.value = withTiming(0, { duration: 200 }); };

  return (
    <Sheet ref={ref} onDismiss={() => { if (state !== 'sending') { setState('idle'); fill.value = 0; } }}>
      {state === 'sent' ? (
        <Animated.View entering={FadeIn} style={{ gap: 10 }}>
          <View style={styles.sosIconOk}><Ionicons name="shield-checkmark" size={28} color={palette.green} /></View>
          <Txt v="h3">AbhiBus safety team alerted</Txt>
          <Txt v="body" color={palette.textSecondary}>
            {`We’ve shared your details and the bus location${place ? ` (near ${place})` : ''} with our team and your emergency contacts. They will call you shortly.`}
          </Txt>
          <Txt v="small" color={palette.textTertiary}>Other passengers and the bus crew have not been notified.</Txt>
        </Animated.View>
      ) : (
        <View style={{ gap: 10 }}>
          <Txt v="h3">Need help right now?</Txt>
          <Txt v="body" color={palette.textSecondary}>
            Hold the button to alert the AbhiBus safety team. It quietly sends your details and the bus location. Nobody on the bus is notified.
          </Txt>
          <Pressable onPressIn={pressIn} onPressOut={pressOut} disabled={state === 'sending'} style={styles.holdBtn}
            accessibilityRole="button" accessibilityLabel="Hold to send SOS alert" accessibilityHint="Press and hold for one and a half seconds">
            <Animated.View style={[styles.holdFill, fillStyle]} />
            {state === 'sending' ? <ActivityIndicator color="#fff" /> : (
              <Txt v="bodyStrong" color="#fff">{state === 'error' ? 'Couldn’t send. Hold to try again' : 'Hold to send SOS'}</Txt>
            )}
          </Pressable>
        </View>
      )}
      {/* One tap, no hold: nothing should stand between someone and help. */}
      <Txt v="micro" color={palette.textTertiary} style={styles.callLabel}>CALL DIRECTLY</Txt>
      <View style={styles.callGrid}>
        {[
          { num: '112', label: 'Emergency', icon: 'alert-circle', tone: palette.red },
          { num: '100', label: 'Police', icon: 'shield', tone: palette.red },
          { num: '108', label: 'Ambulance', icon: 'medkit', tone: palette.red },
          ...(isWoman ? [{ num: '181', label: 'Women helpline', icon: 'woman', tone: palette.rose }] : []),
        ].map((c) => (
          <Pressable key={c.num} onPress={() => Linking.openURL(`tel:${c.num}`)} style={({ pressed }) => [styles.callTile, { borderColor: c.tone === palette.rose ? palette.roseBorder : palette.redBorder }, pressed && { opacity: 0.7 }]}
            accessibilityRole="button" accessibilityLabel={`Call ${c.label}, ${c.num}`}>
            <Ionicons name={c.icon as any} size={20} color={c.tone} />
            <Txt v="title" color={c.tone} style={{ fontVariant: ['tabular-nums'] }}>{c.num}</Txt>
            <Txt v="micro" color={palette.textSecondary}>{c.label}</Txt>
          </Pressable>
        ))}
      </View>
      {supportPhone && (
        <Pressable onPress={() => Linking.openURL(`tel:${supportPhone}`)} style={[styles.callBtn, { marginTop: 10, flex: 0 }]} accessibilityRole="button">
          <Ionicons name="headset-outline" size={16} color={palette.text} />
          <Txt v="smallStrong">Call AbhiBus support</Txt>
        </Pressable>
      )}
    </Sheet>
  );
});

// ============================================================== Landmarks ===
export const LandmarkSheet = forwardRef<Ref, { onClose: () => void }>(({ onClose }, ref) => {
  const landmarks = useChat((s) => s.landmarks);
  const roomType = useChat((s) => s.activeRoom);
  const insets = useSafeAreaInsets();
  return (
    <Sheet ref={ref} scrollable>
      <BottomSheetScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 20, gap: 14 }}>
        <View>
          <Txt v="h3">Pickup points</Txt>
          <Txt v="small" color={palette.textSecondary} style={{ marginTop: 4 }}>Photos from the operator so people boarding later can find the bus. Share one to help someone.</Txt>
        </View>
        {landmarks.map((l) => (
          <View key={l.id} style={{ opacity: l.passed ? 0.5 : 1, gap: 8 }}>
            <LandmarkCard payload={{ landmarkId: l.id, pointName: l.pointName, title: l.title, caption: l.caption, imageUrl: l.imageUrl }} width="100%" />
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Txt v="meta" color={palette.textTertiary}>{l.passed ? 'Already passed' : 'Coming up'}</Txt>
              <Pressable onPress={() => { chatSocket.shareLandmark(roomType, l.id); onClose(); }} style={styles.shareBtn} accessibilityRole="button" accessibilityLabel={`Share ${l.pointName} pickup photo in chat`}>
                <Ionicons name="share-outline" size={14} color={roomTheme[roomType].accent} />
                <Txt v="smallStrong" color={roomTheme[roomType].accent}>Share in chat</Txt>
              </Pressable>
            </View>
          </View>
        ))}
      </BottomSheetScrollView>
    </Sheet>
  );
});

// ============================================================== ETA game ===
export const GameSheet = forwardRef<Ref>((_, ref) => {
  const game = useChat((s) => s.game);
  const me = useChat((s) => s.session!.me.seat);
  const now = useServerNow(5000);
  const defaultGuess = useMemo(() => roundTo5(game ? Math.max(Date.parse(game.closesAt) + 20 * 60_000, now + 20 * 60_000) : now), [game?.id]);
  const [guess, setGuess] = useState(defaultGuess);
  const [busy, setBusy] = useState(false);
  useEffect(() => setGuess(defaultGuess), [defaultGuess]);
  if (!game) return <Sheet ref={ref}><Txt v="body" color={palette.textSecondary}>No game running right now.</Txt></Sheet>;

  const submit = async () => {
    setBusy(true);
    const ack = await chatSocket.guess(game.id, new Date(guess));
    setBusy(false);
    if (ack.ok) { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); toast(`Guess locked: ${clock(guess)}`, 'success'); }
    else toast(ack.message, 'danger');
  };
  const nudge = (min: number) => { Haptics.selectionAsync(); setGuess((g) => Math.max(now + 60_000, g + min * 60_000)); };
  const won = game.status === 'RESOLVED' && game.winnerSeat === me;

  return (
    <Sheet ref={ref}>
      <View style={{ gap: 6 }}>
        <MaterialCommunityIcons name="boom-gate-up-outline" size={26} color={palette.amber} />
        <Txt v="h3">{`When will we reach ${game.checkpointName}?`}</Txt>
        <Txt v="small" color={palette.textSecondary}>
          {game.status === 'OPEN' ? `Closest guess wins ${game.rewardPoints} AbhiBus points. Guesses close at ${clock(game.closesAt)}. ${game.guessCount} passengers have guessed.`
            : game.status === 'LOCKED' ? `Guesses are closed. ${game.guessCount} passengers are in. We’ll announce the winner when the bus crosses the toll.`
            : game.actualAt ? `The bus crossed at ${clock(game.actualAt)}.` : ''}
        </Txt>
      </View>

      {game.status === 'RESOLVED' ? (
        <Animated.View entering={ZoomIn.springify()} style={[styles.result, won && { borderColor: palette.amber }]}>
          <Txt style={{ fontSize: 40, lineHeight: 48 }}>{won ? '🏆' : '🏁'}</Txt>
          <Txt v="title" style={{ textAlign: 'center' }}>
            {won ? `You won ${game.rewardPoints} points` : game.winnerSeat ? `${personFrom(useChat.getState(), game.winnerSeat).name} wins` : 'No guesses this time'}
          </Txt>
          {game.winnerDeltaMin != null && <Txt v="small" color={palette.textSecondary}>{game.winnerDeltaMin === 0 ? 'Spot on.' : `Off by ${game.winnerDeltaMin} min`}</Txt>}
          {won && <Txt v="meta" color={palette.textTertiary}>Points are added to your AbhiBus wallet within 24 hours.</Txt>}
        </Animated.View>
      ) : game.myGuess ? (
        <View style={styles.result}>
          <Txt v="meta" color={palette.textSecondary}>Your guess</Txt>
          <Txt v="timer">{clock(game.myGuess)}</Txt>
        </View>
      ) : game.status === 'OPEN' ? (
        <>
          <View style={styles.picker}>
            <StepBtn label="−5" onPress={() => nudge(-5)} />
            <StepBtn label="−1" onPress={() => nudge(-1)} />
            <Txt v="timer" style={{ minWidth: 130, textAlign: 'center' }} accessibilityLiveRegion="polite">{clock(guess)}</Txt>
            <StepBtn label="+1" onPress={() => nudge(1)} />
            <StepBtn label="+5" onPress={() => nudge(5)} />
          </View>
          <Pressable onPress={submit} disabled={busy} style={({ pressed }) => [styles.primary, { backgroundColor: palette.amber }, pressed && { opacity: 0.85 }]} accessibilityRole="button">
            {busy ? <ActivityIndicator color={palette.navy} /> : <Txt v="bodyStrong" color={palette.navy}>Lock in my guess</Txt>}
          </Pressable>
        </>
      ) : null}
    </Sheet>
  );
});

function StepBtn({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.step, pressed && { backgroundColor: palette.surfaceRaised }]} accessibilityRole="button" accessibilityLabel={`${label} minutes`}>
      <Txt v="smallStrong" color={palette.textSecondary}>{label}</Txt>
    </Pressable>
  );
}
const roundTo5 = (ms: number) => Math.ceil(ms / 300_000) * 300_000;

// ================================================================== Trip ===
export const TripSheet = forwardRef<Ref, { onLeave: () => void; onInvite?: () => void }>(({ onLeave, onInvite }, ref) => {
  const s = useChat((st) => st.session!);
  const purgeAt = useChat((st) => st.purgeAt);
  const [confirm, setConfirm] = useState(false);
  return (
    <Sheet ref={ref} onDismiss={() => setConfirm(false)}>
      {confirm ? (
        <Animated.View entering={FadeIn.duration(160)}>
          <Txt v="h3">Exit this trip chat?</Txt>
          <Txt v="body" color={palette.textSecondary} style={{ marginTop: 6 }}>
            You’ll stop getting messages and stop-timer alerts. You can rejoin with your PNR while the trip is live.
          </Txt>
          <View style={styles.confirmRow}>
            <Pressable onPress={() => setConfirm(false)} style={({ pressed }) => [styles.callBtn, pressed && { opacity: 0.7 }]} accessibilityRole="button">
              <Txt v="bodyStrong">Stay</Txt>
            </Pressable>
            <Pressable onPress={() => { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning); onLeave(); }}
              style={({ pressed }) => [styles.callBtn, { backgroundColor: palette.red, borderColor: palette.red }, pressed && { opacity: 0.85 }]} accessibilityRole="button">
              <Txt v="bodyStrong" color="#fff">Exit chat</Txt>
            </Pressable>
          </View>
        </Animated.View>
      ) : (
        <>
          <Txt v="h3">{s.journey.routeName}</Txt>
          <View style={styles.tripRows}>
            <Row k="Bus" v={`${s.journey.busNumber}, ${s.journey.operatorName}`} />
            <Row k="Departed" v={clock(s.journey.startTime)} />
            <Row k="Expected arrival" v={clock(s.journey.estimatedEndTime)} />
            <Row k="You appear as" v={s.me.name} />
            <Row k="Ticket" v={s.me.pnrMasked} />
            {purgeAt && <Row k="Chat deleted at" v={clock(purgeAt)} />}
          </View>
          <View style={styles.appearance}>
            <Txt v="small" color={palette.textSecondary}>Appearance</Txt>
            <ThemeSwitch />
          </View>
          <View style={styles.actions}>
            {!s.me.guest && onInvite && <Action icon="qr-code-outline" label="Invite with QR (booked on another app)" onPress={onInvite} />}
            <Action icon="exit-outline" label="Exit trip chat" danger onPress={() => setConfirm(true)} />
          </View>
        </>
      )}
    </Sheet>
  );
});

// ============================================================== Location ===
/**
 * Two kinds of location, chosen explicitly every time:
 *  - My location: a one-time snapshot from this phone (needs permission). For
 *    "I'm at the dhaba, where are you?" moments. Never a live trail.
 *  - Bus location: from the bus GPS; uses nothing from the phone.
 */
export const LocationSheet = forwardRef<Ref, { onClose: () => void }>(({ onClose }, ref) => {
  const roomType = useChat((st) => st.activeRoom);
  const sharing = useChat((st) => st.liveShare);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveOpen, setLiveOpen] = useState(false);

  const run = async (key: string, fn: () => Promise<string | null | void>) => {
    setError(null);
    setBusy(key);
    try {
      const failed = await fn();
      if (failed) { setError(failed); return; }
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onClose();
    } catch (e) {
      setError(e instanceof LocationError ? e.message : 'Couldn’t share your location. Try again.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet ref={ref} onDismiss={() => { setError(null); setBusy(null); setLiveOpen(false); }}>
      <Txt v="h3">Share a location</Txt>
      <Txt v="small" color={palette.textSecondary} style={{ marginTop: 4 }}>{`Everyone in ${roomTheme[roomType].name} will see it.`}</Txt>
      <View style={{ gap: 10, marginTop: 16 }}>
        {/* Live location (WhatsApp-style): 10, 15 or 20 minutes only. */}
        <Pressable onPress={() => (sharing ? run('stop', () => stopLiveShare()) : setLiveOpen((o) => !o))} disabled={!!busy}
          style={({ pressed }) => [styles.locOption, (liveOpen || sharing) && { borderColor: palette.roseBorder }, pressed && { backgroundColor: palette.surfaceRaised }]}
          accessibilityRole="button" accessibilityLabel={sharing ? 'Stop sharing live location' : 'Share live location'}>
          <View style={[styles.locIcon, { backgroundColor: palette.roseSoft }]}>
            {busy === 'stop' ? <ActivityIndicator color={palette.rose} /> : <MaterialCommunityIcons name="map-marker-radius" size={22} color={palette.rose} />}
          </View>
          <View style={{ flex: 1 }}>
            <Txt v="bodyStrong">{sharing ? 'Stop sharing live location' : 'Share live location'}</Txt>
            <Txt v="meta" color={palette.textSecondary}>{sharing ? 'You’re sharing right now' : 'Updates as you move, while the app is open'}</Txt>
          </View>
          {!sharing && <Ionicons name={liveOpen ? 'chevron-up' : 'chevron-down'} size={18} color={palette.textTertiary} />}
        </Pressable>
        {liveOpen && !sharing && (
          <Animated.View entering={FadeIn.duration(150)} style={styles.liveChoices}>
            {LIVE_LOCATION_MINUTES.map((min) => (
              <Pressable key={min} onPress={() => run(`live-${min}`, () => startLiveShare(roomType, min))} disabled={!!busy}
                style={({ pressed }) => [styles.liveChip, pressed && { opacity: 0.7 }]} accessibilityRole="button" accessibilityLabel={`Share live location for ${min} minutes`}>
                {busy === `live-${min}` ? <ActivityIndicator color={palette.rose} /> : (<>
                  <Txt v="title" style={{ fontVariant: ['tabular-nums'] }}>{min}</Txt>
                  <Txt v="micro" color={palette.textSecondary}>minutes</Txt>
                </>)}
              </Pressable>
            ))}
          </Animated.View>
        )}

        <Pressable onPress={() => run('once', async () => { chatSocket.shareMyLocation(roomType, await currentCoords()); })} disabled={!!busy}
          style={({ pressed }) => [styles.locOption, pressed && { backgroundColor: palette.surfaceRaised }]} accessibilityRole="button" accessibilityLabel="Send my current location">
          <View style={[styles.locIcon, { backgroundColor: palette.cyanSoft }]}>
            {busy === 'once' ? <ActivityIndicator color={palette.cyan} /> : <Ionicons name="locate" size={22} color={palette.cyan} />}
          </View>
          <View style={{ flex: 1 }}>
            <Txt v="bodyStrong">Send current location</Txt>
            <Txt v="meta" color={palette.textSecondary}>Where you are right now, sent once</Txt>
          </View>
        </Pressable>

        <Pressable onPress={() => run('bus', async () => { chatSocket.shareBusLocation(roomType); })} disabled={!!busy}
          style={({ pressed }) => [styles.locOption, pressed && { backgroundColor: palette.surfaceRaised }]} accessibilityRole="button" accessibilityLabel="Share where the bus is">
          <View style={[styles.locIcon, { backgroundColor: palette.surfaceRaised }]}>
            <MaterialCommunityIcons name="bus-marker" size={22} color={palette.textSecondary} />
          </View>
          <View style={{ flex: 1 }}>
            <Txt v="bodyStrong">Where the bus is</Txt>
            <Txt v="meta" color={palette.textSecondary}>From the bus GPS. Doesn’t use your phone’s location.</Txt>
          </View>
        </Pressable>
      </View>
      {error && (
        <View style={styles.locError} accessibilityLiveRegion="assertive">
          <Ionicons name="alert-circle-outline" size={16} color={palette.amber} />
          <Txt v="small" style={{ flex: 1 }}>{error}</Txt>
        </View>
      )}
    </Sheet>
  );
});

// ============================================================== QR invite ===
/**
 * Show this to someone on the bus who booked elsewhere (e.g. RedBus). Minted
 * only for PNR-verified passengers who are with the bus; the scanner must be
 * near both the bus and this phone. Expires when the trip chat ends.
 */
export const QrInviteSheet = forwardRef<Ref>((_, ref) => {
  const insets = useSafeAreaInsets();
  const [invite, setInvite] = useState<QrInvite | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const link = invite?.link ?? '';

  const create = async () => {
    setError(null);
    setBusy(true);
    try {
      const coords = await currentCoords();
      const ack = await chatSocket.createQrInvite(coords);
      if (ack.ok) setInvite(ack.data); else setError(ack.message);
    } catch (e) {
      setError(e instanceof LocationError ? e.message : 'Couldn’t create the QR. Try again.');
    } finally { setBusy(false); }
  };

  return (
    <Sheet ref={ref} scrollable onDismiss={() => { setError(null); }}>
      <BottomSheetScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 20 }}>
        <Txt v="h3">Invite with QR</Txt>
        <Txt v="small" color={palette.textSecondary} style={{ marginTop: 4 }}>
          For someone on this bus who booked on another app. They point their phone camera at it — no app or link needed.
        </Txt>
        {invite ? (
          <Animated.View entering={FadeIn} style={{ alignItems: 'center', marginTop: 18 }}>
            <View style={styles.qrBox}><QRCode value={link} size={220} backgroundColor="#FFFFFF" color="#0B132B" /></View>
            <View style={styles.scanHint}>
              <Ionicons name="camera-outline" size={18} color={palette.text} />
              <Txt v="bodyStrong">Ask them to scan this with their camera</Txt>
            </View>
            <Txt v="meta" color={palette.textSecondary} style={{ marginTop: 4 }}>{`Works until this chat ends · ${clock(invite.expiresAt)}`}</Txt>
            {invite.check.skipped && (
              <Txt v="micro" color={palette.amber} style={{ marginTop: 4, textAlign: 'center' }}>
                {`Demo: location check skipped${invite.check.providerKm != null ? ` (you’re ${invite.check.providerKm} km from the bus)` : ''}`}
              </Txt>
            )}
          </Animated.View>
        ) : (
          <Pressable onPress={create} disabled={busy} style={({ pressed }) => [styles.primary, { marginTop: 18, backgroundColor: palette.cyan }, pressed && { opacity: 0.85 }]} accessibilityRole="button">
            {busy ? <ActivityIndicator color={palette.navy} /> : <Txt v="bodyStrong" color={palette.navy}>Check my location & show QR</Txt>}
          </Pressable>
        )}
        {error && (
          <View style={styles.locError} accessibilityLiveRegion="assertive">
            <Ionicons name="alert-circle-outline" size={16} color={palette.amber} />
            <Txt v="small" style={{ flex: 1 }}>{error}</Txt>
          </View>
        )}
        <View style={styles.qrRules}>
          {[
            'They must be with the bus — their location is checked against the bus and your phone',
            'Guests are marked “Joined via QR” and can’t enter the women-only room',
            'This QR works only for this bus and stops when the chat ends',
          ].map((t) => (
            <View key={t} style={{ flexDirection: 'row', gap: 8 }}>
              <Ionicons name="checkmark-circle-outline" size={16} color={palette.textSecondary} />
              <Txt v="small" color={palette.textSecondary} style={{ flex: 1 }}>{t}</Txt>
            </View>
          ))}
        </View>
      </BottomSheetScrollView>
    </Sheet>
  );
});

function Row({ k, v }: { k: string; v: string }) {
  return (
    <View style={styles.tripRow}>
      <Txt v="small" color={palette.textSecondary}>{k}</Txt>
      <Txt v="smallStrong" style={{ flexShrink: 1, textAlign: 'right' }}>{v}</Txt>
    </View>
  );
}

const styles = themed(() => ({
  reactRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8 },
  reactBtn: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.surfaceSunk },
  reactBtnOn: { backgroundColor: palette.surfaceRaised, borderWidth: 1, borderColor: palette.hairlineStrong },
  reactSummary: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 10, marginBottom: 4 },
  actions: { marginTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.hairline, paddingTop: 6 },
  action: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, paddingHorizontal: 6, borderRadius: 12 },
  holdBtn: { marginTop: 10, height: 60, borderRadius: radius.pill, backgroundColor: palette.sosHold, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  holdFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: palette.red, transformOrigin: 'left' },
  sosIconOk: { width: 52, height: 52, borderRadius: 16, backgroundColor: palette.greenSoft, alignItems: 'center', justifyContent: 'center' },
  callBtn: { flex: 1, flexDirection: 'row', gap: 8, height: 46, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: palette.hairlineStrong },
  callLabel: { marginTop: 18, marginBottom: 8, letterSpacing: 1 },
  callGrid: { flexDirection: 'row', gap: 8 },
  callTile: { flex: 1, alignItems: 'center', gap: 2, paddingVertical: 12, borderRadius: radius.card, borderWidth: 1, backgroundColor: palette.redSoft },
  shareBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 32, paddingHorizontal: 12, borderRadius: radius.pill, backgroundColor: palette.surfaceSunk },
  picker: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginVertical: 20 },
  step: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: palette.hairlineStrong },
  primary: { height: 52, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  result: { marginTop: 18, padding: 18, alignItems: 'center', gap: 6, borderRadius: radius.card, backgroundColor: palette.surfaceSunk, borderWidth: 1, borderColor: palette.hairline },
  tripRows: { marginTop: 14, gap: 12 },
  quote: { marginTop: 10, padding: 10, borderRadius: radius.chip, backgroundColor: palette.surfaceSunk, borderLeftWidth: 3, borderLeftColor: palette.redBorder },
  tripRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 16 },
  appearance: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 18 },
  confirmRow: { flexDirection: 'row', gap: 10, marginTop: 20 },
  genderRow: { flexDirection: 'row', gap: 8, marginTop: 14, flexWrap: 'wrap' },
  countPill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, height: 36, borderRadius: radius.pill, backgroundColor: palette.surfaceSunk, borderWidth: 1, borderColor: palette.hairline },
  personRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: palette.hairline },
  voterChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingRight: 10, paddingLeft: 3, height: 28, borderRadius: radius.pill, backgroundColor: palette.surfaceSunk },
  locOption: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: radius.card, backgroundColor: palette.surfaceSunk, borderWidth: 1, borderColor: palette.hairline },
  locIcon: { width: 42, height: 42, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  locError: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, padding: 12, borderRadius: radius.chip, backgroundColor: palette.amberSoft },
  liveChoices: { flexDirection: 'row', gap: 8, marginTop: -2 },
  liveChip: { flex: 1, height: 64, borderRadius: radius.card, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.roseSoft, borderWidth: 1, borderColor: palette.roseBorder },
  scanHint: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14 },
  qrBox: { padding: 14, borderRadius: radius.card, backgroundColor: '#FFFFFF' },
  qrRules: { marginTop: 20, gap: 10, padding: 14, borderRadius: radius.card, backgroundColor: palette.surfaceSunk },
  gameTag: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: palette.surfaceRaised },
  pollLabel: { marginTop: 18, marginBottom: 6, letterSpacing: 1 },
  pollInput: {
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : null),
    minHeight: 46, paddingHorizontal: 14, paddingVertical: 12, borderRadius: radius.chip, backgroundColor: palette.surfaceSunk,
    borderWidth: 1, borderColor: palette.hairline, color: palette.text, fontFamily: font.body, fontSize: 15,
  },
  pollQuestion: { fontFamily: font.bodySemi, maxHeight: 110 },
  pollOptRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pollMulti: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 18, paddingVertical: 4 },
  switchTrack: { width: 44, height: 26, borderRadius: 13, padding: 3, backgroundColor: palette.surfaceRaised },
  switchKnob: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#FFFFFF' },
  voteGroup: { gap: 8, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: palette.hairline },
  voteHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  voteSeats: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
}));

// ================================================================= Polls ===
/**
 * Create a poll, WhatsApp-style: a question, 2–12 options (a fresh empty
 * option appears as soon as the last one is filled), and "Allow multiple answers".
 */
export const PollCreateSheet = forwardRef<Ref, { onClose: () => void }>(({ onClose }, ref) => {
  const roomType = useChat((st) => st.activeRoom);
  const insets = useSafeAreaInsets();
  const accent = roomTheme[roomType].accent;
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [multi, setMulti] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setQuestion(''); setOptions(['', '']); setMulti(false); setError(null); };
  const filled = options.map((o) => o.trim()).filter(Boolean);
  const dupes = new Set(filled.map((o) => o.toLowerCase())).size !== filled.length;
  const valid = question.trim().length > 0 && filled.length >= POLL_LIMITS.minOptions && !dupes;

  const setOption = (i: number, v: string) => setOptions((cur) => {
    const next = cur.map((o, j) => (j === i ? v : o));
    // Keep exactly one empty slot at the end (until the limit), like WhatsApp.
    if (i === next.length - 1 && v.trim() && next.length < POLL_LIMITS.maxOptions) next.push('');
    return next;
  });
  const removeOption = (i: number) => setOptions((cur) => (cur.length <= 2 ? cur : cur.filter((_, j) => j !== i)));

  const send = () => {
    if (!valid) return;
    const res = chatSocket.createPoll(roomType, { question: question.trim(), options: filled, multi });
    if (!res.ok) { setError(res.reason); Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error); return; }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    reset();
    onClose();
  };

  return (
    <Sheet ref={ref} scrollable onDismiss={reset}>
      <BottomSheetScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 20 }}>
        <Txt v="h3">Create poll</Txt>
        <Txt v="small" color={palette.textSecondary} style={{ marginTop: 4 }}>{`Everyone in ${roomTheme[roomType].name} can vote. Votes show names, like WhatsApp.`}</Txt>

        <Txt v="micro" color={palette.textTertiary} style={styles.pollLabel}>QUESTION</Txt>
        <SheetInput value={question} onChangeText={(v) => { setQuestion(v); setError(null); }} placeholder="Ask a question" placeholderTextColor={palette.placeholder}
          maxLength={POLL_LIMITS.questionMax} multiline style={[styles.pollInput, styles.pollQuestion]} selectionColor={accent} accessibilityLabel="Poll question" />

        <Txt v="micro" color={palette.textTertiary} style={styles.pollLabel}>OPTIONS</Txt>
        <View style={{ gap: 8 }}>
          {options.map((o, i) => (
            <View key={i} style={styles.pollOptRow}>
              <SheetInput value={o} onChangeText={(v) => { setOption(i, v); setError(null); }} placeholder={`Option ${i + 1}`} placeholderTextColor={palette.placeholder}
                maxLength={POLL_LIMITS.optionMax} style={[styles.pollInput, { flex: 1 }]} selectionColor={accent} accessibilityLabel={`Option ${i + 1}`} />
              {options.length > 2 && !!o && (
                <Pressable onPress={() => removeOption(i)} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Remove option ${i + 1}`}>
                  <Ionicons name="close-circle" size={20} color={palette.textTertiary} />
                </Pressable>
              )}
            </View>
          ))}
        </View>

        <Pressable onPress={() => { Haptics.selectionAsync(); setMulti((m) => !m); }} style={styles.pollMulti} accessibilityRole="switch" accessibilityState={{ checked: multi }}>
          <View style={{ flex: 1 }}>
            <Txt v="bodyStrong">Allow multiple answers</Txt>
            <Txt v="meta" color={palette.textSecondary}>People can pick more than one option</Txt>
          </View>
          <View style={[styles.switchTrack, multi && { backgroundColor: accent }]}>
            <View style={[styles.switchKnob, multi && { transform: [{ translateX: 18 }] }]} />
          </View>
        </Pressable>

        {(error || dupes) && (
          <View style={styles.locError} accessibilityLiveRegion="assertive">
            <Ionicons name="alert-circle-outline" size={16} color={palette.amber} />
            <Txt v="small" style={{ flex: 1 }}>{error ?? 'Two options are the same.'}</Txt>
          </View>
        )}

        <Pressable onPress={send} disabled={!valid} style={({ pressed }) => [styles.primary, { marginTop: 18, backgroundColor: valid ? accent : palette.surfaceRaised }, pressed && { opacity: 0.85 }]}
          accessibilityRole="button" accessibilityState={{ disabled: !valid }}>
          <Txt v="bodyStrong" color={valid ? roomTheme[roomType].onAccent : palette.textTertiary}>Send poll</Txt>
        </Pressable>
      </BottomSheetScrollView>
    </Sheet>
  );
});

/** Who voted for what. Live: re-reads the message from the store. */
export const PollVotesSheet = forwardRef<Ref, { message: UiMessage | null }>(({ message }, ref) => {
  const live = useChat((st) => (message ? st.rooms[message.roomType].messages.find((m) => m.id === message.id) ?? message : null));
  const insets = useSafeAreaInsets();
  const poll = live?.contentType === 'POLL' ? (live.payload as PollPayload) : null;
  const votes = poll ? pollVotes(live!.reactions, poll.options.length) : [];
  return (
    <Sheet ref={ref} scrollable>
      <BottomSheetScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 20, gap: 14 }}>
        <View>
          <Txt v="h3">Poll results</Txt>
          {poll && <Txt v="body" color={palette.textSecondary} style={{ marginTop: 4 }}>{poll.question}</Txt>}
        </View>
        {poll?.options.map((opt, i) => (
          <View key={i} style={styles.voteGroup}>
            <View style={styles.voteHead}>
              <Txt v="bodyStrong" style={{ flex: 1 }}>{opt}</Txt>
              <Txt v="smallStrong" color={palette.textSecondary}>{`${votes[i].length} vote${votes[i].length === 1 ? '' : 's'}`}</Txt>
            </View>
            {votes[i].length > 0 ? (
              <View style={styles.voteSeats}>{votes[i].map((seat) => {
                const p = personFrom(useChat.getState(), seat);
                return <View key={seat} style={styles.voterChip}><Avatar name={p.name} avatar={p.avatar} size={22} /><Txt v="smallStrong">{p.name}</Txt></View>;
              })}</View>
            ) : <Txt v="meta" color={palette.textTertiary}>No votes</Txt>}
          </View>
        ))}
      </BottomSheetScrollView>
    </Sheet>
  );
});

// ================================================================= Games ===
/**
 * Game picker. Quiz / movie rounds are one-at-a-time per room (the server
 * enforces it too), so a running round shows as "Live now" instead of a second start.
 */
export const GamesSheet = forwardRef<Ref, { onClose: () => void; onOpenArrivalGame: () => void }>(({ onClose, onOpenArrivalGame }, ref) => {
  const roomType = useChat((st) => st.activeRoom);
  const messages = useChat((st) => st.rooms[st.activeRoom].messages);
  const eta = useChat((st) => st.game);
  const now = useServerNow(5000);
  const insets = useSafeAreaInsets();
  const live = messages.some((m) => m.contentType === 'GAME' && m.status === 'sent' && (
    (m.payload.kind === 'QUIZ' && m.payload.correct == null && now < Date.parse(m.payload.revealAt)) ||
    (m.payload.kind === 'EMOJI' && !m.payload.solvedBy && now < Date.parse(m.payload.expiresAt))));

  const start = (kind: GameKind) => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); chatSocket.startGame(roomType, kind); onClose(); };
  const games: { key: string; emoji: string; title: string; desc: string; tag: string; onPress?: () => void; disabled?: boolean }[] = [
    { key: 'QUIZ', emoji: '🧠', title: 'Bus Quiz', desc: 'One question for everyone. 25 seconds. Fastest right answer wins.', tag: live ? 'A round is live' : 'Everyone', onPress: () => start('QUIZ'), disabled: live },
    { key: 'EMOJI', emoji: '🎬', title: 'Guess the Movie', desc: 'A Bollywood film in emojis. Type your guess in the chat.', tag: live ? 'A round is live' : 'Everyone', onPress: () => start('EMOJI'), disabled: live },
    { key: 'TTT', emoji: '❌⭕', title: 'Tic-tac-toe', desc: 'Challenge the bus. First to accept plays you, others watch.', tag: '1 vs 1', onPress: () => start('TTT') },
  ];
  if (eta) games.push({
    key: 'ETA', emoji: '🏁', title: 'Arrival game', tag: `Win ${eta.rewardPoints} pts`,
    desc: `Guess when we reach ${eta.checkpointName}. Closest guess wins AbhiBus points.`,
    onPress: () => { onClose(); onOpenArrivalGame(); },
  });

  return (
    <Sheet ref={ref} scrollable>
      <BottomSheetScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 20, gap: 10 }}>
        <View style={{ marginBottom: 6 }}>
          <Txt v="h3">Play with the bus</Txt>
          <Txt v="small" color={palette.textSecondary} style={{ marginTop: 4 }}>{`Games start in ${roomTheme[roomType].name}. Quick, quiet and first-names only.`}</Txt>
        </View>
        {games.map((g) => (
          <Pressable key={g.key} onPress={g.onPress} disabled={g.disabled}
            style={({ pressed }) => [styles.locOption, g.disabled && { opacity: 0.5 }, pressed && { backgroundColor: palette.surfaceRaised }]}
            accessibilityRole="button" accessibilityState={{ disabled: !!g.disabled }} accessibilityLabel={`${g.title}. ${g.desc}`}>
            <View style={[styles.locIcon, { backgroundColor: palette.surfaceRaised }]}><Txt style={{ fontSize: 22, lineHeight: 28 }}>{g.emoji}</Txt></View>
            <View style={{ flex: 1, gap: 2 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Txt v="bodyStrong">{g.title}</Txt>
                <View style={styles.gameTag}><Txt v="micro" color={palette.textSecondary}>{g.tag}</Txt></View>
              </View>
              <Txt v="meta" color={palette.textSecondary}>{g.desc}</Txt>
            </View>
            <Ionicons name="chevron-forward" size={18} color={palette.textTertiary} />
          </Pressable>
        ))}
      </BottomSheetScrollView>
    </Sheet>
  );
});
