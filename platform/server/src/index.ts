import http from 'http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config';
import { logger } from './lib/logger';
import { prisma } from './db';
import { errorHandler } from './lib/errors';
import { v1 } from './http/v1';
import { consoleApi } from './http/console';
import { chatApi } from './http/chat';
import { createRealtime } from './realtime/socket';
import { startEngine } from './core/lifecycle';
import './core/outbound'; // publishes room.message_posted for tenants with their own chat UI
import { startDemo, demoRouter } from './demo/simulator';

/**
 * Trip Rooms platform
 *   /v1          tenant API (AbhiBus, ConfirmTkt, ixigo Trains, ixigo Flights backends)
 *   /console/v1  dashboard API (Ops, Marketing, Developer, Admin, Support, Viewer)
 *   /chat/v1     hosted chat screen bootstrap
 *   /ws          realtime (chat screen)
 */
async function main() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: config.corsOrigins }));
  app.use(express.json({ limit: '256kb' }));
  app.get('/healthz', async (_req, res) => { await prisma.$queryRaw`SELECT 1`; res.json({ ok: true, service: 'trip-rooms', demo: config.DEMO_MODE }); });
  app.use('/v1', v1);
  app.use('/console/v1', consoleApi);
  app.use('/chat/v1', chatApi);
  if (config.DEMO_MODE) app.use('/demo', demoRouter);
  app.use((_req, res) => res.status(404).json({ error: { code: 'not_found', message: 'No such endpoint. See the Developer portal → API reference.' } }));
  app.use(errorHandler);

  const server = http.createServer(app);
  createRealtime(server);
  startEngine();
  if (config.DEMO_MODE) await startDemo();
  server.listen(config.PORT, () => logger.info(`🛰️  Trip Rooms platform on :${config.PORT} (demo=${config.DEMO_MODE})`));
  const shutdown = async () => { await prisma.$disconnect(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
main().catch((err) => { logger.fatal({ err }, 'boot failed'); process.exit(1); });
