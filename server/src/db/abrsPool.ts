import mysql from 'mysql2/promise';
import { config } from '../config';
import { logger } from '../lib/logger';

/**
 * Read-only pool against the Aurora READER endpoint for `abrs_new`.
 *
 * Guardrails:
 *  - Every connection is put into READ ONLY transaction mode, so even a bug
 *    cannot write to the booking database.
 *  - Per-query timeout (DB_QUERY_TIMEOUT_MS) — a slow booking lookup degrades
 *    to a friendly "try again" instead of hanging the join request.
 *  - Only parameterised queries. Identifiers come from a validated allowlist.
 */
let pool: mysql.Pool | null = null;

export function abrsPool(): mysql.Pool {
  if (!config.DB_ENABLED) throw new Error('abrs_new access disabled (DB_ENABLED=false)');
  if (pool) return pool;
  pool = mysql.createPool({
    host: config.DB_HOST,
    port: config.DB_PORT,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    database: config.DB_NAME,
    connectionLimit: config.DB_CONNECTION_LIMIT,
    connectTimeout: config.DB_CONNECT_TIMEOUT_MS,
    waitForConnections: true,
    enableKeepAlive: true,
    dateStrings: true,
    timezone: '+05:30',
    ...(config.DB_SSL ? { ssl: 'Amazon RDS' as any } : {}),
  });
  pool.on('connection', (conn) => {
    conn.query('SET SESSION TRANSACTION READ ONLY');
  });
  logger.info({ host: config.DB_HOST, db: config.DB_NAME }, 'abrs_new read-only pool ready');
  return pool;
}

export async function abrsQuery<T = any>(sql: string, params: unknown[]): Promise<T[]> {
  const [rows] = await abrsPool().query({ sql, timeout: config.DB_QUERY_TIMEOUT_MS }, params);
  return rows as T[];
}
