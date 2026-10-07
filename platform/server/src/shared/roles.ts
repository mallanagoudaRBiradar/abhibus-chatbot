/**
 * Dashboard roles → permissions. Single source of truth: the server enforces
 * it on every console endpoint and the dashboard uses it to show/hide UI.
 *  - admin      everything, incl. users, tenants, API keys
 *  - ops        run live trips: alerts, trip tools, inbox, broadcast, moderation, reveal (logged)
 *  - support    customer care desk: the @care / @support ticket queue, private replies, the inbox — no reveal, no broadcast
 *  - marketing  campaigns, ad rules (read), results
 *  - developer  API docs, sandbox, tenant config, API keys & webhooks for their tenants
 *  - viewer     read-only dashboards (leadership)
 */
export const ROLES = ['admin', 'ops', 'support', 'marketing', 'developer', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'rooms.read', 'rooms.act', 'inbox.act', 'broadcast.send', 'members.reveal', 'moderation.act', 'audit.read',
  'campaigns.read', 'campaigns.write', 'config.read', 'config.write', 'keys.manage', 'webhooks.manage',
  'sandbox.use', 'users.manage', 'tenants.manage', 'events.read', 'support.handle',
  'rooms.manage', // admin: create (single / bulk), edit, end chat, close, delete trip rooms
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: [...PERMISSIONS],
  ops: ['rooms.read', 'rooms.act', 'inbox.act', 'broadcast.send', 'members.reveal', 'moderation.act', 'audit.read', 'campaigns.read', 'config.read', 'events.read'],
  support: ['rooms.read', 'inbox.act', 'support.handle', 'audit.read', 'events.read'],
  marketing: ['rooms.read', 'campaigns.read', 'campaigns.write', 'config.read', 'events.read'],
  developer: ['rooms.read', 'config.read', 'config.write', 'keys.manage', 'webhooks.manage', 'sandbox.use', 'events.read', 'audit.read'],
  viewer: ['rooms.read', 'campaigns.read', 'config.read', 'audit.read', 'events.read'],
};
export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin', ops: 'Operations', support: 'Customer support', marketing: 'Marketing', developer: 'Developer', viewer: 'Viewer (read-only)',
};
export const can = (role: Role, p: Permission) => ROLE_PERMISSIONS[role]?.includes(p) ?? false;

/** OAuth scopes for tenant API clients. */
export const SCOPES = ['rooms:write', 'rooms:read', 'members:write', 'announcements:write', 'location:write', 'campaigns:write', 'moderation:write', 'webhooks:write', 'config:write'] as const;
export type Scope = (typeof SCOPES)[number];
