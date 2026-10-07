import React, { forwardRef, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { BottomSheetScrollView, BottomSheetTextInput, type BottomSheetModal } from '@gorhom/bottom-sheet';
import Animated, { Easing, FadeIn, useAnimatedStyle, useSharedValue, withSpring, withTiming, runOnJS, ZoomIn } from 'react-native-reanimated';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { currentCoords, LocationError } from '../services/location';
import { startLiveShare, stopLiveShare } from '../services/liveLocation';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Sheet } from './Sheet';
import { ThemeSwitch } from './ThemeSwitch';
import { Txt } from './Txt';
import { Avatar } from './Avatar';
import { personFrom, usePeople } from '../hooks/usePeople';
import { toast } from './Toast';
import { useChat, type UiMessage } from '../store/chatStore';
import { chatSocket } from '../services/socket';
import { tenantName, useTenant, useUnit, useVertical } from '../tenant';
import { notifyHost } from '../services/host';
import { berthLabel, berthOf } from '../utils/seat';
import { clock, when } from '../utils/format';
import { useServerNow } from '../hooks/useNow';
import { font, motion, palette, radius, roomTheme, themed } from '../theme/tokens';
import { type GameKind, LIVE_LOCATION_MINUTES, isSystemReactionKey, POLL_LIMITS, REACTIONS, REPORT_REASONS, pollVotes, type PollPayload, type ReactionEmoji, type ReportReason } from '../shared/protocol';

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
        {member.guest && <Txt v="meta" color={palette.textTertiary} style={{ textAlign: 'center' }}>Joined as a guest.</Txt>}
      </View>
      <View style={styles.actions}>
        <Action icon="flag-outline" label={`Report ${member.name}`} danger onPress={() => onReport(seat, member.name)} />
        <Action icon={isBlocked ? 'person-add-outline' : 'remove-circle-outline'} label={isBlocked ? `Unblock ${member.name}` : `Block ${member.name}`} onPress={block} />
      </View>
      <Txt v="meta" color={palette.textTertiary} style={{ marginTop: 6 }}>{`Blocking hides their messages for you only. Reporting tells the ${tenantName()} safety team and counts toward removing them.`}</Txt>
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
const SOS_REASONS = ['I feel unsafe', 'Medical help', 'Harassment', 'Rash driving', 'Something else'] as const;
export const SosSheet = forwardRef<Ref>((_, ref) => {
  const supportPhone = useChat((s) => s.tenant?.supportPhone ?? s.session!.supportPhone);
  const isWoman = useChat((s) => s.session!.me.gender === 'F');
  const tenant = useTenant();
  const unit = useUnit();
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [reason, setReason] = useState<string>(SOS_REASONS[0]);
  const [withLoc, setWithLoc] = useState(true);
  const fill = useSharedValue(0);
  const fillStyle = useAnimatedStyle(() => ({ transform: [{ scaleX: fill.value }] }));

  const fire = async () => {
    setState('sending');
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    let coords: { lat: number; lng: number; accuracyM: number | null } | undefined;
    if (withLoc) { try { coords = await Promise.race([currentCoords(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('slow')), 6000))]); } catch { coords = undefined; } }
    const a = await chatSocket.sos(reason, coords);
    setState(a.ok ? 'sent' : 'error');
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
          <Txt v="h3">{`${tenant?.name ?? 'Ops'} safety team alerted`}</Txt>
          <Txt v="body" color={palette.textSecondary}>
            {`They have your booking, the ${unit.noun}’s position${withLoc ? ' and your location' : ''}. Someone will call you shortly. Their replies appear here, only to you.`}
          </Txt>
          <Txt v="small" color={palette.textTertiary}>{`Other travellers and the crew have not been notified.`}</Txt>
        </Animated.View>
      ) : (
        <View style={{ gap: 10 }}>
          <Txt v="h3">Need help right now?</Txt>
          <Txt v="body" color={palette.textSecondary}>
            {`Hold the button to quietly alert the ${tenant?.name ?? ''} safety team. Nobody in the room is notified.`}
          </Txt>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {SOS_REASONS.map((r) => (
              <Pressable key={r} onPress={() => { Haptics.selectionAsync(); setReason(r); }} style={[styles.reasonChip, reason === r && { borderColor: palette.red, backgroundColor: palette.redSoft }]} accessibilityRole="radio" accessibilityState={{ selected: reason === r }}>
                <Txt v="smallStrong" color={reason === r ? palette.red : palette.textSecondary}>{r}</Txt>
              </Pressable>
            ))}
          </View>
          <Pressable onPress={() => setWithLoc((x) => !x)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }} accessibilityRole="checkbox" accessibilityState={{ checked: withLoc }}>
            <Ionicons name={withLoc ? 'checkbox' : 'square-outline'} size={20} color={withLoc ? palette.red : palette.textTertiary} />
            <Txt v="small" color={palette.textSecondary}>Send my exact location too</Txt>
          </Pressable>
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
        <Pressable onPress={() => Linking.openURL(`tel:${supportPhone.replace(/\s/g, '')}`)} style={[styles.callBtn, { marginTop: 10, flex: 0 }]} accessibilityRole="button">
          <Ionicons name="headset-outline" size={16} color={palette.text} />
          <Txt v="smallStrong">{`Call ${tenant?.name ?? ''} support`}</Txt>
        </Pressable>
      )}
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
          {game.status === 'OPEN' ? `Closest guess wins ${game.rewardPoints} points. Guesses close at ${clock(game.closesAt)}. ${game.guessCount} passengers have guessed.`
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
          {won && <Txt v="meta" color={palette.textTertiary}>Points are added to your wallet within 24 hours.</Txt>}
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
export const TripSheet = forwardRef<Ref, { onLeave: () => void }>(({ onLeave }, ref) => {
  const s = useChat((st) => st.session!);
  const tenant = useTenant();
  const vertical = useVertical();
  const loc = useChat((st) => st.location);
  const purgeAt = useChat((st) => st.purgeAt);
  const [confirm, setConfirm] = useState(false);
  const j = s.journey;
  const meta = j.meta ?? {};
  return (
    <Sheet ref={ref} onDismiss={() => setConfirm(false)}>
      {confirm ? (
        <Animated.View entering={FadeIn.duration(160)}>
          <Txt v="h3">Leave this trip chat?</Txt>
          <Txt v="body" color={palette.textSecondary} style={{ marginTop: 6 }}>
            {`You’ll go back to ${tenant?.name ?? 'the app'}. Alerts still reach you by push and SMS, and you can open the chat again from your trip.`}
          </Txt>
          <View style={styles.confirmRow}>
            <Pressable onPress={() => setConfirm(false)} style={({ pressed }) => [styles.callBtn, pressed && { opacity: 0.7 }]} accessibilityRole="button">
              <Txt v="bodyStrong">Stay</Txt>
            </Pressable>
            <Pressable onPress={() => { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning); onLeave(); }}
              style={({ pressed }) => [styles.callBtn, { backgroundColor: palette.red, borderColor: palette.red }, pressed && { opacity: 0.85 }]} accessibilityRole="button">
              <Txt v="bodyStrong" color="#fff">Leave chat</Txt>
            </Pressable>
          </View>
        </Animated.View>
      ) : (
        <>
          <Txt v="h3">{j.routeName}</Txt>
          {!!j.subtitle && <Txt v="small" color={palette.textSecondary} style={{ marginTop: 2 }}>{j.subtitle}</Txt>}
          <View style={styles.tripRows}>
            {vertical === 'bus' && !!j.busNumber && <Row k="Bus" v={j.busNumber} />}
            {vertical === 'train' && !!meta.platform && <Row k="Platform" v={meta.platform} />}
            {vertical === 'train' && !!meta.coach && <Row k="Coach position" v={meta.coach} />}
            {vertical === 'flight' && !!meta.gate && <Row k="Gate" v={`${meta.gate}${meta.terminal ? ` · ${meta.terminal}` : ''}`} />}
            {vertical === 'flight' && !!meta.belt && <Row k="Baggage belt" v={meta.belt} />}
            <Row k={vertical === 'flight' ? 'Departs' : 'Departed'} v={clock(j.startTime)} />
            <Row k="Expected arrival" v={`${clock(j.estimatedEndTime)}${j.delayMin ? ` (${j.delayMin} min late)` : ''}`} />
            {loc && <Row k="Position" v={`${loc.near} · ${loc.source}`} />}
            <Row k="You appear as" v={s.me.name} />
            <Row k="Booking" v={s.me.pnrMasked} />
            {purgeAt && <Row k="Chat deleted" v={when(purgeAt)} />}
          </View>
          <View style={styles.appearance}>
            <Txt v="small" color={palette.textSecondary}>Appearance</Txt>
            <ThemeSwitch />
          </View>
          <View style={styles.actions}>
            <Action icon="exit-outline" label="Leave trip chat" danger onPress={() => setConfirm(true)} />
          </View>
          <Txt v="micro" color={palette.textTertiary} style={{ marginTop: 6, textAlign: 'center' }}>{`Trip Rooms for ${tenant?.name ?? ''}`}</Txt>
        </>
      )}
    </Sheet>
  );
});

// ======================================================= Traveller actions ===
/** Report a group issue (AC, charging…). One card per issue; others tap "Me too"; Ops is alerted at the threshold. */
export const IssueSheet = forwardRef<Ref, { onClose: () => void }>(({ onClose }, ref) => {
  const roomType = useChat((st) => st.activeRoom);
  const issues = useChat((st) => st.tenant?.issues ?? []);
  const [busy, setBusy] = useState<string | null>(null);
  const pick = async (label: string) => {
    setBusy(label); Haptics.selectionAsync();
    const a = await chatSocket.reportIssue(roomType, label);
    setBusy(null);
    if (a.ok) { onClose(); toast('Reported. Others can tap “Me too”.', 'success'); } else toast(a.message, 'danger');
  };
  return (
    <Sheet ref={ref}>
      <Txt v="h3">Something not working?</Txt>
      <Txt v="small" color={palette.textSecondary} style={{ marginTop: 4, marginBottom: 10 }}>{`Pick one. If enough travellers report the same thing, ${tenantName()} Ops is alerted automatically.`}</Txt>
      <View style={{ gap: 6 }}>
        {issues.map((l) => (
          <Pressable key={l} onPress={() => pick(l)} disabled={!!busy} style={({ pressed }) => [styles.locOption, pressed && { backgroundColor: palette.surfaceRaised }]} accessibilityRole="button">
            <Txt v="bodyStrong" style={{ flex: 1 }}>{l}</Txt>
            {busy === l ? <ActivityIndicator color={palette.textSecondary} /> : <Ionicons name="chevron-forward" size={18} color={palette.textTertiary} />}
          </Pressable>
        ))}
      </View>
    </Sheet>
  );
});

/** Running late to boarding: a private request to Ops (never posted in the room). */
export const WaitSheet = forwardRef<Ref, { onClose: () => void }>(({ onClose }, ref) => {
  const [busy, setBusy] = useState(false);
  const send = async (minutes: number) => {
    setBusy(true); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const a = await chatSocket.waitForMe(minutes);
    setBusy(false);
    if (a.ok) { onClose(); toast('Sent to Ops. Their reply shows up here, only for you.', 'success'); } else toast(a.message, 'danger');
  };
  return (
    <Sheet ref={ref}>
      <Txt v="h3">Running late?</Txt>
      <Txt v="small" color={palette.textSecondary} style={{ marginTop: 4, marginBottom: 12 }}>We’ll ask the crew to wait if they can. Only Ops sees this request.</Txt>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {[5, 10, 15].map((n) => (
          <Pressable key={n} onPress={() => send(n)} disabled={busy} style={({ pressed }) => [styles.callTile, { flex: 1, borderColor: palette.hairlineStrong }, pressed && { opacity: 0.7 }]} accessibilityRole="button" accessibilityLabel={`${n} minutes late`}>
            <Txt v="title">{`${n} min`}</Txt>
            <Txt v="micro" color={palette.textSecondary}>late</Txt>
          </Pressable>
        ))}
      </View>
    </Sheet>
  );
});

/** Lost & found: posted in the room (numbers masked) and copied to Ops. */
export const LostSheet = forwardRef<Ref, { onClose: () => void }>(({ onClose }, ref) => {
  const roomType = useChat((st) => st.activeRoom);
  const unit = useUnit();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const post = async () => {
    if (!text.trim()) return;
    setBusy(true);
    const a = await chatSocket.lostFound(roomType, text.trim());
    setBusy(false);
    if (a.ok) { setText(''); onClose(); toast('Posted. Ops has a copy too.', 'success'); } else toast(a.message, 'danger');
  };
  return (
    <Sheet ref={ref}>
      <Txt v="h3">Lost or found something?</Txt>
      <Txt v="small" color={palette.textSecondary} style={{ marginTop: 4, marginBottom: 10 }}>{`Describe it and where it was. Everyone on the ${unit.noun} sees it; phone numbers are hidden automatically.`}</Txt>
      <SheetInput value={text} onChangeText={setText} maxLength={300} multiline placeholder="e.g. Black backpack near seat row 6" placeholderTextColor={palette.textTertiary} style={styles.sheetInput} />
      <Pressable onPress={post} disabled={busy || !text.trim()} style={({ pressed }) => [styles.primaryBtn, (!text.trim() || busy) && { opacity: 0.5 }, pressed && { opacity: 0.85 }]} accessibilityRole="button">
        {busy ? <ActivityIndicator color={palette.navyDeep} /> : <Txt v="bodyStrong" color={palette.navyDeep}>Post</Txt>}
      </Pressable>
    </Sheet>
  );
});

/** Ask Tara privately (also: "@Tara …" in the chat answers in public). */
export const TaraSheet = forwardRef<Ref, { onClose: () => void }>(({ onClose }, ref) => {
  const roomType = useChat((st) => st.activeRoom);
  const asks = useChat((st) => st.tenant?.quickAsks ?? []);
  const [q, setQ] = useState('');
  const ask = async (question: string) => {
    if (!question.trim()) return;
    Haptics.selectionAsync();
    const a = await chatSocket.askTara(roomType, question.trim());
    if (a.ok) { setQ(''); onClose(); } else toast(a.message, 'danger');
  };
  return (
    <Sheet ref={ref}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><Txt style={{ fontSize: 20 }}>✨</Txt><Txt v="h3">Ask Tara</Txt></View>
      <Txt v="small" color={palette.textSecondary} style={{ marginTop: 4, marginBottom: 10 }}>Your trip assistant. Answers from live trip data, only you see them.</Txt>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
        {asks.map((x) => (
          <Pressable key={x} onPress={() => ask(x)} style={({ pressed }) => [styles.reasonChip, pressed && { opacity: 0.7 }]} accessibilityRole="button"><Txt v="smallStrong" color={palette.text}>{x}</Txt></Pressable>
        ))}
      </View>
      <SheetInput value={q} onChangeText={setQ} maxLength={300} placeholder="Or type a question" placeholderTextColor={palette.textTertiary} style={styles.sheetInput} onSubmitEditing={() => ask(q)} returnKeyType="send" />
      <Pressable onPress={() => ask(q)} disabled={!q.trim()} style={({ pressed }) => [styles.primaryBtn, !q.trim() && { opacity: 0.5 }, pressed && { opacity: 0.85 }]} accessibilityRole="button">
        <Txt v="bodyStrong" color={palette.navyDeep}>Ask</Txt>
      </Pressable>
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
          style={({ pressed }) => [styles.locOption, pressed && { backgroundColor: palette.surfaceRaised }]} accessibilityRole="button" accessibilityLabel="Share where the vehicle is">
          <View style={[styles.locIcon, { backgroundColor: palette.surfaceRaised }]}>
            <MaterialCommunityIcons name={vehicleIcon()} size={22} color={palette.textSecondary} />
          </View>
          <View style={{ flex: 1 }}>
            <Txt v="bodyStrong">{`Where the ${vehicleNoun()} is`}</Txt>
            <Txt v="meta" color={palette.textSecondary}>{`Best known position (${useChat.getState().location?.source ?? 'live feed'}). Doesn’t use your phone’s location.`}</Txt>
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
function Row({ k, v }: { k: string; v: string }) {
  return (
    <View style={styles.tripRow}>
      <Txt v="small" color={palette.textSecondary}>{k}</Txt>
      <Txt v="smallStrong" style={{ flexShrink: 1, textAlign: 'right' }}>{v}</Txt>
    </View>
  );
}

const vehicleNoun = () => ({ bus: 'bus', train: 'train', flight: 'flight', custom: 'vehicle' } as Record<string, string>)[useChat.getState().session?.journey.vertical ?? 'bus'];
const vehicleIcon = () => ({ bus: 'bus-marker', train: 'train', flight: 'airplane-marker', custom: 'map-marker' } as Record<string, any>)[useChat.getState().session?.journey.vertical ?? 'bus'];
const unitNoun = () => ({ bus: 'bus', train: 'coach', flight: 'gate', custom: 'trip' } as Record<string, string>)[useChat.getState().session?.journey.vertical ?? 'bus'];
const styles = themed(() => ({
  reasonChip: { paddingHorizontal: 12, height: 32, borderRadius: radius.pill, borderWidth: 1, borderColor: palette.hairlineStrong, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.surfaceSunk },
  sheetInput: { ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : null), minHeight: 46, maxHeight: 120, paddingHorizontal: 14, paddingVertical: 12, borderRadius: radius.chip, borderWidth: 1, borderColor: palette.hairlineStrong, color: palette.text, fontFamily: font.body, fontSize: 15, backgroundColor: palette.surfaceSunk },
  primaryBtn: { marginTop: 12, height: 48, borderRadius: radius.pill, backgroundColor: palette.cyan, alignItems: 'center', justifyContent: 'center' },
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
    { key: 'QUIZ', emoji: '🧠', title: 'Trip Quiz', desc: 'One question for everyone. 25 seconds. Fastest right answer wins.', tag: live ? 'A round is live' : 'Everyone', onPress: () => start('QUIZ'), disabled: live },
    { key: 'EMOJI', emoji: '🎬', title: 'Guess the Movie', desc: 'A Bollywood film in emojis. Type your guess in the chat.', tag: live ? 'A round is live' : 'Everyone', onPress: () => start('EMOJI'), disabled: live },
    { key: 'TTT', emoji: '❌⭕', title: 'Tic-tac-toe', desc: 'Challenge the room. First to accept plays you, others watch.', tag: '1 vs 1', onPress: () => start('TTT') },
  ];

  return (
    <Sheet ref={ref} scrollable>
      <BottomSheetScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 20, gap: 10 }}>
        <View style={{ marginBottom: 6 }}>
          <Txt v="h3">{`Play with the ${unitNoun()}`}</Txt>
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
