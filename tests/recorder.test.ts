import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { encodePcm16Wav, resampleTo16k } from '../src/renderer/lib/recorder.js';

test('48/44.1 kHz capture becomes mono PCM16 at 16 kHz with clipping', () => {
  for (const rate of [48000, 44100, 16000, 8000]) {
    const input = new Float32Array(rate).fill(0.5);
    const output = resampleTo16k(input, rate);
    assert.equal(output.length, 16000);
    assert.ok(output.every(value => Math.abs(value - 0.5) < 0.00001));
    const wav = new DataView(encodePcm16Wav(output));
    assert.equal(wav.getUint32(24, true), 16000);
    assert.equal(wav.getUint16(22, true), 1);
    assert.equal(wav.getUint16(34, true), 16);
    assert.equal(wav.getUint32(40, true), 32000);
  }
  const clipped = new DataView(encodePcm16Wav(new Float32Array([-2, 2])));
  assert.equal(clipped.getInt16(44, true), -32768);
  assert.equal(clipped.getInt16(46, true), 32767);
});

test('actual worklet downmixes and flushes every frame including the final partial block once', async () => {
  let Processor: any;
  const messages: any[] = [];
  const source = await readFile(new URL('../public/capture-worklet.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    AudioWorkletProcessor: class { port = { onmessage: undefined, postMessage: (data: any) => messages.push(data) }; },
    registerProcessor(name: string, constructor: any) { assert.equal(name, 'paper2-capture'); Processor = constructor; }
  });
  const processor = new Processor();
  for (let i = 0; i < 17; i++) processor.process([[new Float32Array(128).fill(0.2), new Float32Array(128).fill(0.6)]]);
  processor.port.onmessage({ data: 'flush' });
  processor.port.onmessage({ data: 'flush' });
  assert.equal(messages.filter(m => m.flushed).length, 1);
  const chunks = messages.filter(m => m.samples).map(m => m.samples as Float32Array);
  assert.equal(chunks.reduce((n, chunk) => n + chunk.length, 0), 2176);
  assert.ok(chunks.every(chunk => chunk.every(sample => Math.abs(sample - 0.4) < 0.00001)));
  assert.equal(processor.process([[new Float32Array(128)]]), false);
});
