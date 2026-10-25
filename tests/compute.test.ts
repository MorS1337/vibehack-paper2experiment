import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectAndValidate } from '../src/core/artifacts.js';
import { extractVerifiedTarMember, hashFile, parseExportInventory, validateExportPath } from '../src/compute/export.js';
import { LocalBackend } from '../src/compute/local.js';
import { assertConfigMatchesSpec, readProjectManifest } from '../src/compute/manifest.js';
import { delay, executionEnv, isProcessAlive, runProcess } from '../src/compute/process.js';
import { selectVastTargets, evaluateVastOffer } from '../src/compute/vast-offers.js';
import { SpecSchema } from '../src/shared/types.js';
import type { AppSettings, ComputeContext, ExperimentRun, ExperimentSpec } from '../src/shared/types.js';

const PYTHON = process.env.PYTHON ?? 'python3';

const settings: AppSettings = {
  piProvider: '', piModel: '', python: PYTHON,
  whisperBinary: '', whisperModel: '', sshKeyPath: ''
};

function makeSpec(options: { timeSeconds?: number; maxHourlyUSD?: number; maxTotalUSD?: number; parameters?: Record<string, unknown>; metric?: string } = {}): ExperimentSpec {
  return SpecSchema.parse({
    version: 1,
    title: 'Compute test',
    objective: 'Exercise the compute layer',
    paperResult: 'A deterministic local result',
    sourceRefs: [{ page: 1, quote: 'test' }],
    data: { description: 'none', split: 'none', preprocessing: 'none' },
    method: 'unit test',
    baseline: 'none',
    parameters: options.parameters ?? {},
    metric: { name: options.metric ?? 'value', computation: 'x', publishedValue: null, comparable: false },
    requirements: { cpuCores: 1, ramGB: 1, gpu: false, vramGB: 0, diskGB: 1 },
    limits: { timeSeconds: options.timeSeconds ?? 60, maxHourlyUSD: options.maxHourlyUSD ?? 5, maxTotalUSD: options.maxTotalUSD ?? 20 },
    implementation: 'independent',
    assumptions: [],
    missing: [],
    demo: null
  });
}

function makeOffer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1001,
    gpu_name: 'RTX 4090',
    num_gpus: 1,
    cpu_cores_effective: 8,
    cpu_ram: 32768,
    gpu_ram: 24576,
    disk_space: 100,
    dph_total: 0.5,
    storage_cost: 0.5,
    inet_down_cost: 0.005,
    inet_up_cost: 0.005,
    reliability: 0.995,
    verified: true,
    verification: 'verified',
    rentable: true,
    geolocation: 'Test, US',
    ...overrides
  };
}

function baseRun(root: string, spec: ExperimentSpec): ExperimentRun {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    title: spec.title,
    status: 'running',
    input: { agentMode: 'pi', source: 'inline', task: 'compute test', mode: 'local', timeSeconds: spec.limits.timeSeconds, maxHourlyUSD: spec.limits.maxHourlyUSD, maxTotalUSD: spec.limits.maxTotalUSD, cleanup: 'destroy' },
    dir: root,
    spec,
    planVersion: 1,
    attempts: 0,
    artifacts: [],
    deadlineAt: new Date(Date.now() + 120_000).toISOString()
  };
}

async function createProject(root: string, mainSource: string, parameters: Record<string, unknown> = {}, extraManifest: Record<string, unknown> = {}): Promise<string> {
  const project = path.join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, 'experiment.json'), JSON.stringify({
    entryPoint: 'main.py', config: 'config.json', requirements: 'requirements.txt',
    artifacts: ['metrics.json'], ...extraManifest
  }));
  await writeFile(path.join(project, 'config.json'), JSON.stringify(parameters));
  await writeFile(path.join(project, 'requirements.txt'), '');
  await writeFile(path.join(project, 'main.py'), mainSource);
  return project;
}

function context(run: ExperimentRun, projectDir: string, controller: AbortController, events: string[]): ComputeContext {
  return {
    run,
    spec: run.spec!,
    projectDir,
    signal: controller.signal,
    settings,
    persist: async patch => { Object.assign(run, patch); },
    emit: async (type, message) => { events.push(`${type}: ${message}`); }
  };
}

// These are integration tests against real child processes: polling the real process
// table is the awaited condition, so no fake clock can replace the platform wait.
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error('waitFor timed out');
}

test('Vast filter converts units, counts all-in price once and enforces network and total budgets', () => {
  const spec = makeSpec({ timeSeconds: 3600, maxHourlyUSD: 1, maxTotalUSD: 5 });
  const evaluation = evaluateVastOffer(makeOffer(), spec, { bootSeconds: 0, transferGB: 0 });
  assert.ok(evaluation);
  assert.equal(evaluation.target.cpuCores, 8);
  assert.equal(evaluation.target.ramGB, 32);
  assert.equal(evaluation.target.vramGB, 24);
  assert.equal(evaluation.target.diskGB, 16);
  assert.equal(evaluation.hourlyUSD, 0.5);
  assert.equal(evaluation.estimatedUSD, evaluation.hourlyUSD);
  assert.equal(evaluation.networkReserveUSD, 0);
  assert.equal(evaluation.target.details?.image, 'pytorch/pytorch:2.4.0-cuda12.4-cudnn9-runtime');

  const allIn = evaluateVastOffer(makeOffer({ dph_total: 0.95, storage_cost: 4.5 }), spec, { bootSeconds: 0, transferGB: 0 });
  assert.equal(allIn?.hourlyUSD, 0.95, 'dph_total already includes the requested storage allocation');
  assert.equal(evaluateVastOffer(makeOffer({ dph_total: 1.01 }), spec, { bootSeconds: 0, transferGB: 0 }), null);

  const tightTotal = makeSpec({ timeSeconds: 3600, maxHourlyUSD: 1, maxTotalUSD: 1 });
  const networkExcluded = evaluateVastOffer(makeOffer({ dph_total: 1, storage_cost: 0 }), tightTotal, { bootSeconds: 0, transferGB: 5 });
  assert.equal(networkExcluded, null, 'network reserve must count toward maxTotalUSD');
  const networkZero = evaluateVastOffer(makeOffer({ dph_total: 1, storage_cost: 0 }), tightTotal, { bootSeconds: 0, transferGB: 0 });
  assert.ok(networkZero);

  const rejected = [
    makeOffer({ verified: false, verification: 'unverified' }),
    makeOffer({ rentable: false }),
    makeOffer({ reliability: 0.5 }),
    makeOffer({ num_gpus: 2, gpu_ram: 24576 }),
    makeOffer({ cpu_ram: 512 }),
    makeOffer({ disk_space: 4 }),
    makeOffer({ dph_total: null }),
    makeOffer({ storage_cost: null }),
    makeOffer({ inet_up_cost: null }),
    makeOffer({ inet_down_cost: -1 }),
    makeOffer({ dph_total: 1.5 })
  ];
  for (const raw of rejected) assert.equal(evaluateVastOffer(raw, spec, { bootSeconds: 0, transferGB: 0 }), null, JSON.stringify(raw));

  const gpuSpec = makeSpec({ timeSeconds: 3600, maxHourlyUSD: 5, maxTotalUSD: 20 });
  gpuSpec.requirements.gpu = true;
  gpuSpec.requirements.vramGB = 24;
  assert.ok(evaluateVastOffer(makeOffer({ gpu_ram: 24576 }), gpuSpec, { bootSeconds: 0, transferGB: 0 }));
  assert.equal(evaluateVastOffer(makeOffer({ gpu_ram: 16000 }), gpuSpec, { bootSeconds: 0, transferGB: 0 }), null);
});

test('Vast selection is sorted by all-in cost and capped at six candidates', () => {
  const spec = makeSpec({ timeSeconds: 3600, maxHourlyUSD: 10, maxTotalUSD: 100 });
  const offers = Array.from({ length: 9 }, (_, index) => makeOffer({ id: 2000 + index, dph_total: 0.2 + index * 0.1 }));
  const targets = selectVastTargets(offers, spec, { bootSeconds: 0, transferGB: 0 });
  assert.equal(targets.length, 6);
  assert.deepEqual(targets.map(target => target.offerId), [2000, 2001, 2002, 2003, 2004, 2005]);
  const again = selectVastTargets([...offers].reverse(), spec, { bootSeconds: 0, transferGB: 0 });
  assert.deepEqual(targets.map(target => target.id), again.map(target => target.id));
});

test('remote export inventory is parsed with strict paths and duplicate rejection', () => {
  const hash = 'a'.repeat(64);
  const records = parseExportInventory(`${hash}  artifacts/metrics.json\n${hash}  stdout.log\n${hash}  stderr.log\n`);
  assert.deepEqual(records.map(record => record.path), ['artifacts/metrics.json', 'stdout.log', 'stderr.log']);
  assert.deepEqual(records.map(record => record.sha256), [hash, hash, hash]);
  assert.throws(() => parseExportInventory(`${hash}  artifacts/../escape.json\n`), /Недопустимый путь/);
  assert.throws(() => parseExportInventory(`${hash}  artifacts/with space.json\n`), /Недопустимый путь/);
  assert.throws(() => parseExportInventory(`${hash}  artifacts/metrics.json\n${hash}  artifacts/metrics.json\n`), /Повторяющийся/);
  assert.throws(() => validateExportPath('artifacts/.'), /Недопустимый путь/);
  assert.throws(() => validateExportPath('/etc/passwd'), /Недопустимый путь/);
});

test('verified tar extraction streams actual bytes and rejects a hash mismatch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'p2e-export-test-'));
  try {
    const project = path.join(root, 'project');
    await mkdir(path.join(project, 'artifacts'), { recursive: true });
    const source = path.join(project, 'artifacts/metrics.json');
    await writeFile(source, JSON.stringify({ value: 42 }));
    const archive = path.join(root, 'snapshot.tar.gz');
    const tar = await runProcess('tar', ['-czf', archive, '-C', project, 'artifacts'], { timeoutMs: 30_000 });
    assert.equal(tar.exitCode, 0, tar.stderr);
    const digest = await hashFile(source);
    const output = path.join(root, 'extracted.json');
    const bytes = await extractVerifiedTarMember(archive, 'artifacts/metrics.json', output, digest.sha256, 1024 * 1024);
    assert.equal(bytes, digest.bytes);
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), { value: 42 });
    await assert.rejects(
      () => extractVerifiedTarMember(archive, 'artifacts/metrics.json', output, '0'.repeat(64), 1024 * 1024),
      /SHA256 не совпал/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('manifest and frozen config reject traversal, symlinks and scientific parameter changes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'p2e-manifest-test-'));
  const spec = makeSpec({ parameters: { answer: 42 } });
  try {
    const project = await createProject(root, 'print(1)\n', { answer: 42 });
    const valid = await readProjectManifest(project);
    assert.deepEqual(valid.manifest.artifacts, ['metrics.json']);
    await assertConfigMatchesSpec(valid.configFile, spec);
    await writeFile(path.join(project, 'config.json'), JSON.stringify({ answer: 43 }));
    await assert.rejects(() => assertConfigMatchesSpec(valid.configFile, spec), /изменяет параметр плана/);

    await writeFile(path.join(project, 'experiment.json'), JSON.stringify({
      entryPoint: 'main.py', config: 'config.json', requirements: 'requirements.txt', artifacts: ['../escape.json']
    }));
    await assert.rejects(() => readProjectManifest(project), /небезопасный путь|artifacts/);

    await writeFile(path.join(project, 'experiment.json'), JSON.stringify({
      entryPoint: 'main.py', config: 'config.json', requirements: 'requirements.txt', artifacts: ['metrics.json']
    }));
    const outside = path.join(root, 'outside.txt');
    await writeFile(outside, 'secret');
    await symlink(outside, path.join(project, 'linked.py'));
    await writeFile(path.join(project, 'experiment.json'), JSON.stringify({
      entryPoint: 'linked.py', config: 'config.json', requirements: 'requirements.txt', artifacts: ['metrics.json']
    }));
    await assert.rejects(() => readProjectManifest(project), /symlink запрещён/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('LocalBackend executes a real project, streams logs and validates artifacts', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'p2e local ok '));
  const spec = makeSpec();
  const run = baseRun(root, spec);
  const controller = new AbortController();
  const events: string[] = [];
  const source = [
    'import json, pathlib',
    'pathlib.Path("artifacts").mkdir(exist_ok=True)',
    'pathlib.Path("artifacts/metrics.json").write_text(json.dumps({"value": 42.0}))',
    'print("local-ok")',
    ''
  ].join('\n');
  const project = await createProject(root, source);
  const ctx = context(run, project, controller, events);
  const backend = new LocalBackend();
  const lines: string[] = [];
  const unsubscribe = backend.streamLogs(ctx, line => lines.push(line));
  try {
    await backend.prepare(ctx);
    const result = await backend.run(ctx);
    unsubscribe();
    assert.equal(result.exitCode, 0, result.stderr);
    await backend.collectArtifacts(ctx);
    assert.equal(run.artifactsCollected, true);
    const validated = await collectAndValidate(run);
    Object.assign(run, validated);
    assert.equal(run.metrics?.value, 42);
    assert.ok(run.artifacts.some(artifact => artifact.path.endsWith('artifacts/metrics.json')));
    assert.match(await readFile(path.join(project, 'stdout.log'), 'utf8'), /local-ok/);
    assert.ok(lines.some(line => line.includes('local-ok')), `streamLogs lines: ${lines.join(' | ')}`);
    assert.equal(await backend.getStatus(ctx), 'stopped');
    if (process.platform !== 'win32') {
      if (!run.command) throw new Error('No recorded rerun command');
      await rm(path.join(project, 'artifacts/metrics.json'));
      const repeated = await runProcess('/bin/sh', ['-c', run.command], { cwd: os.tmpdir(), timeoutMs: 15_000, env: executionEnv() });
      assert.equal(repeated.exitCode, 0, repeated.stderr);
      assert.equal(JSON.parse(await readFile(path.join(project, 'artifacts/metrics.json'), 'utf8')).value, 42);
    }
    await backend.cleanup(ctx);
  } finally {
    unsubscribe();
    await backend.cancel(ctx).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('LocalBackend enforces its deadline and kills the whole process group', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'p2e-local-timeout-'));
  const spec = makeSpec({ timeSeconds: 30 });
  const run = baseRun(root, spec);
  const controller = new AbortController();
  const events: string[] = [];
  const source = [
    'import pathlib, subprocess, time',
    'child = subprocess.Popen(["sleep", "30"])',
    'pathlib.Path("child.pid").write_text(str(child.pid))',
    'print("sleeping", flush=True)',
    'time.sleep(30)',
    ''
  ].join('\n');
  const project = await createProject(root, source);
  const ctx = context(run, project, controller, events);
  const backend = new LocalBackend();
  try {
    await backend.prepare(ctx);
    await ctx.persist({ deadlineAt: new Date(Date.now() + 3000).toISOString() });
    const started = Date.now();
    const result = await backend.run(ctx);
    const elapsed = Date.now() - started;
    assert.equal(result.exitCode, 124);
    assert.ok(elapsed >= 2000 && elapsed < 15_000, `elapsed ${elapsed}`);
    const childPid = Number(await readFile(path.join(project, 'child.pid'), 'utf8'));
    await waitFor(() => !isProcessAlive(childPid), 5000);
    assert.equal(isProcessAlive(run.pid!), false);
  } finally {
    await backend.cancel(ctx).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('LocalBackend cancel stops the scientific process and its children', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'p2e-local-cancel-'));
  const spec = makeSpec({ timeSeconds: 60 });
  const run = baseRun(root, spec);
  const controller = new AbortController();
  const events: string[] = [];
  const source = [
    'import pathlib, subprocess, time',
    'child = subprocess.Popen(["sleep", "30"])',
    'pathlib.Path("child.pid").write_text(str(child.pid))',
    'print("cancel-me", flush=True)',
    'time.sleep(30)',
    ''
  ].join('\n');
  const project = await createProject(root, source);
  const ctx = context(run, project, controller, events);
  const backend = new LocalBackend();
  let outcome: Promise<{ result: { exitCode: number; stderr: string } | null; error: unknown }> | undefined;
  try {
    await backend.prepare(ctx);
    outcome = backend.run(ctx).then(
      result => ({ result, error: null }),
      error => ({ result: null, error })
    );
    await waitFor(() => run.pid !== undefined, 10_000);
    const childPidFile = path.join(project, 'child.pid');
    await waitFor(async () => {
      try { return Number(await readFile(childPidFile, 'utf8')) > 0; } catch { return false; }
    }, 10_000);
    controller.abort(new Error('cancelled by test'));
    await backend.cancel(ctx);
    const settled = await outcome;
    assert.ok(settled.error instanceof Error);
    assert.match(String(settled.error), /cancelled by test/);
    const childPid = Number(await readFile(childPidFile, 'utf8'));
    await waitFor(() => !isProcessAlive(childPid), 5000);
    assert.equal(isProcessAlive(run.pid!), false);
  } finally {
    if (outcome) await outcome;
    await backend.cancel(ctx).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
