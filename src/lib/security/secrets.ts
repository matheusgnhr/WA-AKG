import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function encryptionKey(): Buffer {
  const raw = process.env.WA_AUTH_ENCRYPTION_KEY || '';
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32 || key.toString('base64') !== raw) {
    throw new Error('WA_AUTH_ENCRYPTION_KEY must be a fresh 32-byte base64 key');
  }
  return key;
}

export function encryptAuthState(json: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');
}

export function decryptAuthState(value: unknown, context: string): string {
  if (typeof value !== 'string') throw new Error('Unencrypted legacy auth state; explicit migration or re-pair required');
  const [version, iv, tag, payload, extra] = value.split(':');
  if (version !== 'v1' || !iv || !tag || !payload || extra) throw new Error('Invalid encrypted auth state');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(payload, 'base64')), decipher.final()]).toString('utf8');
}

export function generateApiKey(): string {
  return `wag_${randomBytes(32).toString('base64url')}`;
}

export function hashApiKey(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function assertSecureConfiguration(): void {
  encryptionKey();
  const secret = process.env.AUTH_SECRET || '';
  if (secret.length < 32 || /your-|change-this|super-secret/i.test(secret)) {
    throw new Error('AUTH_SECRET must be a fresh secret of at least 32 characters');
  }
  const url = new URL(process.env.BASE_URL || '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid BASE_URL');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
}
