import { PrismaClient } from '@prisma/client';
import { config } from '../config';

/** Connects to the database picked by USE_DEMO_DB (see config.ts). */
export const prisma = new PrismaClient({ datasources: { db: { url: config.chatDatabaseUrl } }, log: ['warn', 'error'] });
