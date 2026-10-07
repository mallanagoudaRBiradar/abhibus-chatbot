import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../lib/errors';
import { bearer, verifyTenantToken, verifyUserToken, type TenantClaims, type UserClaims } from './tokens';
import { can, type Permission } from '../shared/roles';
import { limits } from '../lib/rateLimit';

declare global {
  namespace Express {
    interface Request { tenant?: TenantClaims; user?: UserClaims }
  }
}

/** Tenant API: valid tenant token + the required scope; rate limited per client. */
export const requireTenant = (scope?: string) => (req: Request, _res: Response, next: NextFunction) => {
  try {
    const claims = verifyTenantToken(bearer(req.header('authorization')));
    if (scope && !claims.scopes.includes(scope)) return next(new ApiError('forbidden', `This token lacks the "${scope}" scope.`));
    if (!limits.api.take(claims.cid)) return next(new ApiError('rate_limited', 'Rate limit: 50 requests/s per tenant key.'));
    req.tenant = claims;
    next();
  } catch {
    next(new ApiError('unauthorized', 'Missing or expired access token. Get one from POST /v1/oauth/token.'));
  }
};

/** The dashboard token: Authorization header, or ?access_token= for EventSource (which can't set headers). */
export const userBearer = (req: Request) => bearer(req.header('authorization')) || String(req.query.access_token ?? '');

/** Dashboard API: signed-in user with the permission. */
export const requireUser = (perm?: Permission) => (req: Request, _res: Response, next: NextFunction) => {
  try {
    const claims = verifyUserToken(userBearer(req));
    if (perm && !can(claims.role, perm)) return next(new ApiError('forbidden', `Your role (${claims.role}) can’t do this.`));
    req.user = claims;
    next();
  } catch {
    next(new ApiError('unauthorized', 'Please sign in again.'));
  }
};

/** Which tenants a dashboard user may see ([] in the token = all). */
export const userTenants = (u: UserClaims, all: string[]) => (u.tenants.length ? all.filter((t) => u.tenants.includes(t)) : all);
export function assertTenantAccess(u: UserClaims, tenantId: string) {
  if (u.tenants.length && !u.tenants.includes(tenantId)) throw new ApiError('forbidden', 'You don’t have access to this tenant.');
}
