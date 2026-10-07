import React, { useCallback, useEffect, useState } from 'react';
import { Platform, ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { Ionicons } from '../components/icons';
import * as Haptics from '../services/haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { Txt } from '../components/Txt';
import { ThemeSwitch } from '../components/ThemeSwitch';

import { ToastHost, toast } from '../components/Toast';
import { currentCoords, LocationError } from '../services/location';
import type { JoinResponse } from '../shared/protocol';
import { api, ApiError } from '../services/api';
import { getDeviceId, saveSession } from '../services/session';
import { useChat } from '../store/chatStore';
import { clock } from '../utils/format';
import { LockedScreen } from './LockedScreen';
import type { TripLock } from '../services/host';
import { font, palette, radius, themed } from '../theme/tokens';

/**
 * PNR gate. In production the AbhiBus app opens this screen pre-filled
 * (deep link abhibus-chat://join?pnr=..&seat=..) from the "Your bus has
 * departed" push notification, so most passengers never type anything.
 * Manual entry stays as a fallback.
 */
/** Invite token from a scanned QR link (".../?qr=<token>" or "abhibus-chat://qr?t=<token>"). */
function tokenFromInvite(url: string): string | null {
  const m = url.match(/[?&](?:qr|t)=([^&#\s]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

export function JoinScreen({ onResume }: { onResume?: () => void }) {
  const live = useChat((s) => s.session);
  const insets = useSafeAreaInsets();
  const [pnr, setPnr] = useState('');
  const [seat, setSeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string; lock?: TripLock } | null>(null);
  // Placeholders are deliberately faint: a bright example PNR reads as "already filled in".
  const [demo, setDemo] = useState<{ pnr: string; label: string; seats: string[] }[]>([]);

  // Nobody types a name: the server hands out a random trip name + avatar ("Snoring Hulk").
  // PNR + seat joins straight away; a scanned QR waits for one tap (the location prompt needs it).
  const [qrToken, setQrToken] = useState<string | null>(null);

  const enter = async (res: JoinResponse) => {
    await saveSession(res);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    useChat.getState().reset();
    useChat.getState().setSession(res);
    toast(`You’re travelling as ${res.me.name} 🎭`, 'info');
  };
  const fail = (e: unknown) => {
    const err = e as ApiError;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    setError({ code: err.code, message: err.message, lock: err.meta?.opensAt ? (err.meta as TripLock) : undefined });
  };

  const join = async (pending: { kind: 'pnr'; pnr: string; seat: string } | { kind: 'qr'; token: string }) => {
    setBusy(true);
    setError(null);
    try {
      if (pending.kind === 'pnr') {
        await enter(await api.join({ pnr: pending.pnr, seat: pending.seat, deviceId: await getDeviceId() }));
      } else {
        // Phone browsers block location on plain-http pages; send null and let the server decide (demo skips, production asks again).
        const coords = await currentCoords().catch(() => null);
        const res = await api.joinQr({ token: pending.token, deviceId: await getDeviceId(), coords });
        if (res.qrCheck.skipped) toast(`Demo: location check skipped${res.qrCheck.busKm != null ? ` (you’re ${res.qrCheck.busKm} km from the bus)` : ''}`, 'info');
        await enter(res);
      }
    } catch (e) {
      if (e instanceof LocationError) setError({ code: 'LOCATION', message: e.message });
      else fail(e);
    } finally {
      setBusy(false);
    }
  };

  /** PNR + seat → join (no name step). */
  const next = useCallback((p = pnr, s = seat) => {
    if (!p.trim() || !s.trim()) { setError({ code: 'INVALID', message: 'Enter the PNR and seat number from your ticket.' }); return; }
    void join({ kind: 'pnr', pnr: p.trim(), seat: s.trim() });
  }, [pnr, seat]);

  // Deep links: abhibus-chat://join?pnr=AB7X2K9Q&seat=12L · abhibus-chat://qr?t=<invite> · web: /?qr=<invite>
  useEffect(() => {
    const handle = (url: string | null) => {
      if (!url) return;
      const token = tokenFromInvite(url);
      if (token) { setQrToken(token); return; }
      const q = url.split('?')[1] ?? '';
      const params = Object.fromEntries(q.split('&').map((kv) => kv.split('=').map(decodeURIComponent)));
      if (params.pnr && params.seat) { setPnr(params.pnr); setSeat(params.seat); next(params.pnr, params.seat); }
    };
    Linking.getInitialURL().then(handle);
    const sub = Linking.addEventListener('url', (e) => handle(e.url));
    return () => sub.remove();
  }, []);

  useEffect(() => { api.demoTickets().then((r) => setDemo(r.tickets)).catch(() => {}); }, []);

  const notLive = error?.code === 'TRIP_NOT_LIVE';
  if (notLive && error.lock) return <LockedScreen lock={error.lock} onBack={() => setError(null)} />;

  return (
    <KeyboardAwareScrollView style={{ flex: 1, backgroundColor: palette.navy }} contentContainerStyle={[styles.page, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}
      keyboardShouldPersistTaps="handled" bottomOffset={24}>
      <Animated.View entering={FadeIn.duration(500)} style={styles.brandRow}>
        <Txt style={styles.brand} color={palette.red}>AbhiBus</Txt>
        <ThemeSwitch compact />
      </Animated.View>

      {qrToken ? (
        <Animated.View entering={FadeInDown.duration(400)} style={{ gap: 10, marginTop: 28 }}>
          <Txt v="h1">Hop on with a QR 🎟️</Txt>
          <Txt v="body" color={palette.textSecondary}>
            You’ll get a random trip name like “Snoring Hulk” or “Window Seat Baburao”. We’ll ask for your location once, to confirm you’re with this bus.
          </Txt>
          {error && (
            <View style={styles.error} accessibilityLiveRegion="assertive">
              <Ionicons name="alert-circle-outline" size={18} color={palette.red} />
              <Txt v="small" style={{ flex: 1 }}>{error.message}</Txt>
            </View>
          )}
          <Pressable onPress={() => join({ kind: 'qr', token: qrToken })} disabled={busy} style={({ pressed }) => [styles.cta, pressed && { opacity: 0.85 }, busy && { opacity: 0.7 }]}
            accessibilityRole="button">
            {busy ? <ActivityIndicator color={palette.onCyan} /> : <Txt v="bodyStrong" color={palette.onCyan}>Check location & join</Txt>}
          </Pressable>
          <Pressable onPress={() => { setQrToken(null); setError(null); }} style={{ alignSelf: 'center', padding: 10 }} accessibilityRole="button">
            <Txt v="smallStrong" color={palette.textSecondary}>I have an AbhiBus ticket</Txt>
          </Pressable>
        </Animated.View>
      ) : (<>
      {live && onResume && (
        <Animated.View entering={FadeInDown.duration(300)}>
          <Pressable onPress={onResume} style={({ pressed }) => [styles.resume, pressed && { opacity: 0.85 }]} accessibilityRole="button"
            accessibilityLabel={`Back to your trip chat, ${live.journey.sourceCity} to ${live.journey.destinationCity}`}>
            <View style={styles.resumeIcon}><Ionicons name="chatbubbles" size={20} color={palette.navy} /></View>
            <View style={{ flex: 1 }}>
              <Txt v="micro" color={palette.cyan} style={{ letterSpacing: 0.8 }}>YOUR TRIP CHAT IS LIVE</Txt>
              <Txt v="bodyStrong" numberOfLines={1}>{`${live.journey.sourceCity} → ${live.journey.destinationCity}`}</Txt>
              <Txt v="meta" color={palette.textSecondary}>{`You’re in as ${live.me.name} · tap to go back in`}</Txt>
            </View>
            <Ionicons name="chevron-forward" size={20} color={palette.textSecondary} />
          </Pressable>
        </Animated.View>
      )}

      <Animated.View entering={FadeInDown.delay(80).duration(500)} style={{ gap: 10, marginTop: 28 }}>
        <Txt v="h1">Your bus has a chat tonight</Txt>
        <Txt v="body" color={palette.textSecondary}>
          Talk to the people on your bus, see stop timers and know where the bus is. You’ll get a random trip name like “Snoring Hulk” or “Chai Loving Jack Sparrow”, so nobody sees your real name.
        </Txt>
      </Animated.View>

      <Animated.View entering={FadeInDown.delay(160).duration(500)} style={styles.pass}>
        <View style={styles.passTop}>
          <Field label="PNR" value={pnr} onChange={(v) => setPnr(v.toUpperCase())} placeholder="AB7X2K9Q" flex={1.7} autoFocus={false} />
          <View style={styles.vRule} />
          <Field label="Seat" value={seat} onChange={(v) => setSeat(v.toUpperCase())} placeholder="12L" flex={1} onSubmit={() => next()} />
        </View>
        <View style={styles.perfRow}>
          <View style={[styles.notch, { left: -9 }]} />
          <View style={styles.perfLine} />
          <View style={[styles.notch, { right: -9 }]} />
        </View>
        <View style={styles.passStub}>
          <Ionicons name="eye-off-outline" size={16} color={palette.textSecondary} />
          <Txt v="small" color={palette.textSecondary} style={{ flex: 1 }}>Your seat, phone number and booking name are never shown to other passengers.</Txt>
        </View>
      </Animated.View>

      {error && (
        <Animated.View entering={FadeIn.duration(200)} style={[styles.error, notLive && { backgroundColor: palette.amberSoft, borderColor: palette.amberBorder }]} accessibilityLiveRegion="assertive">
          <Ionicons name={notLive ? 'time-outline' : 'alert-circle-outline'} size={18} color={notLive ? palette.amber : palette.red} />
          <Txt v="small" style={{ flex: 1 }}>
            {notLive && error.lock ? `Trip chat opens at ${clock(error.lock.opensAt)}.` : error.message}
          </Txt>
        </Animated.View>
      )}

      <Pressable onPress={() => next()} disabled={busy} style={({ pressed }) => [styles.cta, pressed && { opacity: 0.85 }, busy && { opacity: 0.7 }]}
        accessibilityRole="button" accessibilityLabel="Join trip chat">
        {busy ? <ActivityIndicator color={palette.onCyan} /> : <Txt v="bodyStrong" color={palette.onCyan}>Join trip chat</Txt>}
      </Pressable>

      {/* Guests (booked on RedBus etc.) don't type anything: they scan a passenger's QR with the phone camera. */}
      <View style={styles.qrHint}>
        <View style={styles.qrHintIcon}><Ionicons name="qr-code-outline" size={20} color={palette.text} /></View>
        <View style={{ flex: 1 }}>
          <Txt v="smallStrong">Booked on another app?</Txt>
          <Txt v="meta" color={palette.textSecondary}>Ask someone on your bus to show their trip chat QR and scan it with your phone camera.</Txt>
        </View>
      </View>

      <Txt v="meta" color={palette.textTertiary} style={{ textAlign: 'center', marginTop: 12 }}>
        Chat opens before the first passenger boards and is deleted 3 hours after the last drop.
      </Txt>

      {demo.length > 0 && (
        <Animated.View entering={FadeInDown.delay(260)} style={styles.demo}>
          <Txt v="smallStrong" color={palette.textSecondary}>Try a demo ticket</Txt>
          {demo.map((t) => (
            <Pressable key={t.pnr} onPress={() => { setPnr(t.pnr); setSeat(t.seats[0]); next(t.pnr, t.seats[0]); }}
              style={({ pressed }) => [styles.demoRow, pressed && { backgroundColor: palette.surfaceRaised }]} accessibilityRole="button">
              <View style={{ flex: 1 }}>
                <Txt v="smallStrong">{t.label}</Txt>
                <Txt v="meta" color={palette.textTertiary}>{`PNR ${t.pnr}, seat ${t.seats.join(' / ')}`}</Txt>
              </View>
              <Ionicons name="arrow-forward" size={16} color={palette.textTertiary} />
            </Pressable>
          ))}
        </Animated.View>
      )}
      </>)}
      <ToastHost />
    </KeyboardAwareScrollView>
  );
}

function Field({ label, value, onChange, placeholder, flex, onSubmit, autoFocus }: {
  label: string; value: string; onChange: (v: string) => void; placeholder: string; flex: number; onSubmit?: () => void; autoFocus?: boolean;
}) {
  return (
    <View style={{ flex, gap: 4 }}>
      <Txt v="meta" color={palette.textTertiary}>{label}</Txt>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={palette.placeholder}
        autoCapitalize="characters"
        autoCorrect={false}
        autoFocus={autoFocus}
        returnKeyType={onSubmit ? 'go' : 'next'}
        onSubmitEditing={onSubmit}
        style={styles.input}
        selectionColor={palette.cyan}
        accessibilityLabel={label}
      />
    </View>
  );
}

const styles = themed(() => ({
  page: { paddingHorizontal: 22 },
  resume: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 20, padding: 14, borderRadius: radius.card, backgroundColor: palette.cyanSoft, borderWidth: 1, borderColor: palette.cyanBorder },
  resumeIcon: { width: 40, height: 40, borderRadius: 12, backgroundColor: palette.cyan, alignItems: 'center', justifyContent: 'center' },
  brandRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brand: { fontFamily: font.displayBold, fontSize: 20, letterSpacing: -0.3 },
  pass: { marginTop: 28, borderRadius: radius.card, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.hairline },
  passTop: { flexDirection: 'row', padding: 18, gap: 16 },
  vRule: { width: StyleSheet.hairlineWidth, backgroundColor: palette.hairlineStrong },
  input: { ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : null), fontFamily: font.displayBold, fontSize: 22, color: palette.text, paddingVertical: 4, letterSpacing: 1 },
  perfRow: { height: 18, justifyContent: 'center' },
  perfLine: { marginHorizontal: 14, borderTopWidth: 1.5, borderColor: palette.hairlineStrong, borderStyle: 'dashed' },
  notch: { position: 'absolute', width: 18, height: 18, borderRadius: 9, backgroundColor: palette.navy },
  passStub: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18, paddingVertical: 14 },
  error: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14, padding: 12, borderRadius: radius.chip, backgroundColor: palette.redSoft, borderWidth: 1, borderColor: palette.redBorder },
  cta: { marginTop: 18, height: 54, borderRadius: radius.pill, backgroundColor: palette.cyan, alignItems: 'center', justifyContent: 'center' },
  demo: { marginTop: 36, gap: 8 },
  qrHint: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 14, padding: 14, borderRadius: radius.card, backgroundColor: palette.surfaceSunk, borderWidth: 1, borderColor: palette.hairline },
  qrHintIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.surfaceRaised },
  demoRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, borderRadius: radius.chip, backgroundColor: palette.surfaceSunk, borderWidth: 1, borderColor: palette.hairline },
}));
