import { prisma } from '../db/prisma';
import { config } from '../config';
import { logger } from './logger';

/**
 * Leader lease for background jobs. Every instance runs the same timers; only
 * the one holding the lease does the work, so 3 instances still post ONE
 * "You've arrived" message per bus.
 *
 * Stored in MySQL (chat_job_lease), so it needs no extra infrastructure. The
 * holder renews on every run; if it dies, another instance takes over once
 * the lease expires (ttl). Times are UTC, like every Prisma DateTime.
 */
export async function acquireLease(name: string, ttlMs: number): Promise<boolean> {
  const me = config.instanceId;
  // Renew our own lease, or take over an expired one. InnoDB row locks make
  // this atomic: of two instances racing for an expired lease, one matches.
  const taken = await prisma.$executeRaw`
    UPDATE chat_job_lease
       SET holder = ${me}, expires_at = UTC_TIMESTAMP(3) + INTERVAL ${ttlMs * 1000} MICROSECOND
     WHERE name = ${name} AND (expires_at < UTC_TIMESTAMP(3) OR holder = ${me})`;
  if (taken > 0) return true;
  // No row yet: the first instance to insert it is the leader.
  const inserted = await prisma.$executeRaw`
    INSERT IGNORE INTO chat_job_lease (name, holder, expires_at)
    VALUES (${name}, ${me}, UTC_TIMESTAMP(3) + INTERVAL ${ttlMs * 1000} MICROSECOND)`;
  return inserted > 0;
}

export async function releaseLeases() {
  await prisma.jobLease.deleteMany({ where: { holder: config.instanceId } }).catch(() => {});
}

/**
 * Runs `fn` every `intervalMs` on the lease holder only. Never overlaps itself:
 * a slow run delays the next one instead of stacking up.
 */
export function leaderInterval(name: string, intervalMs: number, fn: () => Promise<void>) {
  let running = false;
  const run = async () => {
    if (running) { logger.warn({ job: name }, 'previous run still going, skipping this one'); return; }
    running = true;
    const started = Date.now();
    try {
      if (!(await acquireLease(name, intervalMs * 3))) return;
      await fn();
      jobStats.set(name, { lastRunMs: Date.now() - started, lastRunAt: new Date().toISOString() });
    } catch (err) {
      logger.error({ err, job: name }, 'job failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
  void run();
  return timer;
}

/** Last run per job on this instance (exposed on /metrics). */
export const jobStats = new Map<string, { lastRunMs: number; lastRunAt: string }>();
