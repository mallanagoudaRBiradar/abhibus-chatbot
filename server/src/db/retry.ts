/**
 * Prisma's upsert is a SELECT then an INSERT, not one atomic statement, so two
 * requests for the same new row (first passengers of a bus joining together,
 * the room opener racing a join, two booking batches for one journey) can both
 * try the INSERT. The loser gets P2002; running it again takes the UPDATE path.
 * MySQL can also pick one of two such transactions as a deadlock victim
 * (P2034); it is safe to rerun, after a short random pause.
 */
const RETRYABLE = new Set(['P2002', 'P2034']);
export async function retryOnConflict<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e: any) {
      if (!RETRYABLE.has(e?.code) || i >= attempts) throw e;
      if (e.code === 'P2034') await new Promise((r) => setTimeout(r, 10 + Math.random() * 40 * i));
    }
  }
}
