import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectAndValidate } from '../src/core/artifacts.js';
import { SpecSchema, type ExperimentRun, type ExperimentSpec } from '../src/shared/types.js';

const demoSpec = SpecSchema.parse(JSON.parse(await readFile(new URL('../demos/bernoulli-hoeffding/spec.json', import.meta.url), 'utf8'))) as ExperimentSpec;

interface FixtureConfig {
  p: number;
  epsilon: number;
  nValues: number[];
  trialsPerN: number;
  seed: number;
  primaryN: number;
}

const config: FixtureConfig = { p: 0.5, epsilon: 0.5, nValues: [2, 4], trialsPerN: 4, seed: 7, primaryN: 4 };

function threshold(n: number): number {
  return Math.ceil(n * (config.p + config.epsilon) - 1e-12);
}

function exactUpperTail(n: number): number {
  const k = threshold(n);
  let total = 0;
  for (let successes = k; successes <= n; successes++) {
    let combinations = 1;
    for (let index = 1; index <= successes; index++) combinations = combinations * (n - index + 1) / index;
    total += combinations * config.p ** successes * (1 - config.p) ** (n - successes);
  }
  return total;
}

function fixtureMetrics(tails: Map<number, number>): Record<string, number> {
  const primary = tails.get(config.primaryN)!;
  const empirical = primary / config.trialsPerN;
  const bound = Math.exp(-2 * config.primaryN * config.epsilon ** 2);
  const exact = exactUpperTail(config.primaryN);
  const maxExcess = Math.max(...config.nValues.map(n => tails.get(n)! / config.trialsPerN - Math.exp(-2 * n * config.epsilon ** 2)));
  return {
    empirical_tail_probability: empirical,
    hoeffding_bound: bound,
    exact_binomial_tail_probability: exact,
    bound_minus_empirical: bound - empirical,
    bound_minus_exact: bound - exact,
    empirical_to_bound_ratio: empirical / bound,
    monte_carlo_standard_error: Math.sqrt(empirical * (1 - empirical) / config.trialsPerN),
    max_empirical_minus_bound: maxExcess,
    all_exact_tails_within_bound: config.nValues.every(n => exactUpperTail(n) <= Math.exp(-2 * n * config.epsilon ** 2) + 1e-12) ? 1 : 0,
    tail_count_primary: primary,
    n_primary: config.primaryN,
    p: config.p,
    epsilon: config.epsilon,
    trials_per_n: config.trialsPerN,
    seed: config.seed,
    n_configurations: config.nValues.length,
    total_rows: config.nValues.length * config.trialsPerN
  };
}

function runFor(root: string): ExperimentRun {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    title: 'fixture',
    status: 'collecting',
    input: { source: 'https://arxiv.org/abs/1910.02884', task: 'fixture', mode: 'local', timeSeconds: 30, maxHourlyUSD: 0, maxTotalUSD: 0, cleanup: 'destroy' },
    dir: root,
    planVersion: 1,
    attempts: 0,
    artifacts: [],
    spec: { ...demoSpec, parameters: { p: config.p, epsilon: config.epsilon, n_values: config.nValues, trials_per_n: config.trialsPerN, seed: config.seed, primary_n: config.primaryN, tail_side: 'greater' } }
  };
}

async function writeFixture(root: string, metricsOverride?: Record<string, number>): Promise<ExperimentRun> {
  const project = path.join(root, 'project');
  const artifacts = path.join(project, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  const successesByN: Record<number, number[]> = { 2: [0, 1, 2, 2], 4: [4, 3, 4, 1] };
  const tails = new Map<number, number>();
  const rows = config.nValues.map(n => successesByN[n].map((successes, index) => {
    if (successes >= threshold(n)) tails.set(n, (tails.get(n) ?? 0) + 1);
    return `${index + 1},${successes},${n},${config.p},${config.epsilon}`;
  })).flat();
  await writeFile(path.join(artifacts, 'samples.csv'), ['trial,successes,n,p,epsilon', ...rows].join('\n') + '\n');
  await writeFile(path.join(artifacts, 'metrics.json'), JSON.stringify(metricsOverride ?? fixtureMetrics(tails), null, 2));
  await writeFile(path.join(artifacts, 'plot.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><title>empirical vs Hoeffding</title><desc>Fixture series for artifact validation; not a scientific result.</desc><polyline points="10,10 20,20"/><polyline points="10,30 20,40"/><circle cx="10" cy="10" r="2"/><circle cx="20" cy="20" r="2"/></svg>`);
  await writeFile(path.join(project, 'main.py'), 'print("fixture")\n');
  await writeFile(path.join(project, 'requirements.txt'), '# stdlib only\n');
  await writeFile(path.join(project, 'config.json'), JSON.stringify({ p: config.p, epsilon: config.epsilon, n_values: config.nValues, trials_per_n: config.trialsPerN, seed: config.seed, primary_n: config.primaryN, tail_side: 'greater' }, null, 2));
  await writeFile(path.join(project, 'experiment.json'), JSON.stringify({ entryPoint: 'main.py', config: 'config.json', requirements: 'requirements.txt', artifacts: ['metrics.json', 'samples.csv', 'plot.svg'] }, null, 2));
  await writeFile(path.join(project, 'stdout.log'), 'fixture completed\n');
  await writeFile(path.join(project, 'stderr.log'), '');
  return runFor(root);
}

async function withRoot(work: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'paper2-artifacts-'));
  try {
    await work(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('recomputes the demo primary metric and hashes all artifacts', async () => {
  await withRoot(async root => {
    const result = await collectAndValidate(await writeFixture(root));
    assert.equal(result.metrics.empirical_tail_probability, 0.5);
    assert.equal(result.metrics.hoeffding_bound, Math.exp(-2 * 4 * 0.25));
    assert.ok(result.artifacts.some(artifact => artifact.path === 'project/artifacts/samples.csv' && artifact.sha256.length === 64));
    assert.ok(result.verification.includes('Независимая проверка'));
  });
});

test('rejects a non-numeric metric', async () => {
  await withRoot(async root => {
    const run = await writeFixture(root);
    const metrics = JSON.parse(await readFile(path.join(root, 'project/artifacts/metrics.json'), 'utf8')) as Record<string, number>;
    await writeFile(path.join(root, 'project/artifacts/metrics.json'), JSON.stringify({ ...metrics, empirical_tail_probability: '0.5' }));
    await assert.rejects(collectAndValidate(run), /конечным числом/);
  });
});

test('rejects a recomputed metric disagreement', async () => {
  await withRoot(async root => {
    const run = await writeFixture(root);
    const metrics = JSON.parse(await readFile(path.join(root, 'project/artifacts/metrics.json'), 'utf8')) as Record<string, number>;
    await writeFile(path.join(root, 'project/artifacts/metrics.json'), JSON.stringify({ ...metrics, empirical_tail_probability: metrics.empirical_tail_probability + 0.1 }));
    await assert.rejects(collectAndValidate(run), /empirical_tail_probability/);
  });
});

test('rejects scientific config drift from the frozen plan', async () => {
  await withRoot(async root => {
    const run = await writeFixture(root);
    const configPath = path.join(root, 'project/config.json');
    const configObject = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    await writeFile(configPath, JSON.stringify({ ...configObject, epsilon: 0.4 }));
    await assert.rejects(collectAndValidate(run), /замороженным планом/);
  });
});

test('rejects manifest traversal', async () => {
  await withRoot(async root => {
    const run = await writeFixture(root);
    await writeFile(path.join(root, 'project/experiment.json'), JSON.stringify({ entryPoint: 'main.py', config: 'config.json', requirements: 'requirements.txt', artifacts: ['metrics.json', '../escape.txt', 'plot.svg'] }));
    await assert.rejects(collectAndValidate(run), /подозрительный путь|обход/);
  });
});

test('rejects a symlinked artifact', async () => {
  await withRoot(async root => {
    const run = await writeFixture(root);
    const outside = path.join(root, 'outside.txt');
    await writeFile(outside, 'outside');
    await symlink(outside, path.join(root, 'project/artifacts/extra.txt'));
    await assert.rejects(collectAndValidate(run), /симлинк|symlink/);
  });
});

test('rejects duplicate trials instead of trusting row counts', async () => {
  await withRoot(async root => {
    const run = await writeFixture(root);
    await writeFile(path.join(root, 'project/artifacts/samples.csv'), [
      'trial,successes,n,p,epsilon',
      '1,1,2,0.5,0.5', '1,1,2,0.5,0.5', '3,1,2,0.5,0.5', '4,1,2,0.5,0.5',
      '1,1,4,0.5,0.5', '2,1,4,0.5,0.5', '3,1,4,0.5,0.5', '4,1,4,0.5,0.5'
    ].join('\n') + '\n');
    await assert.rejects(collectAndValidate(run), /повтор/);
  });
});

test('rejects a missing declared output', async () => {
  await withRoot(async root => {
    const run = await writeFixture(root);
    await unlink(path.join(root, 'project/artifacts/plot.svg'));
    await assert.rejects(collectAndValidate(run), /Обязательный артефакт.*не найден/s);
  });
});
