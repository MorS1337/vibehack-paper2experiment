import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import { projectMessages, readConversation, readArtifactPreview } from '../src/core/conversation.js';
import { Store } from '../src/core/store.js';

type Message = AgentSession['messages'][number];
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const call: Message = { role: 'assistant', api: 'openai-completions', provider: 'fixture', model: 'test', timestamp: 20, stopReason: 'toolUse', usage, content: [{ type: 'text', text: 'Inspecting the source.' }, { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'main.py' } }] };

test('tool results settle their original row without losing arguments, position, or failure state', () => {
  const messages: Message[] = [{ role: 'user', content: 'Check the code.', timestamp: 10 }, call, { role: 'toolResult', toolCallId: 'read-1', toolName: 'read', timestamp: 30, content: [{ type: 'text', text: 'File missing' }], isError: true }];
  const blocks = projectMessages(messages, false);
  assert.deepEqual(blocks.map(block => block.kind), ['user', 'assistant', 'tool']);
  assert.deepEqual(blocks[2], { id: 'read-1', at: 20, kind: 'tool', tool: 'read', args: JSON.stringify({ path: 'main.py' }, null, 2), text: 'File missing', state: 'error' });
  assert.equal(projectMessages([call], false)[1].state, 'cancelled');
  assert.equal(projectMessages([call], true)[1].state, 'running');
});

test('paginated Pi history survives reopening without gaps or duplicate boundary messages', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'p2e-history-'));
  try {
    const store = new Store(root); await store.load();
    const run = await store.create({ agentMode: 'pi', source: 'paper.pdf', task: 'History test', mode: 'local', timeSeconds: 30, maxHourlyUSD: 0, maxTotalUSD: 0, cleanup: 'destroy' });
    const manager = SessionManager.create(run.dir, path.join(run.dir, 'session'));
    for (let i = 0; i < 205; i++) manager.appendMessage({ role: 'user', content: `Message ${i}`, timestamp: 1000 + i });
    manager.appendMessage({ role: 'assistant', api: 'openai-completions', provider: 'fixture', model: 'test', timestamp: 2000, stopReason: 'stop', usage, content: [{ type: 'text', text: 'History saved.' }] });
    run.sessionFile = manager.getSessionFile();
    const latest = readConversation(run);
    const middle = readConversation(run, latest.before);
    const earliest = readConversation(run, middle.before);
    assert.equal(latest.hasMore, true);
    assert.equal(earliest.hasMore, false);
    const all = [...earliest.blocks, ...middle.blocks, ...latest.blocks];
    assert.equal(new Set(all.map(block => block.id)).size, 206);
    assert.equal(all[0].text, 'Message 0');
    assert.equal(all[204].text, 'Message 204');
    assert.equal(all[205].text, 'History saved.');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('artifact previews reject traversal, session storage, directory symlinks, and oversized files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'p2e-preview-'));
  try {
    const store = new Store(root); await store.load();
    const run = await store.create({ agentMode: 'pi', source: 'paper.pdf', task: 'Preview test', mode: 'local', timeSeconds: 30, maxHourlyUSD: 0, maxTotalUSD: 0, cleanup: 'destroy' });
    await mkdir(path.join(run.dir, 'project')); await mkdir(path.join(run.dir, 'session'));
    await writeFile(path.join(run.dir, 'project', 'figure.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><text>Evidence</text></svg>');
    await writeFile(path.join(run.dir, 'session', 'private.txt'), 'not a workspace artifact');
    await symlink(path.join(run.dir, 'session'), path.join(run.dir, 'project', 'linked'));
    await writeFile(path.join(run.dir, 'project', 'large.txt'), 'x'.repeat(512 * 1024 + 1));
    assert.equal((await readArtifactPreview(run, 'project/figure.svg')).mime, 'image/svg+xml');
    await assert.rejects(readArtifactPreview(run, 'project/../session/private.txt'), /Invalid artifact path/);
    await assert.rejects(readArtifactPreview(run, 'session/private.txt'), /outside/);
    await assert.rejects(readArtifactPreview(run, 'project/linked/private.txt'), /Symlink/);
    await assert.rejects(readArtifactPreview(run, 'project/large.txt'), /512 KiB/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
