/** Random, friendly, non-identifying handles (prototype: "Quiet Tiger"). One per member per room. */
const ADJ = ['Amber', 'Quiet', 'Misty', 'Brave', 'Silver', 'Lucky', 'Sunny', 'Swift', 'Calm', 'Golden', 'Indigo', 'Mellow', 'Rapid', 'Cosmic', 'Gentle', 'Bright', 'Jolly', 'Coral', 'Velvet', 'Rustic', 'Breezy', 'Nimble', 'Merry', 'Lively'];
const ANI = ['Owl', 'Tiger', 'Heron', 'Otter', 'Falcon', 'Panda', 'Koala', 'Lynx', 'Dolphin', 'Fox', 'Peacock', 'Gecko', 'Sparrow', 'Robin', 'Yak', 'Kingfisher', 'Bison', 'Mynah', 'Langur', 'Pangolin', 'Hornbill', 'Squirrel', 'Cheetah', 'Flamingo'];
const ANIMAL_EMOJI: Record<string, string> = {
  Owl: '🦉', Tiger: '🐯', Heron: '🦩', Otter: '🦦', Falcon: '🦅', Panda: '🐼', Koala: '🐨', Lynx: '🐱', Dolphin: '🐬', Fox: '🦊', Peacock: '🦚', Gecko: '🦎',
  Sparrow: '🐦', Robin: '🐦', Yak: '🐂', Kingfisher: '🐦', Bison: '🦬', Mynah: '🐦', Langur: '🐒', Pangolin: '🦔', Hornbill: '🦜', Squirrel: '🐿️', Cheetah: '🐆', Flamingo: '🦩',
};
export function randomHandle(taken: Set<string>): string {
  for (let i = 0; i < 400; i++) {
    const h = `${ADJ[Math.floor(Math.random() * ADJ.length)]} ${ANI[Math.floor(Math.random() * ANI.length)]}`;
    if (!taken.has(h)) return h;
  }
  return `Traveller ${taken.size + 1}`;
}
/** The handle's animal doubles as its avatar in handle mode. */
export const handleEmoji = (handle: string) => ANIMAL_EMOJI[handle.split(' ').pop() ?? ''] ?? null;
