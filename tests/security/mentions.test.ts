import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

test('universal message payload preserves embedded mentions and accepts explicit overrides', async () => {
  type Content = { text: string; mentions?: string[] };
  let captured: Content | undefined;
  const source = readFileSync('src/modules/whatsapp/chat.service.ts', 'utf8');
  const sandboxModule = { exports: {} as { ChatService: { sendTextMessage(session: string, jid: string, content: Content, mentions?: string[]): Promise<unknown> } } };
  const stubs: Record<string, unknown> = {
    '@/lib/error-message': { errorMessage: () => 'Stubbed error' },
    '@/lib/prisma': { prisma: {} },
    '@/lib/jid-utils': { normalizeJid: (value: string) => value },
    '@/lib/security/safe-fetch': { safeFetch: () => { throw new Error('Network forbidden'); } },
    '@/lib/security/sticker': class {},
    '@/lib/webhook': { onMessageSent: async () => {} },
    '@/modules/whatsapp/manager': { waManager: { getInstance: () => ({ socket: { sendMessage: async (_jid: string, content: Content) => { captured = content; return { key: { id: 'SYNTHETIC' } }; } } }) } },
  };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module: sandboxModule, exports: sandboxModule.exports, require: (id: string) => { if (!(id in stubs)) throw new Error(`Unstubbed dependency: ${id}`); return stubs[id]; }, Buffer, console, process: { env: {} }, Date, AbortSignal,
  }, { timeout: 1500 });
  const embedded = ['embedded@s.whatsapp.net'], override = ['override@s.whatsapp.net'];
  await sandboxModule.exports.ChatService.sendTextMessage('synthetic', '123@g.us', { text: 'Hello', mentions: embedded });
  assert.deepEqual(captured?.mentions, embedded);
  await sandboxModule.exports.ChatService.sendTextMessage('synthetic', '123@g.us', { text: 'Hello', mentions: embedded }, override);
  assert.deepEqual(captured?.mentions, override);
  await sandboxModule.exports.ChatService.sendTextMessage('synthetic', '123@g.us', { text: 'Hello', mentions: embedded }, []);
  assert.deepEqual(captured?.mentions, []);
});
