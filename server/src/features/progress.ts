import { tracker, toProgressState, type BusPosition } from '../tracking/gpsProvider';
import type { ProgressState } from '../shared/protocol';
import type { BusJourney } from '@prisma/client';

/**
 * Latest bus progress per journey. The leader's ticker refreshes it every 30s;
 * other instances compute it on demand (the tracker reads the journey row, so
 * it's cheap) and keep it for TTL_MS. Entries for finished journeys age out.
 */
const TTL_MS = 30_000;
const cache = new Map<string, { state: ProgressState; position: BusPosition; at: number }>();

export async function refreshProgress(j: BusJourney) {
  const position = await tracker.getPosition(j);
  if (!position) return null;
  const entry = { state: toProgressState(position), position, at: Date.now() };
  cache.set(j.journeyId, entry);
  return entry;
}
export async function getProgress(j: BusJourney): Promise<ProgressState | null> {
  const hit = cache.get(j.journeyId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.state;
  return (await refreshProgress(j))?.state ?? null;
}
export const forgetProgress = (journeyId: string) => cache.delete(journeyId);

setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [k, v] of cache) if (v.at < cutoff) cache.delete(k);
}, 5 * 60_000).unref();
