import nextEnv from '@next/env';
nextEnv.loadEnvConfig(process.cwd());
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes, createHmac } from 'node:crypto';
import type { WASocket } from '@whiskeysockets/baileys';
import { prisma } from '../../src/lib/prisma';
import { bindSessionStore } from '../../src/modules/whatsapp/store';

const dbUrl = new URL(process.env.DATABASE_URL!);
if (dbUrl.hostname !== '127.0.0.1' || dbUrl.pathname !== '/wa_akg_security') throw new Error('Disposable local DB required');

test('real Message/outbox transaction survives capture, welcome and auto-read failures; receipts never regress', { timeout: 30_000 }, async () => {
  const slug = 'store_' + randomBytes(6).toString('hex');
  const secret = randomBytes(32).toString('hex');
  const calls: { signature: string | undefined; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = ''; req.on('data', bytes => body += bytes);
    req.on('end', () => { calls.push({ body, signature: req.headers['x-webhook-signature'] as string }); res.statusCode = 503; res.end('synthetic retry'); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const previous = process.env.WEBHOOK_ALLOWED_ORIGINS;
  process.env.WEBHOOK_ALLOWED_ORIGINS = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const user = await prisma.user.create({ data: { email: slug + '@example.invalid', password: 'UNUSABLE_TEST_HASH' } });
  let trigger = false;
  try {
    const session = await prisma.session.create({ data: { userId: user.id, sessionId: slug, name: 'Synthetic store fixture', botConfig: { create: { enabled: false, autoRead: true, welcomeMessage: 'Synthetic welcome, transport forbidden' } } } });
    const hook = await prisma.webhook.create({ data: { userId: user.id, sessionId: session.id, name: 'Fixture', url: process.env.WEBHOOK_ALLOWED_ORIGINS + '/hook', secret, events: ['message.received', 'message.status'] } });
    const handlers = new Map<string, (value: unknown) => Promise<void>>();
    let welcome = 0, reads = 0;
    const sock = { ev: { on: (name: string, handler: (value: unknown) => Promise<void>) => handlers.set(name, handler) }, readMessages: async () => { reads++; throw new Error('synthetic auto-read failure'); }, sendMessage: async () => { welcome++; throw new Error('synthetic welcome failure'); } } as unknown as WASocket;
    bindSessionStore(sock, slug, null, session.id);
    const message = { key: { id: 'store-opt-out', remoteJid: '15550100301@s.whatsapp.net', fromMe: false }, message: { conversation: 'PARAR' }, messageTimestamp: Math.floor(Date.now() / 1000) };
    const incoming = () => handlers.get('messages.upsert')!({ type: 'notify', messages: [message] });
    await prisma.$executeRawUnsafe(`ALTER TABLE WebhookDelivery ADD CONSTRAINT audit_fail_capture CHECK (sessionId <> '${slug}' OR state = 'FAILED')`); trigger = true;
    await incoming();
    assert.equal(await prisma.message.count({ where: { sessionId: session.id } }), 0, 'outbox failure must roll back the message dedupe marker');
    assert.equal(await prisma.webhookDelivery.count({ where: { webhookId: hook.id } }), 0);
    assert.equal(welcome, 0); assert.equal(reads, 0);
    await prisma.$executeRawUnsafe('ALTER TABLE WebhookDelivery DROP CHECK audit_fail_capture'); trigger = false;
    await incoming();
    assert.equal(await prisma.message.count({ where: { sessionId: session.id } }), 1);
    assert.equal(await prisma.webhookDelivery.count({ where: { webhookId: hook.id } }), 1);
    assert.equal(welcome, 1); assert.equal(reads, 1);
    await incoming();
    assert.equal(welcome, 1); assert.equal(reads, 1);
    assert.equal(await prisma.webhookDelivery.count({ where: { webhookId: hook.id } }), 1, 'replayed message cannot create another webhook');
    const outbound = await prisma.message.create({ data: { sessionId: session.id, keyId: 'store-out', remoteJid: '15550100301@s.whatsapp.net', fromMe: true, type: 'TEXT', content: 'synthetic', status: 'SENT', timestamp: new Date() } });
    const receipt = (status?: number) => handlers.get('messages.update')!([{ key: { id: outbound.keyId }, update: { status } }]);
    for (let n = 0; n < 100 && await prisma.webhookDelivery.count({ where: { webhookId: hook.id, state: 'SENDING' } }); n++) await new Promise(resolve => setTimeout(resolve, 10));
    await prisma.webhookDelivery.updateMany({ where: { webhookId: hook.id }, data: { state: 'FAILED' } });
    await prisma.$executeRawUnsafe(`ALTER TABLE WebhookDelivery ADD CONSTRAINT audit_fail_capture CHECK (sessionId <> '${slug}' OR state = 'FAILED')`); trigger = true;
    await receipt(4);
    assert.equal((await prisma.message.findUniqueOrThrow({ where: { id: outbound.id } })).status, 'SENT');
    await prisma.$executeRawUnsafe('ALTER TABLE WebhookDelivery DROP CHECK audit_fail_capture'); trigger = false;
    await receipt(4); // Baileys READ.
    assert.equal((await prisma.message.findUniqueOrThrow({ where: { id: outbound.id } })).status, 'READ');
    const count = await prisma.webhookDelivery.count({ where: { webhookId: hook.id } });
    await receipt(2); await receipt();
    await handlers.get('messages.upsert')!({ type: 'notify', messages: [{ ...message, key: { ...message.key, id: outbound.keyId, fromMe: true } }] });
    assert.equal((await prisma.message.findUniqueOrThrow({ where: { id: outbound.id } })).status, 'READ');
    assert.equal(await prisma.webhookDelivery.count({ where: { webhookId: hook.id } }), count);
    for (let n = 0; n < 100 && !calls.length; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(calls.length);
    for (const call of calls) assert.equal(call.signature, 'sha256=' + createHmac('sha256', secret).update(call.body).digest('hex'));
    assert.ok(calls.some(call => JSON.parse(call.body).data.content === 'PARAR'));
    for (let n = 0; n < 100 && await prisma.webhookDelivery.count({ where: { webhookId: hook.id, state: 'SENDING' } }); n++) await new Promise(resolve => setTimeout(resolve, 10));
  } finally {
    if (trigger) await prisma.$executeRawUnsafe('ALTER TABLE WebhookDelivery DROP CHECK audit_fail_capture');
    if (previous === undefined) delete process.env.WEBHOOK_ALLOWED_ORIGINS; else process.env.WEBHOOK_ALLOWED_ORIGINS = previous;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.user.delete({ where: { id: user.id } }); await prisma.$disconnect();
  }
});
