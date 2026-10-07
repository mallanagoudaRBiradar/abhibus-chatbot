import type { Member } from '@prisma/client';
import { handleEmoji } from '../shared/handles';
import type { IdentityMode } from '../shared/protocol';

/**
 * How a member appears to others. Handle mode: "Quiet Tiger" + 🐯. Profile
 * mode: the first name + avatar they picked (falls back to the handle until
 * they do). Booking name, phone, gender and seat never appear.
 */
export function display(m: Pick<Member, 'handle' | 'displayName' | 'avatarId' | 'profileSet' | 'role'>, mode: IdentityMode) {
  if (m.role !== 'traveller') return { name: m.displayName ?? m.handle, avatar: null as string | null };
  if (mode === 'profile' && m.profileSet && m.displayName) return { name: m.displayName, avatar: m.avatarId };
  const e = handleEmoji(m.handle);
  return { name: m.handle, avatar: e ? `emoji:${e}` : null };
}
