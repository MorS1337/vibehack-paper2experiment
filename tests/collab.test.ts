import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startCollabServer } from '../src/collab/server.js';
import { startTunnel } from '../src/collab/tunnel.js';
import { readArtifactDownload } from '../src/core/artifact-download.js';
import { collabLink, decodeBase64Url, encodeBase64Url, parseCollabToken } from '../src/shared/collab-link.js';
import { connectRemote } from '../src/renderer/lib/remote-api.js';
import type { ConversationUpdate, ExperimentRun, RunEvent } from '../src/shared/types.js';

async function fixture(work: (ctx: {
  origin: string; control: string; view: string; root: string;
  server: Awaited<ReturnType<typeof startCollabServer>>;
  calls: { method: string; args: unknown[] }[];
}) => Promise<void>, lifetimeMs?: number) {
  const root = await mkdtemp(path.join(tmpdir(), 'p2e-collab-'));
  await mkdir(path.join(root, 'web'));
  await writeFile(path.join(root, 'web', 'index.html'), '<h1>Paper2Experiment</h1>');
  await writeFile(path.join(root, 'private.js'), 'secret');
  await writeFile(path.join(root, 'paper.pdf'), '%PDF-1.7\npaper fixture');
  await symlink(path.join(root, 'private.js'), path.join(root, 'web', 'escape.js'));
  const calls: { method: string; args: unknown[] }[] = [];
  const server = await startCollabServer({ rendererRoot: path.join(root, 'web'), uploadRoot: path.join(root, 'uploads'), host: '127.0.0.1', port: 0, lifetimeMs,
    request: async (method, ...args) => { calls.push({ method, args }); return method === 'sourcePdfPath' ? path.join(root, 'paper.pdf') : method === 'snapshot' ? { runs: [], settings: {}, connections: [] } : { accepted: method }; } });
  const link = server.status('http://localhost/').links[0];
  try { await work({ root, server, origin: `http://127.0.0.1:${server.port}`, control: parseCollabToken(link.control)!, view: parseCollabToken(link.view)!, calls }); }
  finally { await server.close(); await rm(root, { recursive: true, force: true }); }
}

function auth(token: string) { return { Authorization: `Bearer ${token}` }; }
function event(id: number): RunEvent { return { id: String(id), runId: 'test', at: new Date().toISOString(), type: 'log', message: `line ${id}` }; }

test('collab links round-trip 32-byte keys; reject malformed/noncanonical tokens and unsafe origins', () => {
  const bytes = randomBytes(32), token = encodeBase64Url(bytes);
  assert.deepEqual(Buffer.from(decodeBase64Url(token)!), bytes);
  const link = collabLink('https://paper.example', token);
  assert.equal(new URL(link).search, '');
  assert.equal(parseCollabToken(link), token);
  assert.equal(parseCollabToken(`#p2e=${token}`), token);
  for (const invalid of ['', 'key', token + '=', token + 'x', 'https://example.com/?p2e=' + token]) assert.equal(parseCollabToken(invalid), null);
  for (const origin of ['file:///tmp/', 'https://u:p@example.com', 'https://example.com/path', 'https://example.com/?x=1']) assert.throws(() => collabLink(origin, token));
});

test('HTTP serves only renderer assets; authenticates reads, enforces view access and method allowlist', async () => {
  await fixture(async ({ origin, control, view, calls }) => {
    assert.match(await (await fetch(origin)).text(), /Paper2Experiment/);
    assert.equal((await fetch(`${origin}/escape.js`)).status, 403);
    assert.equal((await fetch(`${origin}/%2e%2e%2fprivate.js`)).status, 403);
    assert.equal((await fetch(`${origin}/api/session`)).status, 401);
    assert.equal((await fetch(`${origin}/api/session`, { headers: auth('bad') })).status, 401);
    const session = await fetch(`${origin}/api/session`, { headers: auth(view) });
    assert.equal((await session.json()).access, 'view');
    assert.equal(session.headers.get('cache-control'), 'no-store');
    assert.match(session.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    const rpc = (token: string, method: string, extra: Record<string, string> = {}) => fetch(`${origin}/api/rpc`, { method: 'POST', headers: { ...auth(token), 'Content-Type': 'application/json', ...extra }, body: JSON.stringify({ method, args: [] }) });
    assert.equal((await rpc(view, 'snapshot')).status, 200);
    for (const method of ['create', 'plan', 'savePlan', 'execute', 'approve', 'cancel', 'cleanup', 'saveSettings', 'transcribe', 'importPaper', 'setBrief', 'sendMessage', 'cancelTranscription']) assert.equal((await rpc(view, method)).status, 403, method);
    for (const method of ['folder', 'shutdown', 'choose', 'collab:start', '__proto__', 'sourcePdfPath', 'piLogin', 'piLoginRespond', 'piLoginState', 'authLink', 'requestMicrophoneAccess']) assert.equal((await rpc(control, method)).status, 404, method);
    assert.equal((await rpc(control, 'create', { Origin: 'https://attacker.example' })).status, 403);
    assert.equal((await rpc(control, 'create')).status, 200);
    assert.deepEqual(calls.map(call => call.method), ['snapshot', 'create']);
  });
});

test('PDF upload requires control, validates bytes and size; WAV transport preserves bytes', async () => {
  await fixture(async ({ origin, control, view, calls, root }) => {
    const upload = (token: string, body: string, extra: Record<string, string> = {}) => fetch(`${origin}/api/upload`, { method: 'POST', headers: { ...auth(token), ...extra }, body });
    assert.equal((await upload(view, '%PDF-1.7')).status, 403);
    assert.equal((await upload(control, '<html>bad</html>')).status, 400);
    assert.equal((await upload(control, '%PDF-1.7', { Origin: 'https://attacker.example' })).status, 403);
    assert.equal((await upload(control, '%PDF-' + 'a'.repeat(25 * 1024 * 1024))).status, 413);
    const file = await (await upload(control, '%PDF-1.7\nfixture')).json();
    assert.ok(file.path.startsWith(path.join(root, 'uploads') + path.sep));
    assert.equal(await readFile(file.path, 'utf8'), '%PDF-1.7\nfixture');
    const audio = Buffer.from([82, 73, 70, 70, 0, 255]);
    const response = await fetch(`${origin}/api/rpc`, { method: 'POST', headers: { ...auth(control), 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'transcribe', args: [audio.toString('base64')] }) });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(calls[0].args[0] as ArrayBuffer), audio);
  });
});

test('live polling delivers updates, resyncs after missed history, and revokes pending reads', async () => {
  await fixture(async ({ origin, view, server }) => {
    const poll = (cursor?: number) => fetch(`${origin}/api/events${cursor === undefined ? '' : `?cursor=${cursor}`}`, { headers: auth(view) });
    assert.deepEqual(await (await poll()).json(), { cursor: 0, sync: true, events: [], conversations: [] });
    const waiting = poll(0);
    await delay(25);
    const first = event(1);
    server.publish(first);
    assert.deepEqual(await (await waiting).json(), { cursor: 1, sync: false, events: [first], conversations: [] });
    for (let index = 2; index <= 502; index++) server.publish(event(index));
    const missed = await (await poll(1)).json();
    assert.equal(missed.sync, true);
    assert.equal(missed.events.length, 500);
    const pending = poll(missed.cursor);
    await delay(25);
    await server.close();
    assert.equal((await pending).status, 401);
  });
});

test('expired links cannot read or mutate', async () => {
  await fixture(async ({ origin, control, server }) => {
    await delay(50);
    const response = await fetch(`${origin}/api/session`, { headers: auth(control) });
    assert.equal(response.status, 401);
    assert.match((await response.json()).error, /истекла/);
  }, 25);
});

test('browser adapter reads and controls the same RPC, reconnects and catches up after a network failure', async () => {
  await fixture(async ({ origin, control, view, server, calls }) => {
    const originalFetch = globalThis.fetch;
    let failNextPoll = false;
    globalThis.fetch = (input, init) => {
      if (failNextPoll && String(input).startsWith('/api/events')) { failNextPoll = false; return Promise.reject(new Error('offline')); }
      return originalFetch(new URL(String(input), origin), init);
    };
    try {
      const api = await connectRemote(control);
      assert.equal(api.access, 'control');
      assert.deepEqual((await api.snapshot()).runs, []);
      await api.plan('run-1');
      assert.equal(calls.at(-1)?.args[0], 'run-1');
      const requestId = 'b48535d5-ab40-4bd7-b294-f0904db64532';
      const wav = Uint8Array.from([82, 73, 70, 70, 0, 255]);
      const beforePermission = calls.length;
      await api.requestMicrophoneAccess();
      assert.equal(calls.length, beforePermission, 'phone permission must not call the desktop microphone');
      await api.transcribe(wav.buffer, requestId);
      assert.equal(calls.at(-1)?.args[1], requestId);
      assert.deepEqual(new Uint8Array(calls.at(-1)?.args[0] as ArrayBuffer), wav);
      await api.cancelTranscription(requestId);
      assert.deepEqual(calls.at(-1), { method: 'cancelTranscription', args: [requestId] });
      await api.sendMessage('run-1', 'Check the assumption', 'steer', requestId);
      assert.deepEqual(calls.at(-1), { method: 'sendMessage', args: ['run-1', 'Check the assumption', 'steer', requestId] });
      await api.conversation('run-1');
      assert.deepEqual(calls.at(-1), { method: 'conversation', args: ['run-1'] });
      const paper = await api.paperPdf!('b48535d5-ab40-4bd7-b294-f0904db64532');
      assert.equal(Buffer.from(paper).toString(), '%PDF-1.7\npaper fixture');
      await assert.rejects(api.piLogin('provider', 'api_key'), /desktop/);
      const viewer = await connectRemote(view);
      await assert.rejects(viewer.cancel('run-1'), /только просмотр/);
      await assert.rejects(viewer.requestMicrophoneAccess(), /view-only/);
      await assert.rejects(viewer.cancelTranscription(requestId), /только просмотр/);
      const events: RunEvent[] = [], connections: string[] = [];
      const conversations: ConversationUpdate[] = [];
      const unConversation = api.onConversation(update => conversations.push(update));
      const unstatus = api.connection!(state => connections.push(state));
      const unsubscribe = api.onEvent(value => events.push(value));
      const until = async (check: () => boolean) => { for (let n = 0; n < 300 && !check(); n++) await delay(10); assert.ok(check()); };
      await until(() => events.some(item => item.id === 'sync'));
      const update: ConversationUpdate = { runId: 'run-1', blocks: [{ id: 'reply', at: 1, kind: 'assistant', state: 'streaming', text: 'Live research' }] };
      server.publishConversation(update);
      await until(() => conversations.length === 1);
      assert.deepEqual(conversations[0], update);
      failNextPoll = true;
      server.publish(event(8));
      await until(() => connections.includes('reconnecting'));
      server.publish(event(9));
      await until(() => events.filter(item => item.id === 'sync').length === 2);
      assert.equal(connections.at(-1), 'connected');
      unsubscribe(); unConversation(); unstatus();
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('artifact download checks inventory, containment and content digest', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'p2e-download-'));
  const content = Buffer.from('x,y\n1,2\n');
  const artifact = { path: 'samples.csv', kind: 'predictions' as const, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') };
  const run = { dir: root, artifacts: [artifact] } as ExperimentRun;
  try {
    await writeFile(path.join(root, 'samples.csv'), content);
    assert.deepEqual(await readArtifactDownload(run, artifact.path), { name: artifact.path, base64: content.toString('base64') });
    await assert.rejects(readArtifactDownload(run, '../secret'), /не зарегистрирован/);
    await writeFile(path.join(root, 'samples.csv'), 'x,y\n9,2\n');
    await assert.rejects(readArtifactDownload(run, artifact.path), /SHA-256/);
    run.artifacts.push({ ...artifact, path: '../secret' });
    await assert.rejects(readArtifactDownload(run, '../secret'), /Недопустимый/);
    await symlink(path.join(root, 'samples.csv'), path.join(root, 'link.csv'));
    run.artifacts.push({ ...artifact, path: 'link.csv' });
    await assert.rejects(readArtifactDownload(run, 'link.csv'), /symlink/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('optional tunnel child is cancelled and stopped without a network call', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'p2e-tunnel-'));
  const previous = process.env.PAPER2_CLOUDFLARED;
  try {
    const executable = path.join(root, 'fake-cloudflared');
    await writeFile(executable, '#!/bin/sh\nprintf "https://paper2-local-fixture.trycloudflare.com\\n" >&2\nexec sleep 30\n');
    await chmod(executable, 0o700);
    process.env.PAPER2_CLOUDFLARED = executable;
    const controller = new AbortController();
    const tunnel = await startTunnel(4317, root, controller.signal);
    assert.equal(tunnel.url, 'https://paper2-local-fixture.trycloudflare.com');
    assert.equal(tunnel.alive(), true);
    controller.abort();
    for (let i = 0; i < 100 && tunnel.alive(); i++) await delay(10);
    assert.equal(tunnel.alive(), false);
    tunnel.close();
    const stopped = new AbortController(); stopped.abort();
    await assert.rejects(startTunnel(4317, root, stopped.signal));
    process.env.PAPER2_CLOUDFLARED = path.join(root, 'missing');
    await assert.rejects(startTunnel(4317, root), /Не найден cloudflared/);
  } finally {
    if (previous === undefined) delete process.env.PAPER2_CLOUDFLARED;
    else process.env.PAPER2_CLOUDFLARED = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('source PDF endpoint requires a session, keeps filesystem paths private and supports view links', async () => {
  await fixture(async ({ origin, view, calls }) => {
    const route = `${origin}/api/paper/b48535d5-ab40-4bd7-b294-f0904db64532`;
    assert.equal((await fetch(route)).status, 401);
    assert.equal((await fetch(`${origin}/api/paper/invalid`, { headers: auth(view) })).status, 400);
    const response = await fetch(route, { headers: auth(view) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/pdf');
    assert.equal(await response.text(), '%PDF-1.7\npaper fixture');
    assert.deepEqual(calls, [{ method: 'sourcePdfPath', args: ['b48535d5-ab40-4bd7-b294-f0904db64532'] }]);
  });
});
