import { createHmac } from 'node:crypto';

export function signWebhook(body: string, secret?: string | null): string {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Webhook secret must have at least 32 characters');
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}
