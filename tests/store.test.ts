import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/core/store.js';

const input = { agentMode: 'pi' as const, source: 'https://arxiv.org/abs/1706.03762', task: 'Persistence probe', mode: 'local' as const, timeSeconds: 10, maxHourlyUSD: 0, maxTotalUSD: 0, cleanup: 'destroy' as const };
test('concurrent transitions persist newest state and all ordered events across restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'p2e-store-'));
  try {
    const store = new Store(root); await store.load(); const run = await store.create(input);
    await Promise.all([
      store.patch(run.id, { status: 'running', pid: 12345 }),
      store.event(run.id, 'status', 'running'),
      store.patch(run.id, { status: 'cancelled', pid: undefined }),
      store.event(run.id, 'status', 'cancelled')
    ]);
    const restored = new Store(root); await restored.load();
    assert.equal(restored.get(run.id).status, 'cancelled');
    assert.equal(restored.get(run.id).pid, undefined);
    assert.deepEqual((await restored.events(run.id)).map(event => event.message), ['running', 'cancelled']);
    assert.equal(JSON.parse(await readFile(path.join(run.dir, 'run.json'), 'utf8')).status, 'cancelled');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('corrupt persisted state is reported instead of silently dropping research history', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'p2e-store-'));
  try {
    const store = new Store(root); await store.load(); const run = await store.create(input);
    await writeFile(path.join(run.dir, 'run.json'), '{invalid-json');
    const restored = new Store(root);
    await assert.rejects(restored.load(), /Не удалось восстановить/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
