import { spawn, spawnSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppSettings, ConnectionStatus } from '../shared/types.js';

const SAMPLE_RATE = 16_000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const MAX_SECONDS = 120;
const MAX_AUDIO_BYTES = MAX_SECONDS * SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8);
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  const factory = Promise as PromiseConstructor & {
    withResolvers<R>(): { promise: Promise<R>; resolve: (value: R | PromiseLike<R>) => void; reject: (reason?: unknown) => void };
  };
  return factory.withResolvers<T>();
}

interface WavInfo {
  durationSeconds: number;
  dataBytes: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

function readAscii(view: DataView, offset: number, length: number): string {
  let result = '';
  for (let index = 0; index < length; index += 1) result += String.fromCharCode(view.getUint8(offset + index));
  return result;
}

/** Parses arbitrary RIFF chunk order and padding; a canonical 44-byte header is not assumed. */
function inspectWav(audio: Uint8Array): WavInfo {
  if (audio.byteLength < 12) throw new Error('WAV: файл короче заголовка RIFF');
  if (audio.byteLength > 64 * 1024 * 1024) throw new Error('WAV: файл слишком большой для короткой диктовки');
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  if (readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') throw new Error('WAV: ожидается RIFF/WAVE');
  let format: number | undefined;
  let channels: number | undefined;
  let sampleRate: number | undefined;
  let bitsPerSample: number | undefined;
  let blockAlign: number | undefined;
  let dataBytes: number | undefined;
  let offset = 12;
  while (offset + 8 <= audio.byteLength) {
    const id = readAscii(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const payload = offset + 8;
    if (payload + size > audio.byteLength) throw new Error(`WAV: chunk ${id.trim() || '?'} обрезан`);
    if (id === 'fmt ') {
      if (size < 16) throw new Error('WAV: некорректный fmt chunk');
      format = view.getUint16(payload, true);
      channels = view.getUint16(payload + 2, true);
      sampleRate = view.getUint32(payload + 4, true);
      blockAlign = view.getUint16(payload + 12, true);
      bitsPerSample = view.getUint16(payload + 14, true);
    } else if (id === 'data') {
      dataBytes = size;
    }
    offset = payload + size + (size % 2);
  }
  if (format === undefined || channels === undefined || sampleRate === undefined || bitsPerSample === undefined || dataBytes === undefined) {
    throw new Error('WAV: отсутствует fmt или data chunk');
  }
  if (format !== 1) throw new Error(`WAV: ожидается PCM (format 1), получено ${format}`);
  if (channels !== CHANNELS) throw new Error(`WAV: ожидается моно (1 канал), получено ${channels}`);
  if (sampleRate !== SAMPLE_RATE) throw new Error(`WAV: ожидается ${SAMPLE_RATE} Гц, получено ${sampleRate}`);
  if (bitsPerSample !== BITS_PER_SAMPLE) throw new Error(`WAV: ожидается PCM16, получено ${bitsPerSample} бит`);
  if (blockAlign !== CHANNELS * (BITS_PER_SAMPLE / 8)) throw new Error('WAV: некорректный blockAlign');
  if (!Number.isSafeInteger(dataBytes) || dataBytes <= 0 || dataBytes % 2 !== 0) throw new Error('WAV: пустой или некорректный data chunk');
  if (dataBytes > MAX_AUDIO_BYTES) throw new Error(`WAV: диктовка длиннее ${MAX_SECONDS} с`);
  const durationSeconds = dataBytes / (SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8));
  if (durationSeconds < 0.2) throw new Error('WAV: слишком короткая запись (меньше 0,2 с)');
  return { durationSeconds, dataBytes, sampleRate, channels, bitsPerSample };
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith(`~${path.sep}`) || value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

async function executableFile(candidate: string): Promise<string | undefined> {
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return undefined;
    await access(candidate, fsConstants.X_OK);
    return candidate;
  } catch {
    return undefined;
  }
}

async function findBinary(settings: AppSettings): Promise<string | undefined> {
  const directories = [...(process.env.PATH ?? '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean);
  const configured = settings.whisperBinary.trim();
  if (configured) {
    const expanded = expandHome(configured);
    if (expanded.includes('/') || expanded.includes('\\')) return executableFile(path.resolve(expanded));
    for (const directory of directories) {
      const found = await executableFile(path.join(directory, expanded));
      if (found) return found;
    }
    return undefined;
  }
  for (const name of ['whisper-cli', 'whisper-cpp']) {
    for (const directory of directories) {
      const found = await executableFile(path.join(directory, name));
      if (found) return found;
    }
  }
  return undefined;
}

async function findModel(settings: AppSettings): Promise<{ file?: string; problem?: string }> {
  const configured = settings.whisperModel.trim();
  if (!configured) return { problem: 'Модель whisper не выбрана. Укажите многоязычную ggml-модель, например ggml-base.bin (не .en).' };
  const file = path.resolve(expandHome(configured));
  const base = path.basename(file);
  if (/\.en(?:\.|$)/i.test(base)) return { problem: `Модель ${base} — англоязычная (.en), а диктовка идёт на русском. Выберите многоязычную модель без .en.` };
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size === 0) return { problem: `Модель whisper не является непустым файлом: ${file}` };
  } catch {
    return { problem: `Файл модели whisper не найден: ${file}` };
  }
  return { file };
}

export async function whisperStatus(settings: AppSettings): Promise<ConnectionStatus> {
  const binary = await findBinary(settings);
  if (!binary) {
    return {
      component: 'whisper',
      state: 'needs_setup',
      detail: `Бинарник whisper не найден (${settings.whisperBinary || 'whisper-cli'}). Установите whisper.cpp или укажите путь к whisper-cli в настройках.`
    };
  }
  const version = spawnSync(binary, ['--help'], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? os.homedir(),
      TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
      LANG: process.env.LANG ?? 'C.UTF-8',
      DYLD_LIBRARY_PATH: process.env.DYLD_LIBRARY_PATH ?? '',
      DYLD_FALLBACK_LIBRARY_PATH: process.env.DYLD_FALLBACK_LIBRARY_PATH ?? '',
      LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH ?? ''
    }
  });
  if (version.error) return { component: 'whisper', state: 'error', detail: `Не удалось запустить ${binary}: ${version.error.message}` };
  if (version.status !== 0) {
    const output = `${version.stdout ?? ''}\n${version.stderr ?? ''}`.trim();
    return { component: 'whisper', state: 'error', detail: `${binary} --help завершился с кодом ${version.status}${output ? `: ${output.slice(-400)}` : ''}` };
  }
  const model = await findModel(settings);
  if (!model.file) return { component: 'whisper', state: 'needs_setup', detail: model.problem ?? 'Модель whisper не готова.' };
  return {
    component: 'whisper',
    state: 'ready',
    detail: `whisper.cpp: ${binary}; многоязычная модель: ${path.basename(model.file)}; язык распознавания: ru; аудио обрабатывается локально.`
  };
}

interface WhisperRun {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

export async function transcribe(audio: Uint8Array, settings: AppSettings, signal?: AbortSignal): Promise<string> {
  if (!(audio instanceof Uint8Array) || audio.byteLength === 0) throw new Error('Аудио не получено.');
  const wav = inspectWav(audio);
  const status = await whisperStatus(settings);
  if (status.state !== 'ready') throw new Error(status.detail);
  const binary = await findBinary(settings);
  const model = await findModel(settings);
  if (!binary || !model.file) throw new Error('whisper не готов: проверьте бинарник и многоязычную модель.');
  signal?.throwIfAborted();

  const directory = await mkdtemp(path.join(os.tmpdir(), 'paper2experiment-whisper-'));
  const wavPath = path.join(directory, 'dictation.wav');
  try {
    await writeFile(wavPath, audio, { mode: 0o600 });
    signal?.throwIfAborted();
    const child = spawn(binary, ['-l', 'ru', '-m', model.file, '-f', wavPath, '-nt', '-np'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? os.homedir(),
        TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
        LANG: process.env.LANG ?? 'C.UTF-8',
        DYLD_LIBRARY_PATH: process.env.DYLD_LIBRARY_PATH ?? '',
        DYLD_FALLBACK_LIBRARY_PATH: process.env.DYLD_FALLBACK_LIBRARY_PATH ?? '',
        LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH ?? ''
      }
    });
    let stdout = '';
    let stderr = '';
    const append = (current: string, chunk: Buffer): string => (current.length >= MAX_CAPTURE_BYTES ? current : current + chunk.toString().slice(0, MAX_CAPTURE_BYTES - current.length));
    child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const finished = deferred<WhisperRun>();
    let timedOut = false;
    const timeoutMs = Math.min(180_000, Math.max(30_000, Math.round(wav.durationSeconds * 4_000)));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.once('close', (code, termination) => finished.resolve({ stdout, stderr, code, signal: termination, timedOut }));
    child.once('error', error => finished.reject(error));
    if (signal?.aborted) onAbort();
    let run: WhisperRun;
    try {
      run = await finished.promise;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    if (signal?.aborted) throw new Error('Расшифровка отменена.');
    if (run.timedOut) throw new Error(`whisper-cli не завершился за ${Math.round(timeoutMs / 1000)} с.`);
    if (run.code !== 0) {
      const detail = run.stderr.trim() || run.stdout.trim() || `сигнал ${run.signal ?? 'неизвестен'}`;
      throw new Error(`whisper-cli завершился с кодом ${run.code}: ${detail.slice(-1_200)}`);
    }
    const text = run.stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !/^\[BLANK_AUDIO\]$/i.test(line))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) throw new Error('whisper не распознал речь в записи.');
    return text;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
