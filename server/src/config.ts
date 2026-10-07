import 'dotenv/config';
import os from 'os';
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

    /** Chat store when USE_DEMO_DB=no: MySQL 8+, e.g. mysql://journey_chat:<pw>@127.0.0.1:3306/journey_chat?connection_limit=20 */
    CHAT_DATABASE_URL: z.string().startsWith('mysql://', 'CHAT_DATABASE_URL must be a mysql:// URL (the chat store is MySQL)').optional(),

    /**
     * Which database the chat store uses:
     *   yes = the shared demo/dev abrs_new (DEMO_DB_*), where bus-online writes chat_abhibus_inbox
     *   no  = CHAT_DATABASE_URL (your local MySQL)
     */
    USE_DEMO_DB: z.enum(['yes', 'no', 'true', 'false']).default('no').transform((v) => v === 'yes' || v === 'true'),
    DEMO_DB_HOST: z.string().optional(),   // use the cluster WRITER endpoint: the chat writes constantly
    DEMO_DB_PORT: z.coerce.number().default(3306),
    DEMO_DB_USER: z.string().optional(),
    DEMO_DB_PASSWORD: z.string().optional(),
    DEMO_DB_NAME: z.string().default('abrs_new'),
    DEMO_DB_CONNECTION_LIMIT: z.coerce.number().int().min(1).max(100).default(10),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be >= 32 chars'),
    PHONE_HASH_PEPPER: z.string().min(16),
    CONDUCTOR_API_KEY: z.string().min(16),
    OPS_API_KEY: z.string().min(16),

    /** partner = bookings pushed to /v1/partner/* (production). mock = demo tickets. mysql = legacy direct read of abrs_new. */
    BOOKING_SOURCE: z.enum(['partner', 'mock', 'mysql']).default('mock'),
    /** push = GPS fixes + route pushed through the partner API (production). mock = demo NH 44 simulation. */
    TRACKING_SOURCE: z.enum(['push', 'mock', 'abrs_tracking']).default('mock'),
    DEMO_MODE: bool,

    // ---- Legacy only (BOOKING_SOURCE=mysql): direct READ of the abrs_new booking DB. Not the chat store. ----
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
    /** Identifies this process in job leases and logs. Defaults to hostname:pid. */
    INSTANCE_ID: z.string().optional(),
    /** Journeys processed in parallel by the 30s ticker. */
    /** permessage-deflate on the WebSocket. Costs ~200 KB RAM per socket; see realtime/socketServer.ts. */
    WS_COMPRESSION: bool,
    TICK_CONCURRENCY: z.coerce.number().int().min(1).max(200).default(16),

    // ---- Partner (AbhiBus backend) integration ------------------------------
    /** Comma-separated server-to-server keys for /v1/partner/*. Two keys = zero-downtime rotation. */
    PARTNER_API_KEYS: z.string().optional(),
    /** Where lifecycle events go (room.opened, journey.closed, sos.raised). Signed with PARTNER_WEBHOOK_SECRET. */
    PARTNER_WEBHOOK_URL: z.string().url().optional(),
    PARTNER_WEBHOOK_SECRET: z.string().optional(),
    /**
     * How a passenger proves who they are when the app calls /v1/journey-chat/join directly.
     *  partner = the app never calls /join; the AbhiBus backend calls POST /v1/partner/chat-sessions (recommended).
     *  jwt     = the app sends its AbhiBus login JWT; verified with APP_JWT_PUBLIC_KEY (RS256) or APP_JWT_SECRET (HS256).
     */
    APP_AUTH_MODE: z.enum(['partner', 'jwt', 'open']).default('partner'),
    APP_JWT_PUBLIC_KEY: z.string().optional(),
    APP_JWT_SECRET: z.string().optional(),
    APP_JWT_ISSUER: z.string().optional(),
    APP_JWT_USER_CLAIM: z.string().default('sub'),
    /** Require the signed-in AbhiBus account to be the one that booked the PNR (needs customerId on ingestion). */
    STRICT_PNR_OWNERSHIP: bool,
    /** 64 hex chars (openssl rand -hex 32). Encrypts passenger name + contact phone at rest (lib/pii.ts). */
    PII_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'PII_ENCRYPTION_KEY must be 64 hex chars (openssl rand -hex 32)').optional(),
    SUPPORT_WEBHOOK_URL: z.string().optional(),
    SUPPORT_PHONE: z.string().optional(),
    /** Public web address of the chat (QR invites open <PUBLIC_WEB_URL>/?qr=…). Unset in dev = this laptop's Wi-Fi IP:8081. */
    PUBLIC_WEB_URL: z.string().optional(),

    /**
     * Trip Rooms platform bridge (optional). With all three set, journeys mirror into platform rooms:
     * Ops/support see the chat in the Console, @care tags become support tickets, SOS reaches the Ops
     * inbox, and agent replies + Ops alerts come back into this chat. Unset = the app runs standalone.
     */
    PLATFORM_API_URL: z.string().url().optional(),
    PLATFORM_CLIENT_ID: z.string().optional(),
    PLATFORM_CLIENT_SECRET: z.string().optional(),
    /** Where the platform can reach this server's webhook. Default: http://localhost:<PORT>/v1/platform/webhook */
    PLATFORM_CALLBACK_URL: z.string().url().optional(),

    /** Rooms open this many minutes before departure (e.g. 30 or 45). Passengers can join from then on. */
    CHAT_OPEN_BEFORE_START_MIN: z.coerce.number().int().min(5).max(180).default(30),
    /**
     * The chat (and its inbox rows) ends this long after the LAST passenger's drop time
     * (latest droppingDateTime), or after the actual arrival if the bus is later than that.
     * Mirrors the opening rule: rooms open CHAT_OPEN_BEFORE_START_MIN before the EARLIEST boarding.
     */
    CHAT_CLOSE_AFTER_LAST_DROP_MIN: z.coerce.number().int().min(0).max(24 * 60).default(180),
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
    if (env.USE_DEMO_DB) {
      for (const k of ['DEMO_DB_HOST', 'DEMO_DB_USER', 'DEMO_DB_PASSWORD'] as const)
        if (!env[k]) ctx.addIssue({ code: 'custom', message: `USE_DEMO_DB=yes requires ${k}` });
      // DEMO_MODE seeds a fake bus + simulated passengers on every boot: never into the shared database.
      if (env.DEMO_MODE) ctx.addIssue({ code: 'custom', message: 'USE_DEMO_DB=yes needs DEMO_MODE=false (the demo simulator would write fake trips into the shared abrs_new). Use BOOKING_SOURCE=partner, TRACKING_SOURCE=push.' });
      if (env.DEMO_DB_HOST?.includes('cluster-ro'))
        console.warn('[config] DEMO_DB_HOST is a reader (-ro) endpoint; the chat writes constantly. Use the cluster writer endpoint.');
    } else if (!env.CHAT_DATABASE_URL) {
      ctx.addIssue({ code: 'custom', message: 'CHAT_DATABASE_URL is required when USE_DEMO_DB=no' });
    }
    const keys = (env.PARTNER_API_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean);
    if (keys.some((k) => k.length < 32)) ctx.addIssue({ code: 'custom', message: 'each PARTNER_API_KEYS entry must be >= 32 chars' });
    if (env.BOOKING_SOURCE === 'partner' && !keys.length) ctx.addIssue({ code: 'custom', message: 'BOOKING_SOURCE=partner requires PARTNER_API_KEYS' });
    if (env.PARTNER_WEBHOOK_URL && (env.PARTNER_WEBHOOK_SECRET ?? '').length < 32)
      ctx.addIssue({ code: 'custom', message: 'PARTNER_WEBHOOK_URL requires PARTNER_WEBHOOK_SECRET (>= 32 chars)' });
    if (env.APP_AUTH_MODE === 'jwt' && !env.APP_JWT_PUBLIC_KEY && !env.APP_JWT_SECRET)
      ctx.addIssue({ code: 'custom', message: 'APP_AUTH_MODE=jwt requires APP_JWT_PUBLIC_KEY or APP_JWT_SECRET' });
    if (env.NODE_ENV === 'production') {
      if (env.APP_AUTH_MODE === 'open') ctx.addIssue({ code: 'custom', message: 'APP_AUTH_MODE=open is for local testing only (anyone with a PNR + seat could join)' });
      if (env.CORS_ORIGINS === '*') ctx.addIssue({ code: 'custom', message: 'CORS_ORIGINS must list real origins in production' });
      if (!env.PII_ENCRYPTION_KEY) ctx.addIssue({ code: 'custom', message: 'PII_ENCRYPTION_KEY is required in production (passenger name/phone are stored encrypted)' });
      if (env.BOOKING_SOURCE === 'mock') ctx.addIssue({ code: 'custom', message: 'BOOKING_SOURCE=mock is not allowed in production' });
      if (env.TRACKING_SOURCE !== 'push') ctx.addIssue({ code: 'custom', message: 'TRACKING_SOURCE must be push in production (mock places every bus on NH 44)' });
      if (!env.REDIS_URL) console.warn('[config] REDIS_URL is not set: only ONE instance may run. Set it before scaling out.');
    }
  });

// `KEY=` (blank) in .env means unset, not an empty value that fails validation.
const parsed = Env.safeParse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== '')));
if (!parsed.success) {
  console.error('❌ Invalid environment:\n' + parsed.error.issues.map((i) => ` - ${i.path.join('.')}: ${i.message}`).join('\n'));
  process.exit(1);
}
const e = parsed.data;
/** The chat store's connection string, from the USE_DEMO_DB switch. */
const chatDatabaseUrl = e.USE_DEMO_DB
  ? `mysql://${encodeURIComponent(e.DEMO_DB_USER!)}:${encodeURIComponent(e.DEMO_DB_PASSWORD!)}@${e.DEMO_DB_HOST}:${e.DEMO_DB_PORT}/${encodeURIComponent(e.DEMO_DB_NAME)}?connection_limit=${e.DEMO_DB_CONNECTION_LIMIT}`
  : e.CHAT_DATABASE_URL!;

export const config = {
  ...parsed.data,
  chatDatabaseUrl,
  /** For logs: where the chat store is, without credentials. */
  chatDatabaseLabel: e.USE_DEMO_DB ? `demo DB ${e.DEMO_DB_HOST}/${e.DEMO_DB_NAME}` : `local ${chatDatabaseUrl.replace(/\/\/[^@]*@/, '//')}`,
  instanceId: parsed.data.INSTANCE_ID ?? `${os.hostname()}:${process.pid}`,
  partnerKeys: (parsed.data.PARTNER_API_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean),
  confirmedStatuses: parsed.data.ABRS_CONFIRMED_STATUSES.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  corsOrigins: parsed.data.CORS_ORIGINS === '*' ? '*' : parsed.data.CORS_ORIGINS.split(',').map((s) => s.trim()),
};
export type Config = typeof config;
