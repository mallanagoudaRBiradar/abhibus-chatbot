import { chatSocket } from './socket';
import { currentCoords, watchCoords } from './location';
import { useChat } from '../store/chatStore';
import type { LiveMinutes, RoomType } from '../shared/protocol';

/**
 * Live location (WhatsApp-style, 10 / 15 / 20 min). Updates are sent while the
 * app is open — we never ask for background location on a bus full of
 * strangers. Ends automatically, when stopped, or when leaving the chat.
 */
let stopWatch: (() => void) | null = null;
let endTimer: ReturnType<typeof setTimeout> | null = null;
let lastSent = 0;

export async function startLiveShare(roomType: RoomType, minutes: LiveMinutes): Promise<string | null> {
  await stopLiveShare();
  const coords = await currentCoords(); // throws LocationError with a friendly message
  const res = await chatSocket.startLiveLocation(roomType, coords, minutes);
  if (typeof res === 'string') return res;
  const until = res.payload?.live?.until ?? new Date(Date.now() + minutes * 60_000).toISOString();
  useChat.getState().setLiveShare({ messageId: res.id, roomType, until });

  stopWatch = await watchCoords((c) => {
    if (Date.now() - lastSent < 9_000) return;
    lastSent = Date.now();
    void chatSocket.liveLocationTick(res.id, c);
  });
  endTimer = setTimeout(() => { void stopLiveShare({ silent: true }); }, Date.parse(until) - Date.now());
  return null;
}

export async function stopLiveShare(opts: { silent?: boolean } = {}) {
  stopWatch?.();
  stopWatch = null;
  if (endTimer) clearTimeout(endTimer);
  endTimer = null;
  const live = useChat.getState().liveShare;
  if (!live) return;
  useChat.getState().setLiveShare(null);
  if (!opts.silent) await chatSocket.liveLocationStop(live.messageId);
}
