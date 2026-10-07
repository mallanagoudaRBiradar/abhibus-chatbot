import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { config } from '../config';

/**
 * Field-level encryption for the few personal details Ops needs to reach a
 * passenger (name, contact phone). AES-256-GCM, key from PII_ENCRYPTION_KEY
 * (64 hex chars). Stored as "v1.<iv>.<tag>.<ciphertext>" (base64url).
 * The rows are hard-deleted with the chat; these values never reach other
 * passengers or the chat UI.
 */
const key = config.PII_ENCRYPTION_KEY ? Buffer.from(config.PII_ENCRYPTION_KEY, 'hex') : null;

export const piiEnabled = () => key !== null;

export function seal(plain: string | null | undefined): string | null {
  if (!plain || !key) return null;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

export function open(sealed: string | null | undefined): string | null {
  if (!sealed || !key) return null;
  const [v, iv, tag, data] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || !data) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
  } catch { return null; }
}
