import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { logger } from './logger';
import { prisma } from './prisma';
import { decryptAuthState,encryptAuthState } from './security/secrets';
import { sendWebhookRequest,type WebhookPayload } from './webhook';

/** Persist before attempting HTTP. Retries keep the original event timestamp and payload. */
export async function enqueueWebhookDelivery(webhookId: string, payload: WebhookPayload, db: Prisma.TransactionClient = prisma): Promise<void> {
  const id = randomUUID();
  await db.webhookDelivery.create({ data: { id, webhookId, sessionId: payload.sessionId, payload: encryptAuthState(JSON.stringify(payload), `webhook:${id}`) } });
}

/** At-least-once delivery; receivers deduplicate. A lease also recovers process crashes. */
export async function deliverWebhookJobs(now = new Date()): Promise<number> {
  const jobs = await prisma.webhookDelivery.findMany({
    where: { OR: [{ state: 'PENDING', nextAt: { lte: now } }, { state: 'SENDING', leaseUntil: { lte: now } }] }, orderBy: { nextAt: 'asc' }, take: 10,
  });
  let delivered = 0;
  for (const job of jobs) {
    const leaseUntil = new Date(now.getTime() + 60_000);
    const claim = await prisma.webhookDelivery.updateMany({ where: { id: job.id, attempts: job.attempts, state: job.state, ...(job.state === 'SENDING' ? { leaseUntil: { lte: now } } : {}) }, data: { state: 'SENDING', attempts: { increment: 1 }, leaseUntil } });
    if (!claim.count) continue;
    const where = { id: job.id, attempts: job.attempts + 1, leaseUntil };
    try {
      const webhook = await prisma.webhook.findUnique({ where: { id: job.webhookId }, include: { user: { select: { id: true, role: true, disabled: true } } } });
      if (!webhook?.isActive || webhook.user.disabled) {
        await prisma.webhookDelivery.deleteMany({ where });
        continue;
      }
      const session = await prisma.session.findUnique({ where: { sessionId: job.sessionId }, select: { id: true, userId: true, user: { select: { disabled: true } } } });
      if (!session || session.user.disabled || (webhook.sessionId && webhook.sessionId !== session.id)) { await prisma.webhookDelivery.deleteMany({ where }); continue; }
      if (webhook.user.role !== 'SUPERADMIN' && session.userId !== webhook.user.id && !await prisma.sessionAccess.findUnique({ where: { sessionId_userId: { sessionId: session.id, userId: webhook.user.id } } })) { await prisma.webhookDelivery.deleteMany({ where }); continue; }
      const payload: WebhookPayload = JSON.parse(decryptAuthState(job.payload, `webhook:${job.id}`));
      const events = webhook.events;
      if (!Array.isArray(events) || (!events.includes(payload.event) && !events.includes('*'))) {
        await prisma.webhookDelivery.deleteMany({ where }); continue;
      }
      await sendWebhookRequest(webhook.url, payload, webhook.secret, webhook.id);
      await prisma.webhookDelivery.deleteMany({ where });
      delivered++;
    } catch {
      // Retain encrypted dead letters for explicit review instead of losing failed opt-outs.
      const exhausted = now.getTime() - job.createdAt.getTime() > 7 * 86_400_000;
      await prisma.webhookDelivery.updateMany({ where, data: { state: exhausted ? 'FAILED' : 'PENDING', leaseUntil: null, nextAt: new Date(now.getTime() + Math.min(3600_000, 5000 * 2 ** Math.min(job.attempts, 10))) } });
      logger.warn('Webhook', exhausted ? 'Delivery exhausted; encrypted dead letter retained for review' : 'Delivery pending retry');
    }
  }
  return delivered;
}

export function startWebhookDeliveryWorker(): ReturnType<typeof setInterval> {
  const timer = setInterval(() => { deliverWebhookJobs().catch(() => logger.error('Webhook', 'Delivery worker failed')); }, 5000);
  timer.unref();
  return timer;
}
