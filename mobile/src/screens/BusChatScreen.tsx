import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useBottomSheetModal, type BottomSheetModal } from '@gorhom/bottom-sheet';
import { Ionicons } from '../components/icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { TopBar } from '../components/TopBar';
import { TripTicker } from '../components/TripTicker';
import { RoomSwitcher } from '../components/RoomSwitcher';
import { PinnedRail } from '../components/PinnedRail';
import { RoomPane } from '../components/RoomPane';
import { MessageMenu, type Rect } from '../components/MessageMenu';
import { Composer } from '../components/Composer';
import { Txt } from '../components/Txt';
import { ToastHost } from '../components/Toast';
import { GameSheet, GamesSheet, QrInviteSheet, ReactionsSheet, LandmarkSheet, LocationSheet, PollCreateSheet, PollVotesSheet, PassengerSheet, PersonSheet, ReportSheet, type ReportTarget, SeenBySheet, SosSheet, TripSheet } from '../components/sheets';
import { useChat, type UiMessage } from '../store/chatStore';
import { chatSocket } from '../services/socket';
import { clearSession } from '../services/session';
import { stopLiveShare } from '../services/liveLocation';
import { LiveDot } from '../components/LiveDot';
import { useServerNow } from '../hooks/useNow';
import { mmss } from '../utils/format';
import { FRAME_MAX, byMode, motion, palette, radius, themed } from '../theme/tokens';
import { SettingsSheet } from '../components/SettingsSheet';
import { WALLPAPERS, useSettings } from '../store/settings';
import { host } from '../services/host';

/**
 * ============================================================================
 *  BusChatScreen
 * ============================================================================
 *   ┌─────────────────────────────────────────────┐
 *   │ ← Hyderabad → Bengaluru            [🛡] [⋮] │  TopBar
 *   │   Sunrise Travels · 15 travellers           │
 *   │ [📍 Your stop HSR Layout in ~2 h · • • •]    │  TripTicker ("up next", rotates)
 *   │ [ 👥 Everyone | 🛡 Women Zone • ]           │  RoomSwitcher (F only)
 *   │ ┌ Dinner stop ............... 14:32 ┐       │  PinnedRail (≤1 card)
 *   ├─────────────────────────────────────────────┤
 *   │  messages (pager: everyone | women)         │  RoomPane x2
 *   ├─────────────────────────────────────────────┤
 *   │ (Where is the bus now?) (Rest stop?) …      │  Composer: quick replies,
 *   │ [ Message everyone   ☺ 🎤 ] [📍] [🎮/➤]    │  location, games tray / send
 *   └─────────────────────────────────────────────┘
 *
 *  State: everything lives in the Zustand store (store/chatStore.ts), fed by
 *  the socket service. This screen only orchestrates layout, the room pager
 *  and which sheet is open.
 * ============================================================================
 */
export function BusChatScreen({ onBack }: { onBack: () => void }) {
  const { width: windowW } = useWindowDimensions();
  const width = Math.min(windowW, FRAME_MAX); // pager pages = the app column, not the browser window
  const me = useChat((s) => s.session!.me);
  const activeRoom = useChat((s) => s.activeRoom);
  const closed = useChat((s) => s.closed);

  // ===== WOMEN-ONLY ROOM: UI gate. Rendered only when the passenger's own
  // PNR booking says 'F'. The server independently enforces the same rule on
  // every room:join, so a tampered client still can't get in.
  const womenEligible = me.gender === 'F';

  // 0 = lounge, 1 = women. Drives the pager slide and accent colour morph.
  const roomIndex = useSharedValue(activeRoom === 'WOMEN_ONLY' ? 1 : 0);
  useEffect(() => { roomIndex.value = withSpring(activeRoom === 'WOMEN_ONLY' ? 1 : 0, motion.spring); }, [activeRoom]);
  const pager = useAnimatedStyle(() => ({ transform: [{ translateX: -roomIndex.value * width }] }));

  useEffect(() => {
    chatSocket.connect();
    return () => chatSocket.disconnect();
  }, []);

  // ------------------------------------------------------------ sheets ---
  const passengers = useRef<BottomSheetModal>(null);
  const seenBy = useRef<BottomSheetModal>(null);
  const report = useRef<BottomSheetModal>(null);
  const person = useRef<BottomSheetModal>(null);
  const [menu, setMenu] = useState<{ message: UiMessage; rect: Rect } | null>(null);
  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null);
  const [personSeat, setPersonSeat] = useState<string | null>(null);
  const sos = useRef<BottomSheetModal>(null);
  const landmarks = useRef<BottomSheetModal>(null);
  const game = useRef<BottomSheetModal>(null);
  const trip = useRef<BottomSheetModal>(null);
  const location = useRef<BottomSheetModal>(null);
  const pollCreate = useRef<BottomSheetModal>(null);
  const pollVotes = useRef<BottomSheetModal>(null);
  const games = useRef<BottomSheetModal>(null);
  const reactions = useRef<BottomSheetModal>(null);
  const qrInvite = useRef<BottomSheetModal>(null);
  const settings = useRef<BottomSheetModal>(null);
  const wallpaper = useSettings((s) => s.wallpaper);
  const wallColors = wallpaper === 'plain' ? null : byMode(WALLPAPERS[wallpaper]);
  const [focusMsg, setFocusMsg] = useState<UiMessage | null>(null);

  const openSeenBy = useCallback((m: UiMessage) => { setFocusMsg(m); seenBy.current?.present(); }, []);
  const openMenu = useCallback((m: UiMessage, rect: Rect) => setMenu({ message: m, rect }), []);
  const openReport = useCallback((t: ReportTarget) => { setReportTarget(t); report.current?.present(); }, []);
  const openPerson = useCallback((seat: string) => { setPersonSeat(seat); passengers.current?.dismiss(); person.current?.present(); }, []);
  const openReactions = useCallback((m: UiMessage) => { setFocusMsg(m); reactions.current?.present(); }, []);
  const openVotes = useCallback((m: UiMessage) => { setFocusMsg(m); pollVotes.current?.present(); }, []);

  /** Exit chat / chat ended. Inside the AbhiBus app, hand control back with `close`. */
  const leave = async (reason = 'left') => {
    trip.current?.dismiss();
    await stopLiveShare();
    chatSocket.disconnect();
    if (!host.embedded) await clearSession();
    useChat.getState().reset();
    host.post('close', { reason });
  };

  // Android hardware back (sent by the app): close the top sheet or menu first, then leave the screen.
  const { dismiss: dismissSheet } = useBottomSheetModal();
  const menuOpen = useRef(false);
  menuOpen.current = !!menu;
  useEffect(() => host.on('back', () => {
    if (useChat.getState().closed) return void leave('back');
    if (menuOpen.current) return setMenu(null);
    if (!dismissSheet()) onBack();
  }), [dismissSheet, onBack]);

  if (closed) return <ClosedState reason={closed.reason} note={closed.note} onDone={() => leave(closed.reason === 'ENDED' ? 'ended' : closed.reason === 'REMOVED' ? 'removed' : 'unauthorized')} />;

  return (
    <View style={styles.root}>
      <TopBar onBack={onBack} onOpenPassengers={() => passengers.current?.present()} onOpenSos={() => sos.current?.present()} onOpenMenu={() => trip.current?.present()} />
      <TripTicker onOpenTrip={() => trip.current?.present()} onOpenLandmarks={() => landmarks.current?.present()} onOpenPassengers={() => passengers.current?.present()} />
      {womenEligible && <RoomSwitcher roomIndex={roomIndex} />}
      <LiveShareBanner />
      <PinnedRail onOpenGame={() => game.current?.present()} />

      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <View style={styles.pagerClip}>
          {/* Settings → Chat background: a gradient drawn in code (no image to download). */}
          {wallColors && <LinearGradient colors={wallColors} style={[StyleSheet.absoluteFill, { pointerEvents: 'none' }]} />}
          <Animated.View style={[styles.pager, { width: width * (womenEligible ? 2 : 1) }, pager]}>
            <RoomPane roomType="MAIN_COMMON" width={width} onLongPress={openMenu} onOpenSeenBy={openSeenBy} onOpenVotes={openVotes} onOpenReactions={openReactions} onShareLocation={() => location.current?.present()} />
            {womenEligible && <RoomPane roomType="WOMEN_ONLY" width={width} onLongPress={openMenu} onOpenSeenBy={openSeenBy} onOpenVotes={openVotes} onOpenReactions={openReactions} onShareLocation={() => location.current?.present()} />}
          </Animated.View>
          {/* Soft edge so messages fade under the header instead of being sliced. */}
          {!wallColors && <LinearGradient colors={[palette.navy, palette.bgClear]} style={[styles.fade, { pointerEvents: 'none' }]} />}
        </View>
        <Composer roomIndex={roomIndex} onOpenGame={() => game.current?.present()} onOpenLandmarks={() => landmarks.current?.present()} onOpenLocation={() => location.current?.present()} onOpenPoll={() => pollCreate.current?.present()} onOpenGames={() => games.current?.present()} />
      </KeyboardAvoidingView>

      <PassengerSheet ref={passengers} onOpenPerson={openPerson} />
      <PersonSheet ref={person} seat={personSeat} onClose={() => person.current?.dismiss()}
        onReport={(seat, name) => { person.current?.dismiss(); openReport({ kind: 'person', seat, name }); }} />
      <ReportSheet ref={report} target={reportTarget} onClose={() => report.current?.dismiss()} />
      <SeenBySheet ref={seenBy} message={focusMsg} />
      <SosSheet ref={sos} />
      <LandmarkSheet ref={landmarks} onClose={() => landmarks.current?.dismiss()} />
      <GameSheet ref={game} />
      <TripSheet ref={trip} onOpenSettings={() => { trip.current?.dismiss(); settings.current?.present(); }} onOpenPassengers={() => { trip.current?.dismiss(); passengers.current?.present(); }} onLeave={() => leave('left')} onInvite={() => { trip.current?.dismiss(); qrInvite.current?.present(); }} />
      <QrInviteSheet ref={qrInvite} />
      <SettingsSheet ref={settings} />
      <LocationSheet ref={location} onClose={() => location.current?.dismiss()} />
      <PollCreateSheet ref={pollCreate} onClose={() => pollCreate.current?.dismiss()} />
      <PollVotesSheet ref={pollVotes} message={focusMsg} />
      <ReactionsSheet ref={reactions} message={focusMsg} onClose={() => reactions.current?.dismiss()} />
      <GamesSheet ref={games} onClose={() => games.current?.dismiss()} onOpenArrivalGame={() => game.current?.present()} />
      <MessageMenu target={menu} onClose={() => setMenu(null)} onReport={(m) => openReport({ kind: 'message', message: m })} onSeenBy={openSeenBy} />
      <ToastHost />
    </View>
  );
}

/** While I'm sharing live location: always visible, one tap to stop (WhatsApp shows the same). */
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

function ClosedState({ reason, note, onDone }: { reason: 'ENDED' | 'UNAUTHORIZED' | 'REMOVED'; note?: string | null; onDone: () => void }) {
  const insets = useSafeAreaInsets();
  const ended = reason === 'ENDED';
  const removed = reason === 'REMOVED';
  return (
    <View style={[styles.root, styles.closed, { paddingTop: insets.top + 40, paddingBottom: insets.bottom + 24 }]}>
      <View style={styles.closedIcon}><Ionicons name={removed ? 'ban-outline' : ended ? 'moon-outline' : 'lock-closed-outline'} size={28} color={removed ? palette.red : palette.textSecondary} /></View>
      <Txt v="h2" style={{ textAlign: 'center' }}>{removed ? 'You’ve been removed from this chat' : ended ? 'This trip chat has ended' : 'Your session expired'}</Txt>
      <Txt v="body" color={palette.textSecondary} style={{ textAlign: 'center' }}>
        {removed
          ? `${note ?? 'You can’t rejoin this trip’s chat.'} SOS and AbhiBus support still work as normal.`
          : ended ? 'Messages from this trip have been deleted. Thanks for travelling with AbhiBus.' : 'Open the chat again from your trip in the AbhiBus app.'}
      </Txt>
      <Pressable onPress={onDone} style={styles.closedBtn} accessibilityRole="button">
        <Txt v="bodyStrong">Done</Txt>
      </Pressable>
    </View>
  );
}

const styles = themed(() => ({
  root: { flex: 1, backgroundColor: palette.navy },
  pagerClip: { flex: 1, overflow: 'hidden' },
  pager: { flex: 1, flexDirection: 'row' },
  liveBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 12, marginBottom: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.chip, backgroundColor: palette.roseSoft, borderWidth: 1, borderColor: palette.roseBorder },
  liveStop: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill, backgroundColor: palette.redSoft },
  fade: { position: 'absolute', top: 0, left: 0, right: 0, height: 14 },
  closed: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 12 },
  closedIcon: { width: 64, height: 64, borderRadius: 20, backgroundColor: palette.surface, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  closedBtn: { marginTop: 20, height: 50, paddingHorizontal: 40, borderRadius: radius.pill, backgroundColor: palette.surfaceRaised, alignItems: 'center', justifyContent: 'center' },
}));
