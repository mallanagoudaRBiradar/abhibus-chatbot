import { z } from 'zod';

/**
 * Per-tenant behaviour. Admins / developers edit it in the dashboard
 * (Tenants & config) or via PATCH /v1/tenants/{tenant}/config. A room can
 * override `features` for itself (e.g. ads off on a sensitive route).
 */
export const FEATURE_KEYS = [
  'chat', 'alerts', 'tara', 'location_crowd', 'live_location', 'polls', 'surveys', 'games', 'ads', 'sos',
  'issues', 'wait_for_me', 'rest_stop', 'lost_found', 'vouchers', 'reactions', 'mentions', 'women_channel',
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export const FEATURE_LABELS: Record<FeatureKey, string> = {
  chat: 'Group chat', alerts: 'Ops alerts', tara: 'Tara (AI assistant)', location_crowd: 'Crowd location',
  live_location: 'Live location sharing (10/15/20 min)', polls: 'Polls', surveys: 'Surveys', games: 'Games', ads: 'Ads',
  sos: 'Private SOS', issues: 'Group issue reporting', wait_for_me: 'Wait for me', rest_stop: 'Rest-stop timer',
  lost_found: 'Lost & found', vouchers: 'Delay vouchers', reactions: 'Reactions', mentions: '@ Customer care mentions',
  women_channel: 'Women-only channel',
};

export const TenantConfigZ = z.object({
  features: z.record(z.enum(FEATURE_KEYS), z.boolean()),
  identity: z.object({ mode: z.enum(['handle', 'profile']) }),
  timing: z.object({ open_before_min: z.number().int().min(0).max(1440), readonly_after_min: z.number().int().min(0).max(1440), purge_days: z.number().int().min(1).max(30) }),
  quiet: z.object({ from: z.string().regex(/^\d\d:\d\d$/), to: z.string().regex(/^\d\d:\d\d$/) }),
  ads: z.object({ gap_min: z.number().int().min(0), max_per_trip: z.number().int().min(0), block_after_alert_min: z.number().int().min(0) }),
  social_min: z.number().int().min(1).max(50),
  slow_mode_sec: z.number().int().min(0).max(300),
  report_hide_at: z.number().int().min(1).max(20),
  issue_escalate_at: z.number().int().min(1).max(50),
  support: z.object({ phone: z.string().nullable(), care_handle: z.string() }),
});
export type TenantConfig = z.infer<typeof TenantConfigZ>;

export function defaultConfig(over: Partial<Record<FeatureKey, boolean>> = {}, identity: 'handle' | 'profile' = 'handle'): TenantConfig {
  return {
    features: Object.fromEntries(FEATURE_KEYS.map((k) => [k, over[k] ?? true])) as Record<FeatureKey, boolean>,
    identity: { mode: identity },
    timing: { open_before_min: 180, readonly_after_min: 120, purge_days: 7 },
    quiet: { from: '23:00', to: '06:00' },
    ads: { gap_min: 45, max_per_trip: 4, block_after_alert_min: 15 },
    social_min: 3,
    slow_mode_sec: 30,
    report_hide_at: 2,
    issue_escalate_at: 3,
    support: { phone: null, care_handle: 'Customer Care' },
  };
}

/** Effective features for a room = tenant defaults overridden by the room. */
export function featuresFor(cfg: TenantConfig, roomFeatures?: Partial<Record<FeatureKey, boolean>> | null) {
  return { ...cfg.features, ...(roomFeatures ?? {}) } as Record<FeatureKey, boolean>;
}

/** Deep-merge a partial patch into a config (used by PATCH config). */
export function mergeConfig(base: TenantConfig, patch: any): TenantConfig {
  const out: any = structuredClone(base);
  const walk = (o: any, p: any) => { for (const k of Object.keys(p ?? {})) { if (p[k] && typeof p[k] === 'object' && !Array.isArray(p[k])) { o[k] ??= {}; walk(o[k], p[k]); } else o[k] = p[k]; } };
  walk(out, patch);
  return TenantConfigZ.parse(out);
}
