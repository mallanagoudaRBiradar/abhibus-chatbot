import * as Location from 'expo-location';
import { chatSocket } from './socket';
import { currentCoords } from './location';
import { useChat } from '../store/chatStore';
import type { LiveMinutes, RoomType } from '../shared/protocol';

/**
 * Live location (WhatsApp-style, 10 / 15 / 20 min). Updates are sent while the
 * app is open — we never ask for background location on a bus full of
 * strangers. Ends automatically, when stopped, or when leaving the chat.
 */
let watcher: Location.LocationSubscription | null = null;
let endTimer: ReturnType<typeof setTimeout> | null = null;
let lastSent = 0;

export async function startLiveShare(roomType: RoomType, minutes: LiveMinutes): Promise<string | null> {
  await stopLiveShare();
  const coords = await currentCoords(); // throws LocationError with a friendly message
  const res = await chatSocket.startLiveLocation(roomType, coords, minutes);
  if (typeof res === 'string') return res;
  const until = res.payload?.live?.until ?? new Date(Date.now() + minutes * 60_000).toISOString();
  useChat.getState().setLiveShare({ messageId: res.id, roomType, until });

  watcher = await Location.watchPositionAsync(
    { accuracy: Location.Accuracy.Balanced, timeInterval: 10_000, distanceInterval: 15 },
    (pos) => {
      if (Date.now() - lastSent < 9_000) return;
      lastSent = Date.now();
      void chatSocket.liveLocationTick(res.id, { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy ?? null });
    },
  );
  endTimer = setTimeout(() => { void stopLiveShare({ silent: true }); }, Date.parse(until) - Date.now());
  return null;
}

export async function stopLiveShare(opts: { silent?: boolean } = {}) {
  watcher?.remove();
  watcher = null;
  if (endTimer) clearTimeout(endTimer);
  endTimer = null;
  const live = useChat.getState().liveShare;
  if (!live) return;
  useChat.getState().setLiveShare(null);
  if (!opts.silent) await chatSocket.liveLocationStop(live.messageId);
}
