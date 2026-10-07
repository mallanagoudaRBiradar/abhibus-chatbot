import * as Native from 'expo-haptics';
import { Platform } from 'react-native';
import { host } from './host';
import { useSettings } from '../store/settings';

/**
 * Drop-in for expo-haptics. Native app: the device engine. Inside the AbhiBus
 * WebView: asks the app (`haptic` bridge message) when it supports it.
 * Plain browser: nothing.
 */
export { ImpactFeedbackStyle, NotificationFeedbackType } from 'expo-haptics';

const viaHost = (style: string) => { if (host.can('haptics')) host.post('haptic', { style }); return Promise.resolve(); };
const native = Platform.OS !== 'web';
/** Settings → Vibration off silences every buzz. */
const on = () => useSettings.getState().vibration;

export const selectionAsync = () => (!on() ? Promise.resolve() : native ? Native.selectionAsync() : viaHost('light'));
export const impactAsync = (style: Native.ImpactFeedbackStyle = Native.ImpactFeedbackStyle.Medium) => (!on() ? Promise.resolve() : native ? Native.impactAsync(style) : viaHost(style));
export const notificationAsync = (type: Native.NotificationFeedbackType = Native.NotificationFeedbackType.Success) => (!on() ? Promise.resolve() : native ? Native.notificationAsync(type) : viaHost(type));
