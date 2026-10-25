import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceTask, type VoiceCapture } from '../src/renderer/lib/voice-task.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(options: { permission?: Promise<void>; capture?: (signal: AbortSignal) => Promise<VoiceCapture>; result?: Promise<string>; timeout?: number } = {}) {
  const appended: string[] = [];
  const calls: string[] = [];
  let disposed = 0;
  const capture: VoiceCapture = { device: 'Physical test mic', dispose() { disposed++; }, async stop() { calls.push('flush'); return new ArrayBuffer(44); } };
  const task = new VoiceTask({
    requestMicrophoneAccess: () => options.permission ?? Promise.resolve(),
    transcribe: async (_wav, id) => { calls.push(`transcribe:${id}`); return options.result ?? 'Проверить границу Хёффдинга'; },
    cancelTranscription: async id => { calls.push(`cancel:${id}`); }
  }, options.capture ?? (async () => capture), () => {}, text => appended.push(text), options.timeout ?? 1000);
  return { task, appended, calls, capture, get disposed() { return disposed; } };
}

test('start → stop → flush → transcript; repeated start and stop do not duplicate transcription', async () => {
  const s = setup();
  await s.task.start();
  assert.equal(s.task.state.phase, 'recording');
  assert.equal(s.task.state.device, 'Physical test mic');
  await s.task.start();
  await Promise.all([s.task.stop(), s.task.stop()]);
  assert.deepEqual(s.appended, ['Проверить границу Хёффдинга']);
  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[0], 'flush');
  assert.equal(s.task.state.phase, 'idle');
  assert.equal(s.disposed, 1);
});

test('permission denial is actionable; a stalled OS prompt times out and can be retried', async () => {
  const denied = setup({ permission: Promise.reject(new DOMException('denied', 'NotAllowedError')) });
  await denied.task.start();
  assert.match(denied.task.state.error!, /Доступ.*запрещён.*Микрофон/);
  const permission = Promise.withResolvers<void>();
  const s = setup({ permission: permission.promise, timeout: 10 });
  await s.task.start();
  assert.equal(s.task.state.phase, 'idle');
  assert.match(s.task.state.error!, /за 0.01 с/);
  permission.resolve();
  await s.task.start();
  assert.equal(s.task.state.phase, 'recording');
  s.task.cancel();
});

test('cancel/unmount while requesting disposes late capture without reviving the old operation', async () => {
  const pending = Promise.withResolvers<VoiceCapture>();
  const s = setup({ capture: () => pending.promise });
  const starting = s.task.start();
  await tick();
  s.task.cancel();
  await starting;
  assert.equal(s.task.state.phase, 'idle');
  pending.resolve(s.capture);
  await tick();
  assert.equal(s.disposed, 1);
  assert.equal(s.task.state.phase, 'idle');
  assert.deepEqual(s.appended, []);
});

test('cancelled OS prompt never starts capture after a later permission grant', async () => {
  const permission = Promise.withResolvers<void>();
  let captures = 0;
  const s = setup({ permission: permission.promise, capture: async () => { captures++; return s.capture; } });
  const starting = s.task.start();
  s.task.cancel();
  await starting;
  permission.resolve();
  await tick();
  assert.equal(captures, 0);
});

test('cancel during flush prevents IPC; cancel during transcription sends matching id and ignores late text', async () => {
  const flushed = Promise.withResolvers<ArrayBuffer>();
  const s = setup();
  s.capture.stop = () => flushed.promise;
  await s.task.start();
  const stopping = s.task.stop();
  s.task.cancel();
  flushed.resolve(new ArrayBuffer(44));
  await stopping;
  assert.deepEqual(s.calls, []);
  const result = Promise.withResolvers<string>();
  const t = setup({ result: result.promise });
  await t.task.start();
  const transcribing = t.task.stop();
  await tick();
  t.task.cancel();
  assert.equal(t.calls[2], t.calls[1].replace('transcribe:', 'cancel:'));
  await t.task.start();
  result.resolve('late');
  await transcribing;
  assert.equal(t.task.state.phase, 'recording');
  assert.deepEqual(t.appended, []);
  t.task.cancel();
});

test('60 second limit calls stop once and releases recording resources', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const s = setup();
  await s.task.start();
  t.mock.timers.tick(60_000);
  await tick();
  assert.equal(s.task.state.phase, 'idle');
  assert.equal(s.calls.filter(call => call.startsWith('transcribe:')).length, 1);
  assert.equal(s.disposed, 1);
});

test('empty speech and backend errors leave editable task untouched', async () => {
  for (const result of [Promise.resolve(''), Promise.reject(new Error('Модель .en не подходит'))]) {
    // Attach a handler before the capture awaits permission.
    result.catch(() => {});
    const s = setup({ result });
    await s.task.start();
    await s.task.stop();
    assert.equal(s.task.state.phase, 'idle');
    assert.ok(s.task.state.error);
    assert.deepEqual(s.appended, []);
    assert.equal(s.disposed, 1);
  }
});
