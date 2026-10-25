import type { AppAPI } from '../../shared/types.js';
import { errorMessage } from './api.js';
import { RECORDING_MAX_SECONDS } from './recorder.js';

export type VoicePhase = 'idle' | 'requesting' | 'recording' | 'transcribing';
export interface VoiceState { phase: VoicePhase; elapsed: number; error: string | null; device: string; }
export interface VoiceCapture { device: string; stop(): Promise<ArrayBuffer>; dispose(): void; }
export type CaptureFactory = (signal: AbortSignal, onEnded: () => void) => Promise<VoiceCapture>;
export const MICROPHONE_TIMEOUT_MS = 15_000;
export const MICROPHONE_HELP = 'Проверьте системный запрос доступа. macOS: Системные настройки → Конфиденциальность и безопасность → Микрофон → Electron (при npm start) или Paper2Experiment, затем перезапустите приложение. Windows: Параметры → Конфиденциальность → Микрофон.';

/** Reject immediately on cancellation; still consume a late native permission result. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

/** Owns a single dictation. Identity checks prevent late results from changing a newer one. */
export class VoiceTask {
  state: VoiceState = { phase: 'idle', elapsed: 0, error: null, device: '' };
  private operation?: { controller: AbortController; id: string; capture?: VoiceCapture; sent: boolean };
  private clock?: ReturnType<typeof setInterval>;
  private limit?: ReturnType<typeof setTimeout>;
  private startedAt = 0;
  private cancelling: Promise<void> = Promise.resolve();

  constructor(
    private api: Pick<AppAPI, 'requestMicrophoneAccess' | 'transcribe' | 'cancelTranscription'>,
    private capture: CaptureFactory,
    private changed: (state: VoiceState) => void,
    private transcript: (text: string) => void,
    private requestTimeoutMs = MICROPHONE_TIMEOUT_MS
  ) {}

  private update(patch: Partial<VoiceState>) { this.state = { ...this.state, ...patch }; this.changed(this.state); }
  private clearTimers() { clearInterval(this.clock); clearTimeout(this.limit); }

  async start(): Promise<void> {
    if (this.operation) return;
    const operation = { controller: new AbortController(), id: crypto.randomUUID(), sent: false, capture: undefined as VoiceCapture | undefined };
    this.operation = operation;
    const { signal } = operation.controller;
    this.update({ phase: 'requesting', elapsed: 0, error: null, device: '' });
    const timeout = setTimeout(() => operation.controller.abort(new Error(`Не удалось получить доступ к микрофону за ${this.requestTimeoutMs / 1000} с. ${MICROPHONE_HELP}`)), this.requestTimeoutMs);
    try {
      await abortable(this.api.requestMicrophoneAccess(), signal);
      signal.throwIfAborted();
      operation.capture = await abortable(this.capture(signal, () => {
        if (this.operation !== operation) return;
        this.cancel();
        this.update({ error: 'Микрофон отключён. Подключите устройство и повторите запись.' });
      }).then(capture => {
        if (signal.aborted) { capture.dispose(); signal.throwIfAborted(); }
        return capture;
      }), signal);
      signal.throwIfAborted();
      this.startedAt = performance.now();
      this.update({ phase: 'recording', device: operation.capture!.device });
      this.clock = setInterval(() => this.update({ elapsed: Math.min(RECORDING_MAX_SECONDS, Math.floor((performance.now() - this.startedAt) / 1000)) }), 200);
      this.limit = setTimeout(() => void this.stop(), RECORDING_MAX_SECONDS * 1000);
    } catch (error) {
      if (this.operation !== operation) return;
      this.cancel();
      const name = error instanceof Error ? error.name : '';
      this.update({ error: name === 'NotAllowedError' || name === 'SecurityError'
        ? `Доступ к микрофону запрещён. ${MICROPHONE_HELP}`
        : name === 'NotFoundError' ? 'Микрофон не найден. Подключите устройство и повторите запись.'
        : name === 'NotReadableError' ? 'Микрофон недоступен или занят другим приложением. Проверьте устройство и повторите запись.'
        : `Не удалось начать запись: ${errorMessage(error)}` });
    } finally { clearTimeout(timeout); }
  }

  async stop(): Promise<void> {
    const operation = this.operation;
    if (!operation?.capture || this.state.phase !== 'recording') return;
    this.clearTimers();
    this.update({ phase: 'transcribing' });
    try {
      const wav = await operation.capture.stop();
      operation.controller.signal.throwIfAborted();
      await abortable(this.cancelling, operation.controller.signal);
      operation.controller.signal.throwIfAborted();
      operation.sent = true;
      const text = (await this.api.transcribe(wav, operation.id)).trim();
      if (this.operation !== operation) return;
      if (!text) throw new Error('Речь не распознана. Проверьте микрофон и настройки Whisper.');
      this.transcript(text);
    } catch (error) {
      if (this.operation === operation) this.update({ error: `Не удалось распознать речь: ${errorMessage(error)}` });
    } finally {
      operation.capture.dispose();
      if (this.operation === operation) { this.operation = undefined; this.update({ phase: 'idle' }); }
    }
  }

  cancel(): void {
    const operation = this.operation;
    this.operation = undefined;
    this.clearTimers();
    operation?.controller.abort(new DOMException('Диктовка отменена', 'AbortError'));
    operation?.capture?.dispose();
    if (operation?.sent) this.cancelling = this.api.cancelTranscription(operation.id).catch(() => undefined);
    this.update({ phase: 'idle', elapsed: 0, device: '' });
  }
}
