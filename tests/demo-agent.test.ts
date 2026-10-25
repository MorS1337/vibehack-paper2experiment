import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Harness } from '../src/core/harness.js';
import { Store } from '../src/core/store.js';
import { demoPlan } from '../src/core/demo-agent.js';
import type { ExperimentInput, ExperimentRun } from '../src/shared/types.js';
import baseline from '../demos/bernoulli-hoeffding/spec.json' with { type: 'json' };
import { SpecSchema } from '../src/shared/types.js';

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

test('an incompatible demo primary metric is rejected before protocol approval or execution', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'p2e-demo-protocol-'));
  try {
    const store = new Store(root); await store.load();
    const harness = new Harness(store);
    const run = await store.create({ ...input, agentMode: 'pi' });
    const spec = SpecSchema.parse(baseline);
    await store.patch(run.id, { source: { original: 'fixture.pdf', textPath: 'fixture.txt', sha256: 'fixture', pages: spec.sourceRefs.map(ref => ({ page: ref.page, text: ref.quote })) } });
    await assert.rejects(harness.savePlan(run.id, { ...spec, metric: { ...spec.metric, name: 'exact_tail_vs_bound' } }), /empirical_tail_probability/);
    assert.equal(run.planVersion, 0);
    assert.equal(run.spec, undefined);
    await harness.savePlan(run.id, spec);
    assert.equal(run.spec?.metric.name, 'empirical_tail_probability');
    assert.equal(run.approvedPlanVersion, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
