/** Tiny in-app event bus for UI reactions that aren't state (e.g. "I just sent something → scroll to the latest"). */
type Events = {
  sent: { roomType: 'MAIN_COMMON' | 'WOMEN_ONLY' };
  /** Scroll the room to a message (the "Up next" ticker → a game waiting for you). */
  jumpTo: { roomType: 'MAIN_COMMON' | 'WOMEN_ONLY'; messageId: string };
};
const listeners: { [K in keyof Events]?: Set<(e: Events[K]) => void> } = {};
export const chatEvents = {
  on<K extends keyof Events>(k: K, fn: (e: Events[K]) => void) {
    (listeners[k] ??= new Set() as never).add(fn as never);
    return () => { listeners[k]?.delete(fn as never); };
  },
  emit<K extends keyof Events>(k: K, e: Events[K]) { listeners[k]?.forEach((fn) => (fn as (x: Events[K]) => void)(e)); },
};
