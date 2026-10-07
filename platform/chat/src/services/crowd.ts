import * as Location from 'expo-location';
import { chatSocket } from './socket';
import { currentCoords } from './location';
import { useChat } from '../store/chatStore';

/**
 * Anonymous crowd location: while on board, a traveller can let their phone
 * help everyone see where the vehicle is. Only the fused estimate is shown
 * ("3 travellers on board"), never who shared. Foreground only; stops when the
 * trip goes read-only or the person turns it off.
 */
let watcher: Location.LocationSubscription | null = null;
let last = 0;

export async function startCrowdShare(): Promise<string | null> {
  try {
    const coords = await currentCoords();
    const ack = await chatSocket.crowdShare(true, coords);
    if (!ack.ok) return ack.message;
    watcher?.remove();
    watcher = await Location.watchPositionAsync({ accuracy: Location.Accuracy.Balanced, timeInterval: 60_000, distanceInterval: 200 }, (pos) => {
      if (Date.now() - last < 55_000) return;
      last = Date.now();
      const st = useChat.getState().session?.journey.state;
      if (st === 'read_only' || st === 'closed') { void stopCrowdShare(); return; }
      void chatSocket.crowdPing({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy ?? null });
    });
    return null;
  } catch (e: any) { return e?.message ?? 'Couldn’t get your location.'; }
}

export async function stopCrowdShare() {
  watcher?.remove();
  watcher = null;
  if (useChat.getState().sharingLocation) await chatSocket.crowdShare(false);
}
