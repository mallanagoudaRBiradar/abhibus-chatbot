import { randomBytes } from 'crypto';
/** Short, prefixed, URL-safe ids: room_9f2k1a, mem_3kd9x2, act_… */
export const newId = (prefix: string, len = 10) => `${prefix}_${randomBytes(16).toString('base64url').replace(/[-_]/g, '').slice(0, len).toLowerCase()}`;
