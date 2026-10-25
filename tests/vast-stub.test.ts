import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { getComputeStatuses, LocalBackend, selectCompute, VastBackend } from '../src/compute/index.js';
import { VastApiClient } from '../src/compute/vast-api.js';
import { SpecSchema, type ComputeContext, type ExperimentRun } from '../src/shared/types.js';

const unavailable = 'Vast — заглушка, платный запуск отключён';

function context(root = '/unused'): ComputeContext {
  const spec = SpecSchema.parse({
    version: 1, title: 'Release compute policy', objective: 'Execute only real local compute', paperResult: 'test',
    sourceRefs: [{ page: 1, quote: 'test' }], data: { description: 'none', split: 'none', preprocessing: 'none' },
    method: 'test', baseline: 'none', parameters: {},
    metric: { name: 'value', computation: 'x', publishedValue: null, comparable: false },
    requirements: { cpuCores: 1, ramGB: 1, gpu: false, vramGB: 0, diskGB: 1 },
    limits: { timeSeconds: 60, maxHourlyUSD: 2, maxTotalUSD: 5 },
    implementation: 'independent', assumptions: [], missing: [], demo: null
  });
  const run: ExperimentRun = {
    id: '00000000-0000-4000-8000-123456789abc', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    title: spec.title, status: 'running', dir: root, spec, planVersion: 1, attempts: 0, artifacts: [],
    input: { agentMode: 'pi', source: 'inline', task: 'test', mode: 'local', timeSeconds: 60, maxHourlyUSD: 2, maxTotalUSD: 5, cleanup: 'destroy' },
    deadlineAt: new Date(Date.now() + 120_000).toISOString()
  };
  return {
    run, spec, projectDir: path.join(root, 'project'), signal: new AbortController().signal,
    settings: { piProvider: '', piModel: '', python: process.env.PYTHON ?? 'python3', whisperBinary: '', whisperModel: '', sshKeyPath: '' },
    persist: async patch => { Object.assign(run, patch); }, emit: async () => undefined
  };
}

function environment(t: TestContext, key: string, value: string | undefined): void {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
}

test('Vast selection, backend launch and direct API create reject before any provider request or credential-file lookup', async t => {
  environment(t, 'VAST_API_KEY', undefined);
  environment(t, 'TYPESAFE_API_KEY', undefined);
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected HTTP request'); });
  const home = t.mock.method(os, 'homedir', () => { throw new Error('Unexpected credential-file lookup'); });
  const ctx = context();
  const backend = new VastBackend();
  const client = new VastApiClient('present-key-does-not-enable-paid-compute');
  await assert.rejects(selectCompute(ctx, 'vast'), { message: unavailable });
  await assert.rejects(backend.prepare(ctx), { message: unavailable });
  await assert.rejects(backend.run(ctx), { message: unavailable });
  await assert.rejects(client.createInstance(123, { image: 'unused' }), { message: unavailable });
  await assert.rejects(client.manageInstance(123, { state: 'running' }), { message: unavailable });
  const status = (await getComputeStatuses(ctx.settings)).find(item => item.component === 'vast');
  assert.deepEqual(status, { component: 'vast', state: 'error', detail: unavailable });
  assert.equal(ctx.run.instanceId, undefined);
  assert.equal(ctx.run.provisioningUncertain, undefined);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(home.mock.callCount(), 0);
});

test('a configured Vast key and SSH path cannot make its release status ready', async t => {
  environment(t, 'VAST_API_KEY', 'configured-but-disabled');
  environment(t, 'TYPESAFE_API_KEY', undefined);
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected HTTP request'); });
  const ctx = context();
  ctx.settings.sshKeyPath = '/configured/ssh/key';
  const status = (await getComputeStatuses(ctx.settings)).find(item => item.component === 'vast');
  assert.deepEqual(status, { component: 'vast', state: 'error', detail: unavailable });
  await assert.rejects(selectCompute(ctx, 'vast'), { message: unavailable });
  assert.equal(fetch.mock.callCount(), 0);
});

test('Auto never searches Vast and still requires the real Jev choice protocol for a suitable Local machine', async t => {
  environment(t, 'VAST_API_KEY', 'configured-but-disabled');
  environment(t, 'TYPESAFE_API_KEY', undefined);
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected HTTP request'); });
  const ctx = context();
  await assert.rejects(selectCompute(ctx, 'auto'), /Jev не настроен/);
  ctx.spec.requirements.cpuCores = Number.MAX_SAFE_INTEGER;
  await assert.rejects(selectCompute(ctx, 'auto'), error => error instanceof Error && error.message.includes('локально: нужно CPU') && error.message.includes(unavailable));
  assert.equal(fetch.mock.callCount(), 0);
});

test('Local selection and real Python execution remain usable while Vast is disabled', async t => {
  environment(t, 'VAST_API_KEY', undefined);
  environment(t, 'TYPESAFE_API_KEY', undefined);
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected HTTP request'); });
  const root = await mkdtemp(path.join(os.tmpdir(), 'p2e-local-release-'));
  const ctx = context(root);
  const backend = new LocalBackend();
  t.after(async () => {
    try { await backend.cleanup(ctx); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  await mkdir(ctx.projectDir);
  await writeFile(path.join(ctx.projectDir, 'experiment.json'), JSON.stringify({ entryPoint: 'main.py', config: 'config.json', requirements: 'requirements.txt', artifacts: ['metrics.json'] }));
  await writeFile(path.join(ctx.projectDir, 'config.json'), '{}');
  await writeFile(path.join(ctx.projectDir, 'requirements.txt'), '');
  await writeFile(path.join(ctx.projectDir, 'main.py'), 'import json\nfrom pathlib import Path\nPath("artifacts/metrics.json").write_text(json.dumps({"value": sum(range(10))}))\n');
  const target = await selectCompute(ctx, 'local');
  assert.equal(target.kind, 'local');
  assert.equal(target.hourlyUSD, 0);
  assert.equal(target.estimatedUSD, 0);
  ctx.run.target = target;
  await backend.prepare(ctx);
  assert.equal((await backend.run(ctx)).exitCode, 0);
  await backend.collectArtifacts(ctx);
  assert.deepEqual(JSON.parse(await readFile(path.join(ctx.projectDir, 'artifacts', 'metrics.json'), 'utf8')), { value: 45 });
  assert.equal(ctx.run.artifactsCollected, true);
  assert.equal(fetch.mock.callCount(), 0);
});
