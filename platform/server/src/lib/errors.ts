import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { logger } from './logger';

/** API errors map to the documented codes (Developer portal → Errors & limits). */
export type ErrorCode =
  | 'invalid_request' | 'unauthorized' | 'forbidden' | 'feature_disabled' | 'not_found'
  | 'room_state' | 'trip_key_conflict' | 'moderation_blocked' | 'rate_limited' | 'internal';
const STATUS: Record<ErrorCode, number> = {
  invalid_request: 400, unauthorized: 401, forbidden: 403, feature_disabled: 403, not_found: 404,
  room_state: 409, trip_key_conflict: 409, moderation_blocked: 422, rate_limited: 429, internal: 500,
};
export class ApiError extends Error {
  constructor(public code: ErrorCode, message: string, public details?: unknown) { super(message); }
}
export const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: { code: 'invalid_request', message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') } });
  }
  if (err instanceof ApiError) {
    if (err.code === 'rate_limited') res.setHeader('Retry-After', '5');
    return res.status(STATUS[err.code]).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  logger.error({ err, path: req.path }, 'unhandled error');
  return res.status(500).json({ error: { code: 'internal', message: 'Something went wrong.' } });
}
