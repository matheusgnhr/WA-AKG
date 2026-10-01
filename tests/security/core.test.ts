import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createCipheriv, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { getMediaKeys } from '@whiskeysockets/baileys';
import { assertSessionId, mediaFilename, parseMediaFilename, newSessionId } from '../../src/lib/security/identifiers';
import { generateApiKey, hashApiKey, encryptAuthState, decryptAuthState } from '../../src/lib/security/secrets';
import { validateSafeUrl, isPublicAddress, safeFetch } from '../../src/lib/security/safe-fetch';
import { MEDIA_DIR, writePrivateMedia, readPrivateMedia, deletePrivateMedia } from '../../src/lib/security/media-store';
import { decryptWhatsAppMedia } from '../../src/lib/security/incoming-media';
import Sticker from '../../src/lib/security/sticker';
import { safeLoginRedirect } from '../../src/lib/security/redirect';
import { signWebhook } from '../../src/lib/security/webhook-signature';
import { boundedFormData, MAX_UPLOAD_BYTES } from '../../src/lib/security/uploads';
import { KeyedLock } from '../../src/lib/security/keyed-lock';

test('session lifecycle serializes starts/stops/deletes and releases after failure', async () => {
  const lock = new KeyedLock(), order: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const first = lock.run('session', async () => { order.push('start'); await barrier; order.push('started'); });
  const second = lock.run('session', async () => { order.push('delete'); });
  await lock.run('other', async () => { order.push('other'); });
  assert.deepEqual(order, ['start', 'other']);
  release(); await Promise.all([first, second]);
  assert.deepEqual(order, ['start', 'other', 'started', 'delete']);
  await assert.rejects(lock.run('session', async () => { throw new Error('fixture'); }));
  await lock.run('session', async () => { order.push('recovered'); });
  assert.equal(order.at(-1), 'recovered');
});

test('multipart uploads have a streamed byte limit, including absent Content-Length', async () => {
  const form = new FormData(); form.append('file', new Blob(['fixture']), 'fixture.txt');
  const parsed = await boundedFormData(new Request('https://example.invalid', { method: 'POST', body: form }));
  assert.equal(await (parsed.get('file') as File).text(), 'fixture');
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_UPLOAD_BYTES + 1)); }, cancel() { cancelled = true; } });
  const request = new Request('https://example.invalid', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
  await assert.rejects(boundedFormData(request), /10 MiB/); assert.equal(cancelled, true);
});

test('login redirects stay inside the app and webhooks always require a signing secret', () => {
  for (const value of [null, 'https://evil.invalid', '//evil.invalid', '/\\evil.invalid', '/\tevil.invalid']) assert.equal(safeLoginRedirect(value), '/dashboard');
  assert.equal(safeLoginRedirect('/dashboard/webhooks?tab=api'), '/dashboard/webhooks?tab=api');
  for (const secret of [null, undefined, '', 'short']) assert.throws(() => signWebhook('{}', secret), /secret/);
  const secret = randomBytes(32).toString('hex'), body = '{"test":"é"}';
  assert.equal(signWebhook(body, secret), 'sha256=' + createHmac('sha256', secret).update(body).digest('hex'));
});

test('IDs and filenames reject traversal, namespace injection and uncontrolled MIME extensions', () => {
  for (const id of ['../public', '../../public/exposed', 'user:victim', 'a/b', '', 'a'.repeat(81)]) assert.throws(() => assertSessionId(id));
  assertSessionId(newSessionId());
  const file = mediaFilename('media_session123', 'ABC123', 'documentMessage');
  assert.equal(file, 'media_session123-ABC123.bin');
  assert.deepEqual(parseMediaFilename(file), { sessionId: 'media_session123', messageId: 'ABC123' });
  assert.equal(parseMediaFilename('orphan.jpg'), null);
  assert.equal(parseMediaFilename('session-ABC.html'), null);
  assert.throws(() => mediaFilename('safe', '../evil', 'imageMessage'));
});

test('API keys have independent entropy and hashes contain no plaintext', () => {
  const keys = Array.from({ length: 100 }, generateApiKey);
  assert.equal(new Set(keys).size, 100);
  assert.match(keys[0], /^wag_[A-Za-z0-9_-]{43}$/);
  assert.match(hashApiKey(keys[0]), /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(hashApiKey(keys[0]), keys[0]);
});

test('auth-state encrypts, binds rows, and rejects tampering and plaintext legacy records', () => {
  const previous = process.env.WA_AUTH_ENCRYPTION_KEY;
  process.env.WA_AUTH_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  try {
    const plain = '{"privateKey":"SYNTHETIC_SECRET"}';
    const value = encryptAuthState(plain, 'session:creds-me');
    assert.equal(value.includes('SYNTHETIC_SECRET'), false);
    assert.equal(decryptAuthState(value, 'session:creds-me'), plain);
    assert.throws(() => decryptAuthState(value, 'other:creds-me'));
    const parts = value.split(':'); parts[3] = Buffer.alloc(16).toString('base64');
    assert.throws(() => decryptAuthState(parts.join(':'), 'session:creds-me'));
    assert.throws(() => decryptAuthState({ privateKey: 'legacy' }, 'session:creds-me'));
  } finally { if (previous === undefined) delete process.env.WA_AUTH_ENCRYPTION_KEY; else process.env.WA_AUTH_ENCRYPTION_KEY = previous; }
});

test('private, mapped IPv6 and metadata destinations are blocked', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '0.0.0.0', '192.168.1.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1']) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  for (const url of ['http://example.com', 'file:///etc/passwd', 'https://user:pass@example.com', 'https://127.0.0.1', 'https://[::1]', 'https://169.254.169.254']) assert.throws(() => validateSafeUrl(url));
  await assert.rejects(safeFetch('https://localhost'), /Private DNS/);
  await assert.rejects(safeFetch('https://example.com', { signal: AbortSignal.abort() }), /aborted/);
});

test('real loopback webhook fixture proves explicit allowlist, signing bytes, redirects, byte limits and malformed status rejection', async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    if (req.url === '/redirect') { res.writeHead(302, { location: 'http://169.254.169.254/' }); res.end(); return; }
    if (req.url === '/large') { res.end(Buffer.alloc(70_000)); return; }
    if (req.url === '/upgrade') { res.writeHead(101, { connection: 'Upgrade', upgrade: 'websocket' }); res.end(); return; }
    if (req.url === '/bad-status') { res.writeHead(600); res.end(); return; }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ body, signature: req.headers['x-webhook-signature'] })); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const previous = process.env.WEBHOOK_ALLOWED_ORIGINS;
  process.env.WEBHOOK_ALLOWED_ORIGINS = origin;
  try {
    await assert.rejects(safeFetch(origin + '/ok'), /HTTPS/); assert.equal(requests, 0);
    const body = '{"event":"synthetic"}';
    const signature = 'sha256=' + createHmac('sha256', 'synthetic-secret').update(body).digest('hex');
    const response = await safeFetch(origin + '/ok', { method: 'POST', body, headers: { 'x-webhook-signature': signature } }, true);
    assert.deepEqual(await response.json(), { body, signature });
    await assert.rejects(safeFetch(origin + '/redirect', {}, true), /Redirects/);
    await assert.rejects(safeFetch(origin + '/large', {}, true), /size limit/);
    await assert.rejects(safeFetch(origin + '/bad-status', {}, true), /range/);
    await assert.rejects(safeFetch(origin + '/upgrade', {}, true), /upgrades|closed/);
    assert.equal(requests, 5);
  } finally { if (previous === undefined) delete process.env.WEBHOOK_ALLOWED_ORIGINS; else process.env.WEBHOOK_ALLOWED_ORIGINS = previous; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('private media cannot escape, overwrite an attachment or follow a symlink', async () => {
  const id = 'media_test' + randomBytes(8).toString('hex');
  const filename = mediaFilename(id, 'ABC', 'documentMessage');
  const link = mediaFilename(id, 'LINK', 'documentMessage');
  try {
    await assert.rejects(writePrivateMedia('../evil.bin', Buffer.from('bad')));
    await writePrivateMedia(filename, Buffer.from('original'));
    await assert.rejects(writePrivateMedia(filename, Buffer.from('replacement')), /Conflicting/);
    await writePrivateMedia(filename, Buffer.from('original'));
    assert.equal((await readPrivateMedia(filename)).toString(), 'original');
    await symlink(path.join(MEDIA_DIR, filename), path.join(MEDIA_DIR, link));
    await assert.rejects(readPrivateMedia(link));
    await assert.rejects(writePrivateMedia(link, Buffer.from('bad')));
    await assert.rejects(deletePrivateMedia(link));
  } finally { await unlink(path.join(MEDIA_DIR, link)).catch(() => {}); await deletePrivateMedia(filename).catch(() => {}); }
});

test('incoming media validates vendor-derived keys and MAC before CBC decryption', async () => {
  const key = randomBytes(32);
  const keys = await getMediaKeys(key, 'image');
  const plain = Buffer.from('synthetic encrypted media fixture');
  const cipher = createCipheriv('aes-256-cbc', keys.cipherKey, keys.iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const mac = createHmac('sha256', keys.macKey!).update(keys.iv).update(ciphertext).digest().subarray(0, 10);
  const encrypted = Buffer.concat([ciphertext, mac]);
  assert.deepEqual(await decryptWhatsAppMedia(encrypted, key, 'image'), plain);
  const corrupt = Buffer.from(encrypted); corrupt[0] ^= 1;
  await assert.rejects(decryptWhatsAppMedia(corrupt, key, 'image'), /authentication/);
  await assert.rejects(decryptWhatsAppMedia(encrypted, randomBytes(32), 'image'), /authentication/);
});

test('local sticker converter produces a bounded WebP with pack metadata', async () => {
  const png = await sharp({ create: { width: 16, height: 12, channels: 4, background: '#ff0000' } }).png().toBuffer();
  const webp = await new Sticker(png, { pack: 'Synthetic pack', author: 'Test author' }).toBuffer();
  const info = await sharp(webp).metadata();
  assert.equal(info.format, 'webp'); assert.equal(info.width, 512); assert.equal(info.height, 512);
  assert.equal(webp.includes(Buffer.from('Synthetic pack')), true);
  const circle = await new Sticker(png, { type: 'circle' }).toBuffer();
  const { data, info: raw } = await sharp(circle).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(data[3], 0, 'circle corners remain transparent');
  assert.equal(data[(256 * raw.width + 256) * 4 + 3], 255, 'circle center remains opaque');
  const pixels = Buffer.alloc(16 * 24 * 4, 255);
  for (let offset = 16 * 12 * 4; offset < pixels.length; offset += 4) pixels[offset] = 0;
  const frames = await sharp(pixels, { raw: { width: 16, height: 24, channels: 4, pageHeight: 12 } }).gif({ delay: [100, 100], loop: 0 }).toBuffer();
  assert.equal((await sharp(frames, { animated: true }).metadata()).pages, 2, 'fixture contains distinct frames');
  const animated = await new Sticker(frames, { type: 'circle' }).toBuffer();
  assert.equal((await sharp(animated, { animated: true }).metadata()).pages, 2, 'animated GIF keeps both frames');
  await assert.rejects(new Sticker(Buffer.alloc(11 * 1024 * 1024)).toBuffer(), /limit/);
});
