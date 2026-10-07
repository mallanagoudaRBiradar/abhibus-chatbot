import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useTheme } from '../lib/theme';
import { Btn, Seg } from './ui';

/**
 * The real hosted chat screen (platform/chat) embedded as a demo traveller of this room.
 * Exactly what AbhiBus / ConfirmTkt / ixigo users get inside their app's WebView.
 */
export function LivePhone({ roomId, brand }: { roomId: string; brand?: string }) {
  const [gender, setGender] = useState<'U' | 'F'>('U');
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [n, setN] = useState(0);
  const { mode } = useTheme();
  const src = url ? `${url}&theme=${mode}` : null; // the chat screen follows the console's light/dark theme
  useEffect(() => {
    let off = false;
    setUrl(null); setErr(null);
    api<{ chat_url: string }>(`/rooms/${roomId}/preview-member`, { body: { gender } })
      .then(async (r) => {
        if (off) return;
        setUrl(r.chat_url);
        try { await fetch(new URL(r.chat_url).origin, { mode: 'no-cors' }); setReachable(true); } catch { setReachable(false); }
      })
      .catch((e) => !off && setErr(e.message));
    return () => { off = true; };
  }, [roomId, gender, n]);
  return (
    <aside className="live">
      <span className="lt">Live traveller view</span>
      <Seg value={gender} onChange={setGender} options={[['U', 'Any traveller'], ['F', 'Woman traveller']]} />
      <div className="phone frame" style={brand ? ({ ['--brand' as any]: brand }) : undefined}>
        {src && reachable !== false ? <iframe key={src} src={src} title="Traveller chat screen" allow="geolocation; camera; clipboard-write" /> : (
          <div className="phone-ph">
            <b>{err ? 'Can’t open the room' : reachable === false ? 'Chat screen is not running' : 'Opening the room…'}</b>
            <p>{err ?? (reachable === false ? 'Start platform/chat (npx expo start --web --port 8090), then retry.' : 'Joining as a demo traveller.')}</p>
            {(err || reachable === false) && <div><Btn sm onClick={() => setN((x) => x + 1)}>Retry</Btn></div>}
          </div>
        )}
      </div>
      {src && <a className="hint lnk" href={src} target="_blank" rel="noreferrer">Open in a new tab ↗</a>}
      <p className="hint" style={{ maxWidth: 360, textAlign: 'center' }}>No profile setup needed. Your posts here are real messages in this room.</p>
    </aside>
  );
}
