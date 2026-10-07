import { prisma } from '../db';
import { resetAll, seed, DEMO_PASSWORD } from '../demo/seed';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { config } from '../config';

/**
 * Real mode: the console with NO demo trips. Keeps what the console needs to work
 * (tenants, console users, API keys for the AbhiBus bridge) and deletes every demo
 * room, member, message, campaign and log. Run with DEMO_MODE=false so nothing
 * fake is created again; real journeys then arrive through the journey-chat bridge.
 *
 *   npm run setup:real
 */
(async () => {
  await resetAll();
  await seed(); // tenants, users, API keys (written to .demo-credentials.json) … and demo trips, removed below
  await prisma.$transaction([
    prisma.reaction.deleteMany(), prisma.receipt.deleteMany(), prisma.message.deleteMany(), prisma.channel.deleteMany(), prisma.block.deleteMany(),
    prisma.report.deleteMany(), prisma.action.deleteMany(), prisma.issueReport.deleteMany(), prisma.locationFix.deleteMany(),
    prisma.tripEvent.deleteMany(), prisma.campaignDelivery.deleteMany(), prisma.campaign.deleteMany(), prisma.surveyResponse.deleteMany(),
    prisma.eventLog.deleteMany(), prisma.auditLog.deleteMany(), prisma.member.deleteMany(), prisma.room.deleteMany(),
    prisma.webhook.deleteMany(), // demo webhooks pointed at the demo sink; the bridge registers its own
  ]);
  const [tenants, users, keys, rooms] = await Promise.all([prisma.tenant.count(), prisma.user.count(), prisma.apiClient.count(), prisma.room.count()]);
  console.log(`✅ real mode: ${tenants} tenants, ${users} console users, ${keys} API keys, ${rooms} rooms.`);
  console.log(`   Database: ${config.databaseLabel}`);
  syncBridgeKey();
  console.log(`   Console logins: <role>@triprooms.local / ${DEMO_PASSWORD}. AbhiBus API key in .demo-credentials.json (api.abhibus).`);
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });

/**
 * Every setup issues a new AbhiBus API key. Copy it into the journey-chat server's .env
 * (PLATFORM_CLIENT_ID / PLATFORM_CLIENT_SECRET) so its console bridge keeps working.
 */
function syncBridgeKey() {
  const target = join(process.cwd(), '../../server/.env');
  if (!existsSync(target)) return;
  const creds = JSON.parse(readFileSync(join(process.cwd(), '.demo-credentials.json'), 'utf8')).api?.abhibus;
  if (!creds) return;
  let env = readFileSync(target, 'utf8');
  for (const [k, v] of [['PLATFORM_CLIENT_ID', creds.client_id], ['PLATFORM_CLIENT_SECRET', creds.client_secret]] as const) {
    env = new RegExp(`^${k}=.*$`, 'm').test(env) ? env.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`) : `${env.trimEnd()}\n${k}=${v}\n`;
  }
  writeFileSync(target, env);
  console.log('   Bridge key copied to server/.env (restart the journey-chat server).');
}
