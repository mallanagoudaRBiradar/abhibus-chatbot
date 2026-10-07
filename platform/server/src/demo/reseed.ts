/** `npm run seed` — wipe and re-create the demo tenants, users, keys and trips (local trip_rooms DB only). */
import { prisma } from '../db';
import { resetAll, seed } from './seed';

(async () => {
  await resetAll();
  await seed();
  console.log('✅ demo data re-seeded. Logins: <role>@triprooms.local / TripRooms@2026 · API keys in .demo-credentials.json');
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
