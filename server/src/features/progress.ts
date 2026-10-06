import { tracker, toProgressState, type BusPosition } from '../tracking/gpsProvider';
import type { ProgressState } from '../shared/protocol';
import type { BusJourney } from '@prisma/client';

/** Latest bus progress per journey, refreshed by jobs/journeyTicker every 30s. */
const cache = new Map<string, { state: ProgressState; position: BusPosition }>();

export async function refreshProgress(j: BusJourney) {
  const position = await tracker.getPosition(j);
  if (!position) return null;
  const entry = { state: toProgressState(position), position };
  cache.set(j.journeyId, entry);
  return entry;
}
export async function getProgress(j: BusJourney): Promise<ProgressState | null> {
  return cache.get(j.journeyId)?.state ?? (await refreshProgress(j))?.state ?? null;
}
export const forgetProgress = (journeyId: string) => cache.delete(journeyId);
