import nextEnv from '@next/env';
nextEnv.loadEnvConfig(process.cwd());
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes, createHmac } from 'node:crypto';
import { prisma } from '../../src/lib/prisma';
import { dispatchWebhook, testWebhook } from '../../src/lib/webhook';

const db = new URL(process.env.DATABASE_URL!);
if (db.hostname !== '127.0.0.1' || db.pathname !== '/wa_akg_security') throw new Error('Disposable DB required');

test('real webhook HTTP signing and shared-access revocation with real database', { timeout: 15_000 }, async () => {
  const prefix = 'hook_' + randomBytes(6).toString('hex');
  const secret = randomBytes(32).toString('hex');
  const calls: { path: string; signature: string | undefined; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = ''; req.on('data', chunk => body += chunk);
    req.on('end', () => { calls.push({ path: req.url!, signature: req.headers['x-webhook-signature'] as string, body }); res.end('ok'); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const oldAllowlist = process.env.WEBHOOK_ALLOWED_ORIGINS;
  process.env.WEBHOOK_ALLOWED_ORIGINS = origin;
  const userIds: string[] = [];
  async function waitForCount(count: number) {
    for (let i = 0; i < 100 && calls.length < count; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls.length, count);
  }
  try {
    for (const suffix of ['owner', 'shared']) userIds.push((await prisma.user.create({ data: { email: prefix + suffix + '@example.invalid', password: 'UNUSABLE_SYNTHETIC_HASH' } })).id);
    const session = await prisma.session.create({ data: { userId: userIds[0], sessionId: prefix, name: 'Synthetic webhook fixture' } });
    await prisma.sessionIdentifier.createMany({ data: [{ id: prefix }, { id: session.id }] });
    const grant = await prisma.sessionAccess.create({ data: { sessionId: session.id, userId: userIds[1] } });
    for (const [index, path] of ['owner', 'shared'].entries()) await prisma.webhook.create({ data: { userId: userIds[index], sessionId: session.id, name: path, url: origin + '/' + path, secret, events: ['message.received'] } });
    const legacy = await prisma.webhook.create({ data: { userId: userIds[0], sessionId: session.id, name: 'unsigned', url: origin + '/unsigned', events: ['message.received'] } });
    await dispatchWebhook(prefix, 'message.received', { text: 'synthetic before revocation' });
    await waitForCount(2);
    await prisma.sessionAccess.delete({ where: { id: grant.id } });
    await dispatchWebhook(prefix, 'message.received', { text: 'synthetic after revocation' });
    await waitForCount(3);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(calls.filter(call => call.path === '/shared').length, 1, 'revoked sharing must prevent subsequent delivery');
    assert.equal(calls.filter(call => call.path === '/owner').length, 2);
    assert.equal(calls.filter(call => call.path === '/unsigned').length, 0);
    for (const call of calls) assert.equal(call.signature, 'sha256=' + createHmac('sha256', secret).update(call.body).digest('hex'));
    const unsigned = await testWebhook(legacy.id, legacy.url, legacy.secret);
    assert.equal(unsigned.success, false); assert.equal(calls.length, 3);
    // Wait for delivery-log writes before deleting fixtures.
    for (let i = 0; i < 100; i++) {
      if (await prisma.webhookLog.count({ where: { webhook: { sessionId: session.id }, status: 'SUCCESS' } }) === 3) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(await prisma.webhookLog.count({ where: { webhook: { sessionId: session.id }, status: 'SUCCESS' } }), 3);
  } finally {
    if (oldAllowlist === undefined) delete process.env.WEBHOOK_ALLOWED_ORIGINS; else process.env.WEBHOOK_ALLOWED_ORIGINS = oldAllowlist;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }); await prisma.$disconnect();
  }
});
