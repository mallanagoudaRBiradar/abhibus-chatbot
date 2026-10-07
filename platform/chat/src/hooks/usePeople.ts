import { useCallback } from 'react';
import { useChat } from '../store/chatStore';
import type { Member } from '../shared/protocol';

export type Person = Pick<Member, 'name' | 'avatar' | 'guest'>;

/** Resolve an internal seat id to how that person appears: name + avatar (never the seat). */
export function personFrom(st: ReturnType<typeof useChat.getState>, seat: string | null | undefined): Person {
  if (!seat) return { name: 'Someone', avatar: null, guest: false };
  if (st.session?.me.seat === seat) return { name: st.session.me.name, avatar: st.session.me.avatar, guest: st.session.me.guest };
  for (const rt of ['MAIN_COMMON', 'WOMEN_ONLY'] as const) {
    const m = st.rooms[rt].presence.members?.find((x) => x.seat === seat);
    if (m) return { name: m.name, avatar: m.avatar, guest: m.guest };
  }
  for (const rt of ['MAIN_COMMON', 'WOMEN_ONLY'] as const) {
    const msg = st.rooms[rt].messages.find((x) => x.senderSeat === seat);
    if (msg) return { name: msg.senderHandle, avatar: msg.senderAvatar ?? null, guest: !!msg.senderGuest };
  }
  return { name: 'A passenger', avatar: null, guest: false };
}

/** Hook form: returns a stable lookup that re-renders when presence changes. */
export function usePeople() {
  useChat((s) => s.rooms.MAIN_COMMON.presence.members);
  useChat((s) => s.rooms.WOMEN_ONLY.presence.members);
  return useCallback((seat: string | null | undefined) => personFrom(useChat.getState(), seat), []);
}

export const nameList = (names: string[]) =>
  names.length <= 1 ? names[0] ?? '' : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, 2).join(', ')} and ${names.length - 2} other${names.length > 3 ? 's' : ''}`;
