import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { PiAuth } from '../src/integrations/pi-auth.js';
import type { PiLoginState } from '../src/shared/types.js';

async function until(auth: PiAuth, id: string, predicate: (state: PiLoginState) => boolean): Promise<PiLoginState> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = auth.state(id);
    if (predicate(state)) return state;
    await delay(10);
  }
  throw new Error('Login did not reach expected state');
}

test('Pi API-key login persists in native storage without exposing the key in public state', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'p2e-auth-'));
  const authPath = path.join(root, 'auth.json');
  const auth = new PiAuth(signal => ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false, signal }));
  const secret = 'isolated-test-key-not-a-real-credential';
  try {
    const login = auth.start('anthropic', 'api_key');
    const prompted = await until(auth, login.id, state => !!state.prompt);
    assert.equal(prompted.prompt?.type, 'secret');
    assert.throws(() => auth.respond(login.id, 'stale-prompt', secret), /завершён/);
    assert.throws(() => auth.start('openai', 'oauth'), /Уже/);
    auth.respond(login.id, prompted.prompt!.id, secret);
    const completed = await until(auth, login.id, state => state.status !== 'pending');
    assert.equal(completed.status, 'completed');
    assert.equal(completed.prompt, undefined);
    assert.equal(JSON.stringify(completed).includes(secret), false);
    const stored = JSON.parse(await readFile(authPath, 'utf8'));
    assert.equal(stored.anthropic.type, 'api_key');
    assert.equal(stored.anthropic.key, secret);
    const reloaded = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
    assert.ok((await reloaded.listCredentials()).some(entry => entry.providerId === 'anthropic'));
    assert.throws(() => auth.respond(login.id, prompted.prompt!.id, secret), /завершён/);
  } finally { await auth.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test('cancelling a pending credential prompt leaves no saved credential and permits another login', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'p2e-auth-cancel-'));
  const authPath = path.join(root, 'auth.json');
  const auth = new PiAuth(signal => ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false, signal }));
  try {
    const first = auth.start('anthropic', 'api_key');
    await until(auth, first.id, state => !!state.prompt);
    await auth.cancel(first.id);
    assert.equal(auth.state(first.id).status, 'cancelled');
    assert.equal(auth.state(first.id).prompt, undefined);
    const runtime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
    assert.deepEqual(await runtime.listCredentials(), []);
    const second = auth.start('anthropic', 'api_key');
    await until(auth, second.id, state => !!state.prompt);
    assert.notEqual(second.id, first.id);
    await auth.shutdown();
    assert.equal(auth.state(second.id).status, 'cancelled');
  } finally { await auth.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test('OAuth callback cancels a manual prompt without ending login; only provider-issued HTTPS links open', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'p2e-auth-oauth-'));
  const authPath = path.join(root, 'auth.json');
  const manual = new AbortController();
  const callback = Promise.withResolvers<void>();
  const deviceIds: string[] = [];
  const auth = new PiAuth(async signal => {
    const runtime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false, signal });
    const original = runtime.getProvider('anthropic')!;
    runtime.registerNativeProvider({
      ...original,
      id: 'oauth-flow-test',
      auth: { oauth: {
        ...original.auth.oauth!,
        async login(interaction, options) {
          deviceIds.push(options!.getDeviceId!());
          interaction.notify({ type: 'auth_url', url: 'https://example.com/authorize' });
          interaction.notify({ type: 'device_code', verificationUri: 'https://example.com/device', userCode: 'ABCD' });
          try { await interaction.prompt({ type: 'manual_code', message: 'Callback URL', signal: manual.signal }); }
          catch { /* The browser callback wins the manual-code race. */ }
          await callback.promise;
          return { type: 'oauth', access: 'private-access', refresh: 'private-refresh', expires: Date.now() + 3600_000 };
        }
      } }
    });
    return runtime;
  }, path.join(root, 'device-id'));
  try {
    const login = auth.start('oauth-flow-test', 'oauth');
    const prompted = await until(auth, login.id, state => !!state.prompt);
    assert.equal(auth.authLink(login.id, 'https://example.com/authorize'), 'https://example.com/authorize');
    assert.equal(auth.authLink(login.id, 'https://example.com/device'), 'https://example.com/device');
    assert.throws(() => auth.authLink(login.id, 'https://unrelated.example/'), /Недопустимая/);
    assert.throws(() => auth.authLink(login.id, 'file:///etc/passwd'), /Недопустимая/);
    manual.abort();
    const waiting = await until(auth, login.id, state => !state.prompt);
    assert.equal(waiting.status, 'pending');
    assert.throws(() => auth.respond(login.id, prompted.prompt!.id, 'late-code'), /завершён/);
    callback.resolve();
    const completed = await until(auth, login.id, state => state.status !== 'pending');
    assert.equal(completed.status, 'completed');
    assert.equal(JSON.stringify(completed).includes('private-access'), false);
    assert.throws(() => auth.authLink(login.id, 'https://example.com/authorize'), /Недопустимая/);
    assert.equal(JSON.parse(await readFile(authPath, 'utf8'))['oauth-flow-test'].type, 'oauth');
    const second = auth.start('oauth-flow-test', 'oauth');
    assert.equal((await until(auth, second.id, state => state.status !== 'pending')).status, 'completed');
    assert.equal(deviceIds[0], await readFile(path.join(root, 'device-id'), 'utf8'));
    assert.equal(deviceIds[0], deviceIds[1]);
  } finally { callback.resolve(); await auth.shutdown(); await rm(root, { recursive: true, force: true }); }
});
