import nextEnv from '@next/env';
nextEnv.loadEnvConfig(process.cwd());
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BufferJSON, initAuthCreds } from '@whiskeysockets/baileys';
import { prisma } from '../../src/lib/prisma';
import { createPrismaAuthState as usePrismaAuthState } from '../../src/modules/whatsapp/auth/usePrismaAuthState';
const exec = promisify(execFile);
const url = new URL(process.env.DATABASE_URL!);
if (url.hostname !== '127.0.0.1' || url.pathname !== '/wa_akg_security') throw new Error('Disposable DB required');

test('real bootstrap refuses account promotion and explicit credential migration preserves identity', async () => {
  const prefix = 'provision_' + randomBytes(6).toString('hex');
  const email = prefix + '@example.invalid';
  const user = await prisma.user.create({ data: { email, password: 'SYNTHETIC_HASH', role: 'OWNER' } });
  try {
    await assert.rejects(exec(process.execPath, ['scripts/setup-admin.mjs', email], { env: { ...process.env, ADMIN_PASSWORD: randomBytes(32).toString('hex') } }), /Refusing to promote/);
    const unchanged = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(unchanged.role, 'OWNER'); assert.equal(unchanged.password, 'SYNTHETIC_HASH');
    const creds = initAuthCreds();
    const session = await prisma.session.create({ data: { userId: user.id, sessionId: prefix, name: 'Credential migration fixture' } });
    await prisma.sessionIdentifier.createMany({ data: [{ id: prefix }, { id: session.id }] });
    const value = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
    await prisma.authState.create({ data: { sessionId: prefix, key: 'creds-me', value } });
    const cli = ['node_modules/tsx/dist/cli.mjs', 'security/migrate-auth-state.ts'];
    await exec(process.execPath, cli);
    assert.equal(typeof (await prisma.authState.findUniqueOrThrow({ where: { sessionId_key: { sessionId: prefix, key: 'creds-me' } } })).value, 'object', 'dry-run must not modify credentials');
    await exec(process.execPath, [...cli, '--apply']);
    const stored = await prisma.authState.findUniqueOrThrow({ where: { sessionId_key: { sessionId: prefix, key: 'creds-me' } } });
    assert.match(stored.value as string, /^v1:/);
    const reopened = await usePrismaAuthState(prefix);
    assert.deepEqual(Buffer.from(reopened.state.creds.noiseKey.private), Buffer.from(creds.noiseKey.private));
    await exec(process.execPath, [...cli, '--apply']);
    assert.equal((await prisma.authState.findUniqueOrThrow({ where: { id: stored.id } })).value, stored.value, 'migration must be idempotent');
    await assert.rejects(exec(process.execPath, cli, { env: { ...process.env, WA_AUTH_ENCRYPTION_KEY: randomBytes(32).toString('base64') } }), /migration failed/);
    assert.equal((await prisma.authState.findUniqueOrThrow({ where: { id: stored.id } })).value, stored.value, 'wrong key must not overwrite ciphertext');
  } finally {
    await prisma.authState.deleteMany({ where: { sessionId: prefix } });
    await prisma.user.delete({ where: { id: user.id } }); await prisma.$disconnect();
  }
});
