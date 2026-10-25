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

test('API-key login is native-only and never invokes runtime credential entry', () => {
  let created = false;
  const auth = new PiAuth(async () => {
    created = true;
    throw new Error('GUI must not start API-key login');
  });
  assert.throws(() => auth.start('anthropic', 'api_key'), /\/login/);
  assert.equal(created, false);
  assert.equal(auth.busy, false);
});

test('only nonsecret select prompts accept GUI responses; cancellation saves no credential', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'p2e-auth-cancel-'));
  const authPath = path.join(root, 'auth.json');
  const auth = new PiAuth(async signal => {
    const runtime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false, signal });
    const original = runtime.getProvider('anthropic')!;
    runtime.registerNativeProvider({
      ...original,
      id: 'select-flow-test',
      auth: { oauth: {
        ...original.auth.oauth!,
        async login(interaction) {
          await interaction.prompt({ type: 'select', message: 'Account type', options: [{ id: 'personal', label: 'Personal' }] });
          await interaction.prompt({ type: 'select', message: 'Confirm', options: [{ id: 'continue', label: 'Continue' }] });
          throw new Error('Test flow should have been cancelled');
        }
      } }
    });
    return runtime;
  }, path.join(root, 'device-id'));
  try {
    const first = auth.start('select-flow-test', 'oauth');
    const prompted = await until(auth, first.id, state => !!state.prompt);
    assert.equal(prompted.prompt?.type, 'select');
    assert.throws(() => auth.start('select-flow-test', 'oauth'), /Уже/);
    assert.throws(() => auth.respond(first.id, 'stale-prompt', 'personal'), /завершён/);
    assert.throws(() => auth.respond(first.id, prompted.prompt!.id, 'arbitrary-secret'), /Недопустимый/);
    auth.respond(first.id, prompted.prompt!.id, 'personal');
    await until(auth, first.id, state => !!state.prompt && state.prompt.id !== prompted.prompt!.id);
    await auth.cancel(first.id);
    assert.equal(auth.state(first.id).status, 'cancelled');
    assert.equal(auth.state(first.id).prompt, undefined);
    const runtime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
    assert.deepEqual(await runtime.listCredentials(), []);
    const second = auth.start('select-flow-test', 'oauth');
    await until(auth, second.id, state => !!state.prompt);
    assert.notEqual(second.id, first.id);
    await auth.shutdown();
    assert.equal(auth.state(second.id).status, 'cancelled');
  } finally { await auth.shutdown(); await rm(root, { recursive: true, force: true }); }
});

for (const type of ['secret', 'text'] as const) {
  test(`OAuth ${type} credential prompts stay outside public state`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'p2e-auth-native-'));
    const authPath = path.join(root, 'auth.json');
    const auth = new PiAuth(async signal => {
      const runtime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false, signal });
      const original = runtime.getProvider('anthropic')!;
      runtime.registerNativeProvider({
        ...original, id: 'native-only-test',
        auth: { oauth: {
          ...original.auth.oauth!,
          async login(interaction) {
            await interaction.prompt({ type, message: 'Enter private credential' });
            throw new Error('Credential prompt must not resolve');
          }
        } }
      });
      return runtime;
    }, path.join(root, 'device-id'));
    try {
      const login = auth.start('native-only-test', 'oauth');
      const failed = await until(auth, login.id, state => state.status !== 'pending');
      assert.equal(failed.status, 'failed');
      assert.equal(failed.prompt, undefined);
      assert.match(failed.error!, /\/login/);
      assert.equal(JSON.stringify(failed).includes('Enter private credential'), false);
      assert.throws(() => auth.respond(login.id, 'arbitrary', 'private'), /завершён/);
      const runtime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
      assert.deepEqual(await runtime.listCredentials(), []);
    } finally { await auth.shutdown(); await rm(root, { recursive: true, force: true }); }
  });
}

test('OAuth browser callback works without exposing manual-code entry; only provider-owned HTTPS links open', async () => {
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
    const prompted = await until(auth, login.id, state => state.notices.some(notice => notice.type === 'info' && notice.message.includes('/login')));
    assert.equal(prompted.prompt, undefined);
    assert.equal(auth.authLink(login.id, 'https://example.com/authorize'), 'https://example.com/authorize');
    assert.equal(auth.authLink(login.id, 'https://example.com/device'), 'https://example.com/device');
    assert.throws(() => auth.authLink(login.id, 'https://unrelated.example/'), /Недопустимая/);
    assert.throws(() => auth.authLink(login.id, 'file:///etc/passwd'), /Недопустимая/);
    manual.abort();
    const waiting = await until(auth, login.id, state => !state.prompt);
    assert.equal(waiting.status, 'pending');
    assert.throws(() => auth.respond(login.id, 'manual-code-is-not-public', 'late-code'), /завершён/);
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
