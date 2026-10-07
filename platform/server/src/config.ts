import 'dotenv/config';
import { z } from 'zod';

/** Parsed once at boot; a misconfigured server refuses to start. */
const Env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4100),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be >= 32 chars'),
  WEBHOOK_SIGNING_KEY: z.string().min(32),
  DEMO_MODE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  CHAT_WEB_URL: z.string().default('http://localhost:8090'),
  DASHBOARD_URL: z.string().default('http://localhost:5180'),
  CORS_ORIGINS: z.string().default('*'),
}).superRefine((e, ctx) => {
  if (e.NODE_ENV === 'production' && e.DEMO_MODE) ctx.addIssue({ code: 'custom', message: 'DEMO_MODE must be false in production' });
});

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment:\n' + parsed.error.issues.map((i) => ` - ${i.path.join('.')}: ${i.message}`).join('\n'));
  process.exit(1);
}
export const config = { ...parsed.data, corsOrigins: parsed.data.CORS_ORIGINS === '*' ? true : parsed.data.CORS_ORIGINS.split(',') };
