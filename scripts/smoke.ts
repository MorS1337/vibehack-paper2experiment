import assert from 'node:assert/strict';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalBackend } from '../src/compute/local.js';
import { executionEnv, isProcessAlive, runProcess } from '../src/compute/process.js';
import { collectAndValidate } from '../src/core/artifacts.js';
import { Store } from '../src/core/store.js';
import { SpecSchema } from '../src/shared/types.js';
import type { ComputeContext, ExperimentInput, ExperimentRun, ExperimentSpec, RunEvent } from '../src/shared/types.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const referenceDir = path.join(repoRoot, 'demos/bernoulli-hoeffding/reference');
const demoSpec = SpecSchema.parse(JSON.parse(await readFile(path.join(repoRoot, 'demos/bernoulli-hoeffding/spec.json'), 'utf8'))) as ExperimentSpec;

const input: ExperimentInput = {
  agentMode: 'demo', source: 'https://arxiv.org/abs/1910.02884',
  task: 'Bernoulli/Hoeffding local smoke run', mode: 'local', timeSeconds: 120,
  maxHourlyUSD: 0, maxTotalUSD: 0, cleanup: 'destroy'
};

interface SmokeContext {
  store: Store;
  run: ExperimentRun;
  backend: LocalBackend;
  controller: AbortController;
  ctx: ComputeContext;
  running?: Promise<unknown>;
}

const contexts: SmokeContext[] = [];

async function buildContext(root: string, spec: ExperimentSpec, task: string): Promise<SmokeContext> {
  const store = new Store(root);
  await store.load();
  store.settings.python = process.env.PYTHON ?? store.settings.python;
  const run = await store.create({ ...input, task, timeSeconds: spec.limits.timeSeconds });
  await store.patch(run.id, {
    spec, status: 'preparing',
    deadlineAt: new Date(Date.now() + spec.limits.timeSeconds * 1000).toISOString()
  });
  const controller = new AbortController();
  const ctx: ComputeContext = {
    run, spec, projectDir: path.join(run.dir, 'project'), signal: controller.signal,
    settings: store.settings,
    emit: async (type: RunEvent['type'], message: string) => {
      console.log(`[${task}] ${type}: ${message}`);
      await store.event(run.id, type, message);
    },
    persist: async (patch: Partial<ExperimentRun>) => {
      await store.patch(run.id, patch);
    }
  };
  const context = { store, run, backend: new LocalBackend(), controller, ctx };
  contexts.push(context);
  return context;
}

async function copyDemoProject(context: SmokeContext): Promise<void> {
  const { ctx } = context;
  await mkdir(ctx.projectDir, { recursive: true });
  // Copy only committed inputs, never a developer's cached venv or old outputs.
  for (const file of ['main.py', 'experiment.json', 'requirements.txt']) {
    await copyFile(path.join(referenceDir, file), path.join(ctx.projectDir, file));
  }
  await writeFile(path.join(ctx.projectDir, 'config.json'), JSON.stringify(ctx.spec.parameters, null, 2) + '\n');
  await writeFile(path.join(ctx.projectDir, 'plan.json'), JSON.stringify(ctx.spec, null, 2) + '\n');
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Probe did not settle within ${timeoutMs}ms`)), timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForLog(projectDir: string, text: string, timeoutMs = 8000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const log = await readFile(path.join(projectDir, 'stdout.log'), 'utf8').catch(() => '');
    if (log.includes(text)) return;
    await delay(50);
  }
  throw new Error(`Python did not write readiness marker: ${text}`);
}

async function historyProbe(context: SmokeContext): Promise<void> {
  const { store, run } = context;
  const event = await store.event(run.id, 'log', 'smoke: completed run persisted');
  const reopened = new Store(store.root);
  await reopened.load();
  const restored = reopened.get(run.id);
  assert.equal(restored.status, 'completed');
  assert.equal(restored.artifactsCollected, true);
  assert.deepEqual(restored.spec, run.spec);
  // Metrics use a null-prototype map in memory; JSON persistence restores a
  // regular object. Compare the persisted numeric content, not its prototype.
  assert.deepEqual(restored.metrics, JSON.parse(JSON.stringify(run.metrics)));
  assert.deepEqual(restored.artifacts, run.artifacts);
  assert.equal(restored.verification, run.verification);
  assert.equal(restored.command, run.command);
  assert.ok((await reopened.events(run.id)).some(item => item.id === event.id && item.message === event.message));
  console.log('history: completed state, metrics, artifact hashes, plan, command and events restored');
}

async function reproducibilityProbe(root: string, spec: ExperimentSpec, task: string): Promise<void> {
  const context = await buildContext(root, spec, task);
  const { backend, ctx, store, run } = context;
  await copyDemoProject(context);
  await backend.prepare(ctx);
  await ctx.persist({ status: 'running' });
  const execution = await backend.run(ctx);
  assert.equal(execution.exitCode, 0, execution.stderr);
  await backend.collectArtifacts(ctx);
  const first = await collectAndValidate(run);
  assert.equal(await backend.getStatus(ctx), 'stopped');
  assert.ok(first.artifacts.length > 0);

  // Run the actual saved command from another cwd. The temporary project path
  // contains spaces, and no previous outputs may satisfy the second validation.
  assert.ok(run.command, 'LocalBackend must record a rerun command');
  const command = run.command;
  const configBefore = await readFile(path.join(ctx.projectDir, 'config.json'), 'utf8');
  await rm(path.join(ctx.projectDir, 'artifacts'), { recursive: true });
  const repeated = await runProcess('/bin/sh', ['-c', command], {
    cwd: repoRoot, env: executionEnv(), timeoutMs: spec.limits.timeSeconds * 1000
  });
  assert.equal(repeated.exitCode, 0, repeated.stderr);
  const second = await collectAndValidate(run);
  const samplesHash = (result: typeof first) => {
    const samples = result.artifacts.find(artifact => artifact.path === 'project/artifacts/samples.csv');
    assert.ok(samples, 'Missing samples.csv digest');
    return samples.sha256;
  };
  assert.equal(samplesHash(first), samplesHash(second), 'Same plan/config/seed changed the sample counts');
  assert.deepEqual(second.metrics, first.metrics, 'Independently recomputed metrics changed on rerun');
  assert.equal(await readFile(path.join(ctx.projectDir, 'config.json'), 'utf8'), configBefore);
  assert.deepEqual(JSON.parse(await readFile(path.join(ctx.projectDir, 'plan.json'), 'utf8')), spec);
  console.log(JSON.stringify({
    probe: 'reproducibility', task, parameters: spec.parameters, samplesSHA256: samplesHash(second),
    primaryMetric: second.metrics[spec.metric.name], tailCount: second.metrics.tail_count_primary
  }, null, 2));
  console.log(second.verification);
  await store.patch(run.id, { ...second, artifactsCollected: true, status: 'completed' });
  await historyProbe(context);
  await backend.cleanup(ctx);
}

async function sleepingProject(root: string, task: string): Promise<SmokeContext> {
  const context = await buildContext(root, demoSpec, task);
  await copyDemoProject(context);
  await writeFile(path.join(context.ctx.projectDir, 'main.py'), [
    'import time', 'print("probe-started", flush=True)', 'time.sleep(30)',
    'print("probe-finished", flush=True)', ''
  ].join('\n'));
  await context.backend.prepare(context.ctx);
  await context.ctx.persist({ status: 'running' });
  return context;
}

async function assertStopped(context: SmokeContext): Promise<void> {
  assert.ok(context.run.pid, 'Probe must have launched a real process');
  assert.equal(isProcessAlive(context.run.pid), false, `Process ${context.run.pid} is still alive`);
  assert.equal(await context.backend.getStatus(context.ctx), 'stopped');
  assert.doesNotMatch(await readFile(path.join(context.ctx.projectDir, 'stdout.log'), 'utf8'), /probe-finished/);
}

async function cancellationProbe(root: string): Promise<void> {
  const context = await sleepingProject(root, 'cancellation probe');
  const { backend, ctx, controller } = context;
  // Observe rejections immediately; assertions/cleanup still await the outcome.
  const outcome = backend.run(ctx).then(result => ({ result, error: undefined }), error => ({ result: undefined, error }));
  context.running = outcome;
  await waitForLog(ctx.projectDir, 'probe-started');
  const reason = new Error('smoke: explicit cancellation');
  controller.abort(reason);
  await within(backend.cancel(ctx), 15_000);
  const settled = await within(outcome, 15_000);
  assert.equal(settled.error, reason, 'Cancellation must propagate the abort reason');
  await assertStopped(context);
  await backend.cleanup(ctx);
  console.log('cancellation: ready Python process stopped and run rejected');
}

async function timeoutProbe(root: string): Promise<void> {
  const context = await sleepingProject(root, 'timeout probe');
  const { backend, ctx } = context;
  // Exercise LocalBackend's own deadline, without an external cancel timer.
  await ctx.persist({ deadlineAt: new Date(Date.now() + 3000).toISOString() });
  const startedAt = Date.now();
  const outcome = backend.run(ctx);
  context.running = outcome;
  void outcome.catch(() => undefined);
  await waitForLog(ctx.projectDir, 'probe-started');
  const result = await within(outcome, 15_000);
  assert.equal(result.exitCode, 124, result.stderr);
  assert.ok(Date.now() - startedAt < 15_000, 'Deadline was not enforced');
  await assertStopped(context);
  await backend.cleanup(ctx);
  console.log('timeout: backend deadline stopped ready Python process with exit 124');
}

async function saveFailureDiagnostics(): Promise<void> {
  const destination = process.env.PAPER2_SMOKE_DIAGNOSTICS;
  if (!destination) return;
  // Explicit allowlist from this script's generated projects only. Never copy
  // Store settings, user state, the venv, environment dumps, credentials or audio.
  const files = ['plan.json', 'config.json', 'experiment.json', 'stdout.log', 'stderr.log',
    'artifacts/metrics.json', 'artifacts/samples.csv', 'artifacts/plot.svg'];
  for (const [index, context] of contexts.entries()) {
    for (const file of files) {
      const source = path.join(context.ctx.projectDir, file);
      const info = await lstat(source).catch(() => undefined);
      if (!info?.isFile() || info.size > 64 * 1024 * 1024) continue;
      const target = path.join(destination, `probe-${index + 1}`, file);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
    }
  }
  console.log(`smoke: failure diagnostics saved to ${destination}`);
}

async function main(root: string): Promise<void> {
  console.log(`smoke root: ${root}`);
  console.log('Reference plan/code are explicit demo stubs; Python execution is real. No LLM, Jev, Vast or paid API.');
  await reproducibilityProbe(root, demoSpec, 'default demo');
  const editedSpec = SpecSchema.parse({
    ...demoSpec,
    parameters: { p: 0.35, epsilon: 0.12, n_values: [12, 24, 48], trials_per_n: 256, seed: 17, primary_n: 24, tail_side: 'greater' }
  });
  await reproducibilityProbe(root, editedSpec, 'edited plan');
  await cancellationProbe(root);
  await timeoutProbe(root);
  console.log('smoke: completed all real local probes');
}

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'paper2 smoke ')));
try {
  try {
    await main(root);
  } finally {
    // Stop every probe before removing files, even when an assertion fails.
    const cleanup = await Promise.allSettled(contexts.map(async context => {
      context.controller.abort(new Error('smoke cleanup'));
      await context.backend.cancel(context.ctx);
      await context.running?.catch(() => undefined);
      await context.backend.cleanup(context.ctx);
    }));
    const failures = cleanup.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Smoke cleanup failed');
  }
} catch (error) {
  await saveFailureDiagnostics().catch(diagnosticError => console.error('Diagnostic export failed:', diagnosticError));
  throw error;
} finally {
  await rm(root, { recursive: true, force: true });
  console.log('smoke: temporary directories removed');
}
