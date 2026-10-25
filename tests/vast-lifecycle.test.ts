import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { VastApiClient, VastApiError, VastCreateRejectedError } from '../src/compute/vast-api.js';
import { VastBackend, vastLaunchCommand } from '../src/compute/vast.js';
import { evaluateVastOffer, vastSearchBody } from '../src/compute/vast-offers.js';
import { SpecSchema, type ComputeContext, type ExperimentRun } from '../src/shared/types.js';

const exec = promisify(execFile);
const PUBLIC_KEY = 'ssh-ed25519 AAAATEST lifecycle-test';
const offer = {
  id: 123, gpu_name: 'RTX 4090', num_gpus: 1, cpu_cores_effective: 8,
  cpu_ram: 32768, gpu_ram: 24576, disk_space: 100, dph_total: 0.5,
  storage_cost: 0.5, inet_down_cost: 0.005, inet_up_cost: 0.005,
  reliability: 0.995, verified: true, rentable: true
};

function context(root = '/unused'): ComputeContext {
  const spec = SpecSchema.parse({
    version: 1, title: 'Vast lifecycle', objective: 'Exercise lease recovery', paperResult: 'test',
    sourceRefs: [{ page: 1, quote: 'test' }], data: { description: 'none', split: 'none', preprocessing: 'none' },
    method: 'test', baseline: 'none', parameters: {},
    metric: { name: 'value', computation: 'x', publishedValue: null, comparable: false },
    requirements: { cpuCores: 1, ramGB: 1, gpu: true, vramGB: 1, diskGB: 17 },
    limits: { timeSeconds: 60, maxHourlyUSD: 2, maxTotalUSD: 5 },
    implementation: 'independent', assumptions: [], missing: [], demo: null
  });
  const run: ExperimentRun = {
    id: '00000000-0000-4000-8000-123456789abc', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    title: spec.title, status: 'running', dir: root, spec, planVersion: 1, attempts: 0, artifacts: [],
    input: { source: 'inline', task: 'test', mode: 'vast', timeSeconds: 60, maxHourlyUSD: 2, maxTotalUSD: 5, cleanup: 'destroy' },
    target: evaluateVastOffer(offer, spec)!.target, deadlineAt: new Date(Date.now() + 120_000).toISOString()
  };
  return {
    run, spec, projectDir: path.join(root, 'project'), signal: new AbortController().signal,
    settings: { piProvider: '', piModel: '', python: 'python3', whisperBinary: '', whisperModel: '', sshKeyPath: '' },
    persist: async patch => { Object.assign(run, patch); }, emit: async () => undefined
  };
}

function reply(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of req) text += chunk;
  return JSON.parse(text);
}

async function server(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> | void): Promise<string> {
  const errors: unknown[] = [];
  const http = createServer((req, res) => {
    void Promise.resolve().then(() => handler(req, res, new URL(req.url!, 'http://localhost'))).catch(error => {
      errors.push(error);
      reply(res, 500, { error: String(error) });
    });
  });
  const listening = Promise.withResolvers<void>();
  http.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  t.after(async () => {
    http.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    http.close(error => error ? closed.reject(error) : closed.resolve());
    await closed.promise;
    assert.deepEqual(errors, []);
  });
  const address = http.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

function routeProvider(t: TestContext, base: string): void {
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.ok(url.hostname === 'console.vast.ai' || url.hostname === '127.0.0.1', `Unexpected network destination ${url}`);
    return originalFetch(new URL(url.pathname + url.search, base), init);
  });
  const oldKey = process.env.VAST_API_KEY;
  process.env.VAST_API_KEY = 'local-test-only';
  t.after(() => { if (oldKey === undefined) delete process.env.VAST_API_KEY; else process.env.VAST_API_KEY = oldKey; });
}

async function project(t: TestContext): Promise<ComputeContext> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'p2e-vast-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ctx = context(root);
  await mkdir(ctx.projectDir);
  await writeFile(path.join(ctx.projectDir, 'experiment.json'), JSON.stringify({ entryPoint: 'main.py', config: 'config.json', requirements: 'requirements.txt', artifacts: ['metrics.json'] }));
  await writeFile(path.join(ctx.projectDir, 'config.json'), '{}');
  await writeFile(path.join(ctx.projectDir, 'requirements.txt'), '');
  await writeFile(path.join(ctx.projectDir, 'main.py'), 'print("test")\n');
  return ctx;
}

function preparedBackend(base: string): VastBackend {
  const backend = new VastBackend();
  // No key derivation/SSH connection is involved in these HTTP lifecycle tests.
  Object.defineProperty(backend, 'session', { value: async () => ({ client: new VastApiClient('local-test-only', `${base}/api/v0`), keyPath: '/unused', publicKey: PUBLIC_KEY }) });
  return backend;
}

test('Vast API reads documented instance objects and paginates actual account instances with exact label filters', async t => {
  const label = 'p2e-full-run-id';
  const requests: string[] = [];
  const base = await server(t, (req, res, url) => {
    requests.push(url.pathname);
    assert.equal(req.headers.authorization, 'Bearer local-test-only');
    if (url.pathname === '/api/v0/instances/81/') {
      reply(res, 200, { instances: { id: 81, label, actual_status: 'running', ssh_host: 'ssh.test', ssh_port: 10081 } });
      return;
    }
    assert.equal(url.pathname, '/api/v1/instances');
    assert.equal(url.searchParams.get('limit'), '25');
    assert.deepEqual(JSON.parse(url.searchParams.get('select_filters')!), { label: { eq: label } });
    if (!url.searchParams.has('after_token')) reply(res, 200, { success: true, instances: [{ id: 81, label, actual_status: 'running' }], next_token: 'second/page+' });
    else {
      assert.equal(url.searchParams.get('after_token'), 'second/page+');
      reply(res, 200, { success: true, instances: [{ id: 82, label, actual_status: 'loading' }], next_token: null });
    }
  });
  const client = new VastApiClient('local-test-only', `${base}/api/v0`);
  assert.equal((await client.showInstance(81))?.sshPort, 10081);
  assert.deepEqual((await client.listInstances({ label })).map(instance => instance.id), [81, 82]);
  assert.deepEqual(requests, ['/api/v0/instances/81/', '/api/v1/instances', '/api/v1/instances']);
});

test('Vast SSH keys treats only endpoint 404 as an empty account, not authentication failure', async t => {
  let status = 404;
  const base = await server(t, (_req, res, url) => { assert.equal(url.pathname, '/api/v0/ssh'); reply(res, status, { error: status === 404 ? 'No SSH keys found' : 'auth_error' }); });
  const client = new VastApiClient('local-test-only', `${base}/api/v0`);
  assert.deepEqual(await client.listSshKeys(), []);
  await client.ping();
  status = 401;
  await assert.rejects(client.listSshKeys(), error => error instanceof VastApiError && error.status === 401);
  await assert.rejects(client.ping(), error => error instanceof VastApiError && error.status === 401);
});

test('lost create response persists intent before dispatch and recovers the actual lease despite cancellation', async t => {
  const ctx = await project(t);
  const cancel = new AbortController();
  ctx.signal = cancel.signal;
  let creates = 0;
  const base = await server(t, async (req, res, url) => {
    if (url.pathname === '/api/v0/ssh') { reply(res, 200, [{ id: 1, key: PUBLIC_KEY }]); return; }
    if (url.pathname === '/api/v0/bundles/') {
      assert.equal((await body(req)).allocated_storage, vastSearchBody(ctx.spec).allocated_storage);
      reply(res, 200, { offers: [offer] }); return;
    }
    if (url.pathname === '/api/v0/asks/123/') {
      creates++;
      const payload = await body(req);
      assert.equal(ctx.run.provisioningUncertain, true);
      assert.equal(ctx.run.cleanupRequired, true);
      assert.equal(ctx.run.provisioningLabel, `p2e-${ctx.run.id}`);
      assert.equal(payload.label, ctx.run.provisioningLabel);
      assert.equal(payload.disk, 17);
      req.socket.destroy();
      cancel.abort(new Error('cancelled after provider accepted create'));
      return;
    }
    assert.equal(url.pathname, '/api/v1/instances');
    reply(res, 200, { success: true, instances: [
      { id: 66, label: `p2e-${ctx.run.id.slice(0, 8)}`, actual_status: 'running' },
      { id: 77, label: ctx.run.provisioningLabel, actual_status: 'loading' }
    ], next_token: null });
  });
  routeProvider(t, base);
  await assert.rejects(preparedBackend(base).prepare(ctx), /cancelled after provider accepted create/);
  assert.equal(creates, 1);
  assert.equal(ctx.run.instanceId, 77);
  assert.equal(ctx.run.provisioningUncertain, false);
  assert.equal(ctx.run.cleanupRequired, true);
});

test('empty successful listings and transport errors leave uncertainty durable and prohibit another create', async t => {
  const ctx = await project(t);
  ctx.run.provisioningLabel = `p2e-${ctx.run.id}`;
  ctx.run.provisioningUncertain = true;
  // Real HTTP/provider-poll integration: the second request, not a guessed sleep,
  // ends reconciliation. Only the independent overall abort budget is controlled.
  const stop = new AbortController();
  const originalTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', (ms: number) => ms === 30_000 ? stop.signal : originalTimeout(ms));
  let listings = 0;
  const base = await server(t, (_req, res, url) => {
    if (url.pathname === '/api/v0/ssh') { reply(res, 200, [{ id: 1, key: PUBLIC_KEY }]); return; }
    assert.equal(url.pathname, '/api/v1/instances', 'must never reissue create/search for an uncertain lease');
    listings++;
    if (listings === 1) reply(res, 200, { success: true, instances: [], next_token: null });
    else { res.destroy(); stop.abort(); }
  });
  routeProvider(t, base);
  const backend = preparedBackend(base);
  await assert.rejects(backend.prepare(ctx), /остаётся неизвестным/);
  assert.equal(listings, 2);
  assert.equal(ctx.run.instanceId, undefined);
  assert.equal(ctx.run.provisioningUncertain, true);
  assert.equal(ctx.run.cleanupRequired, true);
  await assert.rejects(backend.prepare(ctx), /остаётся неизвестным/);
  assert.equal(listings, 2, 'an expired reconciliation budget must not fall through to create');
  assert.equal(await backend.getStatus(ctx), 'unknown');
});

test('cleanup reconciles an uncertain lease before looking up its ID and destroying it', async t => {
  const ctx = context();
  ctx.run.provisioningLabel = `p2e-${ctx.run.id}`;
  ctx.run.provisioningUncertain = true;
  ctx.signal = AbortSignal.abort(new Error('already cancelled'));
  const requests: string[] = [];
  const base = await server(t, (req, res, url) => {
    requests.push(`${req.method} ${url.pathname}`);
    if (url.pathname === '/api/v1/instances') reply(res, 200, { success: true, instances: [{ id: 91, label: ctx.run.provisioningLabel, actual_status: 'loading' }], next_token: null });
    else { assert.equal(req.method, 'DELETE'); assert.equal(ctx.run.instanceId, 91); reply(res, 200, { success: true }); }
  });
  routeProvider(t, base);
  await new VastBackend().cleanup(ctx);
  assert.deepEqual(requests, ['GET /api/v1/instances', 'DELETE /api/v0/instances/91/']);
  assert.equal(ctx.run.instanceId, undefined);
  assert.equal(ctx.run.provisioningUncertain, false);
  assert.equal(ctx.run.cleanupRequired, false);
});

test('duplicate exact labels remain uncertain instead of silently adopting one billable lease', async t => {
  const ctx = context();
  ctx.run.provisioningLabel = `p2e-${ctx.run.id}`;
  ctx.run.provisioningUncertain = true;
  const base = await server(t, (_req, res, url) => {
    assert.equal(url.pathname, '/api/v1/instances');
    reply(res, 200, { instances: [1, 2].map(id => ({ id, label: ctx.run.provisioningLabel, actual_status: 'running' })), next_token: null });
  });
  routeProvider(t, base);
  await assert.rejects(new VastBackend().reconcile(ctx), /несколько инстансов/);
  assert.equal(ctx.run.instanceId, 1, 'retain at least the discovered ID immediately for operator recovery');
  assert.equal(ctx.run.provisioningUncertain, true);
  assert.equal(ctx.run.cleanupRequired, true);
});

test('a discovered lease ID persists even when a later listing page fails', async t => {
  const ctx = context();
  ctx.run.provisioningLabel = `p2e-${ctx.run.id}`;
  ctx.run.provisioningUncertain = true;
  const base = await server(t, (_req, res, url) => {
    assert.equal(url.pathname, '/api/v1/instances');
    if (!url.searchParams.has('after_token')) {
      reply(res, 200, { instances: [{ id: 92, label: ctx.run.provisioningLabel, actual_status: 'loading' }], next_token: 'remaining' });
    } else {
      assert.equal(ctx.run.instanceId, 92, 'the first-page lease must already be durable');
      reply(res, 503, { error: 'temporary provider failure' });
    }
  });
  routeProvider(t, base);
  await assert.rejects(new VastBackend().reconcile(ctx), /503/);
  assert.equal(ctx.run.instanceId, 92);
  assert.equal(ctx.run.provisioningUncertain, true);
  assert.equal(ctx.run.cleanupRequired, true);
});

test('definitive create rejection is distinguished from a malformed or lost response', async t => {
  let response: unknown = { success: false, msg: 'offer no longer available' };
  const base = await server(t, (_req, res) => reply(res, 200, response));
  const client = new VastApiClient('local-test-only', `${base}/api/v0`);
  await assert.rejects(client.createInstance(123, {}), error => error instanceof VastCreateRejectedError);
  response = { success: true };
  await assert.rejects(client.createInstance(123, {}), error => error instanceof VastApiError && !(error instanceof VastCreateRejectedError));
});

test('a rescued remote PID resumes observation and preserves the real workload failure code', async t => {
  const ctx = await project(t);
  ctx.run.instanceId = 88;
  ctx.settings.sshKeyPath = '/unused';
  const bin = path.join(ctx.run.dir, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'ssh'), [
    '#!/bin/bash',
    'command="${@: -1}"',
    'if [[ "$command" == *"nohup setsid"* ]]; then echo channel-lost >&2; exit 255; fi',
    'if [[ "$command" == "cat /workspace/paper2experiment/.pid"* ]]; then echo 4321; exit 0; fi',
    'if [[ "$command" == *"CODE="* ]]; then printf "CODE=7\\nTIMEOUT=no\\n"; exit 0; fi',
    'if [[ "$command" == "tail -c 30000"* ]]; then printf "real workload error"; exit 0; fi',
    'exit 0'
  ].join('\n'), { mode: 0o700 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  t.after(() => { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; });
  const base = await server(t, (_req, res, url) => {
    assert.equal(url.pathname, '/api/v0/instances/88/');
    reply(res, 200, { instances: { id: 88, actual_status: 'running', ssh_host: 'ssh.test', ssh_port: 10088 } });
  });
  const backend = preparedBackend(base);
  Object.defineProperty(backend, 'getStatus', { value: async () => 'stopped' });
  const result = await backend.run(ctx);
  assert.equal(ctx.run.pid, 4321);
  assert.equal(ctx.run.executionStarted, true);
  assert.deepEqual(result, { exitCode: 7, stderr: 'real workload error' });
});

test('all-in offer price includes allocated disk exactly once while retaining boot/network budget reserves', () => {
  const ctx = context();
  ctx.spec.limits.timeSeconds = 3600;
  ctx.spec.limits.maxHourlyUSD = 1;
  ctx.spec.limits.maxTotalUSD = 2;
  const raw = { ...offer, dph_total: 0.95, storage_cost: 4.5 };
  const evaluation = evaluateVastOffer(raw, ctx.spec, { bootSeconds: 0, transferGB: 0 });
  assert.ok(evaluation);
  assert.equal(evaluation.hourlyUSD, 0.95);
  assert.equal(evaluation.estimatedUSD, 0.95);
  assert.equal(evaluation.storageHourlyUSD, 4.5 * 17 / 720, 'informational storage breakdown remains available');
  ctx.spec.limits.maxTotalUSD = 1;
  assert.equal(evaluateVastOffer(raw, ctx.spec, { bootSeconds: 900, transferGB: 0 }), null);
  assert.equal(evaluateVastOffer(raw, ctx.spec, { bootSeconds: 0, transferGB: 10 }), null);
  assert.equal(evaluateVastOffer({ ...raw, dph_total: 1.01 }, ctx.spec, { bootSeconds: 0, transferGB: 0 }), null);
});

// This Linux integration exercises the actual detached process table and server
// watchdog clock. Fake JS timers cannot advance bash sleep or /proc state.
async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    const nextPoll = Promise.withResolvers<void>();
    setTimeout(nextPoll.resolve, 50);
    await nextPoll.promise;
  }
  throw new Error('condition timed out');
}

test('detached remote launch polls absolute PID and independent watchdog KILLs a TERM-ignoring workload', { skip: process.platform !== 'linux', timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'p2e-watchdog-'));
  let workloadGroup = 0;
  let watchdog = 0;
  try {
    await mkdir(path.join(root, '.venv', 'bin'), { recursive: true });
    await writeFile(path.join(root, '.venv', 'bin', 'python'), '#!/bin/bash\ntrap "" TERM\necho $$ > worker.pid\nwhile true; do sleep 0.1; done\n', { mode: 0o700 });
    const deadline = Date.now() + 2500;
    const launched = await exec('/bin/bash', ['-c', vastLaunchCommand(root, 'main.py', 'config.json', deadline)], { cwd: os.tmpdir(), timeout: 15_000 });
    workloadGroup = Number(launched.stdout.trim());
    assert.ok(Number.isSafeInteger(workloadGroup) && workloadGroup > 0);
    watchdog = Number((await readFile(path.join(root, '.watchdog.pid'), 'utf8')).trim());
    await waitFor(() => readFile(path.join(root, 'worker.pid'), 'utf8').then(() => true, () => false), 1500);
    const worker = Number((await readFile(path.join(root, 'worker.pid'), 'utf8')).trim());
    const workerGroup = Number((await exec('ps', ['-o', 'pgid=', '-p', String(worker)])).stdout.trim());
    const watchdogGroup = Number((await exec('ps', ['-o', 'pgid=', '-p', String(watchdog)])).stdout.trim());
    assert.equal(workerGroup, workloadGroup);
    assert.notEqual(watchdogGroup, workloadGroup);
    const alive = async () => {
      const stat = await readFile(`/proc/${worker}/stat`, 'utf8').catch(() => '');
      return !!stat && !/\) [ZX] /.test(stat);
    };
    await waitFor(() => readFile(path.join(root, '.timed_out'), 'utf8').then(() => true, () => false), 4000);
    assert.equal(await alive(), true, 'TERM-ignoring worker must still be alive during the watchdog grace period');
    await waitFor(async () => !await alive(), 7000);
    assert.ok(Date.now() <= deadline + 7000, 'deadline must not reset to the full experiment duration');
  } finally {
    for (const pid of [workloadGroup, watchdog]) if (pid > 0) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already exited */ } }
    await rm(root, { recursive: true, force: true });
  }
});
