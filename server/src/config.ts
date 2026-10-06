import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment is parsed ONCE at boot. A misconfigured server must refuse to
 * start rather than run with a weak secret or a half-configured booking source.
 */
const bool = z.enum(['true', 'false']).default('false').transform((v) => v === 'true');

const Env = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().default(4000),
    CORS_ORIGINS: z.string().default('*'),

    CHAT_DATABASE_URL: z.string().min(1),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be >= 32 chars'),
    PHONE_HASH_PEPPER: z.string().min(16),
    CONDUCTOR_API_KEY: z.string().min(16),
    OPS_API_KEY: z.string().min(16),

    BOOKING_SOURCE: z.enum(['mock', 'mysql']).default('mock'),
    TRACKING_SOURCE: z.enum(['mock', 'abrs_tracking']).default('mock'),
    DEMO_MODE: bool,

    DB_ENABLED: bool,
    DB_HOST: z.string().optional(),
    DB_PORT: z.coerce.number().default(3306),
    DB_USER: z.string().optional(),
    DB_PASSWORD: z.string().optional(),
    DB_NAME: z.string().default('abrs_new'),
    DB_SSL: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
    DB_CONNECTION_LIMIT: z.coerce.number().default(20),
    DB_CONNECT_TIMEOUT_MS: z.coerce.number().default(20000),
    DB_QUERY_TIMEOUT_MS: z.coerce.number().default(1500),
    ABRS_CONFIRMED_STATUSES: z.string().default('Confirmed,Booked'),

    REDIS_URL: z.string().optional(),
    SUPPORT_WEBHOOK_URL: z.string().optional(),
    SUPPORT_PHONE: z.string().optional(),
    /** Public web address of the chat (QR invites open <PUBLIC_WEB_URL>/?qr=…). Unset in dev = this laptop's Wi-Fi IP:8081. */
    PUBLIC_WEB_URL: z.string().optional(),

    CHAT_OPEN_BEFORE_START_MIN: z.coerce.number().default(30),
    PURGE_AFTER_ARRIVAL_MIN: z.coerce.number().default(120),
    REPORT_MUTE_THRESHOLD: z.coerce.number().default(3),
    ETA_GAME_REWARD_POINTS: z.coerce.number().default(50),
  })
  .superRefine((env, ctx) => {
    if (env.BOOKING_SOURCE === 'mysql') {
      if (!env.DB_ENABLED) ctx.addIssue({ code: 'custom', message: 'BOOKING_SOURCE=mysql requires DB_ENABLED=true' });
      for (const k of ['DB_HOST', 'DB_USER', 'DB_PASSWORD'] as const)
        if (!env[k] || env[k] === 'CHANGE_ME') ctx.addIssue({ code: 'custom', message: `${k} is required for BOOKING_SOURCE=mysql` });
      if (env.DB_HOST && !env.DB_HOST.includes('-ro-') && !env.DB_HOST.includes('cluster-ro'))
        console.warn('[config] DB_HOST does not look like an Aurora reader (-ro) endpoint. Chat must only ever READ abrs_new.');
    }
    if (env.NODE_ENV === 'production' && env.DEMO_MODE)
      ctx.addIssue({ code: 'custom', message: 'DEMO_MODE must be false in production' });
  });

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ Invalid environment:\n' + parsed.error.issues.map((i) => ` - ${i.path.join('.')}: ${i.message}`).join('\n'));
  process.exit(1);
}
export const config = {
  ...parsed.data,
  confirmedStatuses: parsed.data.ABRS_CONFIRMED_STATUSES.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  corsOrigins: parsed.data.CORS_ORIGINS === '*' ? '*' : parsed.data.CORS_ORIGINS.split(',').map((s) => s.trim()),
};
export type Config = typeof config;
