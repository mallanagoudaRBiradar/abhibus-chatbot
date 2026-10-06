import { logger } from '../lib/logger';

/**
 * TODO(wallet-team): credit AbhiBus reward points through the wallet service
 * (which owns abrs_wallet_transactions). The chat service must NOT write to
 * abrs_new directly — its DB user is read-only by design.
 */
export async function creditRewardPoints(pnr: string, points: number, reason: string) {
  logger.info({ pnr, points, reason }, 'reward points credit requested');
  return { ok: true };
}
