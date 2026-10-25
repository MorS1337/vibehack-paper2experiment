import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store, defaultSettings } from '../src/core/store.js';
import { converseWithPi } from '../src/integrations/pi.js';

test('provider authentication failure is preserved by the persistent conversation session', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'p2e-provider-error-'));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const server = createServer((_request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { type: 'authentication_error', code: 'api_key_expired', message: 'This API key has expired.' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    process.env.PI_CODING_AGENT_DIR = root;
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await writeFile(path.join(root, 'models.json'), JSON.stringify({ providers: {
      'failure-test': { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'isolated-non-secret', models: [{ id: 'test-model', contextWindow: 128000, maxTokens: 1024 }] }
    } }));
    const store = new Store(path.join(root, 'state'));
    await store.load();
    const run = await store.create({ agentMode: 'pi', source: 'local.pdf', task: 'Check a theorem.', mode: 'local', timeSeconds: 60, maxHourlyUSD: 0, maxTotalUSD: 0, cleanup: 'destroy' });
    run.source = { original: 'local.pdf', textPath: 'source.txt', sha256: 'test', pages: [{ page: 1, text: 'A theorem about independent random variables.' }] };
    const context = { run, settings: { ...defaultSettings, piProvider: 'failure-test', piModel: 'test-model' }, signal: AbortSignal.timeout(15000), emit: async () => undefined, projectDir: path.join(run.dir, 'project'), queued: [], persist: (patch: Partial<typeof run>) => store.patch(run.id, patch), publish: () => undefined, attach: () => undefined, acknowledge: async () => undefined };
    await assert.rejects(converseWithPi(context, 'Check this theorem.', { propose: async () => { throw new Error('Must not propose on authentication failure'); }, execute: async () => { throw new Error('Must not execute on authentication failure'); } }), /401.*api_key_expired/);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    const closed = Promise.withResolvers<void>();
    server.close(error => error ? closed.reject(error) : closed.resolve());
    await closed.promise;
    await rm(root, { recursive: true, force: true });
  }
});
