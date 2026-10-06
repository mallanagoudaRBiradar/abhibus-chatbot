import { config } from '../config';

/**
 * Hook into the existing AbhiBus customer session.
 *
 * In production the mobile app already has a logged-in AbhiBus user. The join
 * call forwards that session token; we verify it with the auth service and
 * check the PNR belongs to that account (account_id on
 * abrs_online_tickets_temp). PNR + seat alone is a guessable secret — this is
 * what makes room access truly "PNR-verified".
 *
 * TODO(platform): replace the body with a call to the AbhiBus auth service.
 */
export async function verifyAppSession(authHeader: string | undefined): Promise<{ userId: string } | null> {
  if (config.DEMO_MODE) return { userId: 'demo-user' };
  if (!authHeader?.startsWith('Bearer ')) return null;
  // const res = await fetch(`${AUTH_URL}/session/verify`, { headers: { authorization: authHeader } });
  // return res.ok ? { userId: (await res.json()).userId } : null;
  return null;
}
