import React, { useCallback, useEffect, useState } from 'react';
import { Platform, ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { Txt } from '../components/Txt';
import { ThemeSwitch } from '../components/ThemeSwitch';
import { ProfileStep } from '../components/ProfileStep';

import { ToastHost, toast } from '../components/Toast';
import { currentCoords, LocationError } from '../services/location';
import { loadProfile, saveProfile } from '../services/prefs';
import type { JoinResponse } from '../shared/protocol';
import { api, ApiError } from '../services/api';
import { getDeviceId, saveSession } from '../services/session';
import { useChat } from '../store/chatStore';
import { clock } from '../utils/format';
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
  const [error, setError] = useState<{ code: string; message: string; opensAt?: string } | null>(null);
  // Placeholders are deliberately faint: a bright example PNR reads as "already filled in".
  const [demo, setDemo] = useState<{ pnr: string; label: string; seats: string[] }[]>([]);

  // Steps: ticket (PNR + seat) → profile (name + avatar) → join. A scanned QR opens straight on the profile step.
  const [step, setStep] = useState<'ticket' | 'profile'>('ticket');
  const [pending, setPending] = useState<{ kind: 'pnr'; pnr: string; seat: string } | { kind: 'qr'; token: string } | null>(null);
  const [savedProfile, setSavedProfile] = useState<{ name: string; avatar: string | null } | null>(null);
  useEffect(() => { loadProfile().then(setSavedProfile); }, []);

  const enter = async (res: JoinResponse, profile: { name: string; avatar: string | null }) => {
    await saveSession(res);
    await saveProfile(profile);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    useChat.getState().reset();
    useChat.getState().setSession(res);
  };
  const fail = (e: unknown) => {
    const err = e as ApiError;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    setError({ code: err.code, message: err.message, opensAt: err.meta?.opensAt });
  };

  /** Ticket step → profile step (nothing is sent until the profile is set). */
  const next = useCallback((p = pnr, s = seat) => {
    if (!p.trim() || !s.trim()) { setError({ code: 'INVALID', message: 'Enter the PNR and seat number from your ticket.' }); return; }
    setError(null);
    setPending({ kind: 'pnr', pnr: p.trim(), seat: s.trim() });
    setStep('profile');
  }, [pnr, seat]);

  const join = async (profile: { name: string; avatar: string | null }) => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      if (pending.kind === 'pnr') {
        await enter(await api.join({ pnr: pending.pnr, seat: pending.seat, deviceId: await getDeviceId(), profile }), profile);
      } else {
        // Phone browsers block location on plain-http pages; send null and let the server decide (demo skips, production asks again).
        const coords = await currentCoords().catch(() => null);
        const res = await api.joinQr({ token: pending.token, deviceId: await getDeviceId(), coords, profile });
        if (res.qrCheck.skipped) toast(`Demo: location check skipped${res.qrCheck.busKm != null ? ` (you’re ${res.qrCheck.busKm} km from the bus)` : ''}`, 'info');
        await enter(res, profile);
      }
    } catch (e) {
      if (e instanceof LocationError) setError({ code: 'LOCATION', message: e.message });
      else fail(e);
    } finally {
      setBusy(false);
    }
  };

  // Deep links: abhibus-chat://join?pnr=AB7X2K9Q&seat=12L · abhibus-chat://qr?t=<invite> · web: /?qr=<invite>
  useEffect(() => {
    const handle = (url: string | null) => {
      if (!url) return;
      const token = tokenFromInvite(url);
      if (token) { setPending({ kind: 'qr', token }); setStep('profile'); return; }
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

  return (
    <KeyboardAwareScrollView style={{ flex: 1, backgroundColor: palette.navy }} contentContainerStyle={[styles.page, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}
      keyboardShouldPersistTaps="handled" bottomOffset={24}>
      <Animated.View entering={FadeIn.duration(500)} style={styles.brandRow}>
        <Txt style={styles.brand} color={palette.red}>AbhiBus</Txt>
        <ThemeSwitch compact />
      </Animated.View>

      {step === 'profile' && pending ? (
        <ProfileStep initial={savedProfile} busy={busy} error={error?.message ?? null}
          cta={pending.kind === 'qr' ? 'Check location & join' : 'Join trip chat'}
          note={pending.kind === 'qr' ? 'We’ll ask for your location once, to confirm you’re with this bus.' : 'Chat opens when your bus departs and is deleted 2 hours after arrival.'}
          onBack={() => { setStep('ticket'); setError(null); }} onSubmit={join} />
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
          Talk to the people on your bus, see stop timers from the conductor and know where the bus is. You’ll show up by your first name and avatar.
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
            {notLive && error.opensAt ? `Trip chat opens at ${clock(error.opensAt)}, 30 minutes before your bus departs.` : error.message}
          </Txt>
        </Animated.View>
      )}

      <Pressable onPress={() => next()} disabled={busy} style={({ pressed }) => [styles.cta, pressed && { opacity: 0.85 }, busy && { opacity: 0.7 }]}
        accessibilityRole="button" accessibilityLabel="Continue">
        {busy ? <ActivityIndicator color={palette.navy} /> : <Txt v="bodyStrong" color={palette.navy}>Continue</Txt>}
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
        Chat opens when your bus departs and is deleted 2 hours after arrival.
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
