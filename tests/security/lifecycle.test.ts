import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

// Actual first-party modules run in a VM; every external effect is explicitly denied or controlled.
// For reproducible red evidence: WA_AKG_LIFECYCLE_BASELINE=02da763 node --import tsx --test tests/security/lifecycle.test.ts
const root = process.cwd();
const baseline = process.env.WA_AKG_LIFECYCLE_BASELINE === '02da763';
const source = (file: string) => baseline ? execFileSync('git', ['show', '02da763:' + file], { cwd: root, encoding: 'utf8' }) : fs.readFileSync(path.join(root, file), 'utf8');
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
const logger = new Proxy({}, { get: () => () => {} });
function load<T>(file: string, stubs: Record<string, unknown>, extras: Record<string, unknown> = {}): T {
  const sandboxModule = { exports: {} };
  const sandbox = { module: sandboxModule, exports: sandboxModule.exports, require: (id: string) => { if (!(id in stubs)) throw new Error('Unstubbed dependency: ' + id); return stubs[id]; }, process: { env: {} }, Buffer, Date, console, ...extras };
  vm.runInNewContext(ts.transpileModule(source(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, sandbox, { timeout: 1500 });
  return sandboxModule.exports as T;
}
type Gate = { started: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> };
type Keys = { set(data: Record<string, Record<string, unknown>>): Promise<void> };
type AuthStore = { state: { keys: Keys }; close(): Promise<void> };
type AuthModule = { createPrismaAuthState(sessionId: string): Promise<AuthStore> };
type Socket = { auth: { keys: Keys }; fire(event: string, data: unknown): Promise<unknown> };
type Manager = { setup(io: unknown): void; startSession(id: string): Promise<void>; stopSession(id: string): Promise<void>; loadSessions(): Promise<void> };
function fixture() {
  const state: { status: string; auth: Map<string, string>; sockets: Socket[]; disconnected: Gate | null; mutation: Gate | null; sessionUpdates: string[] } = { status: 'CONNECTED', auth: new Map(), sockets: [], disconnected: null, mutation: null, sessionUpdates: [] };
  const row = () => ({ id: 'db-synthetic', sessionId: 'synthetic', userId: 'owner-synthetic', status: state.status, user: { disabled: false }, botConfig: {}, config: {} });
  const prisma = {
    session: {
      findUnique: async () => row(),
      findMany: async ({ where }: { where: { status: { notIn?: string[]; not?: string } } }) => { const filter = where.status; return filter.notIn?.includes(state.status) || filter.not === state.status ? [] : [row()]; },
      update: async ({ data }: { data: { status: string } }) => { if (data.status === 'DISCONNECTED' && state.disconnected) { state.disconnected.started.resolve(); await state.disconnected.release.promise; } state.status = data.status; state.sessionUpdates.push(data.status); return row(); },
    },
    authState: {
      findUnique: async ({ where }: { where: { sessionId_key: { key: string } } }) => state.auth.has(where.sessionId_key.key) ? { value: state.auth.get(where.sessionId_key.key) } : null,
      count: async () => state.auth.size,
      upsert: async ({ create }: { create: { key: string; value: string } }) => { if (state.mutation) { state.mutation.started.resolve(); await state.mutation.release.promise; } state.auth.set(create.key, create.value); return create; },
      deleteMany: async ({ where }: { where: { key?: string } }) => { if (where.key) { if (state.mutation) { state.mutation.started.resolve(); await state.mutation.release.promise; } state.auth.delete(where.key); } else state.auth.clear(); return { count: 1 }; },
    },
    $transaction: async (fn: ((db: unknown) => Promise<unknown>) | Promise<unknown>[]) => typeof fn === 'function' ? fn(prisma) : Promise.all(fn),
  };
  const baileys = {
    __esModule: true,
    default: (config: { auth: { keys: Keys } }) => { const listeners = new Map<string, (data: unknown) => unknown>(); const socket = { ev: { on: (event: string, cb: (data: unknown) => unknown) => listeners.set(event, cb) }, sendMessage: async () => { throw new Error('Real messages forbidden'); }, end: () => {}, logout: async () => {}, auth: config.auth, fire: (event: string, data: unknown) => Promise.resolve(listeners.get(event)?.(data)) }; state.sockets.push(socket); return socket; },
    DisconnectReason: { loggedOut: 401 }, fetchLatestBaileysVersion: async () => ({ version: [0, 0, 0] }), makeCacheableSignalKeyStore: (value: unknown) => value,
    BufferJSON: { replacer: (_key: string, value: unknown) => value, reviver: (_key: string, value: unknown) => value }, initAuthCreds: () => ({ synthetic: true }),
  };
  const auth = load<AuthModule>('src/modules/whatsapp/auth/usePrismaAuthState.ts', { '@/lib/logger': { logger }, '@/lib/prisma': { prisma }, '@/lib/security/secrets': { encryptAuthState: (value: string) => value, decryptAuthState: (value: string) => value }, '@whiskeysockets/baileys': baileys });
  const instance = load('src/modules/whatsapp/instance.ts', { '@/lib/logger': { logger }, '@/lib/prisma': { prisma }, '@prisma/client': { Prisma: { PrismaClientKnownRequestError: class extends Error {} } }, '@whiskeysockets/baileys': baileys, pino: { default: () => ({}) }, './antispam': { antispam: { enqueue: async () => {} } }, './auth/usePrismaAuthState': auth, './store': { bindSessionStore: () => {} }, './store/autoreply': { bindAutoReply: () => {} }, './store/contacts': { bindContactSync: () => {} }, './store/groups': { syncGroups: async () => {} }, './store/ppguard': { bindPpGuard: () => {} } }, { setTimeout: () => ({ unref: () => {} }) });
  const lock = load('src/lib/security/keyed-lock.ts', {});
  const manager = load<{ waManager: Manager }>('src/modules/whatsapp/manager.ts', { '@/lib/logger': { logger }, '@/lib/prisma': { prisma }, '@/lib/security/identifiers': { assertSessionId: () => {}, newSessionId: () => 'synthetic' }, '@/lib/security/keyed-lock': lock, './instance': instance }, { global: {}, setTimeout: () => { throw new Error('Unexpected lifecycle sleep'); } }).waManager;
  manager.setup({ to: () => ({ emit: () => {} }) });
  const route = load<{ POST(request: unknown, context: unknown): Promise<{ status: number }> }>('src/app/api/sessions/[sessionId]/[action]/route.ts', { '@/lib/api-auth': { getAuthenticatedUser: async () => ({ id: 'owner-synthetic', role: 'OWNER' }), canAccessSession: async () => true }, '@/lib/error-message': { errorMessage: (error: Error) => error.message }, '@/lib/prisma': { prisma }, '@/modules/whatsapp/manager': { waManager: manager }, 'next/server': { NextResponse: { json: (data: unknown, options: { status?: number } = {}) => ({ status: options.status ?? 200, data }) } } });
  const logoutRoute = () => route.POST({ json: async () => ({}) }, { params: Promise.resolve({ sessionId: 'synthetic', action: 'logout' }) });
  return { state, manager, auth, logoutRoute };
}

test('entered connection callback is drained before final STOPPED, and stopped session is not autoloaded', { timeout: 4000 }, async () => {
  const { state, manager } = fixture();
  await manager.startSession('synthetic');
  state.disconnected = { started: deferred(), release: deferred() };
  const event = state.sockets[0].fire('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 500 } } } });
  await state.disconnected.started.promise;
  let stopped = false;
  const stop = manager.stopSession('synthetic').then(() => { stopped = true; });
  try { await flush(); assert.equal(stopped, false, 'stop must await the already-entered connection callback'); }
  finally { state.disconnected.release.resolve(); await Promise.all([event, stop]); }
  assert.equal(state.status, 'STOPPED', 'late disconnect callback must not be the final persistent state');
  state.auth.set('creds-me', JSON.stringify({ synthetic: true }));
  const sockets = state.sockets.length;
  await manager.loadSessions();
  assert.equal(state.sockets.length, sockets, 'manual stop must remain sticky across autoload');
});

for (const kind of ['creds', 'signal-key']) test('logout drains gated ' + kind + ' mutation and prevents old state from recreating AuthState', { timeout: 4000 }, async () => {
  const { state, manager, logoutRoute } = fixture();
  await manager.startSession('synthetic');
  const socket = state.sockets[0];
  state.mutation = { started: deferred(), release: deferred() };
  const oldKeys = socket.auth.keys;
  const writing = kind === 'creds' ? socket.fire('creds.update', {}) : oldKeys.set({ session: { 'synthetic-key': { synthetic: true } } });
  await state.mutation.started.promise;
  let loggedOut = false;
  const logout = logoutRoute().then(response => { assert.equal(response.status, 200); loggedOut = true; });
  try { await flush(); assert.equal(loggedOut, false, 'logout must await in-flight credential/key persistence'); }
  finally { state.mutation.release.resolve(); await Promise.all([writing, logout]); }
  assert.equal(state.status, 'LOGGED_OUT');
  assert.equal(state.auth.size, 0, 'logout removes credentials after the last old write');
  await oldKeys.set({ session: { 'late-key': { synthetic: true } } });
  await socket.fire('creds.update', {});
  assert.equal(state.auth.size, 0, 'old callbacks and key stores cannot recreate credentials after logout');
});

test('auth close independently drains key deletions and blocks new key writes', { timeout: 4000 }, async () => {
  const { state, auth } = fixture();
  const old = await auth.createPrismaAuthState('synthetic');
  state.mutation = { started: deferred(), release: deferred() };
  state.auth.set('session-key', JSON.stringify({ synthetic: true }));
  const writing = old.state.keys.set({ session: { key: null } });
  await state.mutation.started.promise;
  assert.equal(typeof old.close, 'function', 'auth store needs an explicit write barrier');
  let closed = false;
  const closing = old.close().then(() => { closed = true; });
  try { await flush(); assert.equal(closed, false); }
  finally { state.mutation.release.resolve(); await Promise.all([writing, closing]); }
  state.auth.clear();
  await old.state.keys.set({ session: { key: { forbiddenLateWrite: true } } });
  assert.equal(state.auth.size, 0);
});
