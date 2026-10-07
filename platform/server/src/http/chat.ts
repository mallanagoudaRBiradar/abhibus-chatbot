import { Router } from 'express';
import { prisma } from '../db';
import { ApiError, wrap } from '../lib/errors';
import { bearer, verifyMemberToken } from '../auth/tokens';
import { getTenant, isQuiet, roomFeatures } from '../core/tenants';
import { journeyInfo } from '../core/rooms';
import { display } from '../core/identity';
import { QUICK_ASKS, ISSUE_TYPES } from '../shared/verticals';
import type { JoinResponse } from '../shared/protocol';

/**
 * Hosted chat screen bootstrap: GET /chat/v1/session with the member token
 * → tenant branding + features, the room, and who "I" am. The screen then
 * connects to /ws with the same token.
 */
export const chatApi = Router();
chatApi.get('/session', wrap(async (req, res) => {
  let c;
  try { c = verifyMemberToken(bearer(req.header('authorization')) || String(req.query.token ?? '')); } catch { throw new ApiError('unauthorized', 'This link has expired. Open the chat again from your trip.'); }
  const [m, r] = await Promise.all([prisma.member.findUnique({ where: { id: c.mid } }), prisma.room.findUnique({ where: { id: c.rid } })]);
  if (!m || !r) throw new ApiError('unauthorized', 'This link has expired.');
  if (m.removedAt) throw new ApiError('forbidden', m.removedReason === 'reported_by_majority' ? 'You were removed from this trip chat after reports from other travellers.' : 'You’re no longer in this trip chat.');
  const { t, cfg } = await getTenant(r.tenantId);
  const theme = t.theme as JoinResponse['tenant']['theme'];
  const features = await roomFeatures(r);
  const who = display(m, cfg.identity.mode);
  const body: JoinResponse = {
    tenant: {
      id: t.id, name: t.name, theme, identityMode: cfg.identity.mode, features, socialMin: cfg.social_min, slowModeSec: cfg.slow_mode_sec,
      quiet: { ...cfg.quiet, active: isQuiet(cfg) }, careHandle: cfg.support.care_handle, supportPhone: cfg.support.phone,
      quickAsks: QUICK_ASKS[r.vertical], issues: ISSUE_TYPES[r.vertical],
    },
    token: String(bearer(req.header('authorization')) || req.query.token),
    me: { seat: m.id, profileNeeded: cfg.identity.mode === 'profile' && !m.profileSet, handle: who.name, name: who.name, avatar: who.avatar, guest: false, pnrMasked: m.bookingRef.replace(/^(.{2}).*(.{2})$/, '$1••••$2'), gender: m.gender },
    journey: await journeyInfo(r, m),
    supportPhone: cfg.support.phone,
  };
  res.json(body);
}));
