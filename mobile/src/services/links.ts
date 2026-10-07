import { Linking } from 'react-native';
import { host } from './host';

/**
 * Open a phone number or an outside link. Inside the AbhiBus WebView, navigation
 * is locked to the chat, so the app does it (`call` / `openExternal`). If an older
 * app version lacks that capability, we still try the link directly.
 */
export function openUrl(url: string) {
  if (host.embedded) {
    if (url.startsWith('tel:') && host.can('call')) return host.post('call', { number: url.slice(4) });
    if (/^https?:/.test(url) && host.can('openExternal')) return host.post('openExternal', { url });
  }
  return Linking.openURL(url).catch(() => {});
}
