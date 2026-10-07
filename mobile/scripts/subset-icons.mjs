#!/usr/bin/env node
/**
 * Web build only: shrink the fonts the chat downloads inside the AbhiBus WebView.
 *  - Icon fonts → only the glyphs the code uses (1.6 MB → ~28 KB), plus small glyph
 *    maps so the web build doesn't ship @expo/vector-icons' full name tables.
 *  - Text fonts (Sora, Plus Jakarta Sans) → Latin + the punctuation/symbols the UI
 *    uses (~93 KB → ~25 KB each). Hindi/Telugu text falls back to the phone's
 *    system font either way: these families have no Indic glyphs.
 *
 *   node scripts/subset-icons.mjs          regenerate assets/fonts/**
 *   node scripts/subset-icons.mjs --check  fail if the code uses an icon the subset lacks
 *
 * "Used icon" = every quoted string in src/ and App.tsx that is an icon name, plus its
 * `-outline` variant, so names chosen at runtime (icon={...}, lookup tables,
 * `${icon}-outline`) are covered. A superset is fine.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import subsetFont from 'subset-font';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'package.json'));
const VENDOR = join(ROOT, 'node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons');
const OUT = join(ROOT, 'assets/fonts');
const ICON_SETS = ['Ionicons', 'MaterialCommunityIcons'];
const TEXT_FONTS = {
  Sora_600SemiBold: '@expo-google-fonts/sora/600SemiBold/Sora_600SemiBold.ttf',
  Sora_700Bold: '@expo-google-fonts/sora/700Bold/Sora_700Bold.ttf',
  PlusJakartaSans_400Regular: '@expo-google-fonts/plus-jakarta-sans/400Regular/PlusJakartaSans_400Regular.ttf',
  PlusJakartaSans_500Medium: '@expo-google-fonts/plus-jakarta-sans/500Medium/PlusJakartaSans_500Medium.ttf',
  PlusJakartaSans_600SemiBold: '@expo-google-fonts/plus-jakarta-sans/600SemiBold/PlusJakartaSans_600SemiBold.ttf',
  PlusJakartaSans_700Bold: '@expo-google-fonts/plus-jakarta-sans/700Bold/PlusJakartaSans_700Bold.ttf',
};
// Basic Latin, Latin-1, Latin Extended-A, general punctuation, ₹, arrows, ×, −, ™.
const RANGES = [[0x20, 0x7e], [0xa0, 0x17f], [0x2000, 0x206f], [0x20b9, 0x20b9], [0x2122, 0x2122], [0x2190, 0x21ff], [0x2212, 0x2212]];
const check = process.argv.includes('--check');

const files = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(tsx?|jsx?)$/.test(f)) files.push(p); } };
walk(join(ROOT, 'src'));
files.push(join(ROOT, 'App.tsx'));
const literals = new Set();
// shared/personas.ts holds character ids ('flash', 'rocket'…), not icon names: skip it.
for (const f of files) if (!f.endsWith('personas.ts')) for (const m of readFileSync(f, 'utf8').matchAll(/['"`]([a-z0-9][a-z0-9-]*)['"`]/g)) literals.add(m[1]);

const mapsPath = join(OUT, 'icons.subset.json');
const maps = check ? JSON.parse(readFileSync(mapsPath, 'utf8')) : {};
let missing = 0;
mkdirSync(OUT, { recursive: true });
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

for (const set of ICON_SETS) {
  const glyphs = JSON.parse(readFileSync(join(VENDOR, `glyphmaps/${set}.json`), 'utf8'));
  // Names built at runtime as `${name}-outline` (e.g. RoomSwitcher's inactive tab) are covered too.
  const used = [...new Set([...literals].flatMap((n) => [n, `${n}-outline`]))].filter((n) => n in glyphs).sort();
  if (check) {
    const lacking = used.filter((n) => !(n in (maps[set] ?? {})));
    if (lacking.length) { missing += lacking.length; console.error(`✘ ${set}: not in subset: ${lacking.join(', ')}`); }
    continue;
  }
  const full = readFileSync(join(VENDOR, `Fonts/${set}.ttf`));
  const sub = await subsetFont(full, used.map((n) => String.fromCodePoint(glyphs[n])).join(''), { targetFormat: 'truetype' });
  writeFileSync(join(OUT, `${set}.subset.ttf`), sub);
  maps[set] = Object.fromEntries(used.map((n) => [n, glyphs[n]]));
  console.log(`✔ ${set}: ${used.length} glyphs, ${kb(full.length)} → ${kb(sub.length)}`);
}

if (check) {
  if (missing) { console.error('Run: npm run icons:subset'); process.exit(1); }
  console.log('✔ icon subsets cover every icon used');
  process.exit(0);
}
writeFileSync(mapsPath, JSON.stringify(maps, null, 2) + '\n');

const text = RANGES.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => String.fromCodePoint(a + i))).join('');
mkdirSync(join(OUT, 'text'), { recursive: true });
for (const [name, mod] of Object.entries(TEXT_FONTS)) {
  const full = readFileSync(require.resolve(mod));
  const sub = await subsetFont(full, text, { targetFormat: 'truetype' });
  writeFileSync(join(OUT, 'text', `${name}.ttf`), sub);
  console.log(`✔ ${name}: ${kb(full.length)} → ${kb(sub.length)}`);
}
