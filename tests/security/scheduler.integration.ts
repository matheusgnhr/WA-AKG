import nextEnv from '@next/env';
nextEnv.loadEnvConfig(process.cwd());
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { prisma } from '../../src/lib/prisma';
import { checkScheduledMessages, recoverInterruptedSchedules } from '../../src/modules/whatsapp/scheduler';
const url = new URL(process.env.DATABASE_URL!);
if (url.hostname !== '127.0.0.1' || url.pathname !== '/wa_akg_security') throw new Error('Disposable local DB required');

test('real DB concurrent schedule claims prevent duplicate sends and preserve ambiguous outcomes', async () => {
  const id = 'scheduler_' + randomBytes(6).toString('hex');
  const user = await prisma.user.create({ data: { email: id + '@example.invalid', password: 'UNUSABLE_TEST_HASH', role: 'OWNER' } });
  try {
    const session = await prisma.session.create({ data: { userId: user.id, sessionId: id, name: 'Scheduler fixture' } });
    const due = await prisma.scheduledMessage.create({ data: { sessionId: session.id, jid: 'synthetic@example.invalid', content: 'synthetic', sendAt: new Date(0) } });
    let calls = 0;
    const sender = { getInstance: () => ({ socket: { sendMessage: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 20)); return { key: { id: 'SYNTHETIC' } }; } } }) };
    await Promise.all([checkScheduledMessages(sender), checkScheduledMessages(sender)]);
    assert.equal(calls, 1);
    assert.equal((await prisma.scheduledMessage.findUnique({ where: { id: due.id } }))?.status, 'SENT');
    const uncertain = await prisma.scheduledMessage.create({ data: { sessionId: session.id, jid: 'synthetic@example.invalid', content: 'synthetic', sendAt: new Date(0) } });
    const ambiguous = { getInstance: () => ({ socket: { sendMessage: async () => { calls++; throw new Error('synthetic timeout after submission'); } } }) };
    await checkScheduledMessages(ambiguous);
    assert.equal((await prisma.scheduledMessage.findUnique({ where: { id: uncertain.id } }))?.status, 'UNKNOWN');
    await checkScheduledMessages(ambiguous); assert.equal(calls, 2, 'unknown provider outcome must not be retried');
    const badMedia = await prisma.scheduledMessage.create({ data: { sessionId: session.id, jid: 'synthetic@example.invalid', mediaUrl: 'file:///etc/passwd', sendAt: new Date(0) } });
    await checkScheduledMessages(sender);
    assert.equal((await prisma.scheduledMessage.findUnique({ where: { id: badMedia.id } }))?.status, 'FAILED');
    assert.equal(calls, 2, 'unsafe media must fail before provider call');
    const interrupted = await prisma.scheduledMessage.create({ data: { sessionId: session.id, jid: 'synthetic@example.invalid', content: 'synthetic interrupted attempt', sendAt: new Date(0), status: 'DISPATCHING' } });
    await recoverInterruptedSchedules();
    assert.equal((await prisma.scheduledMessage.findUniqueOrThrow({ where: { id: interrupted.id } })).status, 'UNKNOWN');
    await checkScheduledMessages(sender);
    assert.equal(calls, 2, 'interrupted attempts require review rather than automatic resend');
  } finally { await prisma.user.delete({ where: { id: user.id } }); await prisma.$disconnect(); }
});
