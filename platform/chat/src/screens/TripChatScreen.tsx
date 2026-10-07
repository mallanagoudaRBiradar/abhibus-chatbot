import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import Animated, { FadeIn, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import type { BottomSheetModal } from '@gorhom/bottom-sheet';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { TopBar } from '../components/TopBar';
import { RouteStrip } from '../components/RouteStrip';
import { RoomSwitcher } from '../components/RoomSwitcher';
import { PinnedRail } from '../components/PinnedRail';
import { RoomPane } from '../components/RoomPane';
import { MessageMenu, type Rect } from '../components/MessageMenu';
import { Composer } from '../components/Composer';
import { ProfileStep } from '../components/ProfileStep';
import { Txt } from '../components/Txt';
import { ToastHost, toast } from '../components/Toast';
import {
  GamesSheet, IssueSheet, LocationSheet, LostSheet, PassengerSheet, PersonSheet, PollCreateSheet, PollVotesSheet, ReactionsSheet, ReportSheet,
  type ReportTarget, SeenBySheet, SosSheet, TaraSheet, TripSheet, WaitSheet,
} from '../components/sheets';
import { useChat, type UiMessage } from '../store/chatStore';
import { chatSocket } from '../services/socket';
import { notifyHost } from '../services/host';
import { stopLiveShare } from '../services/liveLocation';
import { startCrowdShare, stopCrowdShare } from '../services/crowd';
import { LiveDot } from '../components/LiveDot';
import { useServerNow } from '../hooks/useNow';
import { mmss, when } from '../utils/format';
import { FRAME_MAX, brand, motion, palette, radius, themed } from '../theme/tokens';
import { useFeature, useTenant, useUnit, useVertical } from '../tenant';

/**
 * ============================================================================
 *  TripChatScreen — the hosted Trip Rooms screen every tenant app opens
 * ============================================================================
 *   ┌───────────────────────────────────────────┐
 *   │ ConfirmTkt · Trip chat                     │  BrandBar (host app's colour)
 *   │ ‹ Kacheguda → Yesvantpur  +25 min  ● 14  SOS ⋮ │  TopBar
 *   │ LIVE  between X and Y · Running status      │  RouteStrip (fused position)
 *   │ [ Coach lounge | Women only ]               │  RoomSwitcher (F + feature)
 *   │ Quiet hours · Share location prompt         │  banners
 *   │ ┌ Ops alert / rest-stop countdown ┐         │  PinnedRail (≤1)
 *   ├─────────────────────────────────────────────┤
 *   │  messages + platform cards                  │  RoomPane ×2
 *   ├─────────────────────────────────────────────┤
 *   │ quick asks · [+] [ message… ] [send]        │  Composer
 *   └─────────────────────────────────────────────┘
 *  Gates before the room: not open yet → PreOpen; profile identity and no
 *  name yet → ProfileGate; closed / removed / expired → ClosedState.
 * ============================================================================
 */
export function TripChatScreen() {
  const me = useChat((s) => s.session!.me);
  const state = useChat((s) => s.session!.journey.state);
  const closed = useChat((s) => s.closed);
  const connection = useChat((s) => s.connection);

  useEffect(() => {
    chatSocket.connect();
    const sub = AppState.addEventListener('change', (st) => { if (st === 'active') useChat.getState().bumpBackgroundUnread(true); });
    const vis = () => { if (typeof document !== 'undefined' && document.visibilityState === 'visible') { useChat.getState().bumpBackgroundUnread(true); notifyHost('tr:unread', { count: 0 }); } };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', vis);
    return () => { chatSocket.disconnect(); sub.remove(); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', vis); };
  }, []);
  useEffect(() => { if (connection === 'online') notifyHost('tr:ready'); }, [connection === 'online']);
  useEffect(() => { if (state === 'read_only' || state === 'closed') { void stopCrowdShare(); void stopLiveShare({ silent: true }); } }, [state]);

  const leave = useCallback(async () => {
    await stopLiveShare();
    await stopCrowdShare();
    notifyHost('tr:close');
  }, []);

  if (closed) return <ClosedState reason={closed.reason} onDone={leave} />;
  if (state === 'scheduled' || state === 'dormant') return <PreOpen onBack={leave} />;
  if (me.profileNeeded) return <ProfileGate onBack={leave} />;
  return <Room onLeave={leave} />;
}

function Room({ onLeave }: { onLeave: () => void }) {
  const { width: windowW } = useWindowDimensions();
  const width = Math.min(windowW, FRAME_MAX);
  const me = useChat((s) => s.session!.me);
  const activeRoom = useChat((s) => s.activeRoom);
  const womenFeature = useFeature('women_channel');
  // WOMEN-ONLY ROOM: UI gate only. The server re-checks the booking gender on every join.
  const womenEligible = me.gender === 'F' && womenFeature;

  const roomIndex = useSharedValue(activeRoom === 'WOMEN_ONLY' ? 1 : 0);
  useEffect(() => { roomIndex.value = withSpring(activeRoom === 'WOMEN_ONLY' ? 1 : 0, motion.spring); }, [activeRoom]);
  const pager = useAnimatedStyle(() => ({ transform: [{ translateX: -roomIndex.value * width }] }));

  const sheets = {
    passengers: useRef<BottomSheetModal>(null), seenBy: useRef<BottomSheetModal>(null), report: useRef<BottomSheetModal>(null), person: useRef<BottomSheetModal>(null),
    sos: useRef<BottomSheetModal>(null), trip: useRef<BottomSheetModal>(null), location: useRef<BottomSheetModal>(null), pollCreate: useRef<BottomSheetModal>(null),
    pollVotes: useRef<BottomSheetModal>(null), games: useRef<BottomSheetModal>(null), reactions: useRef<BottomSheetModal>(null),
    issue: useRef<BottomSheetModal>(null), wait: useRef<BottomSheetModal>(null), lost: useRef<BottomSheetModal>(null), tara: useRef<BottomSheetModal>(null),
  };
  const open = (k: keyof typeof sheets) => sheets[k].current?.present();
  const close = (k: keyof typeof sheets) => sheets[k].current?.dismiss();
  const [menu, setMenu] = useState<{ message: UiMessage; rect: Rect } | null>(null);
  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null);
  const [personSeat, setPersonSeat] = useState<string | null>(null);
  const [focusMsg, setFocusMsg] = useState<UiMessage | null>(null);

  const openSeenBy = useCallback((m: UiMessage) => { setFocusMsg(m); open('seenBy'); }, []);
  const openMenu = useCallback((m: UiMessage, rect: Rect) => setMenu({ message: m, rect }), []);
  const openReport = useCallback((t: ReportTarget) => { setReportTarget(t); open('report'); }, []);
  const openPerson = useCallback((seat: string) => { setPersonSeat(seat); close('passengers'); open('person'); }, []);
  const openReactions = useCallback((m: UiMessage) => { setFocusMsg(m); open('reactions'); }, []);
  const openVotes = useCallback((m: UiMessage) => { setFocusMsg(m); open('pollVotes'); }, []);

  return (
    <View style={styles.root}>
      <BrandBar onBack={onLeave} />
      <TopBar onBack={onLeave} onOpenPassengers={() => open('passengers')} onOpenSos={() => open('sos')} onOpenMenu={() => open('trip')} />
      <RouteStrip />
      {womenEligible && <RoomSwitcher roomIndex={roomIndex} />}
      <QuietBanner />
      <CrowdPrompt />
      <LiveShareBanner />
      <PinnedRail onOpenGame={() => {}} />

      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <View style={styles.pagerClip}>
          <Animated.View style={[styles.pager, { width: width * (womenEligible ? 2 : 1) }, pager]}>
            <RoomPane roomType="MAIN_COMMON" width={width} onLongPress={openMenu} onOpenSeenBy={openSeenBy} onOpenVotes={openVotes} onOpenReactions={openReactions} />
            {womenEligible && <RoomPane roomType="WOMEN_ONLY" width={width} onLongPress={openMenu} onOpenSeenBy={openSeenBy} onOpenVotes={openVotes} onOpenReactions={openReactions} />}
          </Animated.View>
          <LinearGradient pointerEvents="none" colors={[palette.navy, palette.bgClear]} style={styles.fade} />
        </View>
        <Composer roomIndex={roomIndex} onOpenLocation={() => open('location')} onOpenPoll={() => open('pollCreate')} onOpenGames={() => open('games')}
          onOpenIssue={() => open('issue')} onOpenWait={() => open('wait')} onOpenLost={() => open('lost')} onOpenTara={() => open('tara')} />
      </KeyboardAvoidingView>

      <PassengerSheet ref={sheets.passengers} onOpenPerson={openPerson} />
      <PersonSheet ref={sheets.person} seat={personSeat} onClose={() => close('person')} onReport={(seat, name) => { close('person'); openReport({ kind: 'person', seat, name }); }} />
      <ReportSheet ref={sheets.report} target={reportTarget} onClose={() => close('report')} />
      <SeenBySheet ref={sheets.seenBy} message={focusMsg} />
      <SosSheet ref={sheets.sos} />
      <TripSheet ref={sheets.trip} onLeave={() => { close('trip'); onLeave(); }} />
      <LocationSheet ref={sheets.location} onClose={() => close('location')} />
      <PollCreateSheet ref={sheets.pollCreate} onClose={() => close('pollCreate')} />
      <PollVotesSheet ref={sheets.pollVotes} message={focusMsg} />
      <ReactionsSheet ref={sheets.reactions} message={focusMsg} onClose={() => close('reactions')} />
      <GamesSheet ref={sheets.games} onClose={() => close('games')} onOpenArrivalGame={() => {}} />
      <IssueSheet ref={sheets.issue} onClose={() => close('issue')} />
      <WaitSheet ref={sheets.wait} onClose={() => close('wait')} />
      <LostSheet ref={sheets.lost} onClose={() => close('lost')} />
      <TaraSheet ref={sheets.tara} onClose={() => close('tara')} />
      <MessageMenu target={menu} onClose={() => setMenu(null)} onReport={(m) => openReport({ kind: 'message', message: m })} onSeenBy={openSeenBy} />
      <ToastHost />
    </View>
  );
}

/** A slim strip in the host app's colour so the screen feels like part of AbhiBus / ConfirmTkt / ixigo. */
function BrandBar({ onBack }: { onBack: () => void }) {
  const insets = useSafeAreaInsets();
  const t = useTenant();
  const b = brand();
  if (!t) return null;
  return (
    <View style={[styles.brandBar, { backgroundColor: b.brand, paddingTop: insets.top + 6 }]}>
      <Pressable onPress={onBack} hitSlop={10} accessibilityRole="button" accessibilityLabel={`Back to ${t.name}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Ionicons name="chevron-back" size={16} color={b.ink} />
        <Txt v="smallStrong" color={b.ink}>{t.theme.logoText || t.name}</Txt>
      </Pressable>
      <Txt v="micro" color={b.ink} style={{ marginLeft: 'auto', opacity: 0.85 }}>Trip chat</Txt>
    </View>
  );
}

function QuietBanner() {
  const q = useChat((s) => s.tenant?.quiet);
  const [hidden, setHidden] = useState(false);
  if (!q?.active || hidden) return null;
  return (
    <View style={styles.quiet}>
      <Ionicons name="moon" size={13} color={palette.textSecondary} />
      <Txt v="meta" color={palette.textSecondary} style={{ flex: 1 }}>{`Quiet hours till ${q.to}. No notification sounds; alerts still come through.`}</Txt>
      <Pressable onPress={() => setHidden(true)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Hide"><Ionicons name="close" size={14} color={palette.textTertiary} /></Pressable>
    </View>
  );
}

/** On board and no live feed? Ask (once) to help everyone see where the vehicle is, anonymously. */
function CrowdPrompt() {
  const on = useFeature('location_crowd');
  const vertical = useVertical();
  const unit = useUnit();
  const state = useChat((s) => s.session!.journey.state);
  const sharing = useChat((s) => s.sharingLocation);
  const conf = useChat((s) => s.location?.confidence);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!on || vertical === 'flight' || state !== 'onboard' || dismissed) return null;
  if (sharing) {
    return (
      <Animated.View entering={FadeIn} style={[styles.crowd, { backgroundColor: palette.greenSoft }]}>
        <LiveDot color={palette.green} size={7} />
        <Txt v="meta" color={palette.textSecondary} style={{ flex: 1 }}>{`You’re helping track the ${unit.noun}. Nobody sees it’s you. Stops at your drop point.`}</Txt>
        <Pressable onPress={() => void stopCrowdShare()} hitSlop={8} accessibilityRole="button"><Txt v="smallStrong" color={palette.textSecondary}>Stop</Txt></Pressable>
      </Animated.View>
    );
  }
  if (conf === 'high') return null;
  return (
    <Animated.View entering={FadeIn} style={styles.crowd}>
      <MaterialCommunityIcons name="crosshairs-gps" size={16} color={palette.green} />
      <Txt v="meta" color={palette.text} style={{ flex: 1 }}>{`Help everyone see where the ${unit.noun} is. Share your location anonymously while on board.`}</Txt>
      <Pressable onPress={async () => { setBusy(true); const err = await startCrowdShare(); setBusy(false); if (err) toast(err, 'danger'); }} disabled={busy}
        style={({ pressed }) => [styles.crowdBtn, pressed && { opacity: 0.8 }]} accessibilityRole="button"><Txt v="smallStrong" color={palette.navyDeep}>{busy ? '…' : 'Share'}</Txt></Pressable>
      <Pressable onPress={() => setDismissed(true)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Not now"><Ionicons name="close" size={16} color={palette.textTertiary} /></Pressable>
    </Animated.View>
  );
}

function LiveShareBanner() {
  const live = useChat((s) => s.liveShare);
  const now = useServerNow(1000);
  if (!live) return null;
  const left = Math.max(0, Date.parse(live.until) - now);
  return (
    <View style={styles.liveBanner} accessibilityLiveRegion="polite">
      <LiveDot color={palette.rose} size={7} />
      <Txt v="smallStrong" style={{ flex: 1 }}>{`Sharing live location · ${mmss(left)} left`}</Txt>
      <Pressable onPress={() => void stopLiveShare()} hitSlop={8} style={styles.liveStop} accessibilityRole="button" accessibilityLabel="Stop sharing live location">
        <Txt v="smallStrong" color={palette.red}>Stop</Txt>
      </Pressable>
    </View>
  );
}

/** Before the room opens (scheduled), or a flight room that opens only on a long delay (dormant). */
function PreOpen({ onBack }: { onBack: () => void }) {
  const insets = useSafeAreaInsets();
  const j = useChat((s) => s.session!.journey);
  const t = useTenant();
  const unit = useUnit();
  return (
    <View style={styles.root}>
      <BrandBar onBack={onBack} />
      <ScrollView contentContainerStyle={[styles.center, { paddingBottom: insets.bottom + 24 }]}>
        <View style={styles.closedIcon}><MaterialCommunityIcons name={unit.icon} size={28} color={brand().brand} /></View>
        <Txt v="h2" style={{ textAlign: 'center' }}>{j.routeName}</Txt>
        {!!j.subtitle && <Txt v="small" color={palette.textSecondary} style={{ textAlign: 'center' }}>{j.subtitle}</Txt>}
        {j.state === 'dormant' ? (
          <Txt v="body" color={palette.textSecondary} style={{ textAlign: 'center', marginTop: 8 }}>
            {`This room opens only if your flight is delayed. If it is, you’ll get a notification from ${t?.name ?? 'us'} and can chat with others on the same flight.`}
          </Txt>
        ) : (
          <>
            <Txt style={[styles.bigTime, { color: brand().brand }]}>{when(j.opensAt)}</Txt>
            <Txt v="title" style={{ textAlign: 'center' }}>Your trip room opens soon</Txt>
            <Txt v="body" color={palette.textSecondary} style={{ textAlign: 'center' }}>
              {`You’ll get ${unit.noun === 'flight' ? 'gate and delay' : 'boarding and delay'} alerts from ${t?.name ?? 'Ops'}, live ${unit.noun} position, Tara, polls and games. ${t?.identityMode === 'profile' ? 'You’ll pick how others see you.' : 'You’ll join with a random handle.'} Nobody sees your name, number, gender or seat.`}
            </Txt>
          </>
        )}
        <Txt v="meta" color={palette.textTertiary} style={{ marginTop: 10 }}>{`Departs ${when(j.startTime)}`}</Txt>
      </ScrollView>
    </View>
  );
}

/** Profile identity mode: pick a first name + avatar once, then the room opens. */
function ProfileGate({ onBack }: { onBack: () => void }) {
  const insets = useSafeAreaInsets();
  const t = useTenant();
  const unit = useUnit();
  const online = useChat((s) => s.connection === 'online');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <View style={styles.root}>
      <BrandBar onBack={onBack} />
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 24 }} keyboardShouldPersistTaps="handled">
        <ProfileStep initial={null} busy={busy || !online} error={error} cta={online ? 'Join the trip chat' : 'Connecting…'}
          title={`How should people on this ${unit.noun} see you?`}
          subtitle={`A first name and a picture. Your full name, phone, seat and ${t?.name ?? ''} account stay private.`}
          note="You can’t change this later during this trip."
          onSubmit={async (p) => {
            setBusy(true); setError(null);
            const a = await chatSocket.setProfile(p.name, p.avatar);
            setBusy(false);
            if (!a.ok) setError(a.message);
          }} />
      </ScrollView>
    </View>
  );
}

function ClosedState({ reason, onDone }: { reason: 'ENDED' | 'UNAUTHORIZED' | 'REMOVED'; onDone: () => void }) {
  const insets = useSafeAreaInsets();
  const t = useTenant();
  const ended = reason === 'ENDED';
  const removed = reason === 'REMOVED';
  return (
    <View style={[styles.root, styles.center, { paddingTop: insets.top + 40, paddingBottom: insets.bottom + 24 }]}>
      <View style={styles.closedIcon}><Ionicons name={removed ? 'ban-outline' : ended ? 'moon-outline' : 'lock-closed-outline'} size={28} color={removed ? palette.red : palette.textSecondary} /></View>
      <Txt v="h2" style={{ textAlign: 'center' }}>{removed ? 'You’ve been removed from this chat' : ended ? 'This trip chat has ended' : 'This link has expired'}</Txt>
      <Txt v="body" color={palette.textSecondary} style={{ textAlign: 'center' }}>
        {removed
          ? `Several travellers reported your messages, so you can’t rejoin this trip’s chat. SOS and ${t?.name ?? ''} support still work as normal.`
          : ended ? `Messages from this trip have been deleted. Thanks for travelling with ${t?.name ?? 'us'}.` : `Open the chat again from your trip in the ${t?.name ?? ''} app.`}
      </Txt>
      <Pressable onPress={onDone} style={styles.closedBtn} accessibilityRole="button"><Txt v="bodyStrong">Done</Txt></Pressable>
    </View>
  );
}

const styles = themed(() => ({
  root: { flex: 1, backgroundColor: palette.navy },
  pagerClip: { flex: 1, overflow: 'hidden' },
  pager: { flex: 1, flexDirection: 'row' },
  fade: { position: 'absolute', top: 0, left: 0, right: 0, height: 14 },
  brandBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 6 },
  quiet: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 12, marginBottom: 6, paddingHorizontal: 12, paddingVertical: 7, borderRadius: radius.chip, backgroundColor: palette.surface },
  crowd: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 12, marginBottom: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.chip, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.hairline },
  crowdBtn: { paddingHorizontal: 12, height: 28, borderRadius: radius.pill, backgroundColor: palette.green, alignItems: 'center', justifyContent: 'center' },
  liveBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 12, marginBottom: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.chip, backgroundColor: palette.roseSoft, borderWidth: 1, borderColor: palette.roseBorder },
  liveStop: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill, backgroundColor: palette.redSoft },
  center: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, gap: 10 },
  bigTime: { fontFamily: 'Sora_700Bold', fontSize: 30, lineHeight: 38, textAlign: 'center', marginTop: 12 },
  closedIcon: { width: 64, height: 64, borderRadius: 20, backgroundColor: palette.surface, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  closedBtn: { marginTop: 20, height: 50, paddingHorizontal: 40, borderRadius: radius.pill, backgroundColor: palette.surfaceRaised, alignItems: 'center', justifyContent: 'center' },
}));

