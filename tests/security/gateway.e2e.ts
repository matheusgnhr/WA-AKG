import nextEnv from '@next/env';
nextEnv.loadEnvConfig(process.cwd());
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { io, Socket } from 'socket.io-client';
import { prisma } from '../../src/lib/prisma';
import { hashApiKey } from '../../src/lib/security/secrets';
import { mediaFilename } from '../../src/lib/security/identifiers';
import { writePrivateMedia, deletePrivateMedia } from '../../src/lib/security/media-store';
import { createPrismaAuthState as usePrismaAuthState } from '../../src/modules/whatsapp/auth/usePrismaAuthState';

const base = process.env.BASE_URL!;
const dbUrl = new URL(process.env.DATABASE_URL!);
if (dbUrl.hostname !== '127.0.0.1' || dbUrl.pathname !== '/wa_akg_security' || new URL(base).hostname !== '127.0.0.1') throw new Error('This suite requires the dedicated local disposable DB and gateway');
const checks: string[] = [];
const sockets: Socket[] = [];
const userIds: string[] = [];
const sessionSlugs: string[] = [];
const prefix = 'sec_' + randomBytes(6).toString('hex');
function check(label: string, condition: unknown) { assert.ok(condition, label); checks.push(label); }
async function request(path: string, method = 'GET', body?: unknown, cookie?: string, key?: string) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (key) headers['x-api-key'] = key;
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}
function cookies(response: Response): string {
  return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
}
async function login(email: string, password: string) {
  const csrf = await fetch(base + '/api/auth/csrf');
  const { csrfToken } = await csrf.json();
  const response = await fetch(base + '/api/auth/callback/credentials', { method: 'POST', headers: { cookie: cookies(csrf), 'content-type': 'application/x-www-form-urlencoded', 'x-auth-return-redirect': '1', origin: base }, body: new URLSearchParams({ csrfToken, email, password, callbackUrl: base + '/dashboard' }), redirect: 'manual' });
  const cookie = cookies(response);
  assert.match(cookie, /authjs\.session-token=/, 'real NextAuth credential sign-in must yield a session cookie');
  return cookie;
}
async function connect(auth?: { apiKey: string }, cookie?: string, allowed = true) {
  const socket = io(base, { path: '/api/socket/io', transports: ['websocket'], forceNew: true, reconnection: false, timeout: 1500, auth, extraHeaders: cookie ? { cookie } : undefined });
  sockets.push(socket);
  const result = await new Promise<string>(resolve => { socket.once('connect', () => resolve('connect')); socket.once('connect_error', () => resolve('denied')); });
  assert.equal(result, allowed ? 'connect' : 'denied');
  return socket;
}

// Real HTTP gateway + dedicated MySQL-compatible DB + Socket.IO. No Baileys session start, QR pairing or real message send.
test('security journeys through the production gateway and disposable database', { timeout: 45_000 }, async () => {
  let mediaFile: string | undefined;
  const previousConfig = await prisma.systemConfig.findUnique({ where: { id: 'default' } });
  try {
    const adminCookie = await login(process.env.ADMIN_EMAIL!, process.env.ADMIN_PASSWORD!);
    check('NextAuth real admin login', (await request('/api/sessions', 'GET', undefined, adminCookie)).status === 200);
    check('docs anonymous denied', (await request('/api/docs')).status === 401);
    check('docs fake API key denied', (await request('/api/docs', 'GET', undefined, undefined, 'fake-key')).status === 401);
    check('invalid key does not fall back to valid cookie', (await request('/api/docs', 'GET', undefined, adminCookie, 'fake-key')).status === 401);
    await prisma.systemConfig.upsert({ where: { id: 'default' }, create: { id: 'default', appName: 'Security fixture', enableRegistration: false }, update: { enableRegistration: false } });
    check('public signup closed', (await request('/api/auth/register', 'POST', { name: 'Fixture', email: prefix + '@example.invalid', password: randomBytes(20).toString('hex') })).status === 403);
    check('branding update succeeds', (await request('/api/settings/system', 'POST', { appName: 'Security fixture changed' }, adminCookie)).status === 200);
    check('branding preserves closed registration', (await prisma.systemConfig.findUnique({ where: { id: 'default' } }))?.enableRegistration === false);

    const identities: { email: string; password: string; id: string; cookie: string; key: string }[] = [];
    for (const suffix of ['owner', 'other']) {
      const email = `${prefix}_${suffix}@example.invalid`, password = randomBytes(20).toString('hex');
      const created = await request('/api/users', 'POST', { name: 'Security fixture ' + suffix, email, password, role: 'OWNER' }, adminCookie);
      assert.equal(created.status, 201); userIds.push(created.data.data.id);
      const cookie = await login(email, password);
      const key = (await request('/api/user/api-key', 'POST', undefined, cookie)).data.data.apiKey;
      check('API key stored hashed for ' + suffix, (await prisma.user.findUnique({ where: { id: created.data.data.id } }))?.apiKey === hashApiKey(key));
      identities.push({ email, password, id: created.data.data.id, cookie, key });
    }
    const [owner, other] = identities;
    check('configured key is never redisplayed', (await request('/api/user/api-key', 'GET', undefined, owner.cookie)).data.data.apiKey === null);
    check('configured flag preserved', (await request('/api/user/api-key', 'GET', undefined, owner.cookie)).data.data.configured === true);
    check('path traversal session rejected', (await request('/api/sessions', 'POST', { name: 'Bad', sessionId: '../../public/exposed' }, owner.cookie)).status === 400);
    const sid = prefix + '_wa'; sessionSlugs.push(sid);
    const created = await request('/api/sessions', 'POST', { name: 'Security fixture', sessionId: sid }, owner.cookie);
    assert.equal(created.status, 200); const dbSession = created.data.data;
    check('new session stays disconnected', dbSession.status === 'STOPPED');
    check('namespace collision denied', (await request('/api/sessions', 'POST', { name: 'Collision', sessionId: dbSession.id }, other.cookie)).status === 409);
    const victimSid = prefix + '_victim'; sessionSlugs.push(victimSid);
    const victimSession = (await request('/api/sessions', 'POST', { name: 'Victim fixture', sessionId: victimSid }, other.cookie)).data.data;
    const victimRule = await prisma.autoReply.create({ data: { sessionId: victimSession.id, keyword: 'original', response: 'original', matchType: 'EXACT' } });
    const rulePath = `/api/autoreplies/${sid}/${victimRule.id}`;
    check('foreign auto reply update denied', (await request(rulePath, 'PUT', { keyword: 'corrupt', response: 'corrupt' }, owner.cookie)).status === 404);
    check('foreign auto reply unchanged', (await prisma.autoReply.findUnique({ where: { id: victimRule.id } }))?.keyword === 'original');
    check('foreign auto reply deletion denied', (await request(rulePath, 'DELETE', undefined, owner.cookie)).status === 404);
    const label = await prisma.label.create({ data: { sessionId: victimSid, name: 'Victim label' } });
    const jid = '15555550000@s.whatsapp.net';
    await prisma.chatLabel.create({ data: { labelId: label.id, chatJid: jid } });
    const labelPath = `/api/labels/${sid}/chat/${encodeURIComponent(jid)}/labels`;
    check('foreign label removal denied', (await request(labelPath, 'PUT', { action: 'remove', labelIds: [label.id] }, owner.cookie)).status === 404);
    check('foreign label attachment preserved', !!await prisma.chatLabel.findUnique({ where: { labelId_chatJid: { labelId: label.id, chatJid: jid } } }));
    const ownRule = await prisma.autoReply.create({ data: { sessionId: dbSession.id, keyword: 'own', response: 'own', matchType: 'EXACT' } });
    check('own auto reply update succeeds', (await request(`/api/autoreplies/${sid}/${ownRule.id}`, 'PUT', { keyword: 'updated', response: 'updated' }, owner.cookie)).status === 200);
    const ownLabel = await prisma.label.create({ data: { sessionId: sid, name: 'Own label' } });
    check('own label add succeeds', (await request(labelPath, 'PUT', { action: 'add', labelIds: [ownLabel.id] }, owner.cookie)).status === 200);
    check('own label removal succeeds', (await request(labelPath, 'PUT', { action: 'remove', labelIds: [ownLabel.id] }, owner.cookie)).status === 200);
    check('other owner cannot manage sharing', (await request(`/api/sessions/${sid}/access`, 'POST', { email: other.email }, other.cookie)).status === 403);
    check('unauthorized session socket denied', (await (await connect({ apiKey: other.key })).timeout(1500).emitWithAck('join-session', sid)).allowed === false);
    await connect(undefined, undefined, false); checks.push('anonymous socket handshake denied');
    await connect({ apiKey: 'invalid' }, undefined, false); checks.push('fake key socket handshake denied');
    const ownSocket = await connect({ apiKey: owner.key });
    check('owner room join authorized', (await ownSocket.timeout(1500).emitWithAck('join-session', sid)).allowed === true);
    const cookieSocket = await connect(undefined, owner.cookie);
    check('browser cookie socket authorized', (await cookieSocket.timeout(1500).emitWithAck('join-session', sid)).allowed === true);
    check('arbitrary user namespace not joinable', (await ownSocket.timeout(1500).emitWithAck('join-session', `user:${other.id}`)).allowed === false);
    check('owner can share own session', (await request(`/api/sessions/${sid}/access`, 'POST', { email: other.email }, owner.cookie)).status === 201);
    const sharedSocket = await connect({ apiKey: other.key });
    check('shared socket room authorized', (await sharedSocket.timeout(1500).emitWithAck('join-session', sid)).allowed === true);
    check('owner revokes sharing', (await request(`/api/sessions/${sid}/access`, 'DELETE', { userId: other.id }, owner.cookie)).status === 200);
    check('revoked socket cannot rejoin', (await sharedSocket.timeout(1500).emitWithAck('join-session', sid)).allowed === false);
    check('upstream repeated sends disabled', (await request(`/api/messages/${sid}/synthetic/spam`, 'POST', { message: 'synthetic', count: 999999 }, owner.cookie)).status === 410);
    check('upstream detached broadcast disabled', (await request(`/api/messages/${sid}/broadcast`, 'POST', { recipients: ['synthetic'], message: 'synthetic' }, owner.cookie)).status === 410);
    check('unsafe webhook URL rejected', (await request(`/api/webhooks/${sid}`, 'POST', { name: 'Unsafe', url: 'https://169.254.169.254/', events: ['message.received'], secret: randomBytes(32).toString('hex') }, owner.cookie)).status === 400);
    check('unsigned webhook rejected', (await request(`/api/webhooks/${sid}`, 'POST', { name: 'Unsigned', url: 'https://example.invalid/hook', events: ['message.received'] }, owner.cookie)).status === 400);
    const legacyHook = await prisma.webhook.create({ data: { userId: owner.id, sessionId: dbSession.id, name: 'Legacy unsigned', url: 'https://example.invalid/hook', events: ['message.received'] } });
    check('legacy unsigned test fails before network', (await request(`/api/webhooks/${sid}/${legacyHook.id}/test`, 'POST', undefined, owner.cookie)).data.data.success === false);
    check('legacy unsigned activation rejected', (await request(`/api/webhooks/${sid}/${legacyHook.id}`, 'PUT', { isActive: true }, owner.cookie)).status === 400);
    check('legacy unsigned hook can be disabled', (await request(`/api/webhooks/${sid}/${legacyHook.id}`, 'PUT', { isActive: false }, owner.cookie)).status === 200);
    mediaFile = mediaFilename(`media_${dbSession.id}`, 'SYNTHETIC', 'documentMessage');
    await writePrivateMedia(mediaFile, Buffer.from('SYNTHETIC_PRIVATE_BYTES'));
    check('own media readable', (await fetch(base + '/api/media/' + mediaFile, { headers: { 'x-api-key': owner.key } })).status === 200);
    check('foreign media denied', (await fetch(base + '/api/media/' + mediaFile, { headers: { 'x-api-key': other.key } })).status === 403);
    check('orphan filename rejected', (await request('/api/media/orphan.jpg', 'GET', undefined, owner.cookie)).status === 400);
    check('orphan deletion denied', (await request('/api/media', 'DELETE', { filenames: ['orphan.jpg'] }, owner.cookie)).data.data.deleted === 0);

    const state = await usePrismaAuthState(sid); await state.saveCreds();
    const stored = await prisma.authState.findUnique({ where: { sessionId_key: { sessionId: sid, key: 'creds-me' } } });
    check('real DB stores encrypted WhatsApp credentials', typeof stored?.value === 'string' && stored.value.startsWith('v1:'));
    const reopened = await usePrismaAuthState(sid);
    check('encrypted state reload retains identity', Buffer.from(reopened.state.creds.noiseKey.private).equals(Buffer.from(state.state.creds.noiseKey.private)));
    const disconnected = new Promise<void>(resolve => ownSocket.once('disconnect', () => resolve()));
    const rotated = await request('/api/user/api-key', 'POST', undefined, owner.cookie);
    check('API key rotation succeeds', rotated.status === 200);
    await Promise.race([disconnected, new Promise((_, reject) => setTimeout(() => reject(new Error('socket not disconnected on rotation')), 2000))]);
    checks.push('key rotation disconnects existing socket');
    check('old API key rejected after rotation', (await request('/api/docs', 'GET', undefined, undefined, owner.key)).status === 401);
    owner.key = rotated.data.data.apiKey;
    check('new API key accepted', (await request('/api/docs', 'GET', undefined, undefined, owner.key)).status === 200);
    check('HTTP deletion succeeds once', (await request(`/api/sessions/${sid}/settings`, 'DELETE', undefined, owner.cookie)).status === 200);
    check('real deletion service removes session', await prisma.session.findUnique({ where: { id: dbSession.id } }) === null);
    check('deleted session media cannot transfer', (await fetch(base + '/api/media/' + mediaFile, { headers: { 'x-api-key': other.key } })).status === 403);
    check('deleted public ID cannot be reused', (await request('/api/sessions', 'POST', { name: 'Reuse', sessionId: sid }, other.cookie)).status === 409);
    check('deleted canonical ID cannot become an alias', (await request('/api/sessions', 'POST', { name: 'Alias reuse', sessionId: dbSession.id }, other.cookie)).status === 409);
    const victimState = await usePrismaAuthState(victimSid); await victimState.saveCreds();
    await prisma.user.update({ where: { id: other.id }, data: { disabled: true } });
    check('disabled user API key denied before deletion', (await request('/api/docs', 'GET', undefined, undefined, other.key)).status === 401);
    check('disabled user cookie denied before deletion', (await request('/api/sessions', 'GET', undefined, other.cookie)).status === 401);
    await connect({ apiKey: other.key }, undefined, false); checks.push('disabled user socket denied');
    check('disabled account cannot create sessions', (await request('/api/sessions', 'POST', { name: 'Blocked', sessionId: prefix + '_blocked' }, other.cookie)).status === 401);
    await assert.rejects(login(other.email, other.password)); checks.push('disabled user cannot log in again');
    check('admin can delete a user with sessions', (await request(`/api/users/${other.id}`, 'DELETE', undefined, adminCookie)).status === 200);
    await assert.rejects(victimState.saveCreds()); checks.push('late credential write cannot resurrect deleted session');
    check('deleted user sessions removed', await prisma.session.count({ where: { userId: other.id } }) === 0);
    check('deleted user credentials removed', await prisma.authState.count({ where: { sessionId: victimSid } }) === 0);
    check('deleted user session IDs remain reserved', await prisma.sessionIdentifier.count({ where: { id: { in: [victimSid, victimSession.id] } } }) === 2);
    check('deleted user API key denied', (await request('/api/docs', 'GET', undefined, undefined, other.key)).status === 401);
    console.log(JSON.stringify({ checks: checks.length, passed: checks, environment: 'production HTTP gateway + real MySQL-compatible database + real Socket.IO; no WhatsApp pairing or sends' }));
  } finally {
    for (const socket of sockets) socket.disconnect();
    if (mediaFile) await deletePrivateMedia(mediaFile).catch(() => {});
    await prisma.authState.deleteMany({ where: { sessionId: { in: sessionSlugs } } });
    await prisma.label.deleteMany({ where: { sessionId: { in: sessionSlugs } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    if (previousConfig) { const { id, appName, logoUrl, faviconUrl, timezone, enableRegistration } = previousConfig; const data = { appName, logoUrl, faviconUrl, timezone, enableRegistration }; await prisma.systemConfig.upsert({ where: { id }, create: { id, ...data }, update: data }); }
    else await prisma.systemConfig.deleteMany({ where: { id: 'default' } });
    await prisma.$disconnect();
  }
});
