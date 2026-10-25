import test from 'node:test';
import assert from 'node:assert/strict';
import { captureMicrophone } from '../src/renderer/lib/microphone.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function replaceGlobal(t: { after(fn: () => void): void }, name: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name); });
}
function fakeStream() {
  let stopped = false;
  const track = { stop() { stopped = true; }, onended: null, label:'test physical mic' };
  const stream = { getTracks:()=>[track], getAudioTracks:()=>[track] } as unknown as MediaStream;
  return { stream, get stopped() { return stopped; } };
}

test('late getUserMedia stream is stopped after cancel; no AudioContext is created', async t => {
  const permission = Promise.withResolvers<MediaStream>();
  replaceGlobal(t, 'navigator', { mediaDevices: { getUserMedia:()=>permission.promise } });
  const controller = new AbortController();
  const pending = captureMicrophone(controller.signal, () => {});
  const rejection = assert.rejects(pending, { name:'AbortError' });
  controller.abort();
  await rejection;
  const physical = fakeStream();
  permission.resolve(physical.stream);
  await tick();
  assert.equal(physical.stopped, true);
});

test('cancel during AudioContext.resume closes context and stops physical tracks', async t => {
  const physical = fakeStream();
  const resume = Promise.withResolvers<void>();
  let closed = false;
  replaceGlobal(t, 'navigator', { mediaDevices:{ getUserMedia:async()=>physical.stream } });
  replaceGlobal(t, 'AudioContext', class {
    resume=()=>resume.promise;
    async close() { closed = true; }
  });
  const controller = new AbortController();
  const pending = captureMicrophone(controller.signal, () => {});
  const rejection = assert.rejects(pending, { name:'AbortError' });
  await tick();
  controller.abort();
  await rejection;
  assert.equal(physical.stopped, true);
  assert.equal(closed, true);
  resume.resolve();
});
