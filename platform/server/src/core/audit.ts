import { prisma } from '../db';
export const audit = (a: { tenantId?: string | null; actor: string; action: string; roomId?: string | null; targetId?: string | null; reason?: string | null; data?: object }) =>
  prisma.auditLog.create({ data: { tenantId: a.tenantId ?? null, actor: a.actor, action: a.action, roomId: a.roomId ?? null, targetId: a.targetId ?? null, reason: a.reason ?? null, data: a.data ?? undefined } });
