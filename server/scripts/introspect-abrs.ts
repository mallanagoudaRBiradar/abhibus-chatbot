/**
 * npm run db:introspect-abrs
 *
 * Read-only. Prints the real columns of the four booking tables in abrs_new
 * and checks every name used in src/booking/schemaMap.ts actually exists.
 * Run this once against the reader endpoint before switching BOOKING_SOURCE=mysql.
 */
import '../src/config';
import { abrsQuery } from '../src/db/abrsPool';
import { ABRS_MAP } from '../src/booking/schemaMap';

async function main() {
  let problems = 0;
  for (const [channel, t] of Object.entries(ABRS_MAP.tables)) {
    for (const [role, table] of Object.entries(t)) {
      const cols = await abrsQuery<{ COLUMN_NAME: string; DATA_TYPE: string; COLUMN_KEY: string }>(
        `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_KEY FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [table]);
      console.log(`\n${channel} ${role}: ${table} (${cols.length} columns)`);
      console.log(cols.map((c) => `  ${c.COLUMN_NAME.padEnd(28)} ${c.DATA_TYPE.padEnd(12)} ${c.COLUMN_KEY}`).join('\n'));
      const names = new Set(cols.map((c) => c.COLUMN_NAME));
      const expected = Object.entries(role === 'master' ? ABRS_MAP.master : ABRS_MAP.detail).filter(([, v]) => typeof v === 'string') as [string, string][];
      for (const [k, v] of expected) if (!names.has(v)) { problems++; console.log(`  ✖ mapping ${k} -> ${v} NOT FOUND`); }
    }
  }
  console.log(problems ? `\n${problems} mapping problem(s). Fix src/booking/schemaMap.ts.` : '\n✔ schemaMap matches abrs_new');
  process.exit(problems ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
