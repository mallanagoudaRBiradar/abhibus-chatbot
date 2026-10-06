import React, { useEffect, useState } from 'react';
import { useColorScheme, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { useFonts } from 'expo-font';
import { Sora_600SemiBold, Sora_700Bold } from '@expo-google-fonts/sora';
import {
  PlusJakartaSans_400Regular, PlusJakartaSans_500Medium, PlusJakartaSans_600SemiBold, PlusJakartaSans_700Bold,
} from '@expo-google-fonts/plus-jakarta-sans';
import { JoinScreen } from './src/screens/JoinScreen';
import { BusChatScreen } from './src/screens/BusChatScreen';
import { loadSession } from './src/services/session';
import { loadThemePref } from './src/services/prefs';
import { useChat } from './src/store/chatStore';
import { FRAME_MAX, palette, setActiveMode, themed, useThemePref } from './src/theme/tokens';

/**
 * Root. Two states only: no session -> PNR gate, session -> live chat.
 * A saved, unexpired session resumes straight into the chat (e.g. after the
 * OS killed the app overnight).
 */
export default function App() {
  const [fontsLoaded] = useFonts({
    Sora_600SemiBold, Sora_700Bold,
    PlusJakartaSans_400Regular, PlusJakartaSans_500Medium, PlusJakartaSans_600SemiBold, PlusJakartaSans_700Bold,
  });
  const session = useChat((s) => s.session);
  const [booting, setBooting] = useState(true);
  // Back from the chat = step out to home, not leave. The session and socket
  // state survive, so the trip stays one tap away ("Exit chat" is in the ⋮ menu).
  const [away, setAway] = useState(false);
  useEffect(() => { setAway(false); }, [session?.token]);

  // Theme: resolve Auto against the OS, set it before any child reads a colour,
  // and remount the tree (key) when it changes so every surface repaints.
  const scheme = useColorScheme();
  const pref = useThemePref((s) => s.pref);
  const mode = pref === 'system' ? (scheme === 'light' ? 'light' : 'dark') : pref;
  setActiveMode(mode);

  useEffect(() => {
    Promise.all([
      loadThemePref().then((p) => useThemePref.getState().setPref(p)),
      loadSession().then((s) => { if (s) useChat.getState().setSession(s); }),
    ]).finally(() => setBooting(false));
  }, []);

  if (!fontsLoaded || booting) return <View style={{ flex: 1, backgroundColor: palette.navy }} />;

  return (
    <GestureHandlerRootView key={mode} style={styles.outer}>
      {/* Phone-width column on tablets / desktop browsers; sheets portal inside it. */}
      <View style={styles.frame}>
      <SafeAreaProvider>
        <KeyboardProvider>
          <BottomSheetModalProvider>
            <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
            {session && !away ? <BusChatScreen key={session.token} onBack={() => setAway(true)} /> : <JoinScreen onResume={session ? () => setAway(false) : undefined} />}
          </BottomSheetModalProvider>
        </KeyboardProvider>
      </SafeAreaProvider>
      </View>
    </GestureHandlerRootView>
  );
}

const styles = themed(() => ({
  outer: { flex: 1, backgroundColor: palette.outer, alignItems: 'center' },
  frame: {
    flex: 1, width: '100%', maxWidth: FRAME_MAX, backgroundColor: palette.navy, overflow: 'hidden',
    borderLeftWidth: 1, borderRightWidth: 1, borderColor: palette.hairline,
  },
}));
