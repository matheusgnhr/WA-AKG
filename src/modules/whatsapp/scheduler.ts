import type { WASocket, AnyMessageContent } from "@whiskeysockets/baileys";
import cronParser from 'cron-parser';
import { safeFetch } from '@/lib/security/safe-fetch';
import { prisma } from '@/lib/prisma';
import { waManager } from './manager';
import { logger } from '@/lib/logger';

type Sender = { getInstance(id: string): { socket: Pick<WASocket, 'sendMessage'> | null } | undefined };

export async function checkScheduledMessages(manager: Sender = waManager): Promise<void> {
  const now = new Date();
  const pending = await prisma.scheduledMessage.findMany({ where: { status: 'PENDING', sendAt: { lte: now } }, include: { session: true }, orderBy: { sendAt: 'asc' }, take: 100 });
  for (const msg of pending) {
    const instance = manager.getInstance(msg.session.sessionId);
    if (!instance?.socket) continue;
    const claim = await prisma.scheduledMessage.updateMany({ where: { id: msg.id, status: 'PENDING', sendAt: { lte: now } }, data: { status: 'DISPATCHING' } });
    if (!claim.count) continue;
    let attempted = false;
    try {
      const nextDate = msg.cronExpression ? cronParser.parse(msg.cronExpression, { tz: process.env.TZ || 'UTC' }).next().toDate() : null;
      let content: AnyMessageContent = { text: msg.content || '' };
      if (msg.mediaUrl) {
        const response = await safeFetch(msg.mediaUrl);
        if (!response.ok) throw new Error('Media download failed');
        const bytes = Buffer.from(await response.arrayBuffer());
        if (msg.mediaType === 'image') content = { image: bytes, caption: msg.content || '' };
        else if (msg.mediaType === 'video') content = { video: bytes, caption: msg.content || '' };
        else if (msg.mediaType === 'audio') content = { audio: bytes, mimetype: 'audio/ogg' };
        else content = { document: bytes, caption: msg.content || '', mimetype: 'application/octet-stream', fileName: 'attachment' };
      }
      // Once a provider call starts, errors have ambiguous outcome and must never trigger an automatic retry.
      attempted = true;
      await instance.socket.sendMessage(msg.jid, content);
      await prisma.scheduledMessage.updateMany({ where: { id: msg.id, status: 'DISPATCHING' }, data: nextDate ? { status: 'PENDING', sendAt: nextDate } : { status: 'SENT' } });
    } catch {
      await prisma.scheduledMessage.updateMany({ where: { id: msg.id, status: 'DISPATCHING' }, data: { status: attempted ? 'UNKNOWN' : 'FAILED' } });
      logger.error('Scheduler', `Scheduled message ${msg.id} requires review`);
    }
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
export async function recoverInterruptedSchedules(): Promise<void> {
  // Supported topology is one gateway process. At startup no old claim can still be active.
  await prisma.scheduledMessage.updateMany({ where: { status: 'DISPATCHING' }, data: { status: 'UNKNOWN' } });
}

export function startScheduler() {
  if (timer) return;
  if (process.env.ENABLE_GATEWAY_SCHEDULER !== 'true') return;
  let recovered = false;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      if (!recovered) { await recoverInterruptedSchedules(); recovered = true; }
      await checkScheduledMessages();
    } catch { logger.error('Scheduler', 'Scheduler scan failed'); }
    finally { running = false; }
  };
  run();
  timer = setInterval(run, 30_000);
  timer.unref();
}
