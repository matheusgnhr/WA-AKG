import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { antiSpamDefaults, validAntiSpamConfig } from '../../src/modules/whatsapp/antispam-config';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
test('anti-spam validates numeric bounds and partial merged updates', () => {
  assert.ok(validAntiSpamConfig(antiSpamDefaults));
  assert.ok(validAntiSpamConfig({ spamLimit: 1, spamInterval: 3600, spamDelayMin: 1, spamDelayMax: 60000 }));
  for (const invalid of [{ spamLimit: 0 }, { spamLimit: -1 }, { spamInterval: 0 }, { spamInterval: 3601 }, { spamDelayMin: 0 }, { spamDelayMax: 300.5 }, { spamDelayMin: 4000 }, { spamLimit: '5' }, { spamInterval: null }]) {
    assert.equal(validAntiSpamConfig({ ...antiSpamDefaults, ...invalid }), false);
  }
});

test('public anti-spam queue retains a 120-second rate window and fails closed on storage errors', async () => {
  let now = 0, fail = false;
  const callbacks: (() => void)[] = [];
  const timers: number[] = [];
  class Clock extends Date { static now() { return now; } }
  type Manager = { enqueue(id: string, jid: string, content: unknown): Promise<void>; clearCache(id: string): void };
  const sandboxModule = { exports: {} as { antispam: Manager } };
  const stubs: Record<string, unknown> = {
    '@/lib/logger': { logger: new Proxy({}, { get: () => () => {} }) },
    '@/lib/prisma': { prisma: { session: { findUnique: async () => { if (fail) throw new Error('synthetic storage outage'); return { botConfig: { antiSpamEnabled: true, spamLimit: 2, spamInterval: 120, spamDelayMin: 10000, spamDelayMax: 10000 } }; } } } },
    './antispam-config': { validAntiSpamConfig },
  };
  vm.runInNewContext(ts.transpileModule(readFileSync('src/modules/whatsapp/antispam.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module: sandboxModule, exports: sandboxModule.exports, require: (id: string) => { if (!(id in stubs)) throw new Error('Unstubbed dependency: ' + id); return stubs[id]; }, Date: Clock, Math, Map, console,
    setTimeout: (callback: () => void, ms: number) => { callbacks.push(callback); timers.push(ms); return 1; },
  }, { timeout: 1500 });
  const queue = sandboxModule.exports.antispam;
  await queue.enqueue('synthetic', 'synthetic@example.invalid', { text: 'first' });
  now = 61000;
  await queue.enqueue('synthetic', 'synthetic@example.invalid', { text: 'second' });
  let thirdSent = false;
  const third = queue.enqueue('synthetic', 'synthetic@example.invalid', { text: 'third' }).then(() => { thirdSent = true; });
  await flush(); assert.equal(thirdSent, false); assert.equal(callbacks.length, 1); assert.deepEqual(timers, [10000]);
  now = 71000; callbacks.shift()!(); await flush(); assert.equal(thirdSent, false); assert.equal(callbacks.length, 1);
  now = 120001; callbacks.shift()!(); await third; assert.equal(thirdSent, true);
  queue.clearCache('synthetic'); fail = true;
  await assert.rejects(queue.enqueue('synthetic', 'synthetic@example.invalid', { text: 'blocked' }), /storage outage/);
});

test('scheduler startup recovery cannot overlap across timer ticks', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  let recoveries = 0, scans = 0;
  let tick!: () => Promise<void>;
  const sandboxModule = { exports: {} as { startScheduler(): void } };
  const stubs: Record<string, unknown> = {
    '@/lib/logger': { logger: { error: () => {} } }, '@/lib/security/safe-fetch': { safeFetch: () => { throw new Error('Network forbidden'); } },
    './manager': { waManager: { getInstance: () => undefined } }, 'cron-parser': {},
    '@/lib/prisma': { prisma: { scheduledMessage: { updateMany: async () => { recoveries++; await gate; return { count: 0 }; }, findMany: async () => { scans++; return []; } } } },
  };
  vm.runInNewContext(ts.transpileModule(readFileSync('src/modules/whatsapp/scheduler.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module: sandboxModule, exports: sandboxModule.exports, require: (id: string) => { if (!(id in stubs)) throw new Error('Unstubbed dependency: ' + id); return stubs[id]; }, process: { env: { ENABLE_GATEWAY_SCHEDULER: 'true' } }, Date, Buffer,
    setInterval: (callback: () => Promise<void>) => { tick = callback; return { unref: () => {} }; },
  }, { timeout: 1500 });
  sandboxModule.exports.startScheduler(); await flush();
  await tick(); await tick(); assert.equal(recoveries, 1); assert.equal(scans, 0);
  release(); await flush(); assert.equal(scans, 1);
  await tick(); assert.equal(recoveries, 1); assert.equal(scans, 2);
});
