import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { after } from 'node:test';
import { ModelRuntime, SessionManager, SettingsManager, convertToLlm, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createSnapCompactResources, privateSessionDirectory, SNAPCOMPACT_LIMITS, type SnapArchive } from '../src/integrations/snapcompact.js';
import { openPiSession, type PiSession } from '../src/integrations/pi-session.js';
import { converseWithPi } from '../src/integrations/pi.js';
import { Harness } from '../src/core/harness.js';
import { Store, defaultSettings } from '../src/core/store.js';
import { SpecSchema, type ExperimentRun } from '../src/shared/types.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'paper2 snapcompact tests '));
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
after(async () => {
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  await rm(root, { recursive: true, force: true });
});
const spec = SpecSchema.parse({ version: 1, title: 'Fixture', objective: 'Verify lifecycle', paperResult: 'Synthetic result',
  sourceRefs: [{ page: 1, quote: 'synthetic source' }], data: { description: 'synthetic', split: 'none', preprocessing: 'none' },
  method: 'fixture', baseline: 'none', parameters: { seed: 17 }, metric: { name: 'score', computation: 'score', publishedValue: null, comparable: false },
  requirements: { cpuCores: 1, ramGB: 1, gpu: false, vramGB: 0, diskGB: 1 }, limits: { timeSeconds: 120, maxHourlyUSD: 0, maxTotalUSD: 0 },
  implementation: 'independent', assumptions: [], missing: [], demo: null });
type ToolReply = { name: string; input: Record<string, unknown> };
type Reply = string | ToolReply[] | null;
interface Payload { messages: Array<{ content: string | Array<{ type: string; source?: { data: string; type: string; media_type: string } }> }> }

async function fixture(vision = true, sessionManager?: SessionManager) {
  const dir = await mkdtemp(path.join(root, 'session '));
  const requests: Payload[] = [];
  const replies: Reply[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      assert.equal(new URL(req.url!, 'http://localhost').pathname, '/v1/messages');
      let body = ''; for await (const chunk of req) body += chunk;
      requests.push(JSON.parse(body));
      const reply = replies.length ? replies.shift() : 'local fixture response';
      if (reply === null) return; // A real pending HTTP stream for abort/timeout tests.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (event: Record<string, unknown>) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      send({ type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant', model: 'claude-fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
      const blocks = typeof reply === 'string' ? [{ type: 'text', text: reply }] : (reply ?? []).map((tool, index) => ({ type: 'tool_use', id: `tool-${index}`, name: tool.name, input: tool.input }));
      blocks.forEach((block, index) => {
        send({ type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } });
        send({ type: 'content_block_delta', index, delta: 'text' in block ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
        send({ type: 'content_block_stop', index });
      });
      send({ type: 'message_delta', delta: { stop_reason: typeof reply === 'string' ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } });
      send({ type: 'message_stop' }); res.end();
    })().catch(error => { res.writeHead(500); res.end(String(error)); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, authPath: path.join(dir, 'auth.json'), modelsPath: null });
  runtime.registerProvider('snap-fixture', { baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'local-fixture-only', api: 'anthropic-messages',
    models: [{ id: 'claude-fixture', name: 'Local fixture', reasoning: false, input: vision ? ['text', 'image'] : ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1024 }] });
  const model = runtime.getModel('snap-fixture', 'claude-fixture'); assert.ok(model);
  const settingsManager = SettingsManager.inMemory({ compaction: { keepRecentTokens: 200, reserveTokens: 500 }, retry: { enabled: false } });
  const diagnostics: string[] = [];
  const resources = await createSnapCompactResources({ cwd: dir, agentDir: process.env.PI_CODING_AGENT_DIR!, settingsManager, diagnostic: message => { diagnostics.push(message); } });
  const manager = sessionManager ?? SessionManager.create(dir, privateSessionDirectory(path.join(dir, 'sessions')));
  const options = { cwd: dir, agentDir: process.env.PI_CODING_AGENT_DIR!, modelRuntime: runtime, model, settingsManager, sessionManager: manager, tools: [] };
  const sessions: PiSession[] = [];
  const open = async (bindings: Parameters<typeof openPiSession>[2] = { mode: 'print' }) => {
    const opened = await openPiSession(options, resources, bindings); sessions.push(opened); return opened;
  };
  const done = async () => {
    try { await Promise.all(sessions.map(session => session.close())); }
    finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  };
  return { dir, requests, replies, resources, manager, model, runtime, options, diagnostics, open, done };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function history(f: Fixture, opened: PiSession, turns = 10) {
  for (let i = 0; i < turns; i++) {
    f.manager.appendMessage({ role: 'user', content: `Turn ${i}: scientific conclusion; src/experiment.py config seed=17 error=verified. `.repeat(110), timestamp: Date.now() });
    f.manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: `Conclusion ${i}: preserve generated/artifact.csv and scientific parameters.` }], api: f.model.api, provider: f.model.provider, model: f.model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() });
    if (i === 0) {
      f.manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'scientific-check', name: 'bash', arguments: { command: 'npm test' } }], api: f.model.api, provider: f.model.provider, model: f.model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'toolUse', timestamp: Date.now() });
      f.manager.appendMessage({ role: 'toolResult', toolCallId: 'scientific-check', toolName: 'bash', content: [{ type: 'text', text: '1 passed; src/experiment.py; previous error resolved; artifact generated/artifact.csv' }], isError: false, timestamp: Date.now() });
    }
  }
  opened.session.refreshContext();
}
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Fixture did not reach provider'); await delay(10); }
}
const images = (messages: ReturnType<typeof convertToLlm>) => messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'image') : []);

test('real extension compacts to authenticated PNGs, reconstructs in order and sends them through Anthropic transport after restart', { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    assert.equal(f.resources.loader.getExtensions().extensions.length, 1);
    assert.match(f.resources.loader.getExtensions().extensions[0].path, /pi-snap-compact/);
    const opened = await f.open(); history(f, opened);
    const result = await opened.session.compact();
    const archive = f.resources.validateArchive(result.details as Record<string, unknown>, f.manager.getSessionDir());
    assert.ok(archive.frames.length > 0); assert.ok(archive.mac);
    assert.match(archive.text!, /src\/experiment.py/);
    assert.match(archive.text!, /generated\/artifact.csv/);
    assert.match(archive.text!, /npm test/); assert.match(archive.text!, /1 passed/);
    const rebuilt = convertToLlm(await opened.session.extensionRunner.emitContext(opened.session.messages));
    assert.deepEqual(images(rebuilt).map(image => `${createHash('sha256').update(Buffer.from(image.data, 'base64')).digest('hex')}.png`), archive.frames.map(frame => frame.file));
    const sessionFile = f.manager.getSessionFile()!;
    await opened.close();
    const manager = SessionManager.open(sessionFile);
    const resources = await createSnapCompactResources({ cwd: f.dir, agentDir: process.env.PI_CODING_AGENT_DIR!, settingsManager: f.options.settingsManager });
    const resumed = await openPiSession({ ...f.options, sessionManager: manager }, resources, { mode: 'print' });
    try {
      await resumed.session.prompt('Continue from the archived scientific conclusion.');
      resources.assertHealthy();
      const reply = resumed.session.messages.at(-1); assert.ok(reply?.role === 'assistant'); assert.equal(reply.stopReason, 'stop', reply.errorMessage);
      assert.equal(f.requests.length, 1, JSON.stringify(resumed.session.messages.at(-1)));
      const wireImages = f.requests[0].messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'image') : []);
      assert.equal(wireImages.length, archive.frames.length);
      assert.deepEqual(wireImages.map(block => `${createHash('sha256').update(Buffer.from(block.source!.data, 'base64')).digest('hex')}.png`), archive.frames.map(frame => frame.file));
      assert.ok(wireImages.every(block => block.source?.type === 'base64' && block.source.media_type === 'image/png'));
      assert.ok(f.diagnostics.some(message => /strategy=snapcompact.*frames=.*fallback=none/.test(message)));
    } finally { await resumed.close(); }
  } finally { await f.done(); }
});

test('successive compaction re-renders the accumulated source and removes only superseded PNGs', { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const opened = await f.open(); history(f, opened);
    const first = await opened.session.compact();
    const old = f.resources.validateArchive(first.details as Record<string, unknown>, f.manager.getSessionDir());
    history(f, opened, 4);
    const second = await opened.session.compact();
    const archive = f.resources.validateArchive(second.details as Record<string, unknown>, f.manager.getSessionDir());
    assert.ok(archive.totalChars > old.totalChars); assert.match(archive.text!, /npm test/); assert.match(archive.text!, /Turn 9/);
    assert.notEqual(archive.framesDir, old.framesDir);
    assert.ok(!(await readdir(f.manager.getSessionDir())).includes(old.framesDir!));
    assert.equal(images(convertToLlm(await opened.session.extensionRunner.emitContext(opened.session.messages))).length, archive.frames.length);
    opened.assertHealthy(); assert.equal(f.requests.length, 0);
  } finally { await f.done(); }
});

test('non-vision model and inMemory session are explicit blockers', async () => {
  const f = await fixture(false);
  try {
    await assert.rejects(f.open(), /vision/);
    await assert.rejects(openPiSession({ ...f.options, sessionManager: SessionManager.inMemory(f.dir) }, f.resources, { mode: 'print' }), /persisted/);
    assert.equal(f.requests.length, 0);
  } finally { await f.done(); }
});

for (const fault of ['corrupt-png', 'missing-frame', 'missing-archive', 'tampered-hmac', 'payload-budget', 'traversal'] as const) {
  test(`archive failure ${fault} blocks the provider and retains the original session`, { timeout: 30000 }, async () => {
    const f = await fixture();
    try {
      const opened = await f.open(); history(f, opened);
      const result = await opened.session.compact();
      const archive = (result.details as { snapcompact: SnapArchive }).snapcompact;
      if (fault === 'corrupt-png') await writeFile(path.join(f.manager.getSessionDir(), archive.framesDir!, archive.frames[0].file!), 'corrupted');
      if (fault === 'missing-frame') await rm(path.join(f.manager.getSessionDir(), archive.framesDir!, archive.frames[0].file!));
      if (fault === 'tampered-hmac') archive.text = 'injected archive';
      if (fault === 'missing-archive') {
        const entry = f.manager.getBranch().findLast(entry => entry.type === 'compaction');
        assert.ok(entry?.type === 'compaction'); entry.details = undefined;
      }
      if (fault === 'payload-budget') {
        await mkdir(path.join(f.dir, '.pi')); await writeFile(path.join(f.dir, '.pi/settings.json'), JSON.stringify({ snapcompact: { maxFrameBytes: 1 } }));
      }
      if (fault === 'traversal') archive.framesDir = '../escape';
      await opened.session.prompt('This request must not reach the provider.').catch(() => undefined);
      assert.throws(f.resources.assertHealthy, /SnapCompact|ENOENT/);
      assert.equal(f.requests.length, 0);
      assert.match(await readFile(f.manager.getSessionFile()!, 'utf8'), /scientific conclusion/);
    } finally { await f.done(); }
  });
}

test('source limits and an unwritable archive destination cancel compaction without native text fallback', { timeout: 30000 }, async () => {
  for (const fault of ['limit', 'directory'] as const) {
    const f = await fixture();
    try {
      const opened = await f.open(); history(f, opened, fault === 'limit' ? 40 : 10);
      if (fault === 'directory') {
        // Cross-platform: a regular file in place of a directory, independent of root/ACL semantics.
        const sessionDir = f.manager.getSessionDir();
        await rm(sessionDir, { recursive: true }); await writeFile(sessionDir, 'not a directory');
      }
      await assert.rejects(opened.session.compact());
      assert.throws(f.resources.assertHealthy);
      assert.equal(f.requests.length, 0);
      if (fault === 'limit') assert.ok(f.diagnostics.some(message => /лимит|сериализация/.test(message)));
      if (fault === 'directory') { await rm(f.manager.getSessionDir()); await mkdir(f.manager.getSessionDir()); }
    } finally { await f.done(); }
  }
});

test('normal, repeated and concurrent close await shutdown before native lifetime invalidation', { timeout: 15000 }, async () => {
  const f = await fixture();
  let release = () => {};
  try {
    let shutdowns = 0; let ctx: ExtensionContext | undefined;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    f.resources.loader.getExtensions().extensions[0].handlers.get('session_shutdown')!.push(async (...args: unknown[]) => {
      shutdowns++; ctx = args[1] as ExtensionContext; await barrier; assert.equal(ctx.isIdle(), true);
    });
    const opened = await f.open();
    const first = opened.close(), second = opened.close(); assert.equal(first, second);
    await waitFor(() => shutdowns === 1); assert.equal(ctx!.isIdle(), true);
    release(); await first; await opened.close();
    await delay(80);
    assert.equal(shutdowns, 1); assert.throws(() => ctx!.isIdle(), /stale/);
    assert.equal(f.requests.length, 0);
  } finally { release(); await f.done(); }
});

test('partial native bind failure still runs extension shutdown and invalidates its native ctx', async () => {
  const f = await fixture();
  try {
    let ctx: ExtensionContext | undefined; let shutdowns = 0;
    const ext = f.resources.loader.getExtensions().extensions[0];
    ext.handlers.get('session_start')!.push(async (...args: unknown[]) => { ctx = args[1] as ExtensionContext; throw new Error('synthetic startup input failure'); });
    ext.handlers.get('session_shutdown')!.push(async () => { shutdowns++; assert.equal(ctx!.isIdle(), true); });
    await assert.rejects(f.open({ mode: 'print', onError: () => { throw new Error('host binding failure'); } }), /host binding failure/);
    assert.equal(shutdowns, 1); assert.throws(() => ctx!.isIdle(), /stale/);
  } finally { await f.done(); }
});

test('request image budgets and disabled extension reject explicitly', async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.resources.validateRequest([{ role: 'user', content: Array.from({ length: SNAPCOMPACT_LIMITS.frames + 1 }, () => ({ type: 'image' as const, data: 'AA==', mimeType: 'image/png' })), timestamp: Date.now() }]), /лимит изображений/);
    await mkdir(path.join(f.dir, '.pi')); await writeFile(path.join(f.dir, '.pi/settings.json'), JSON.stringify({ snapcompact: { enabled: false } }));
    await assert.rejects(f.open(), /отключение/);
    assert.equal(f.requests.length, 0);
  } finally { await f.done(); }
});

test('bind and shutdown errors remain observable together without an unhandled rejection', async () => {
  const f = await fixture();
  try {
    let ctx: ExtensionContext | undefined;
    const ext = f.resources.loader.getExtensions().extensions[0];
    ext.handlers.get('session_start')!.push(async (...args: unknown[]) => { ctx = args[1] as ExtensionContext; throw new Error('bind input'); });
    ext.handlers.get('session_shutdown')!.push(async () => { throw new Error('shutdown input'); });
    await assert.rejects(f.open({ mode: 'print', onError: event => { throw new Error(event.error); } }), error => {
      assert.ok(error instanceof AggregateError); assert.match(String(error.errors[0]), /bind input/); assert.match(String(error.errors[1]), /завершения/); return true;
    });
    assert.throws(() => ctx!.isIdle(), /stale/);
  } finally { await f.done(); }
});

for (const reason of ['cancellation', 'timeout', 'process shutdown'] as const) {
  test(`${reason} settles a real active SDK request before shutdown`, { timeout: 15000 }, async () => {
    const f = await fixture();
    try {
      let ctx: ExtensionContext | undefined;
      f.resources.loader.getExtensions().extensions[0].handlers.get('session_shutdown')!.push(async (...args: unknown[]) => { ctx = args[1] as ExtensionContext; assert.equal(ctx.isIdle(), true); });
      const opened = await f.open(); f.replies.push(null);
      const running = opened.session.prompt('Wait for cancellation').catch(() => undefined);
      await waitFor(() => f.requests.length === 1);
      if (reason === 'timeout') {
        const signal = AbortSignal.timeout(40);
        await new Promise<void>(resolve => signal.addEventListener('abort', () => { void opened.close().then(resolve); }, { once: true }));
      } else await opened.close();
      await running; assert.throws(() => ctx!.isIdle(), /stale/);
      assert.equal(f.requests.length, 1);
    } finally { await f.done(); }
  });
}

test('explicit harness contract handoff resumes, but unknown native compactions fail closed', async () => {
  const f = await fixture();
  try {
    f.manager.appendCompaction('Research tool contract handoff; original transcript remains on disk.', null, 0, { reason: 'harness_context_upgrade', contextVersion: 3 });
    const opened = await f.open();
    await opened.session.prompt('Continue the existing research.');
    opened.assertHealthy();
    assert.equal(f.requests.length, 1);
  } finally { await f.done(); }
  const invalid = await fixture();
  try {
    invalid.manager.appendCompaction('An unauthenticated replacement summary.', null, 0, { reason: 'native' });
    const opened = await invalid.open();
    await opened.session.prompt('Do not infer with a foreign archive.').catch(() => undefined);
    assert.throws(opened.assertHealthy, /архив отсутствует/);
    assert.equal(invalid.requests.length, 0);
  } finally { await invalid.done(); }
});

test('continuing conversation retains approved tools, frozen plan, results and one persisted session', { timeout: 30000 }, async t => {
  const f = await fixture();
  try {
    // Only model discovery/auth is supplied externally; lifecycle and HTTP provider encoding are native.
    t.mock.method(ModelRuntime, 'create', async () => f.runtime);
    const projectDir = path.join(f.dir, 'project'); await mkdir(projectDir);
    const run = { id: '00000000-0000-4000-8000-000000000001', dir: f.dir, title: 'Fixture', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'ready', planVersion: 1, approvedPlanVersion: 1, attempts: 0,
      input: { agentMode: 'pi', source: 'fixture', task: 'synthetic experiment', mode: 'local', timeSeconds: 120, maxHourlyUSD: 0, maxTotalUSD: 0, cleanup: 'destroy' },
      source: { original: 'fixture.pdf', textPath: 'fixture.txt', sha256: 'fixture', pages: [{ page: 1, text: 'synthetic source' }] }, spec, artifacts: [], metrics: { score: 1 }, verification: 'Fixture result retained' } as ExperimentRun;
    const context = { run, projectDir, queued: [], settings: { ...defaultSettings, piProvider: 'snap-fixture', piModel: 'claude-fixture' }, signal: new AbortController().signal, emit: async () => {},
      persist: async (patch: Partial<ExperimentRun>) => { Object.assign(run, patch); }, publish: () => {}, attach: () => {}, acknowledge: async () => {} };
    const hooks = { propose: async (proposal: typeof spec) => proposal, execute: async () => ({ metrics: run.metrics, verification: run.verification }) };
    f.replies.push([{ name: 'get_experiment', input: {} }], 'The approved protocol is ready.');
    await converseWithPi(context, 'Review the approved experiment.', hooks);
    const sessionFile = run.sessionFile; assert.ok(sessionFile);
    await writeFile(path.join(projectDir, 'plan.json'), JSON.stringify(spec));
    const files = { 'experiment.json': JSON.stringify({ entryPoint: 'main.py', config: 'config.json', requirements: 'requirements.txt', artifacts: ['metrics.json'] }), 'config.json': JSON.stringify(spec.parameters), 'main.py': 'print("fixture")\n', 'requirements.txt': '# standard library only\n' };
    f.replies.push(Object.entries(files).map(([file, content]) => ({ name: 'write', input: { path: file, content } })), 'Project files created.');
    await converseWithPi(context, 'Create the approved implementation.', hooks);
    f.replies.push([{ name: 'run_experiment', input: {} }], 'Scientific report: the fixture measured score=1. The preserved configuration uses seed=17. This local response makes no scientific equivalence claim.');
    assert.match(await converseWithPi(context, 'Run the approved experiment and report.', hooks), /score=1/);
    assert.deepEqual(JSON.parse(await readFile(path.join(projectDir, 'plan.json'), 'utf8')), spec);
    assert.deepEqual(run.metrics, { score: 1 });
    assert.equal(run.sessionFile, sessionFile);
    assert.equal((await readdir(path.join(f.dir, 'session'))).filter(file => file.endsWith('.jsonl')).length, 1);
    assert.equal(f.requests.length, 6);
  } finally { t.mock.restoreAll(); await f.done(); }
});

test('Harness.shutdown cancels real Pi conversation and preserves its session and approved plan', { timeout: 15000 }, async t => {
  const f = await fixture();
  try {
    t.mock.method(ModelRuntime, 'create', async () => f.runtime);
    const store = new Store(path.join(f.dir, 'research')); const harness = new Harness(store); await harness.initialize();
    await store.saveSettings({ ...store.settings, piProvider: 'snap-fixture', piModel: 'claude-fixture' });
    const run = await harness.create({ agentMode: 'pi', source: 'synthetic', task: 'cancel a synthetic experiment', mode: 'local', timeSeconds: 120, maxHourlyUSD: 0, maxTotalUSD: 0, cleanup: 'destroy' });
    await store.patch(run.id, { status: 'ready', spec, planVersion: 1, approvedPlanVersion: 1, source: { original: 'fixture.pdf', textPath: 'fixture.txt', pages: [{ page: 1, text: 'synthetic source' }], sha256: 'fixture' } });
    f.replies.push(null); await harness.sendMessage(run.id, 'Continue the experiment discussion.');
    await waitFor(() => f.requests.length === 1);
    await harness.shutdown();
    assert.equal(store.get(run.id).status, 'cancelled');
    const reopened = new Store(store.root); await reopened.load();
    assert.equal(reopened.get(run.id).status, 'cancelled'); assert.deepEqual(reopened.get(run.id).spec, spec);
    assert.ok(reopened.get(run.id).sessionFile);
    assert.equal(reopened.get(run.id).approvedPlanVersion, 1);
  } finally { t.mock.restoreAll(); await f.done(); }
});
