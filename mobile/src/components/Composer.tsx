import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import Animated, {
  FadeIn, FadeOut, interpolate, interpolateColor, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withSpring, withTiming, type SharedValue,
} from 'react-native-reanimated';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import EmojiPicker, { type EmojiType } from 'rn-emoji-keyboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Txt } from './Txt';
import { TicketSticker } from './TicketSticker';
import { useChat } from '../store/chatStore';
import { chatSocket } from '../services/socket';
import { useVoiceInput } from '../hooks/useVoiceInput';
import { MAX_TEXT_LENGTH } from '../shared/moderation';
import { MENTIONABLES, STICKERS, mentionsIn } from '../shared/protocol';
import { font, motion, palette, radius, roomTheme, themed } from '../theme/tokens';

/**
 * Bottom input bar.
 *   [sticker] [bus location] [ text field  (emoji) ] [mic ⇄ send]
 * - Mic and Send share one slot and morph: empty field shows mic, typing shows send.
 * - Voice mode replaces the field with a live transcript + level meter. The
 *   final transcript drops into the field so the passenger can fix it first.
 * - Moderation runs locally before sending; a blocked message shakes the field
 *   and explains why, instead of a silent failure.
 */
export function Composer({ roomIndex, onOpenGame, onOpenLandmarks, onOpenLocation, onOpenPoll, onOpenGames }: { roomIndex: SharedValue<number>; onOpenGame: () => void; onOpenLandmarks: () => void; onOpenLocation: () => void; onOpenPoll: () => void; onOpenGames: () => void }) {
  const insets = useSafeAreaInsets();
  const roomType = useChat((s) => s.activeRoom);
  const muted = useChat((s) => s.muted);
  const online = useChat((s) => s.connection === 'online');
  const theme = roomTheme[roomType];
  const game = useChat((s) => s.game);
  const upcomingStops = useChat((s) => s.landmarks.filter((l) => !l.passed).length);
  const hasLandmarks = useChat((s) => s.landmarks.length > 0);

  const [text, setText] = useState('');
  const [trayOpen, setTrayOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<TextInput>(null);

  // @mentions (WhatsApp/Slack-style): typing "@" at the end of the text opens the picker.
  const mentionQuery = text.match(/(?:^|\s)@([\p{L} ]{0,20})$/u)?.[1]?.toLowerCase() ?? null;
  const mentionHits = mentionQuery == null ? [] : MENTIONABLES.filter((m) => m.handle.toLowerCase().startsWith(mentionQuery.trimStart()) || m.title.toLowerCase().includes(mentionQuery.trim()));
  const careInText = mentionsIn(text).includes('CARE');
  const pickMention = (handle: string) => {
    Haptics.selectionAsync();
    setText((t) => t.replace(/@([\p{L} ]{0,20})$/u, `@${handle} `));
    inputRef.current?.focus();
  };

  const voice = useVoiceInput((t) => setText((cur) => (cur ? `${cur} ${t}` : t)));
  const hasText = text.trim().length > 0;

  // ----------------------------------------------------- animations -----
  const morph = useSharedValue(0);          // 0 = mic, 1 = send
  const tray = useSharedValue(0);
  const shake = useSharedValue(0);
  useEffect(() => { morph.value = withSpring(hasText ? 1 : 0, motion.spring); }, [hasText]);
  useEffect(() => { tray.value = withSpring(trayOpen ? 1 : 0, motion.springSoft); }, [trayOpen]);
  useEffect(() => { if (voice.error) { setNotice(voice.error); voice.clearError(); } }, [voice.error]);
  useEffect(() => { if (!notice) return; const t = setTimeout(() => setNotice(null), 4500); return () => clearTimeout(t); }, [notice]);

  const accents = [roomTheme.MAIN_COMMON.accent, roomTheme.WOMEN_ONLY.accent];
  const sendBtn = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(roomIndex.value, [0, 1], accents),
    opacity: morph.value, transform: [{ scale: 0.6 + morph.value * 0.4 }, { rotate: `${(1 - morph.value) * -60}deg` }],
  }));
  const micBtn = useAnimatedStyle(() => ({ opacity: 1 - morph.value, transform: [{ scale: 1 - morph.value * 0.4 }] }));
  const trayStyle = useAnimatedStyle(() => ({ height: tray.value * 330, opacity: tray.value }));
  const fieldStyle = useAnimatedStyle(() => ({ transform: [{ translateX: shake.value }] }));

  const doShake = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    shake.value = withSequence(withTiming(-8, { duration: 50 }), withTiming(8, { duration: 50 }), withTiming(-5, { duration: 50 }), withTiming(0, { duration: 50 }));
  };

  const send = () => {
    if (!hasText) return;
    const res = chatSocket.sendText(roomType, text);
    if (!res.ok) { setNotice(res.reason); doShake(); return; }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setText('');
    setNotice(null);
    chatSocket.typing(roomType, false);
  };

  const onChange = (t: string) => {
    setText(t);
    if (t.length > 0) chatSocket.typing(roomType, true);
  };

  if (muted) {
    return (
      <View style={[styles.mutedBar, { paddingBottom: insets.bottom + 12 }]} accessibilityLiveRegion="polite">
        <Ionicons name="volume-mute-outline" size={18} color={palette.textSecondary} />
        <Txt v="small" color={palette.textSecondary} style={{ flex: 1 }}>
          You’ve been muted for the rest of this trip after several passengers reported messages. You can still read the chat and use SOS.
        </Txt>
      </View>
    );
  }

  return (
    <View style={[styles.wrap, { paddingBottom: Math.max(insets.bottom, 8) }]}>
      {notice && (
        <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(160)} style={styles.notice} accessibilityLiveRegion="assertive">
          <Ionicons name="shield-outline" size={14} color={palette.red} />
          <Txt v="meta" color={palette.text} style={{ flex: 1 }}>{notice}</Txt>
        </Animated.View>
      )}
      {!online && (
        <View style={styles.offline}>
          <Ionicons name="cloud-offline-outline" size={13} color={palette.amber} />
          <Txt v="meta" color={palette.amber}>No signal. Messages will send when the bus is back in range.</Txt>
        </View>
      )}

      {mentionHits.length > 0 && (
        <Animated.View entering={FadeIn.duration(120)} style={styles.mentionBox} accessibilityRole="menu">
          <Txt v="micro" color={palette.textTertiary} style={{ letterSpacing: 0.8, marginBottom: 4 }}>MENTION</Txt>
          {mentionHits.map((m) => (
            <Pressable key={m.id} onPress={() => pickMention(m.handle)} style={({ pressed }) => [styles.mentionRow, pressed && { backgroundColor: palette.surfaceRaised }]}
              accessibilityRole="menuitem" accessibilityLabel={`Mention ${m.title}`}>
              <View style={styles.careIcon}><Ionicons name="headset" size={18} color={palette.navyDeep} /></View>
              <View style={{ flex: 1 }}>
                <Txt v="bodyStrong">{m.title}</Txt>
                <Txt v="meta" color={palette.textSecondary}>{`${m.subtitle} · they’ll be notified`}</Txt>
              </View>
              <Txt v="smallStrong" color={palette.textTertiary}>{`@${m.handle}`}</Txt>
            </Pressable>
          ))}
        </Animated.View>
      )}
      {careInText && mentionHits.length === 0 && (
        <View style={styles.careNotice}>
          <Ionicons name="headset-outline" size={14} color={palette.cyan} />
          <Txt v="meta" color={palette.textSecondary} style={{ flex: 1 }}>AbhiBus Care will be notified when you send this.</Txt>
        </View>
      )}

      <View style={styles.bar}>
        {voice.listening ? (
          <VoiceCapture interim={voice.interim} volume={voice.volume} lang={voice.lang.short} onCycleLang={voice.cycleLang} onCancel={voice.cancel} onDone={voice.stop} />
        ) : (
          <>
            <IconBtn icon={trayOpen ? 'close' : 'plus'} label={trayOpen ? 'Close' : 'Location, poll, games and stickers'} active={trayOpen} accent={theme.accent}
              dot={!trayOpen && game?.status === 'OPEN' && !game.myGuess}
              onPress={() => { setTrayOpen((o) => !o); inputRef.current?.blur(); }} />

            <Animated.View style={[styles.field, fieldStyle]}>
              <TextInput
                ref={inputRef}
                value={text}
                onChangeText={onChange}
                onFocus={() => setTrayOpen(false)}
                onBlur={() => chatSocket.typing(roomType, false)}
                placeholder={roomType === 'WOMEN_ONLY' ? 'Message women on this bus' : 'Message the bus · @ for help'}
                placeholderTextColor={palette.textTertiary}
                style={styles.input}
                multiline
                numberOfLines={1}
                maxLength={MAX_TEXT_LENGTH}
                selectionColor={theme.accent}
                accessibilityLabel="Message"
              />
              <Pressable onPress={() => setEmojiOpen(true)} hitSlop={8} style={styles.emojiBtn} accessibilityRole="button" accessibilityLabel="Emoji">
                <Ionicons name="happy-outline" size={21} color={palette.textSecondary} />
              </Pressable>
            </Animated.View>

            <View style={styles.morphSlot}>
              <Animated.View style={[StyleSheet.absoluteFill, styles.center, micBtn]} pointerEvents={hasText ? 'none' : 'auto'}>
                <Pressable onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); voice.start(); }} style={styles.micBtn}
                  accessibilityRole="button" accessibilityLabel="Voice typing">
                  <Ionicons name="mic-outline" size={22} color={palette.text} />
                </Pressable>
              </Animated.View>
              <Animated.View style={[StyleSheet.absoluteFill, styles.center, styles.sendBtn, sendBtn]} pointerEvents={hasText ? 'auto' : 'none'}>
                <Pressable onPress={send} style={[StyleSheet.absoluteFill, styles.center]} accessibilityRole="button" accessibilityLabel="Send message">
                  <Ionicons name="arrow-up" size={21} color={theme.onAccent} />
                </Pressable>
              </Animated.View>
            </View>
          </>
        )}
      </View>

      <Animated.View style={[styles.tray, trayStyle]}>
        <ScrollView contentContainerStyle={styles.trayGrid} showsVerticalScrollIndicator={false}>
          <View style={styles.actions}>
            <ActionTile icon="map-marker-radius" label="Location" sub="Yours or the bus" color={palette.cyan}
              onPress={() => { setTrayOpen(false); onOpenLocation(); }} />
            <ActionTile icon="poll" label="Poll" sub="Ask the bus" color={palette.green}
              onPress={() => { setTrayOpen(false); onOpenPoll(); }} />
            {hasLandmarks && (
              <ActionTile icon="image-marker" label="Pickup photos" sub={upcomingStops ? `${upcomingStops} stops ahead` : 'All stops'} color={palette.rose}
                onPress={() => { setTrayOpen(false); onOpenLandmarks(); }} />
            )}
            <ActionTile icon="gamepad-variant" label="Games" color={palette.amber} dot={game?.status === 'OPEN' && !game.myGuess}
              sub="Quiz, movies, more" onPress={() => { setTrayOpen(false); onOpenGames(); }} />
          </View>
          <Txt v="micro" color={palette.textTertiary} style={styles.trayLabel}>STICKERS</Txt>
          {chunk(STICKERS, 2).map((pair, i) => (
            <View key={i} style={styles.trayRow}>
              {pair.map((s) => (
                <Pressable key={s.id} style={({ pressed }) => [{ flex: 1 }, pressed && { transform: [{ scale: 0.96 }] }]}
                  onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); chatSocket.sendSticker(roomType, s.id); setTrayOpen(false); }}
                  accessibilityRole="button" accessibilityLabel={`Send sticker: ${s.label}`}>
                  <TicketSticker id={s.id} size="tray" cutout={palette.navyDeep} />
                </Pressable>
              ))}
            </View>
          ))}
        </ScrollView>
      </Animated.View>

      <EmojiPicker
        open={emojiOpen}
        onClose={() => setEmojiOpen(false)}
        onEmojiSelected={(e: EmojiType) => setText((t) => t + e.emoji)}
        enableSearchBar
        enableRecentlyUsed
        categoryPosition="top"
        theme={{
          backdrop: palette.backdrop,
          knob: palette.textTertiary,
          container: palette.surface,
          header: palette.textSecondary,
          skinTonesContainer: palette.surfaceRaised,
          category: { icon: palette.textTertiary, iconActive: theme.accent, container: palette.surfaceSunk, containerActive: palette.surfaceRaised },
          search: { text: palette.text, placeholder: palette.textTertiary, icon: palette.textTertiary, background: palette.surfaceSunk },
        }}
      />
    </View>
  );
}

function IconBtn({ icon, label, onPress, accent, active, dot }: { icon: any; label: string; onPress: () => void; accent: string; active?: boolean; dot?: boolean }) {
  return (
    <Pressable onPress={onPress} hitSlop={4} accessibilityRole="button" accessibilityLabel={label}
      style={({ pressed }) => [styles.iconBtn, active && { backgroundColor: palette.surfaceRaised }, pressed && { opacity: 0.6 }]}>
      <MaterialCommunityIcons name={icon} size={24} color={active ? accent : palette.textSecondary} />
      {dot && <View style={styles.dot} />}
    </Pressable>
  );
}

/** Attach-menu tile (WhatsApp-style): coloured circle + label. */
function ActionTile({ icon, label, sub, color, onPress, dot }: { icon: any; label: string; sub: string; color: string; onPress: () => void; dot?: boolean }) {
  return (
    <Pressable onPress={() => { Haptics.selectionAsync(); onPress(); }} accessibilityRole="button" accessibilityLabel={`${label}. ${sub}`}
      style={({ pressed }) => [styles.tile, pressed && { opacity: 0.6 }]}>
      <View style={[styles.tileIcon, { backgroundColor: color }]}>
        <MaterialCommunityIcons name={icon} size={24} color={palette.navyDeep} />
        {dot && <View style={styles.tileDot} />}
      </View>
      <Txt v="smallStrong" numberOfLines={1}>{label}</Txt>
      <Txt v="micro" color={palette.textTertiary} numberOfLines={1}>{sub}</Txt>
    </Pressable>
  );
}

function VoiceCapture({ interim, volume, lang, onCycleLang, onCancel, onDone }: {
  interim: string; volume: number; lang: string; onCycleLang: () => void; onCancel: () => void; onDone: () => void;
}) {
  const dot = useSharedValue(1);
  useEffect(() => { dot.value = withRepeat(withSequence(withTiming(0.3, { duration: 600 }), withTiming(1, { duration: 600 })), -1); }, []);
  const dotStyle = useAnimatedStyle(() => ({ opacity: dot.value }));
  return (
    <Animated.View entering={FadeIn.duration(180)} style={styles.voice}>
      <Pressable onPress={onCancel} style={styles.iconBtn} accessibilityRole="button" accessibilityLabel="Cancel voice typing">
        <Ionicons name="close" size={22} color={palette.textSecondary} />
      </Pressable>
      <View style={styles.voiceField}>
        <Animated.View style={[styles.recDot, dotStyle]} />
        <Txt v="body" numberOfLines={2} style={{ flex: 1 }} color={interim ? palette.text : palette.textTertiary}>{interim || 'Listening…'}</Txt>
        <Bars volume={volume} />
        <Pressable onPress={onCycleLang} style={styles.langChip} accessibilityRole="button" accessibilityLabel={`Voice language ${lang}. Tap to change.`}>
          <Txt style={{ fontFamily: font.display, fontSize: 12 }} color={palette.textSecondary}>{lang}</Txt>
        </Pressable>
      </View>
      <Pressable onPress={onDone} style={[styles.micBtn, { backgroundColor: palette.cyan }]} accessibilityRole="button" accessibilityLabel="Stop and use text">
        <Ionicons name="checkmark" size={22} color={palette.navy} />
      </Pressable>
    </Animated.View>
  );
}

function Bars({ volume }: { volume: number }) {
  return (
    <View style={styles.bars}>
      {[0.6, 1, 0.75].map((k, i) => <Bar key={i} level={Math.max(0.15, volume * k)} />)}
    </View>
  );
}
function Bar({ level }: { level: number }) {
  const h = useSharedValue(0.15);
  useEffect(() => { h.value = withTiming(level, { duration: 120 }); }, [level]);
  const st = useAnimatedStyle(() => ({ height: interpolate(h.value, [0, 1], [3, 18]) }));
  return <Animated.View style={[styles.bar1, st]} />;
}

const chunk = <T,>(xs: readonly T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

const styles = themed(() => ({
  wrap: { backgroundColor: palette.navyDeep, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.hairline, paddingTop: 8 },
  bar: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 8, gap: 4, minHeight: 48 },
  iconBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  dot: { position: 'absolute', top: 9, right: 9, width: 8, height: 8, borderRadius: 4, backgroundColor: palette.amber, borderWidth: 1.5, borderColor: palette.navyDeep },
  actions: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 6 },
  tile: { width: 80, alignItems: 'center', gap: 3 },
  tileIcon: { width: 54, height: 54, borderRadius: 27, alignItems: 'center', justifyContent: 'center', marginBottom: 3 },
  tileDot: { position: 'absolute', top: 2, right: 2, width: 12, height: 12, borderRadius: 6, backgroundColor: palette.red, borderWidth: 2, borderColor: palette.navyDeep },
  trayLabel: { marginTop: 6, marginLeft: 2, letterSpacing: 1 },
  field: {
    flex: 1, flexDirection: 'row', alignItems: 'flex-end', minHeight: 44, maxHeight: 128, borderRadius: 22,
    backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.hairline, paddingLeft: 14,
  },
  input: { ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : null), flex: 1, color: palette.text, fontFamily: font.body, fontSize: 15, lineHeight: 20, paddingTop: 11, paddingBottom: 11, maxHeight: 124 },
  emojiBtn: { width: 40, height: 42, alignItems: 'center', justifyContent: 'center' },
  morphSlot: { width: 44, height: 44, marginLeft: 2 },
  center: { alignItems: 'center', justifyContent: 'center' },
  micBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.surfaceRaised },
  sendBtn: { borderRadius: 22 },
  notice: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 12, marginBottom: 8, paddingHorizontal: 12, paddingVertical: 9,
    borderRadius: radius.chip, backgroundColor: palette.redSoft, borderWidth: 1, borderColor: palette.redBorder,
  },
  mentionBox: {
    marginHorizontal: 10, marginBottom: 8, padding: 10, borderRadius: radius.card, backgroundColor: palette.surface,
    borderWidth: 1, borderColor: palette.hairlineStrong, shadowColor: palette.shadow, shadowOpacity: 0.2, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 6,
  },
  mentionRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 8, borderRadius: radius.chip },
  careIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: palette.cyan, alignItems: 'center', justifyContent: 'center' },
  careNotice: { flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: 14, marginBottom: 6 },
  offline: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingBottom: 6 },
  mutedBar: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', paddingHorizontal: 16, paddingTop: 14, backgroundColor: palette.navyDeep, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.hairline },
  tray: { overflow: 'hidden' },
  trayGrid: { padding: 12, gap: 10, paddingBottom: 20 },
  trayRow: { flexDirection: 'row', gap: 10 },
  voice: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  voiceField: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingHorizontal: 12, borderRadius: 22,
    backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.redBorder,
  },
  recDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: palette.red },
  bars: { flexDirection: 'row', alignItems: 'center', gap: 3, height: 18 },
  bar1: { width: 3, borderRadius: 2, backgroundColor: palette.cyan },
  langChip: { paddingHorizontal: 8, height: 24, borderRadius: 8, backgroundColor: palette.surfaceRaised, alignItems: 'center', justifyContent: 'center' },
}));
