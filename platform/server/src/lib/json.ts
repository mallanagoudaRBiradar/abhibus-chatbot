/**
 * MySQL has no list columns, so string lists (tenant ids, scopes, routes, …)
 * are stored as JSON arrays. Read them back through this.
 */
export const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
