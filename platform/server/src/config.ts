import 'dotenv/config';
import { z } from 'zod';

/** Parsed once at boot; a misconfigured server refuses to start. */
const Env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4100),
  /** Local database when USE_DEMO_DB=no, e.g. mysql://trip_rooms:<pw>@127.0.0.1:3306/trip_rooms */
  DATABASE_URL: z.string().min(1).optional(),
  /** yes = the shared demo/dev abrs_new (DEMO_DB_*), tables chat_console_*; no = DATABASE_URL. */
  USE_DEMO_DB: z.enum(['yes', 'no', 'true', 'false']).default('no').transform((v) => v === 'yes' || v === 'true'),
  DEMO_DB_HOST: z.string().optional(),
  DEMO_DB_PORT: z.coerce.number().default(3306),
  DEMO_DB_USER: z.string().optional(),
  DEMO_DB_PASSWORD: z.string().optional(),
  DEMO_DB_NAME: z.string().default('abrs_new'),
  DEMO_DB_CONNECTION_LIMIT: z.coerce.number().int().min(1).max(100).default(10),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be >= 32 chars'),
  WEBHOOK_SIGNING_KEY: z.string().min(32),
  DEMO_MODE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  CHAT_WEB_URL: z.string().default('http://localhost:8090'),
  DASHBOARD_URL: z.string().default('http://localhost:5180'),
  CORS_ORIGINS: z.string().default('*'),
}).superRefine((e, ctx) => {
  if (e.NODE_ENV === 'production' && e.DEMO_MODE) ctx.addIssue({ code: 'custom', message: 'DEMO_MODE must be false in production' });
  if (e.USE_DEMO_DB) {
    for (const k of ['DEMO_DB_HOST', 'DEMO_DB_USER', 'DEMO_DB_PASSWORD'] as const) if (!e[k]) ctx.addIssue({ code: 'custom', message: `USE_DEMO_DB=yes requires ${k}` });
    // DEMO_MODE seeds fake trips + a simulator: never into the shared database.
    if (e.DEMO_MODE) ctx.addIssue({ code: 'custom', message: 'USE_DEMO_DB=yes needs DEMO_MODE=false (demo trips would be written into the shared abrs_new)' });
  } else if (!e.DATABASE_URL) ctx.addIssue({ code: 'custom', message: 'DATABASE_URL is required when USE_DEMO_DB=no' });
});

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment:\n' + parsed.error.issues.map((i) => ` - ${i.path.join('.')}: ${i.message}`).join('\n'));
  process.exit(1);
}
const d = parsed.data;
const databaseUrl = d.USE_DEMO_DB
  ? `mysql://${encodeURIComponent(d.DEMO_DB_USER!)}:${encodeURIComponent(d.DEMO_DB_PASSWORD!)}@${d.DEMO_DB_HOST}:${d.DEMO_DB_PORT}/${encodeURIComponent(d.DEMO_DB_NAME)}?connection_limit=${d.DEMO_DB_CONNECTION_LIMIT}`
  : d.DATABASE_URL!;
export const config = { ...parsed.data, databaseUrl, databaseLabel: d.USE_DEMO_DB ? `demo DB ${d.DEMO_DB_HOST}/${d.DEMO_DB_NAME}` : `local ${databaseUrl.replace(/\/\/[^@]*@/, '//')}`, corsOrigins: parsed.data.CORS_ORIGINS === '*' ? true : parsed.data.CORS_ORIGINS.split(',') };
