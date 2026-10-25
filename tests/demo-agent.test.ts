import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Harness } from '../src/core/harness.js';
import { Store } from '../src/core/store.js';
import { demoPlan } from '../src/core/demo-agent.js';
import type { ExperimentInput, ExperimentRun } from '../src/shared/types.js';

const input: ExperimentInput = { agentMode: 'demo', source: 'https://arxiv.org/abs/1910.02884v1', task: 'demo', mode: 'local', timeSeconds: 60, maxHourlyUSD: 0, maxTotalUSD: 0, cleanup: 'destroy' };
test('demo mode cannot create a Vast or Auto run even when a paid budget is supplied', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'p2e-demo-boundary-'));
  try {
    const store = new Store(root); const harness = new Harness(store); await harness.initialize();
    for (const mode of ['vast', 'auto'] as const) await assert.rejects(harness.create({ ...input, mode, maxHourlyUSD: 10, maxTotalUSD: 100 }), { name: 'Error' });
    assert.deepEqual(store.list(), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('fixed demo refuses to present its plan as analysis of a different document', () => {
  const run = { input, source: { sha256: 'different-document' } } as ExperimentRun;
  assert.throws(() => demoPlan(run), { name: 'Error' });
  assert.equal(run.spec, undefined);
});
