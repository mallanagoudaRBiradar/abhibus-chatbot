/**
 * Built-in content for the in-chat mini games. Kept short, family-friendly and
 * India-first (a sleeper bus at 1 AM is not the place for obscure trivia).
 * `answer` is the index of the correct option.
 */
export const QUIZ_BANK: { category: string; question: string; options: string[]; answer: number }[] = [
  { category: 'On this route', question: 'Which national highway connects Hyderabad and Bengaluru?', options: ['NH 44', 'NH 48', 'NH 65', 'NH 16'], answer: 0 },
  { category: 'On this route', question: 'Kurnool sits on the banks of which river?', options: ['Godavari', 'Tungabhadra', 'Kaveri', 'Krishna'], answer: 1 },
  { category: 'On this route', question: 'Anantapur district is famous for growing which crop?', options: ['Tea', 'Groundnut', 'Saffron', 'Apples'], answer: 1 },
  { category: 'On this route', question: 'Lepakshi, near this highway, is famous for its…', options: ['Hanging pillar', 'Sun temple', 'Step well', 'Sea fort'], answer: 0 },
  { category: 'India', question: 'Which is the longest national highway in India?', options: ['NH 48', 'NH 44', 'NH 27', 'NH 19'], answer: 1 },
  { category: 'India', question: 'Which city is called the “Silicon Valley of India”?', options: ['Hyderabad', 'Pune', 'Bengaluru', 'Chennai'], answer: 2 },
  { category: 'India', question: 'Hyderabad’s Charminar was built in which century?', options: ['14th', '16th', '18th', '19th'], answer: 1 },
  { category: 'India', question: 'Which state has the longest coastline in India?', options: ['Tamil Nadu', 'Maharashtra', 'Andhra Pradesh', 'Gujarat'], answer: 3 },
  { category: 'Cricket', question: 'Who has scored the most runs in ODI cricket?', options: ['Virat Kohli', 'Sachin Tendulkar', 'Ricky Ponting', 'Rohit Sharma'], answer: 1 },
  { category: 'Cricket', question: 'India won its first Cricket World Cup in which year?', options: ['1975', '1983', '1987', '2011'], answer: 1 },
  { category: 'Cricket', question: 'Which IPL team plays home games in Hyderabad?', options: ['Deccan Chargers', 'Sunrisers Hyderabad', 'Royal Challengers', 'Gujarat Titans'], answer: 1 },
  { category: 'Bollywood', question: 'Which film features the song “Chaiyya Chaiyya” on a train roof?', options: ['Dil Se', 'Taal', 'Bombay', 'Kuch Kuch Hota Hai'], answer: 0 },
  { category: 'Bollywood', question: '“Mogambo khush hua” is from which film?', options: ['Sholay', 'Mr. India', 'Karma', 'Don'], answer: 1 },
  { category: 'Tollywood', question: 'Which Telugu film’s song “Naatu Naatu” won an Oscar?', options: ['Pushpa', 'Baahubali 2', 'RRR', 'Ala Vaikunthapurramuloo'], answer: 2 },
  { category: 'Food', question: 'Hyderabadi biryani is traditionally cooked in which style?', options: ['Dum', 'Tandoor', 'Steamed idli', 'Deep fried'], answer: 0 },
];

/** Emoji puzzles. `answers` are accepted spellings (matched loosely inside a chat message). */
export const EMOJI_BANK: { category: string; emojis: string; title: string; answers: string[] }[] = [
  { category: 'Bollywood movie', emojis: '🔥 🐎 👬 🪙', title: 'Sholay', answers: ['sholay'] },
  { category: 'Bollywood movie', emojis: '🏏 🇮🇳 🐄 🌧️', title: 'Lagaan', answers: ['lagaan', 'lagan'] },
  { category: 'Bollywood movie', emojis: '🤼‍♀️ 👨‍👧‍👧 🥇', title: 'Dangal', answers: ['dangal'] },
  { category: 'Bollywood movie', emojis: '3️⃣ 🤓 🎓', title: '3 Idiots', answers: ['3 idiots', 'three idiots', '3idiots'] },
  { category: 'Bollywood movie', emojis: '🚂 💃 🌻 🇨🇭', title: 'Dilwale Dulhania Le Jayenge', answers: ['ddlj', 'dilwale dulhania le jayenge', 'dilwale dulhania'] },
  { category: 'Bollywood movie', emojis: '👽 📞 🏠', title: 'Koi Mil Gaya', answers: ['koi mil gaya', 'koimilgaya'] },
  { category: 'Bollywood movie', emojis: '🏃‍♂️ 🏅 🇮🇳', title: 'Bhaag Milkha Bhaag', answers: ['bhaag milkha bhaag', 'bhag milkha bhag', 'milkha'] },
  { category: 'Bollywood movie', emojis: '👑 🗡️ 🐘 🏰', title: 'Baahubali', answers: ['baahubali', 'bahubali'] },
  { category: 'Bollywood movie', emojis: '🌊 🔥 🤝 🏹', title: 'RRR', answers: ['rrr'] },
  { category: 'Bollywood movie', emojis: '🪵 🔴 🚛 😎', title: 'Pushpa', answers: ['pushpa'] },
  { category: 'Bollywood movie', emojis: '🧞 🎤 👨‍🦯 🚗', title: 'Andhadhun', answers: ['andhadhun', 'andhadhun'] },
  { category: 'Bollywood movie', emojis: '🍱 ✉️ 🚆', title: 'The Lunchbox', answers: ['lunchbox', 'the lunchbox'] },
  { category: 'Bollywood movie', emojis: '🏑 👩‍👩‍👧‍👧 🇮🇳', title: 'Chak De! India', answers: ['chak de', 'chakde', 'chak de india'] },
  { category: 'Bollywood movie', emojis: '🧓 🎈 🏠', title: 'Piku', answers: ['piku'] },
];

export const pickRandom = <T,>(xs: readonly T[], avoid?: (x: T) => boolean): T => {
  const pool = avoid ? xs.filter((x) => !avoid(x)) : xs;
  const from = pool.length ? pool : xs;
  return from[Math.floor(Math.random() * from.length)];
};

/** Lowercase, strip punctuation/emoji, collapse spaces — "Is it SHOLAY??" → "is it sholay". */
export const normalise = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** "Dilwale Dulhania Le Jayenge" → "D _ _ _ _ _ _   D _ _ …" style hint: first letter of each word. */
export const hintFor = (title: string) => title.split(/\s+/).map((w) => w[0].toUpperCase() + ' _'.repeat(Math.max(0, w.length - 1))).join('   ');
