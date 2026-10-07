import jwt from 'jsonwebtoken';
import { config } from '../config';

/**
 * Verifies the passenger's AbhiBus login when the APP calls
 * POST /v1/journey-chat/join directly (APP_AUTH_MODE=jwt).
 *
 * PNR + seat alone is a guessable secret, so a join always needs a proof of
 * login. Two supported set-ups:
 *  - partner (recommended): the app asks the AbhiBus backend, which already
 *    knows the user owns the PNR, and the backend calls
 *    POST /v1/partner/chat-sessions with our server key. /join is closed.
 *  - jwt: the app forwards its AbhiBus access token; we verify it with the
 *    auth service's public key (RS256/ES256) or a shared secret (HS256) and
 *    read the account id from APP_JWT_USER_CLAIM.
 *  - open (LOCAL TESTING ONLY, refused in production): no login; PNR + seat on the
 *    web join screen is enough, so real bookings can be tried at localhost:8081.
 */
export async function verifyAppSession(authHeader: string | undefined): Promise<{ userId: string } | null> {
  if (config.DEMO_MODE) return { userId: 'demo-user' };
  if (config.APP_AUTH_MODE === 'open' && config.NODE_ENV !== 'production') return { userId: 'local-test' };
  if (config.APP_AUTH_MODE !== 'jwt' || !authHeader?.startsWith('Bearer ')) return null;
  try {
    const key = config.APP_JWT_PUBLIC_KEY ? config.APP_JWT_PUBLIC_KEY.replace(/\\n/g, '\n') : config.APP_JWT_SECRET!;
    const claims = jwt.verify(authHeader.slice(7), key, {
      algorithms: config.APP_JWT_PUBLIC_KEY ? ['RS256', 'ES256'] : ['HS256'],
      ...(config.APP_JWT_ISSUER ? { issuer: config.APP_JWT_ISSUER } : {}),
    }) as jwt.JwtPayload;
    const userId = claims[config.APP_JWT_USER_CLAIM];
    return userId ? { userId: String(userId) } : null;
  } catch {
    return null;
  }
}
