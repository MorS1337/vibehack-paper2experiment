import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { transcribe, whisperStatus } from '../src/integrations/whisper.js';
import { encodePcm16Wav } from '../src/renderer/lib/recorder.js';
import { Harness } from '../src/core/harness.js';
import { Store, defaultSettings } from '../src/core/store.js';

const wav = () => new Uint8Array(encodePcm16Wav(new Float32Array(8000).fill(0.25)));
async function fixture(t: { after(fn: () => Promise<void>): void }, body: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p2e-whisper-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = path.join(dir, 'whisper-cli');
  const model = path.join(dir, 'ggml-base.bin');
  const marker = path.join(dir, 'invocation.txt');
  await writeFile(model, 'test model; fake cli only');
  // POSIX shell, not the host runtime: this fixture must behave the same under Node or Electron.
  await writeFile(binary, [
    '#!/bin/sh',
    'if [ "$1" = "--help" ]; then echo "test CLI"; exit 0; fi',
    'wav=""',
    'prev=""',
    'for argument in "$@"; do',
    '  if [ "$prev" = "-f" ]; then wav="$argument"; fi',
    '  prev="$argument"',
    'done',
    `{ echo "$$"; echo "$wav"; for argument in "$@"; do printf '%s\\037' "$argument"; done; echo; } > ${JSON.stringify(marker)}`,
    body
  ].join('\n') + '\n', { mode: 0o700 });
  return { dir, marker, settings: { ...defaultSettings, whisperBinary: binary, whisperModel: model } };
}
async function invocation(marker: string): Promise<{ args: string[]; pid: number; wav: string }> {
  for (let i=0;i<200;i++) {
    try {
      const [pid, wav, args] = (await readFile(marker,'utf8')).split('\n');
      return { pid: Number(pid), wav, args: args.split('\x1f').filter(Boolean) };
    } catch { await new Promise(resolve=>setTimeout(resolve,10)); }
  }
  throw new Error('CLI did not start');
}

test('real subprocess receives Russian flags and PCM WAV; transcript is normalized and temp audio removed', async t => {
  const f = await fixture(t, "printf '  Проверить границу\\nХёффдинга  \\n'");
  assert.equal((await whisperStatus(f.settings)).state, 'ready');
  assert.equal(await transcribe(wav(), f.settings), 'Проверить границу Хёффдинга');
  const run = await invocation(f.marker);
  assert.deepEqual(run.args.slice(0,4), ['-l','ru','-m',f.settings.whisperModel]);
  await assert.rejects(stat(path.dirname(run.wav)), { code: 'ENOENT' });
});

test('missing binary/model and English-only models fail explicitly', async t => {
  const f = await fixture(t, ": 'unused'");
  for (const [settings, expected] of [
    [{...f.settings,whisperBinary:path.join(f.dir,'absent')}, /Бинарник.*не найден/],
    [{...f.settings,whisperModel:''}, /Модель.*не выбрана/],
    [{...f.settings,whisperModel:path.join(f.dir,'absent.bin')}, /не найден/],
    [{...f.settings,whisperModel:path.join(f.dir,'ggml-base.en.bin')}, /англоязычная/]
  ] as const) {
    assert.equal((await whisperStatus(settings)).state, 'needs_setup');
    await assert.rejects(transcribe(wav(), settings), expected);
  }
});

test('invalid WAV and recordings over 60s are rejected before a CLI is launched', async () => {
  for (const audio of [new Uint8Array(0), new Uint8Array(44), new Uint8Array(encodePcm16Wav(new Float32Array(16000*61)))]) {
    await assert.rejects(transcribe(audio, defaultSettings), /Аудио|WAV/);
  }
  const malformed = wav();
  new DataView(malformed.buffer).setUint16(22, 2, true);
  await assert.rejects(transcribe(malformed, defaultSettings), /моно/);
  const truncated = wav().subarray(0, 100);
  await assert.rejects(transcribe(truncated, defaultSettings), /RIFF/);
});

test('CLI failure and blank audio clean up WAV and never return a fake transcript', async t => {
  for (const body of ["printf '[BLANK_AUDIO]\\n'", "printf 'model load failed\\n' >&2; exit 2"]) {
    const f = await fixture(t, body);
    await assert.rejects(transcribe(wav(), f.settings), /не распознал|кодом 2.*model load failed/);
    const run = await invocation(f.marker);
    await assert.rejects(stat(path.dirname(run.wav)), { code:'ENOENT' });
  }
});

test('matching cancel and harness shutdown kill the real CLI and await temp cleanup; stale cancel cannot stop a newer request', async t => {
  for (const mode of ['cancel', 'shutdown']) {
    const f = await fixture(t, 'while :; do sleep 1; done');
    const harness = new Harness(new Store(path.join(f.dir, 'state')));
    harness.store.settings = f.settings;
    const id = crypto.randomUUID();
    const pending = harness.transcribe(wav().buffer as ArrayBuffer, id);
    const rejection = assert.rejects(pending, /отменена/);
    const run = await invocation(f.marker);
    await harness.cancelTranscription(crypto.randomUUID());
    process.kill(run.pid, 0);
    if (mode === 'cancel') await harness.cancelTranscription(id); else await harness.shutdown();
    await rejection;
    assert.throws(() => process.kill(run.pid, 0), { code:'ESRCH' });
    await assert.rejects(stat(path.dirname(run.wav)), { code:'ENOENT' });
  }
});

test('hung CLI is killed at the 30s minimum timeout and its WAV directory is removed', { timeout: 40_000 }, async t => {
  const f = await fixture(t, 'while :; do sleep 1; done');
  const pending = transcribe(wav(), f.settings);
  const rejection = assert.rejects(pending, /не завершился за 30 с/);
  const run = await invocation(f.marker);
  await rejection;
  assert.throws(() => process.kill(run.pid, 0), { code:'ESRCH' });
  await assert.rejects(stat(path.dirname(run.wav)), { code:'ENOENT' });
});
