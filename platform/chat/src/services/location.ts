import * as Location from 'expo-location';

export class LocationError extends Error {}

/** One fix from this phone, with friendly errors. Only ever called after the person chose to share. */
export async function currentCoords(): Promise<{ lat: number; lng: number; accuracyM: number | null }> {
  const perm = await Location.requestForegroundPermissionsAsync();
  if (perm.status !== 'granted') throw new LocationError('Location access is off. Allow it in your phone or browser settings.');
  try {
    const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    return { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy ?? null };
  } catch {
    throw new LocationError('Couldn’t get your location. Check that location is on and try again.');
  }
}
