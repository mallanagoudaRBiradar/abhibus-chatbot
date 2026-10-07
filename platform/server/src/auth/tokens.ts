import jwt from 'jsonwebtoken';
import { config } from '../config';
import type { Role } from '../shared/roles';

/**
 * Three token kinds, never interchangeable (audience differs):
 *  - tenant  server-to-server, 1 h, from client credentials
 *  - user    dashboard session, 12 h
 *  - member  one traveller in one room, short-lived, handed to the chat screen
 */
const ISS = 'trip-rooms';
export interface TenantClaims { tid: string; cid: string; scopes: string[] }
export interface UserClaims { uid: string; email: string; role: Role; tenants: string[] }
export interface MemberClaims { rid: string; mid: string; tid: string }

const sign = (aud: string, payload: object, expiresIn: number) => jwt.sign(payload, config.JWT_SECRET, { algorithm: 'HS256', issuer: ISS, audience: aud, expiresIn });
const verify = <T,>(aud: string, token: string) => jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'], issuer: ISS, audience: aud }) as T & jwt.JwtPayload;

export const signTenantToken = (c: TenantClaims) => sign('tenant', c, 3600);
export const verifyTenantToken = (t: string) => verify<TenantClaims>('tenant', t);
export const signUserToken = (c: UserClaims) => sign('user', c, 12 * 3600);
/** Signed-out dashboard sessions, kept until the token would have expired anyway. Per-instance, like the rate limiter. */
const revokedUserTokens = new Map<string, number>(); // token → expiry (ms)
setInterval(() => { const now = Date.now(); for (const [t, exp] of revokedUserTokens) if (exp < now) revokedUserTokens.delete(t); }, 10 * 60_000).unref();
export const verifyUserToken = (t: string) => {
  if (revokedUserTokens.has(t)) throw new Error('revoked');
  return verify<UserClaims>('user', t);
};
export const revokeUserToken = (t: string) => {
  try { revokedUserTokens.set(t, (verifyUserToken(t).exp ?? 0) * 1000); } catch { /* already invalid */ }
};
export const isUserTokenRevoked = (t: string) => revokedUserTokens.has(t);
export const signMemberToken = (c: MemberClaims, ttlSec: number) => sign('member', c, Math.max(60, Math.min(86_400, ttlSec)));
export const verifyMemberToken = (t: string) => verify<MemberClaims>('member', t);
export const bearer = (h: string | undefined) => (h ?? '').replace(/^Bearer\s+/i, '').trim();
