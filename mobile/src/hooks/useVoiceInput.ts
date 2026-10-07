import { useCallback, useEffect, useRef, useState } from 'react';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { host } from '../services/host';

/**
 * Device speech-to-text (Apple Speech / Android SpeechRecognizer).
 * The transcript lands in the input box for review — nothing is sent until
 * the passenger taps send. Audio is never recorded to disk or uploaded by us.
 *
 * Indian languages: the chip in the composer cycles English (India), Hindi
 * and Telugu. Availability depends on the device's installed language packs.
 */
export const VOICE_LANGS = [
  { code: 'en-IN', short: 'EN' },
  { code: 'hi-IN', short: 'हि' },
  { code: 'te-IN', short: 'తె' },
] as const;

const ERROR_COPY: Record<string, string> = {
  'no-speech': 'Didn’t catch that. Try again closer to the phone.',
  'language-not-supported': 'This language isn’t installed on your phone.',
  'not-allowed': 'Allow microphone access in Settings to use voice typing.',
};
const errorCopy = (code: string) => ERROR_COPY[code] ?? 'Voice typing isn’t available right now.';

/** Native app / browser: the device speech engine through expo-speech-recognition. */
function useDeviceVoice(onFinal: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [volume, setVolume] = useState(0);
  const [langIdx, setLangIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const finalRef = useRef('');
  const cancelled = useRef(false);

  useSpeechRecognitionEvent('start', () => { setListening(true); setError(null); });
  useSpeechRecognitionEvent('end', () => {
    setListening(false);
    setVolume(0);
    if (!cancelled.current && finalRef.current.trim()) onFinal(finalRef.current.trim());
    finalRef.current = '';
    setInterim('');
  });
  useSpeechRecognitionEvent('result', (e) => {
    const text = e.results[0]?.transcript ?? '';
    if (e.isFinal) finalRef.current = text;
    setInterim(text);
  });
  useSpeechRecognitionEvent('volumechange', (e) => setVolume(Math.max(0, Math.min(1, (e.value + 2) / 12))));
  useSpeechRecognitionEvent('error', (e) => {
    if (e.error === 'aborted') return;
    setError(errorCopy(e.error));
  });

  const start = useCallback(async () => {
    const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!perm.granted) { setError('Allow microphone access in Settings to use voice typing.'); return; }
    cancelled.current = false;
    finalRef.current = '';
    setInterim('');
    ExpoSpeechRecognitionModule.start({
      lang: VOICE_LANGS[langIdx].code,
      interimResults: true,
      continuous: false,
      addsPunctuation: true,
      volumeChangeEventOptions: { enabled: true, intervalMillis: 120 },
    });
  }, [langIdx]);

  const stop = useCallback(() => ExpoSpeechRecognitionModule.stop(), []);
  const cancel = useCallback(() => { cancelled.current = true; ExpoSpeechRecognitionModule.abort(); }, []);
  const cycleLang = useCallback(() => setLangIdx((i) => (i + 1) % VOICE_LANGS.length), []);

  return { available: true, listening, interim, volume, lang: VOICE_LANGS[langIdx], cycleLang, start, stop, cancel, error, clearError: () => setError(null) };
}

/**
 * Inside the AbhiBus WebView: the app runs speech recognition and streams text
 * back (voiceStart → voiceResult… → voiceEnd / voiceError). Hidden when the app
 * doesn't offer the `voice` capability.
 */
function useHostVoice(onFinal: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [langIdx, setLangIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const finalRef = useRef('');
  const cancelled = useRef(false);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  useEffect(() => {
    const finish = () => {
      setListening(false);
      if (!cancelled.current && finalRef.current.trim()) onFinalRef.current(finalRef.current.trim());
      finalRef.current = '';
      setInterim('');
    };
    const offs = [
      host.on('voiceResult', (d: { text?: string; final?: boolean }) => {
        const text = String(d.text ?? '');
        setInterim(text);
        if (d.final) { finalRef.current = text; finish(); }
      }),
      host.on('voiceEnd', finish),
      host.on('voiceError', (d: { error?: string }) => { setListening(false); setInterim(''); if (d.error !== 'aborted') setError(errorCopy(String(d.error ?? ''))); }),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  const start = useCallback(async () => {
    cancelled.current = false;
    finalRef.current = '';
    setInterim('');
    setError(null);
    setListening(true);
    host.post('voiceStart', { locale: VOICE_LANGS[langIdx].code });
  }, [langIdx]);
  const stop = useCallback(() => host.post('voiceStop', { cancel: false }), []);
  const cancel = useCallback(() => { cancelled.current = true; setListening(false); setInterim(''); host.post('voiceStop', { cancel: true }); }, []);
  const cycleLang = useCallback(() => setLangIdx((i) => (i + 1) % VOICE_LANGS.length), []);

  return { available: host.can('voice'), listening, interim, volume: listening ? 0.35 : 0, lang: VOICE_LANGS[langIdx], cycleLang, start, stop, cancel, error, clearError: () => setError(null) };
}

/** Picked once per runtime, so hook order never changes between renders. */
export const useVoiceInput = host.embedded ? useHostVoice : useDeviceVoice;
