import * as Location from 'expo-location';
import { host } from './host';

export class LocationError extends Error {}
type Coords = { lat: number; lng: number; accuracyM: number | null };

/** Inside the AbhiBus WebView: the app reads its own GPS (`locationRequest` → `location`). */
async function fromHost(): Promise<Coords> {
  if (!host.can('location')) throw new LocationError('Sharing your location needs the latest AbhiBus app.');
  host.post('locationRequest');
  const r = await host.next<{ lat?: number; lng?: number; accuracyM?: number | null; denied?: boolean }>('location', 15_000);
  if (!r) throw new LocationError('Couldn’t get your location. Check that location is on and try again.');
  if (r.denied || typeof r.lat !== 'number' || typeof r.lng !== 'number') throw new LocationError('Location access is off. Allow it for AbhiBus in your phone settings.');
  return { lat: r.lat, lng: r.lng, accuracyM: r.accuracyM ?? null };
}

/** One fix from this phone, with friendly errors. Only ever called after the person chose to share. */
export async function currentCoords(): Promise<Coords> {
  if (host.embedded) return fromHost();
  const perm = await Location.requestForegroundPermissionsAsync();
  if (perm.status !== 'granted') throw new LocationError('Location access is off. Allow it in your phone or browser settings.');
  try {
    const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    return { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy ?? null };
  } catch {
    throw new LocationError('Couldn’t get your location. Check that location is on and try again.');
  }
}

/** Fixes every ~10 s while live sharing (foreground only). Returns a stop function. */
export async function watchCoords(onFix: (c: Coords) => void): Promise<() => void> {
  if (host.embedded) {
    const t = setInterval(() => { fromHost().then(onFix).catch(() => {}); }, 10_000);
    return () => clearInterval(t);
  }
  const sub = await Location.watchPositionAsync(
    { accuracy: Location.Accuracy.Balanced, timeInterval: 10_000, distanceInterval: 15 },
    (pos) => onFix({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy ?? null }),
  );
  return () => sub.remove();
}
