import { useCallback, useRef, useState } from 'react';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';

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

export function useVoiceInput(onFinal: (text: string) => void) {
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
    setError(e.error === 'no-speech' ? 'Didn’t catch that. Try again closer to the phone.'
      : e.error === 'language-not-supported' ? 'This language isn’t installed on your phone.'
      : e.error === 'not-allowed' ? 'Allow microphone access in Settings to use voice typing.'
      : 'Voice typing isn’t available right now.');
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

  return { listening, interim, volume, lang: VOICE_LANGS[langIdx], cycleLang, start, stop, cancel, error, clearError: () => setError(null) };
}
