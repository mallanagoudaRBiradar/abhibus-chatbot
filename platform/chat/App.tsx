import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, useColorScheme, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { useFonts } from 'expo-font';
import { Ionicons } from '@expo/vector-icons';
import { Sora_600SemiBold, Sora_700Bold } from '@expo-google-fonts/sora';
import {
  PlusJakartaSans_400Regular, PlusJakartaSans_500Medium, PlusJakartaSans_600SemiBold, PlusJakartaSans_700Bold,
} from '@expo-google-fonts/plus-jakarta-sans';
import { TripChatScreen } from './src/screens/TripChatScreen';
import { Txt } from './src/components/Txt';
import { api, ApiError } from './src/services/api';
import { launchToken, notifyHost, forgetToken } from './src/services/host';
import { loadThemePref } from './src/services/prefs';
import { useChat } from './src/store/chatStore';
import { UNIT } from './src/tenant';
import { FRAME_MAX, palette, setActiveMode, setBrand, themed, useThemePref } from './src/theme/tokens';

/**
 * Trip Rooms hosted chat screen. Opened by a tenant app (AbhiBus, ConfirmTkt,
 * ixigo Trains, ixigo Flights…) with a short-lived member token:
 *   token → GET /chat/v1/session → brand + features + room → realtime.
 * No login, no PNR entry: the tenant already knows who the traveller is.
 */
type Boot = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; title: string; body: string; retry: boolean };

export default function App() {
  const [fontsLoaded] = useFonts({
    Sora_600SemiBold, Sora_700Bold,
    PlusJakartaSans_400Regular, PlusJakartaSans_500Medium, PlusJakartaSans_600SemiBold, PlusJakartaSans_700Bold,
  });
  const session = useChat((s) => s.session);
  const [boot, setBoot] = useState<Boot>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  const scheme = useColorScheme();
  const pref = useThemePref((s) => s.pref);
  const mode = pref === 'system' ? (scheme === 'dark' ? 'dark' : 'light') : pref;
  setActiveMode(mode);

  useEffect(() => {
    let off = false;
    (async () => {
      useThemePref.getState().setPref(await loadThemePref());
      const token = await launchToken();
      if (!token) { setBoot({ kind: 'error', title: 'Open this from your trip', body: 'Trip chat opens from the “Trip chat” button on your booking in AbhiBus, ConfirmTkt or ixigo.', retry: false }); return; }
      try {
        const s = await api.session(token);
        if (off) return;
        setBrand(s.tenant.theme.brand, s.tenant.theme.brandInk, UNIT[s.journey.vertical]?.lounge);
        if (typeof document !== 'undefined') document.title = `${s.journey.routeName} · ${s.tenant.name} trip chat`;
        useChat.getState().setSession(s);
        setBoot({ kind: 'ready' });
      } catch (e) {
        const err = e as ApiError;
        if (err.status === 401) { forgetToken(); notifyHost('tr:token_expired'); }
        setBoot({ kind: 'error', title: err.status === 401 ? 'This link has expired' : err.status === 403 ? 'You can’t open this chat' : 'Couldn’t open the trip chat', body: err.message, retry: err.code === 'network' || err.status >= 500 });
      }
    })();
    return () => { off = true; };
  }, [attempt]);

  if (!fontsLoaded) return <View style={{ flex: 1, backgroundColor: palette.navy }} />;

  return (
    <GestureHandlerRootView key={mode} style={styles.outer}>
      <View style={styles.frame}>
        <SafeAreaProvider>
          <KeyboardProvider>
            <BottomSheetModalProvider>
              <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
              {boot.kind === 'ready' && session ? <TripChatScreen key={session.token} /> : boot.kind === 'loading' ? (
                <View style={styles.center}><ActivityIndicator color={palette.textSecondary} /><Txt v="small" color={palette.textSecondary}>Opening your trip chat…</Txt></View>
              ) : boot.kind === 'error' ? (
                <View style={styles.center}>
                  <View style={styles.icon}><Ionicons name="chatbubbles-outline" size={28} color={palette.textSecondary} /></View>
                  <Txt v="h2" style={{ textAlign: 'center' }}>{boot.title}</Txt>
                  <Txt v="body" color={palette.textSecondary} style={{ textAlign: 'center' }}>{boot.body}</Txt>
                  {boot.retry && <Pressable onPress={() => { setBoot({ kind: 'loading' }); setAttempt((n) => n + 1); }} style={styles.btn} accessibilityRole="button"><Txt v="bodyStrong">Try again</Txt></Pressable>}
                </View>
              ) : null}
            </BottomSheetModalProvider>
          </KeyboardProvider>
        </SafeAreaProvider>
      </View>
    </GestureHandlerRootView>
  );
}

const styles = themed(() => ({
  outer: { flex: 1, backgroundColor: palette.outer, alignItems: 'center' },
  frame: { flex: 1, width: '100%', maxWidth: FRAME_MAX, backgroundColor: palette.navy, overflow: 'hidden', borderLeftWidth: 1, borderRightWidth: 1, borderColor: palette.hairline },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 32 },
  icon: { width: 64, height: 64, borderRadius: 20, backgroundColor: palette.surface, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  btn: { marginTop: 12, height: 48, paddingHorizontal: 32, borderRadius: 999, backgroundColor: palette.surfaceRaised, alignItems: 'center', justifyContent: 'center' },
}));
