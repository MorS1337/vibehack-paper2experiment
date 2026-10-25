import { open } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const MAX_LINE = 20_000;
const MAX_POLL_BYTES = 256 * 1024;

export type LogStream = 'stdout' | 'stderr';

export class LineDecoder {
  private decoder = new StringDecoder('utf8');
  private buffer = '';

  push(chunk: Buffer, onLine: (line: string) => void): void {
    this.buffer += this.decoder.write(chunk);
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      onLine(line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}… [обрезано]` : line);
    }
  }

  flush(onLine: (line: string) => void): void {
    this.buffer += this.decoder.end();
    if (this.buffer) onLine(this.buffer.replace(/\r$/, ''));
    this.buffer = '';
  }
}

/**
 * Tails the project's stdout.log/stderr.log without copying them: the child process
 * writes the authoritative files, and this only emits lines to the UI/listeners.
 */
export class FileLogPump {
  private offsets: Record<LogStream, number> = { stdout: 0, stderr: 0 };
  private decoders: Record<LogStream, LineDecoder> = { stdout: new LineDecoder(), stderr: new LineDecoder() };
  private listeners = new Set<(line: string) => void>();
  private sink?: (message: string) => void;
  private timer?: NodeJS.Timeout;
  private queued: Promise<void> = Promise.resolve();

  constructor(private readonly projectDir: string) {}

  attachSink(sink: (message: string) => void): void {
    this.sink = sink;
  }

  detachSink(): void {
    this.sink = undefined;
  }

  reset(): void {
    this.offsets = { stdout: 0, stderr: 0 };
    this.decoders = { stdout: new LineDecoder(), stderr: new LineDecoder() };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.queued = this.queued.then(() => this.poll()).catch(() => undefined);
    }, 400);
    this.timer.unref();
    this.queued = this.queued.then(() => this.poll()).catch(() => undefined);
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.queued;
    await this.poll().catch(() => undefined);
    for (const stream of ['stdout', 'stderr'] as const) this.decoders[stream].flush(line => this.deliver(stream, line));
  }

  subscribe(listener: (line: string) => void): () => void {
    this.listeners.add(listener);
    this.start();
    return () => { this.listeners.delete(listener); };
  }

  private deliver(stream: LogStream, line: string): void {
    const text = `[${stream}] ${line}`;
    for (const listener of this.listeners) {
      try { listener(text); } catch { /* a renderer listener must not break the run */ }
    }
    try { this.sink?.(text); } catch { /* persistence failures are surfaced by the orchestrator */ }
  }

  private async poll(): Promise<void> {
    for (const stream of ['stdout', 'stderr'] as const) await this.readStream(stream);
  }

  private async readStream(stream: LogStream): Promise<void> {
    const file = path.join(this.projectDir, `${stream}.log`);
    const handle = await open(file, 'r').catch(error => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    });
    if (!handle) return;
    try {
      const info = await handle.stat();
      if (info.size < this.offsets[stream]) this.reset();
      if (info.size === this.offsets[stream]) return;
      const length = Math.min(info.size - this.offsets[stream], MAX_POLL_BYTES);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, this.offsets[stream]);
      if (bytesRead <= 0) return;
      this.offsets[stream] += bytesRead;
      this.decoders[stream].push(buffer.subarray(0, bytesRead), line => this.deliver(stream, line));
    } finally {
      await handle.close();
    }
  }
}
