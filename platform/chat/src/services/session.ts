import { uuid } from '../utils/uuid';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/** A stable per-install id (diagnostics only). The member token is the identity. */
const K_DEVICE = 'triprooms.chat.device';
export async function getDeviceId(): Promise<string> {
  const get = () => (Platform.OS === 'web' ? Promise.resolve(localStorage.getItem(K_DEVICE)) : SecureStore.getItemAsync(K_DEVICE));
  let id = await get().catch(() => null);
  if (!id) { id = uuid(); try { Platform.OS === 'web' ? localStorage.setItem(K_DEVICE, id) : await SecureStore.setItemAsync(K_DEVICE, id); } catch { /* */ } }
  return id;
}
export async function clearSession() { /* tokens live in the host app; nothing persisted here */ }
