import http from 'http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config';
import { logger } from './lib/logger';
import { prisma } from './db/prisma';
import { router } from './http/routes';
import { createSocketServer } from './realtime/socketServer';
import { startJourneyTicker } from './jobs/journeyTicker';
import { initMiniGames } from './features/miniGames';
import { startExpirySweeper } from './jobs/expirySweeper';
import { startDemoSimulator } from './demo/simulator';
import { DEMO } from './demo/demoData';
import { journeyIdFor } from './booking/types';
import { platformBridge } from './platform/bridge';

async function main() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigins }));
  // Keep the raw body: the Trip Rooms webhook is verified by HMAC over the exact bytes.
  app.use(express.json({ limit: '16kb', verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(router);

  const server = http.createServer(app);
  const io = createSocketServer(server);

  if (config.REDIS_URL) {
    // Multi-node: share rooms/presence across instances. Keep sticky sessions on the LB.
    const { createAdapter } = await import('@socket.io/redis-adapter');
    const { Redis } = await import('ioredis');
    const pub = new Redis(config.REDIS_URL);
    io.adapter(createAdapter(pub, pub.duplicate()));
    logger.info('socket.io redis adapter enabled');
  }

  if (config.DEMO_MODE) {
    // Fresh demo trip on every boot so the timeline always starts near Kurnool.
    await prisma.busJourney.deleteMany({ where: { journeyId: journeyIdFor(DEMO.serviceId, DEMO.journeyDate()) } });
    await startDemoSimulator();
  }

  void platformBridge.start(); // retries in the background until the platform is reachable
  initMiniGames();
  startJourneyTicker();
  startExpirySweeper();

  server.listen(config.PORT, () => logger.info(`🚌 Journey chat on :${config.PORT}  (booking=${config.BOOKING_SOURCE}, demo=${config.DEMO_MODE})`));

  const shutdown = async () => {
    logger.info('shutting down');
    io.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => { logger.fatal({ err }, 'boot failed'); process.exit(1); });
