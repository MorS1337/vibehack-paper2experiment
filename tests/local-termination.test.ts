import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalBackend } from '../src/compute/local.js';
import { delay, isProcessAlive, isProcessGroupAlive, runProcess } from '../src/compute/process.js';
import { SpecSchema } from '../src/shared/types.js';
import type { AppSettings, ComputeContext, ExperimentRun } from '../src/shared/types.js';

const settings: AppSettings = {
  piProvider: '', piModel: '', python: process.env.PYTHON ?? 'python3',
  whisperBinary: '', whisperModel: '', sshKeyPath: ''
};

// The descendant has no inherited output pipes: a leader's exit/close event is
// deliberately insufficient evidence that this experiment has stopped.
const treeSource = [
  'import os, pathlib, signal, subprocess, sys, time',
  'pathlib.Path("leader.pid").write_text(str(os.getpid()))',
  'signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))',
  'descendant = """',
  'import pathlib, signal, time',
  'signal.signal(signal.SIGTERM, signal.SIG_IGN)',
  'deadline = time.time() + 10',
  'pathlib.Path("sentinel.deadline").write_text(str(deadline))',
  'pathlib.Path("descendant.ready").write_text("ready")',
  'time.sleep(max(0, deadline - time.time()))',
  'pathlib.Path("delayed-sentinel").write_text("experiment still running")',
  'time.sleep(30)',
  '"""',
  'child = subprocess.Popen([sys.executable, "-c", descendant], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)',
  'pathlib.Path("descendant.pid").write_text(str(child.pid))',
  'while True:',
  '    time.sleep(1)',
  ''
].join('\n');

async function exists(file: string): Promise<boolean> {
  return access(file).then(() => true, () => false);
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error('Timed out waiting for the real Python process tree');
}

async function stopped(pid: number): Promise<boolean> {
  if (!isProcessAlive(pid)) return true;
  // Some Linux init processes leave orphaned zombies visible to kill(0).
  // A zombie is dead, cannot write the sentinel, and cannot receive a signal.
  const state = await runProcess('ps', ['-o', 'stat=', '-p', String(pid)], { timeoutMs: 5000 });
  return state.exitCode !== 0 || state.stdout.trim().startsWith('Z');
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'p2e-local-termination-'));
  const projectDir = path.join(root, 'project');
  const backend = new LocalBackend();
  const controller = new AbortController();
  const spec = SpecSchema.parse({
    version: 1, title: 'Real process termination', objective: 'Stop all experiment processes',
    paperResult: 'No output after cancellation', sourceRefs: [{ page: 1, quote: 'test' }],
    data: { description: 'none', split: 'none', preprocessing: 'none' },
    method: 'process regression', baseline: 'none', parameters: {},
    metric: { name: 'value', computation: 'x', publishedValue: null, comparable: false },
    requirements: { cpuCores: 1, ramGB: 1, gpu: false, vramGB: 0, diskGB: 1 },
    limits: { timeSeconds: 60, maxHourlyUSD: 0, maxTotalUSD: 0 },
    implementation: 'independent', assumptions: [], missing: [], demo: null
  });
  const run: ExperimentRun = {
    id: '00000000-0000-4000-8000-000000000002', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), title: spec.title, status: 'running',
    input: { source: 'inline', task: spec.title, mode: 'local', timeSeconds: 60, maxHourlyUSD: 0, maxTotalUSD: 0, cleanup: 'destroy' },
    dir: root, spec, planVersion: 1, attempts: 0, artifacts: [],
    deadlineAt: new Date(Date.now() + 60_000).toISOString()
  };
  const ctx: ComputeContext = {
    run, spec, settings, projectDir, signal: controller.signal,
    persist: async patch => { Object.assign(run, patch); },
    emit: async () => undefined
  };
  let running: Promise<{ exitCode: number; stderr: string }> | undefined;
  const cleanup = async () => {
    controller.abort(new Error('test cleanup'));
    const pid = run.pid ?? Number(await readFile(path.join(projectDir, 'leader.pid'), 'utf8').catch(() => '0'));
    // Cleanup must not depend on the termination implementation under test.
    if (pid > 1 && isProcessGroupAlive(pid)) {
      try { process.kill(-pid, 'SIGKILL'); } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ESRCH') throw error;
      }
    }
    try {
      await backend.cancel(ctx);
      await running?.catch(() => undefined);
      const descendant = Number(await readFile(path.join(projectDir, 'descendant.pid'), 'utf8').catch(() => '0'));
      if (descendant > 1) await waitFor(() => stopped(descendant));
      await backend.cleanup(ctx);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };
  try {
    await mkdir(projectDir);
    await writeFile(path.join(projectDir, 'experiment.json'), JSON.stringify({
      entryPoint: 'main.py', config: 'config.json', requirements: 'requirements.txt', artifacts: ['metrics.json']
    }));
    await writeFile(path.join(projectDir, 'config.json'), '{}');
    await writeFile(path.join(projectDir, 'requirements.txt'), '');
    await writeFile(path.join(projectDir, 'main.py'), treeSource);
    await backend.prepare(ctx);
  } catch (error) {
    await cleanup();
    throw error;
  }
  return {
    backend, controller, ctx, projectDir, cleanup,
    start: () => {
      running = backend.run(ctx);
      void running.catch(() => undefined);
      return running;
    }
  };
}

async function ready(projectDir: string): Promise<{ leader: number; descendant: number }> {
  await waitFor(async () => await exists(path.join(projectDir, 'descendant.ready')) && await exists(path.join(projectDir, 'descendant.pid')));
  return {
    leader: Number(await readFile(path.join(projectDir, 'leader.pid'), 'utf8')),
    descendant: Number(await readFile(path.join(projectDir, 'descendant.pid'), 'utf8'))
  };
}

async function assertNoDelayedSentinel(projectDir: string): Promise<void> {
  const deadline = Number(await readFile(path.join(projectDir, 'sentinel.deadline'), 'utf8')) * 1000;
  await delay(Math.max(0, deadline - Date.now() + 250));
  assert.equal(await exists(path.join(projectDir, 'delayed-sentinel')), false, 'a descendant wrote output after the backend settled');
}

const options = { timeout: 60_000, skip: process.platform === 'win32' ? 'POSIX process-group regression' : false };

test('LocalBackend cancel waits for a TERM-resistant descendant after its leader exits', options, async () => {
  const f = await fixture();
  let cancelling: Promise<void> | undefined;
  try {
    const running = f.start();
    const pids = await ready(f.projectDir);
    f.controller.abort(new Error('cancelled by termination regression'));
    cancelling = f.backend.cancel(f.ctx);
    void cancelling.catch(() => undefined);
    // Check run independently of the cancel promise: previously run settled on
    // the leader's exit while its unawaited grace-period cleanup was still live.
    await assert.rejects(running, /cancelled by termination regression/);
    assert.equal(await stopped(pids.leader), true);
    assert.equal(await stopped(pids.descendant), true, 'run settled before the descendant stopped');
    await cancelling;
    await assertNoDelayedSentinel(f.projectDir);
  } finally {
    await f.cleanup();
    await cancelling?.catch(() => undefined);
  }
});

test('LocalBackend timeout does not settle while a TERM-resistant descendant can write', options, async () => {
  const f = await fixture();
  try {
    f.ctx.run.deadlineAt = new Date(Date.now() + 3000).toISOString();
    const running = f.start();
    const pids = await ready(f.projectDir);
    const result = await running;
    assert.equal(result.exitCode, 124);
    assert.equal(await stopped(pids.leader), true);
    assert.equal(await stopped(pids.descendant), true, 'timeout returned before process-group cleanup');
    await assertNoDelayedSentinel(f.projectDir);
  } finally {
    await f.cleanup();
  }
});

test('LocalBackend rechecks cancellation after the pre-dispatch persistence barrier', options, async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const persist = f.ctx.persist;
  f.ctx.persist = async patch => {
    await persist(patch);
    if (patch.executionStarted) {
      entered.resolve();
      await release.promise;
    }
  };
  try {
    f.ctx.run.deadlineAt = new Date(Date.now() + 3000).toISOString();
    const running = f.start();
    await entered.promise;
    f.controller.abort(new Error('cancelled before dispatch'));
    release.resolve();
    await assert.rejects(running, /cancelled before dispatch/);
    assert.equal(f.ctx.run.pid, undefined, 'an already-aborted run must never dispatch Python');
    assert.equal(await exists(path.join(f.projectDir, 'leader.pid')), false);
  } finally {
    release.resolve();
    await f.cleanup();
  }
});

test('LocalBackend observes abort while immediate PID persistence is still pending', options, async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const persist = f.ctx.persist;
  f.ctx.persist = async patch => {
    await persist(patch);
    if (patch.pid !== undefined) {
      entered.resolve();
      await release.promise;
    }
  };
  try {
    const running = f.start();
    await entered.promise;
    const pids = await ready(f.projectDir);
    f.controller.abort(new Error('cancelled during PID persistence'));
    await waitFor(() => stopped(pids.leader));
    release.resolve();
    await assert.rejects(running, /cancelled during PID persistence/);
    assert.equal(await stopped(pids.descendant), true);
    await assertNoDelayedSentinel(f.projectDir);
  } finally {
    release.resolve();
    await f.cleanup();
  }
});

test('LocalBackend kills and awaits the spawned tree when immediate PID persistence fails', options, async () => {
  const f = await fixture();
  const failure = new Error('PID persistence failed');
  let pids: Awaited<ReturnType<typeof ready>> | undefined;
  const persist = f.ctx.persist;
  f.ctx.persist = async patch => {
    if (patch.pid !== undefined) {
      pids = await ready(f.projectDir);
      // Deliberately fail before storing PID: cleanup must use active execution,
      // not depend on a successfully persisted run record.
      throw failure;
    }
    await persist(patch);
  };
  try {
    await assert.rejects(f.start(), error => error === failure);
    assert.ok(pids);
    assert.equal(f.ctx.run.pid, undefined);
    assert.equal(await stopped(pids.leader), true);
    assert.equal(await stopped(pids.descendant), true);
    await assertNoDelayedSentinel(f.projectDir);
  } finally {
    await f.cleanup();
  }
});
