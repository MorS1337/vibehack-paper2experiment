import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalBackend } from '../src/compute/local.js';
import { collectAndValidate } from '../src/core/artifacts.js';
import { Store } from '../src/core/store.js';
import { SpecSchema } from '../src/shared/types.js';
import type { ComputeContext, ExperimentInput, ExperimentRun, ExperimentSpec, RunEvent } from '../src/shared/types.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const referenceDir = path.join(repoRoot, 'demos/bernoulli-hoeffding/reference');
const demoSpec = SpecSchema.parse(JSON.parse(await readFile(path.join(repoRoot, 'demos/bernoulli-hoeffding/spec.json'), 'utf8'))) as ExperimentSpec;

const input: ExperimentInput = {
  agentMode: 'demo',
  source: 'https://arxiv.org/abs/1910.02884',
  task: 'Bernoulli/Hoeffding local smoke run',
  mode: 'local',
  timeSeconds: 60,
  maxHourlyUSD: 0,
  maxTotalUSD: 0,
  cleanup: 'destroy'
};

interface SmokeContext {
  store: Store;
  run: ExperimentRun;
  spec: ExperimentSpec;
  backend: LocalBackend;
  ctx: ComputeContext;
}

async function buildContext(root: string, spec: ExperimentSpec, task: string, explicitProjectDir?: string): Promise<SmokeContext> {
  const store = new Store(root);
  await store.load();
  const run = await store.create({ ...input, task });
  const projectDir = explicitProjectDir ?? path.join(run.dir, 'project');
  await store.patch(run.id, {
    spec,
    status: 'preparing',
    deadlineAt: new Date(Date.now() + spec.limits.timeSeconds * 1000).toISOString()
  });
  const controller = new AbortController();
  const ctx: ComputeContext = {
    run,
    spec,
    projectDir,
    signal: controller.signal,
    settings: store.settings,
    emit: async (type: RunEvent['type'], message: string) => {
      console.log(`[${task}] ${type}: ${message}`);
      await store.event(run.id, type, message);
    },
    persist: async (patch: Partial<ExperimentRun>) => {
      Object.assign(run, patch);
      await store.patch(run.id, patch);
    }
  };
  return { store, run, spec, backend: new LocalBackend(), ctx };
}

async function copyDemoProject(run: ExperimentRun): Promise<string> {
  const projectDir = path.join(run.dir, 'project');
  await cp(referenceDir, projectDir, { recursive: true, force: true });
  await rm(path.join(projectDir, 'artifacts'), { recursive: true, force: true });
  await rm(path.join(projectDir, '.venv'), { recursive: true, force: true });
  await rm(path.join(projectDir, '__pycache__'), { recursive: true, force: true });
  await writeFile(path.join(projectDir, 'plan.json'), JSON.stringify(demoSpec, null, 2) + '\n');
  return projectDir;
}

async function prepareAndRun(context: SmokeContext): Promise<{ exitCode: number; stderr: string }> {
  await context.backend.prepare(context.ctx);
  await context.ctx.persist({ status: 'running' });
  return context.backend.run(context.ctx);
}

async function waitForLog(projectDir: string, text: string, timeoutMs = 8000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if ((await readFile(path.join(projectDir, 'stdout.log'), 'utf8')).includes(text)) return true;
    } catch {
      // The process may not have created stdout.log yet.
    }
    await delay(50);
  }
  return false;
}

// The full Harness requires a real pi plan, so these probes exercise the same
// ComputeBackend operations the harness uses: cancel kills the real process,
// and the timeout probe mirrors the harness deadline timer by calling cancel.
async function cancellationProbe(root: string): Promise<void> {
  const projectTemplate = await mkdtemp(path.join(root, 'probe-project-'));
  const projectDir = path.join(projectTemplate, 'project');
  await cp(referenceDir, projectDir, { recursive: true, force: true });
  await rm(path.join(projectDir, 'artifacts'), { recursive: true, force: true });
  await writeFile(path.join(projectDir, 'main.py'), [
    'import time',
    'print("cancel-probe-started", flush=True)',
    'time.sleep(30)',
    'print("cancel-probe-finished", flush=True)',
    ''
  ].join('\n'));
  await writeFile(path.join(projectDir, 'experiment.json'), JSON.stringify({ entryPoint: 'main.py', config: 'config.json', requirements: 'requirements.txt', artifacts: ['metrics.json'] }, null, 2));

  const context = await buildContext(root, demoSpec, 'cancellation probe', projectDir);
  await context.backend.prepare(context.ctx);
  await context.ctx.persist({ status: 'running' });
  const stdoutHook = context.backend.streamLogs(context.ctx, line => console.log(`[cancel stdout] ${line}`));
  const runPromise = context.backend.run(context.ctx).catch(error => ({ exitCode: -1, stderr: String(error) }));
  const started = await waitForLog(projectDir, 'cancel-probe-started');
  await context.backend.cancel(context.ctx);
  const result = await Promise.race([runPromise, delay(15000).then(() => ({ exitCode: -2, stderr: 'cancel probe timed out after 15s' }))]);
  stdoutHook();
  let alive = false;
  if (context.run.pid) {
    try { process.kill(context.run.pid, 0); alive = true; } catch { alive = false; }
  }
  const status = await context.backend.getStatus(context.ctx);
  console.log(JSON.stringify({ probe: 'cancellation', started, exitCode: result.exitCode, pid: context.run.pid, processStillAlive: alive, status }, null, 2));
  if (result.exitCode === -2) throw new Error('Cancellation probe did not finish');
  if (alive) throw new Error(`Cancelled process ${context.run.pid} is still alive`);
  await context.backend.cleanup(context.ctx).catch(error => console.log(`cleanup after cancel: ${String(error)}`));
}

async function timeoutProbe(root: string): Promise<void> {
  const projectTemplate = await mkdtemp(path.join(root, 'timeout-project-'));
  const projectDir = path.join(projectTemplate, 'project');
  await cp(referenceDir, projectDir, { recursive: true, force: true });
  await rm(path.join(projectDir, 'artifacts'), { recursive: true, force: true });
  await writeFile(path.join(projectDir, 'main.py'), [
    'import time',
    'print("timeout-probe-started", flush=True)',
    'time.sleep(30)',
    'print("timeout-probe-finished", flush=True)',
    ''
  ].join('\n'));
  await writeFile(path.join(projectDir, 'experiment.json'), JSON.stringify({ entryPoint: 'main.py', config: 'config.json', requirements: 'requirements.txt', artifacts: ['metrics.json'] }, null, 2));

  const context = await buildContext(root, demoSpec, 'timeout probe', projectDir);
  await context.backend.prepare(context.ctx);
  await context.ctx.persist({ status: 'running' });
  const startedAt = Date.now();
  let timedOut = false;
  let cancellation: Promise<void> = Promise.resolve();
  let cancellationError: unknown;
  const timer = setTimeout(() => {
    timedOut = true;
    cancellation = context.backend.cancel(context.ctx).catch(error => { cancellationError = error; });
  }, 1200);
  const result = await Promise.race([
    context.backend.run(context.ctx).catch(error => ({ exitCode: -1, stderr: String(error) })),
    delay(15000).then(() => ({ exitCode: -2, stderr: 'timeout probe did not stop within 15s' }))
  ]);
  clearTimeout(timer);
  await cancellation;
  if (cancellationError) throw cancellationError;
  const elapsedMs = Date.now() - startedAt;
  const status = await context.backend.getStatus(context.ctx);
  let alive = false;
  if (context.run.pid) {
    try { process.kill(context.run.pid, 0); alive = true; } catch { alive = false; }
  }
  console.log(JSON.stringify({ probe: 'timeout', timedOut, exitCode: result.exitCode, elapsedMs, pid: context.run.pid, processStillAlive: alive, status }, null, 2));
  if (!timedOut) throw new Error('Timeout probe timer did not fire');
  if (result.exitCode === -2) throw new Error('Timed-out process did not stop');
  if (alive) throw new Error(`Timed-out process ${context.run.pid} is still alive`);
  await context.backend.cleanup(context.ctx).catch(error => console.log(`cleanup after timeout: ${String(error)}`));
}

async function historyProbe(root: string, store: Store, run: ExperimentRun): Promise<void> {
  await store.event(run.id, 'log', 'smoke: completed run persisted');
  const reopened = new Store(root);
  await reopened.load();
  const restored = reopened.get(run.id);
  const events = await reopened.events(run.id);
  console.log(JSON.stringify({
    probe: 'history',
    status: restored.status,
    hasMetrics: !!restored.metrics && Number.isFinite(restored.metrics.empirical_tail_probability),
    artifactCount: restored.artifacts.length,
    events: events.length,
    artifactsCollected: restored.artifactsCollected
  }, null, 2));
  if (!restored.metrics || restored.artifacts.length === 0) throw new Error('History reload lost metrics or artifacts');
}

async function main(): Promise<void> {
  // LocalBackend rejects project paths that resolve through a symlink; on macOS
  // os.tmpdir() is often /var/folders, whose /var is a symlink to /private/var.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'paper2-smoke-')));
  try {
    console.log(`smoke root: ${root}`);
    console.log('No LLM, Jev, Vast or paid API is called by this smoke script.');
    const first = await buildContext(root, demoSpec, 'demo run');
    await copyDemoProject(first.run);
    const execution = await prepareAndRun(first);
    console.log(JSON.stringify({ phase: 'execution', exitCode: execution.exitCode, stderrTail: execution.stderr.slice(-2000) }, null, 2));
    if (execution.exitCode !== 0) throw new Error(`demo exited with ${execution.exitCode}: ${execution.stderr.slice(-4000)}`);
    await first.backend.collectArtifacts(first.ctx);
    const validated = await collectAndValidate(first.run);
    await first.store.patch(first.run.id, { ...validated, artifactsCollected: true, status: 'completed' });
    console.log('Independent recomputation and metrics:');
    console.log(JSON.stringify(validated.metrics, null, 2));
    console.log(validated.verification);
    await historyProbe(root, first.store, first.run);
    await first.backend.cleanup(first.ctx);
    await cancellationProbe(root);
    await timeoutProbe(root);
    console.log('smoke: completed all real local probes');
  } finally {
    await rm(root, { recursive: true, force: true });
    console.log('smoke: temporary directories removed');
  }
}

await main();
