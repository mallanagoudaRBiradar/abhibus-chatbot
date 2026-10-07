import http from 'http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config';
import { logger } from './lib/logger';
import { prisma } from './db/prisma';
import { lifecycle, router } from './http/routes';
import { partnerRouter } from './http/partner';
import { createSocketServer } from './realtime/socketServer';
import { hub } from './realtime/hub';
import { startJourneyTicker } from './jobs/journeyTicker';
import { initMiniGames } from './features/miniGames';
import { startExpirySweeper } from './jobs/expirySweeper';
import { inboxPending, startInboxProcessor } from './jobs/inboxProcessor';
import { startDemoSimulator } from './demo/simulator';
import { DEMO } from './demo/demoData';
import { journeyIdFor } from './booking/types';
import { platformBridge } from './platform/bridge';
import { metrics } from './lib/metrics';
import { jobStats, releaseLeases } from './lib/leader';
import { safeEqual } from './lib/util';

async function main() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigins }));
  // Server-to-server API: bigger bodies (batches, routes). Mounted before the 16 KB app parser.
  app.use('/v1/partner', express.json({ limit: '2mb' }), partnerRouter);
  // Keep the raw body: the Trip Rooms webhook is verified by HMAC over the exact bytes.
  app.use(express.json({ limit: '16kb', verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(router);

  const server = http.createServer(app);
  const io = createSocketServer(server);

  if (config.REDIS_URL) {
    // Multi-node: share rooms/presence across instances. Route sockets of one journey to one node (see docs/DEPLOYMENT.md).
    const { createAdapter } = await import('@socket.io/redis-adapter');
    const { Redis } = await import('ioredis');
    const pub = new Redis(config.REDIS_URL);
    io.adapter(createAdapter(pub, pub.duplicate()));
    logger.info('socket.io redis adapter enabled');
  }

  app.get('/metrics', async (req, res) => {
    if (!safeEqual(req.header('authorization') ?? '', `Bearer ${config.OPS_API_KEY}`)) return res.status(401).end();
    const mem = process.memoryUsage();
    const gauges: Record<string, number> = { sockets: io.engine.clientsCount, rss_bytes: mem.rss, heap_used_bytes: mem.heapUsed, ...prefix('cache_', hub.cacheSizes()) };
    for (const [job, s] of jobStats) gauges[`job_last_run_ms{job="${job}"}`] = s.lastRunMs;
    gauges.inbox_pending = await inboxPending().catch(() => -1);
    res.type('text/plain').send(metrics.render(gauges));
  });

  if (config.DEMO_MODE) {
    // Fresh demo trip on every boot so the timeline always starts near Kurnool.
    await prisma.busJourney.deleteMany({ where: { journeyId: journeyIdFor(DEMO.serviceId, DEMO.journeyDate()) } });
    await startDemoSimulator();
  }

  void platformBridge.start(); // retries in the background until the platform is reachable
  initMiniGames();
  startJourneyTicker();
  startExpirySweeper();
  startInboxProcessor(); // chat_abhibus_inbox rows written by bus-online

  server.listen(config.PORT, () => logger.info(`🚌 Journey chat on :${config.PORT}  (db=${config.chatDatabaseLabel}, booking=${config.BOOKING_SOURCE}, tracking=${config.TRACKING_SOURCE}, demo=${config.DEMO_MODE}, instance=${config.instanceId})`));

  // Graceful shutdown: fail /readyz, give the load balancer time to notice, then close.
  // Phones reconnect to another instance and resync with `since`.
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    lifecycle.draining = true;
    const drainMs = config.NODE_ENV === 'production' ? 10_000 : 0;
    logger.info({ drainMs }, 'shutting down');
    await new Promise((r) => setTimeout(r, drainMs));
    await releaseLeases();
    io.close();
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const prefix = (p: string, o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [p + k, v]));

main().catch((err) => { logger.fatal({ err }, 'boot failed'); process.exit(1); });
