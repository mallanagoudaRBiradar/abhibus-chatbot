import { prisma } from '../db';
import { ApiError } from '../lib/errors';
import { TenantConfigZ, featuresFor, type FeatureKey, type TenantConfig } from '../shared/tenantConfig';
import type { Tenant, Room } from '@prisma/client';

/** Tenants change rarely; cache for 30 s so every message doesn't hit the DB. */
const cache = new Map<string, { t: Tenant; cfg: TenantConfig; at: number }>();

export async function getTenant(id: string) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < 30_000) return hit;
  const t = await prisma.tenant.findUnique({ where: { id } });
  if (!t) throw new ApiError('not_found', `Unknown tenant ${id}.`);
  const entry = { t, cfg: TenantConfigZ.parse(t.config), at: Date.now() };
  cache.set(id, entry);
  return entry;
}
export const invalidateTenant = (id: string) => cache.delete(id);

export async function roomFeatures(room: Pick<Room, 'tenantId' | 'features'>) {
  const { cfg } = await getTenant(room.tenantId);
  return featuresFor(cfg, room.features as Partial<Record<FeatureKey, boolean>> | null);
}

export async function requireFeature(room: Pick<Room, 'tenantId' | 'features'>, f: FeatureKey) {
  if (!(await roomFeatures(room))[f]) throw new ApiError('feature_disabled', `“${f}” is turned off for this tenant or room.`);
}

/** Quiet hours in IST (all four tenants operate in India). */
export function isQuiet(cfg: TenantConfig, at = new Date()) {
  const ist = new Date(at.getTime() + 330 * 60_000);
  const m = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const toMin = (s: string) => { const [h, mm] = s.split(':').map(Number); return h * 60 + mm; };
  const a = toMin(cfg.quiet.from), b = toMin(cfg.quiet.to);
  return a > b ? m >= a || m < b : m >= a && m < b;
}
