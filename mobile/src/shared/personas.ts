/**
 * ============================================================================
 *  Trip names: every passenger gets a random, funny identity on joining.
 * ============================================================================
 *  Name   = one of 32 approved heroes / film characters ("Batman", "Baburao"),
 *           "Groot 2" only if a bus has more people than characters.
 *  Avatar = the persona id ("p:<id>"):
 *           heroes      → an emblem badge (their symbol on their colour)
 *           characters  → a matching emoji face on a soft tile
 *  Nobody picks or types a name, so no real names or phone numbers leak.
 *  Random for everyone, whatever their gender. Emblems are emoji/letters, never the
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
}

const h = (id: string, name: string, from: Persona['from'], glyph: string, color: string): Persona => ({ id, name, kind: 'hero', from, glyph, color });
const c = (id: string, name: string, from: Persona['from'], glyph: string, color: string): Persona => ({ id, name, kind: 'character', from, glyph, color });

export const PERSONAS: Persona[] = [
  // ------------------------------------------------------------ Marvel ---
  h('ironman', 'Iron Man', 'Marvel', '🦾', '#B3261E'),
  h('spiderman', 'Spider-Man', 'Marvel', '🕷️', '#D62839'),
  h('thor', 'Thor', 'Marvel', '🔨', '#3559B7'),
  h('hulk', 'Hulk', 'Marvel', '💪', '#2E8B3E'),
  h('groot', 'Groot', 'Marvel', '🌳', '#6B4F2A'),
  h('widow', 'Black Widow', 'Marvel', '🕸️', '#2B2B2B'),
  // ---------------------------------------------------------------- DC ---
  h('batman', 'Batman', 'DC', '🦇', '#1F1F24'),
  h('superman', 'Superman', 'DC', 'S', '#1F4FBF'),
  h('flash', 'Flash', 'DC', '⚡', '#C8102E'),
  h('aquaman', 'Aquaman', 'DC', '🔱', '#0F7C6E'),
  h('wonder', 'Wonder Woman', 'DC', 'WW', '#B3001B'),
  // --------------------------------------------------------- Desi heroes ---
  h('shaktimaan', 'Shaktimaan', 'Desi hero', '🌀', '#C9741B'),
  h('krrish', 'Krrish', 'Desi hero', '🎭', '#2B2B2B'),
  h('mrindia', 'Mr. India', 'Desi hero', '👻', '#7B1FA2'),
  h('minnal', 'Minnal Murali', 'Desi hero', '⚡', '#1565C0'),
  // ------------------------------------------ Bollywood comedy & classics ---
  c('baburao', 'Baburao', 'Bollywood', '👓', '#F2C14E'),
  c('raju', 'Raju', 'Bollywood', '🤑', '#7CB342'),
  c('circuit', 'Circuit', 'Bollywood', '🕺', '#26A69A'),
  c('chatur', 'Chatur', 'Bollywood', '🤓', '#9575CD'),
  c('udayshetty', 'Uday Shetty', 'Bollywood', '😎', '#FFB74D'),
  c('gogo', 'Crime Master Gogo', 'Bollywood', '🥸', '#A1887F'),
  c('mogambo', 'Mogambo', 'Bollywood', '😈', '#BA68C8'),
  c('geet', 'Geet', 'Bollywood', '🚂', '#FF7043'),
  // ------------------------------------------------------------ Desi TV ---
  c('jethalal', 'Jethalal', 'Desi TV', '👔', '#E0A43B'),
  c('bhide', 'Bhide', 'Desi TV', '📏', '#7986CB'),
  c('popatlal', 'Popatlal', 'Desi TV', '☂️', '#4DD0E1'),
  c('daya', 'Daya', 'Desi TV', '💃', '#F48FB1'),
  // ---------------------------------------------------------- Hollywood ---
  c('sparrow', 'Jack Sparrow', 'Hollywood', '🏴‍☠️', '#8D6E63'),
  c('gandalf', 'Gandalf', 'Hollywood', '🧙', '#B0BEC5'),
  c('bean', 'Mr. Bean', 'Hollywood', '🚗', '#AED581'),
  // ---------------------------------------------------------- Animation ---
  c('shrek', 'Shrek', 'Animation', '🧅', '#9CCC65'),
  c('minion', 'Minion', 'Animation', '🍌', '#FFEE58'),
];

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
 * Pick a trip identity: a character nobody on this bus has yet, named just
 * that ("Batman"). Only when every fitting character is taken does one repeat,
 * with a number ("Groot 2"), so names stay unique on the bus.
 */
export function pickPersona(takenAvatars: Set<string>, takenNames: Set<string>, rand = Math.random): { name: string; avatar: string } {
  // Fully random: anyone can be anyone (a man can be Wonder Woman, a woman can be Batman).
  const pool = PERSONAS;
  const fresh = pool.filter((p) => !takenAvatars.has(`${PERSONA_PREFIX}${p.id}`) && !takenNames.has(p.name.toLowerCase()));
  const p = (fresh.length ? fresh : pool)[Math.floor(rand() * (fresh.length || pool.length))];
  let name = p.name;
  for (let n = 2; takenNames.has(name.toLowerCase()); n++) name = `${p.name} ${n}`;
  return { name, avatar: `${PERSONA_PREFIX}${p.id}` };
}

/** True when `name` is this persona's plain trip name ("Batman" or "Batman 2"). */
export const isPersonaName = (p: Persona, name: string) => name === p.name || new RegExp(`^${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\d+$`).test(name);
