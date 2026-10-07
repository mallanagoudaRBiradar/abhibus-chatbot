/**
 * ============================================================================
 *  Trip names: every passenger gets a random, funny identity on joining.
 * ============================================================================
 *  Name   = a bus-trip adjective + a famous hero or film character
 *           ("Snoring Hulk", "Window Seat Baburao", "Chai Loving Jack Sparrow").
 *  Avatar = the persona id ("p:<id>"):
 *           heroes      → an emblem badge (their symbol on their colour)
 *           characters  → a matching emoji face on a soft tile
 *  Nobody picks or types a name, so no real names or phone numbers leak.
 *  `for` steers the pool by the booking's gender (Women Zone gets women heroes
 *  and characters); 'any' fits everyone. Emblems are emoji/letters, never the
 *  studios' official logo artwork.
 *  Shared by server (assignment) and client (rendering). Keep both copies identical.
 * ============================================================================
 */
export type PersonaKind = 'hero' | 'character';
export interface Persona {
  id: string;
  name: string;
  kind: PersonaKind;
  /** Where they're from, shown in the profile sheet. */
  from: 'Marvel' | 'DC' | 'Desi hero' | 'Bollywood' | 'Desi TV' | 'Hollywood' | 'Animation';
  /** Emblem (heroes: an emoji or 1–2 letters) or face (characters). */
  glyph: string;
  /** Badge colour (heroes) / tile tint (characters). */
  color: string;
  for: 'm' | 'f' | 'any';
}

const h = (id: string, name: string, from: Persona['from'], glyph: string, color: string, f: Persona['for'] = 'm'): Persona => ({ id, name, kind: 'hero', from, glyph, color, for: f });
const c = (id: string, name: string, from: Persona['from'], glyph: string, color: string, f: Persona['for'] = 'm'): Persona => ({ id, name, kind: 'character', from, glyph, color, for: f });

export const PERSONAS: Persona[] = [
  // ------------------------------------------------------------ Marvel ---
  h('ironman', 'Iron Man', 'Marvel', '🦾', '#B3261E'),
  h('spiderman', 'Spider-Man', 'Marvel', '🕷️', '#D62839'),
  h('cap', 'Captain America', 'Marvel', '⭐', '#1F4E9C'),
  h('thor', 'Thor', 'Marvel', '🔨', '#3559B7'),
  h('hulk', 'Hulk', 'Marvel', '💪', '#2E8B3E'),
  h('panther', 'Black Panther', 'Marvel', '🐾', '#4B3B78'),
  h('strange', 'Doctor Strange', 'Marvel', '🔮', '#2C5AA0'),
  h('antman', 'Ant-Man', 'Marvel', '🐜', '#A61B1B'),
  h('deadpool', 'Deadpool', 'Marvel', '⚔️', '#8E1B1B'),
  h('wolverine', 'Wolverine', 'Marvel', '🐺', '#C9A227'),
  h('starlord', 'Star-Lord', 'Marvel', '🎧', '#9C4221'),
  h('hawkeye', 'Hawkeye', 'Marvel', '🏹', '#6A3D9A'),
  h('falcon', 'Falcon', 'Marvel', '🦅', '#8A1C2B'),
  h('shangchi', 'Shang-Chi', 'Marvel', '🐉', '#C0392B'),
  h('groot', 'Groot', 'Marvel', '🌳', '#6B4F2A', 'any'),
  h('rocket', 'Rocket', 'Marvel', '🦝', '#8B5A2B', 'any'),
  h('widow', 'Black Widow', 'Marvel', '🕸️', '#2B2B2B', 'f'),
  h('cmarvel', 'Captain Marvel', 'Marvel', '🌟', '#C62828', 'f'),
  h('wanda', 'Scarlet Witch', 'Marvel', '✨', '#B0124B', 'f'),
  h('storm', 'Storm', 'Marvel', '🌩️', '#455A8A', 'f'),
  h('msmarvel', 'Ms. Marvel', 'Marvel', '💫', '#1E5AA8', 'f'),
  h('gamora', 'Gamora', 'Marvel', '🗡️', '#2E7D4F', 'f'),
  h('wasp', 'Wasp', 'Marvel', '🐝', '#C9A227', 'f'),
  // ---------------------------------------------------------------- DC ---
  h('batman', 'Batman', 'DC', '🦇', '#1F1F24'),
  h('superman', 'Superman', 'DC', 'S', '#1F4FBF'),
  h('flash', 'Flash', 'DC', '⚡', '#C8102E'),
  h('aquaman', 'Aquaman', 'DC', '🔱', '#0F7C6E'),
  h('lantern', 'Green Lantern', 'DC', '💚', '#1B8A3A'),
  h('cyborg', 'Cyborg', 'DC', '🤖', '#5A6472'),
  h('shazam', 'Shazam', 'DC', '🌩️', '#B71C1C'),
  h('arrow', 'Green Arrow', 'DC', '🎯', '#2E6B30'),
  h('robin', 'Robin', 'DC', 'R', '#C62828'),
  h('wonder', 'Wonder Woman', 'DC', 'WW', '#B3001B', 'f'),
  h('supergirl', 'Supergirl', 'DC', 'S', '#2453C7', 'f'),
  h('batgirl', 'Batgirl', 'DC', '🦇', '#4A2B6B', 'f'),
  h('zatanna', 'Zatanna', 'DC', '🎩', '#3B2F63', 'f'),
  // --------------------------------------------------------- Desi heroes ---
  h('shaktimaan', 'Shaktimaan', 'Desi hero', '🌀', '#C9741B'),
  h('krrish', 'Krrish', 'Desi hero', '🎭', '#2B2B2B'),
  h('mrindia', 'Mr. India', 'Desi hero', '👻', '#7B1FA2'),
  h('minnal', 'Minnal Murali', 'Desi hero', '⚡', '#1565C0'),
  // ------------------------------------------ Bollywood comedy & classics ---
  c('baburao', 'Baburao', 'Bollywood', '👓', '#F2C14E'),
  c('raju', 'Raju', 'Bollywood', '🤑', '#7CB342'),
  c('shyam', 'Shyam', 'Bollywood', '😤', '#4FA3E0'),
  c('circuit', 'Circuit', 'Bollywood', '🕺', '#26A69A'),
  c('munna', 'Munna Bhai', 'Bollywood', '🤗', '#FF8A65'),
  c('chatur', 'Chatur', 'Bollywood', '🤓', '#9575CD'),
  c('rancho', 'Rancho', 'Bollywood', '🧠', '#4DB6AC'),
  c('virus', 'Virus', 'Bollywood', '🦠', '#81C784'),
  c('majnu', 'Majnu Bhai', 'Bollywood', '🎨', '#E57373'),
  c('udayshetty', 'Uday Shetty', 'Bollywood', '😎', '#FFB74D'),
  c('gogo', 'Crime Master Gogo', 'Bollywood', '🥸', '#A1887F'),
  c('mogambo', 'Mogambo', 'Bollywood', '😈', '#BA68C8'),
  c('gabbar', 'Gabbar', 'Bollywood', '🤠', '#BCAAA4'),
  c('chulbul', 'Chulbul Pandey', 'Bollywood', '🕶️', '#90A4AE'),
  c('gopal', 'Gopal', 'Bollywood', '😱', '#64B5F6'),
  c('lucky', 'Lucky', 'Bollywood', '🤐', '#AED581'),
  c('pappu', 'Pappu', 'Bollywood', '🥳', '#FFD54F'),
  c('basanti', 'Basanti', 'Bollywood', '🐎', '#F06292', 'f'),
  c('geet', 'Geet', 'Bollywood', '🚂', '#FF7043', 'f'),
  c('poo', 'Poo', 'Bollywood', '💅', '#EC407A', 'f'),
  c('simran', 'Simran', 'Bollywood', '🌻', '#FBC02D', 'f'),
  c('queen', 'Rani', 'Bollywood', '👑', '#AB47BC', 'f'),
  c('bunny', 'Naina', 'Bollywood', '🏔️', '#5C9DD5', 'f'),
  // ------------------------------------------------------------ Desi TV ---
  c('jethalal', 'Jethalal', 'Desi TV', '👔', '#E0A43B'),
  c('bhide', 'Bhide', 'Desi TV', '📏', '#7986CB'),
  c('popatlal', 'Popatlal', 'Desi TV', '☂️', '#4DD0E1'),
  c('daya', 'Daya', 'Desi TV', '💃', '#F48FB1', 'f'),
  c('babita', 'Babita', 'Desi TV', '💁‍♀️', '#CE93D8', 'f'),
  c('chacha', 'Chacha Chaudhary', 'Desi TV', '🧓', '#FFAB91', 'any'),
  // ---------------------------------------------------------- Hollywood ---
  c('sparrow', 'Jack Sparrow', 'Hollywood', '🏴‍☠️', '#8D6E63'),
  c('forrest', 'Forrest Gump', 'Hollywood', '🏃', '#81C784'),
  c('bond', 'James Bond', 'Hollywood', '🍸', '#78909C'),
  c('potter', 'Harry Potter', 'Hollywood', '🧙‍♂️', '#B71C1C'),
  c('gandalf', 'Gandalf', 'Hollywood', '🧙', '#B0BEC5'),
  c('sherlock', 'Sherlock', 'Hollywood', '🔍', '#8D6E63'),
  c('bean', 'Mr. Bean', 'Hollywood', '🚗', '#AED581'),
  c('rocky', 'Rocky', 'Hollywood', '🥊', '#E53935'),
  c('terminator', 'Terminator', 'Hollywood', '🤖', '#90A4AE'),
  c('indiana', 'Indiana Jones', 'Hollywood', '🗺️', '#A1887F'),
  c('neo', 'Neo', 'Hollywood', '🕶️', '#43A047'),
  c('chaplin', 'Charlie Chaplin', 'Hollywood', '🎩', '#9E9E9E'),
  c('jack', 'Jack Dawson', 'Hollywood', '🚢', '#4FC3F7'),
  c('hermione', 'Hermione', 'Hollywood', '📚', '#A1887F', 'f'),
  c('rose', 'Rose', 'Hollywood', '🌹', '#E57373', 'f'),
  c('lara', 'Lara Croft', 'Hollywood', '🏺', '#BCAAA4', 'f'),
  c('katniss', 'Katniss', 'Hollywood', '🏹', '#FF8A65', 'f'),
  c('poppins', 'Mary Poppins', 'Hollywood', '☂️', '#9FA8DA', 'f'),
  c('wednesday', 'Wednesday', 'Hollywood', '🖤', '#757575', 'f'),
  c('barbie', 'Barbie', 'Hollywood', '💖', '#F06292', 'f'),
  c('yoda', 'Yoda', 'Hollywood', '🧘', '#9CCC65', 'any'),
  c('et', 'E.T.', 'Hollywood', '👽', '#A5D6A7', 'any'),
  c('kong', 'King Kong', 'Hollywood', '🦍', '#8D6E63', 'any'),
  c('godzilla', 'Godzilla', 'Hollywood', '🦖', '#66BB6A', 'any'),
  // ---------------------------------------------------------- Animation ---
  c('shrek', 'Shrek', 'Animation', '🧅', '#9CCC65'),
  c('woody', 'Woody', 'Animation', '🤠', '#FFB74D'),
  c('buzz', 'Buzz Lightyear', 'Animation', '🚀', '#9575CD'),
  c('po', 'Kung Fu Panda', 'Animation', '🐼', '#BDBDBD', 'any'),
  c('minion', 'Minion', 'Animation', '🍌', '#FFEE58', 'any'),
  c('nemo', 'Nemo', 'Animation', '🐠', '#FFA726', 'any'),
  c('olaf', 'Olaf', 'Animation', '⛄', '#B3E5FC', 'any'),
  c('dory', 'Dory', 'Animation', '🐟', '#4FC3F7', 'f'),
  c('elsa', 'Elsa', 'Animation', '❄️', '#81D4FA', 'f'),
  c('moana', 'Moana', 'Animation', '🌊', '#4DB6AC', 'f'),
  c('mulan', 'Mulan', 'Animation', '🌸', '#F48FB1', 'f'),
  c('rapunzel', 'Rapunzel', 'Animation', '👸', '#FFD54F', 'f'),
];

/** The funny half: what kind of bus traveller you are tonight. */
export const TRIP_ADJECTIVES = [
  'Sleepy', 'Snoring', 'Window Seat', 'Upper Berth', 'Lower Berth', 'Chai Loving', 'Samosa', 'Midnight', 'Hungry',
  'Dancing', 'Jolly', 'Sneaky', 'Speedy', 'Grumpy', 'Chill', 'Lazy', 'Turbo', 'Desi', 'Filmy', 'Masala', 'Bindaas',
  'Jugaadu', 'Dramatic', 'Toll Plaza', 'Pillow Hugging', 'Selfie', 'Snack Hoarding', 'Seat Reclining', 'Antakshari',
  'Overpacked', 'Dhaba Hopping', 'Headphone', 'Pothole Surfing', 'Late Night', 'Moonlight', 'Highway',
] as const;

/** "Marvel hero", "Bollywood legend", … for the profile line. */
export const personaTagline = (p: Persona) => ({
  'Marvel': 'Marvel hero', 'DC': 'DC hero', 'Desi hero': 'Desi superhero', 'Bollywood': 'Bollywood legend',
  'Desi TV': 'Desi TV legend', 'Hollywood': 'Hollywood icon', 'Animation': 'Animated favourite',
} as const)[p.from];

export const PERSONA_PREFIX = 'p:';
const BY_ID = new Map(PERSONAS.map((p) => [`${PERSONA_PREFIX}${p.id}`, p]));
/** Avatar id → persona (null for old emoji avatars / none). */
export const personaOf = (avatar: string | null | undefined): Persona | null => (avatar ? BY_ID.get(avatar) ?? null : null);

/**
 * Pick a fresh trip identity: a persona nobody on this bus has yet (falls back to
 * repeats only on very full buses) and a name nobody has.
 */
export function pickPersona(gender: 'M' | 'F' | 'O', takenAvatars: Set<string>, takenNames: Set<string>, rand = Math.random): { name: string; avatar: string } {
  const fits = (p: Persona) => p.for === 'any' || (gender === 'F' ? p.for === 'f' : gender === 'M' ? p.for === 'm' : true);
  const pool = PERSONAS.filter(fits);
  const fresh = pool.filter((p) => !takenAvatars.has(`${PERSONA_PREFIX}${p.id}`));
  const from = fresh.length ? fresh : pool;
  for (let tries = 0; tries < 200; tries++) {
    const p = from[Math.floor(rand() * from.length)];
    const name = `${TRIP_ADJECTIVES[Math.floor(rand() * TRIP_ADJECTIVES.length)]} ${p.name}`;
    if (!takenNames.has(name.toLowerCase())) return { name, avatar: `${PERSONA_PREFIX}${p.id}` };
  }
  const p = from[0];
  return { name: `${p.name} ${takenNames.size + 1}`, avatar: `${PERSONA_PREFIX}${p.id}` };
}
