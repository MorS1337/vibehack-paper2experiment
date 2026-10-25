import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
  captureLimit?: number;
}

/**
 * Environment allowlist for every local scientific/SSH child. API keys and other
 * credentials from the Electron process are deliberately not inherited; pip
 * proxy/index credentials therefore also require explicit system configuration
 * outside the harness.
 */
export function executionEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const allowed = [
    'PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT', 'WINDIR',
    'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'CURL_CA_BUNDLE'
  ];
  const env: NodeJS.ProcessEnv = { PYTHONUNBUFFERED: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_INPUT: '1', PYTHONNOUSERSITE: '1' };
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Отменено'));
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', abort);
    resolve();
  }, Math.max(0, ms));
  const abort = () => {
    clearTimeout(timer);
    reject(signal?.reason ?? new Error('Отменено'));
  };
  signal?.addEventListener('abort', abort, { once: true });
  return promise;
}

export function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  if (process.platform === 'win32') {
    const child = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    child.unref();
    return;
  }
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // A detached child may already have lost its group; fall back to the leader.
  }
  try {
    process.kill(pid, signal);
  } catch {
    // ESRCH means it is already gone.
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !!error && typeof error === 'object' && 'code' in error && error.code === 'EPERM';
  }
}

export async function readFileTail(file: string, maxBytes = 20_000): Promise<string> {
  const handle = await open(file, 'r').catch(error => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  });
  if (!handle) return '';
  try {
    const info = await handle.stat();
    const length = Math.min(info.size, maxBytes);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, Math.max(0, info.size - length));
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** TERM the whole process group, then KILL it after the grace period. */
export async function terminateProcessGroup(pid: number, graceMs = 5000): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  signalProcessGroup(pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await delay(100);
  }
  signalProcessGroup(pid, 'SIGKILL');
}

function appendLimited(current: string, chunk: Buffer, limit: number): string {
  if (current.length >= limit) return current;
  const text = chunk.toString('utf8');
  return (current + text).slice(-limit);
}

/** Runs one bounded child with a private environment and kills its group on abort/timeout. */
export function runProcess(command: string, args: string[], options: CommandOptions): Promise<CommandResult> {
  const { promise, resolve, reject } = Promise.withResolvers<CommandResult>();
  const limit = options.captureLimit ?? 2 * 1024 * 1024;
  let stdout = '';
  let stderr = '';
  let settled = false;
  let termination: Error | undefined;
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? executionEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true
  });
  const finish = (result: CommandResult | Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    if (result instanceof Error) reject(result);
    else resolve(result);
  };
  const terminate = (reason: Error) => {
    if (termination) return;
    termination = reason;
    if (child.pid) void terminateProcessGroup(child.pid, 5000);
  };
  const abort = () => terminate(options.signal?.reason instanceof Error ? options.signal.reason : new Error('Отменено'));
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => terminate(new Error(`Команда превысила лимит ${Math.round(options.timeoutMs / 1000)} с: ${path.basename(command)}`)), Math.max(1, options.timeoutMs));
  if (options.signal?.aborted) abort();
  child.stdout?.on('data', (chunk: Buffer) => { stdout = appendLimited(stdout, chunk, limit); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr = appendLimited(stderr, chunk, limit); });
  child.once('error', error => finish(error));
  child.once('close', (code, signal) => {
    if (termination) finish(termination);
    else if (signal) finish(new Error(`Команда завершена сигналом ${signal}: ${path.basename(command)}\n${stderr.slice(-4000)}`));
    else finish({ exitCode: code ?? 1, stdout, stderr });
  });
  return promise;
}

export interface DetachedExecution {
  child: ChildProcess;
  pid: number;
  exit: Promise<number | null>;
}

export interface FileCommandResult {
  exitCode: number;
  stderr: string;
  bytes: number;
  sha256: string;
}

/** Streams a child's stdout into a file while hashing it (used for verified cloud exports). */
export function runProcessToFile(command: string, args: string[], outFile: string, options: CommandOptions & { maxBytes?: number }): Promise<FileCommandResult> {
  const { promise, resolve, reject } = Promise.withResolvers<FileCommandResult>();
  const maxBytes = options.maxBytes ?? 1024 ** 3;
  const hash = createHash('sha256');
  const out = createWriteStream(outFile, { mode: 0o600 });
  let stderr = '';
  let bytes = 0;
  let exitCode: number | null = null;
  let outEnded = false;
  let childClosed = false;
  let outClosed = false;
  let settled = false;
  let termination: Error | undefined;
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? executionEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true
  });
  const finish = () => {
    if (settled || !childClosed || !outClosed) return;
    settled = true;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    if (termination) reject(termination);
    else if (exitCode !== 0) reject(new Error(`Команда завершилась с кодом ${exitCode}: ${path.basename(command)}\n${stderr.slice(-4000)}`));
    else resolve({ exitCode: exitCode ?? 1, stderr, bytes, sha256: hash.digest('hex') });
  };
  const terminate = (reason: Error) => {
    if (termination || settled) return;
    termination = reason;
    if (child.pid) void terminateProcessGroup(child.pid, 5000);
  };
  const abort = () => terminate(options.signal?.reason instanceof Error ? options.signal.reason : new Error('Отменено'));
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => terminate(new Error(`Команда превысила лимит ${Math.round(options.timeoutMs / 1000)} с: ${path.basename(command)}`)), Math.max(1, options.timeoutMs));
  if (options.signal?.aborted) abort();
  child.stdout?.on('data', (chunk: Buffer) => {
    if (termination) return;
    if (bytes + chunk.length > maxBytes) {
      terminate(new Error(`Поток ${path.basename(command)} превысил лимит ${maxBytes} байт`));
      return;
    }
    bytes += chunk.length;
    hash.update(chunk);
    if (!out.write(chunk)) {
      child.stdout?.pause();
      out.once('drain', () => child.stdout?.resume());
    }
  });
  child.stdout?.once('end', () => {
    if (!outEnded) {
      outEnded = true;
      out.end();
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => { stderr = appendLimited(stderr, chunk, 64 * 1024); });
  child.once('error', error => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    out.destroy();
    reject(error);
  });
  child.once('close', code => {
    childClosed = true;
    exitCode = code;
    if (!outEnded) {
      outEnded = true;
      out.end();
    }
    finish();
  });
  out.once('close', () => { outClosed = true; finish(); });
  out.once('error', error => {
    terminate(error);
    if (!settled) {
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      reject(error);
    }
  });
  return promise;
}

/** Starts the scientific process in its own group with stdout/stderr persisted to files. */
export async function startDetached(command: string, args: string[], cwd: string, stdoutFile: string, stderrFile: string): Promise<DetachedExecution> {
  const out = await open(stdoutFile, 'w', 0o600);
  try {
    const err = await open(stderrFile, 'w', 0o600);
    try {
      const child = spawn(command, args, {
        cwd,
        env: executionEnv(),
        stdio: ['ignore', out.fd, err.fd],
        detached: process.platform !== 'win32',
        windowsHide: true
      });
      if (!child.pid) {
        child.once('error', () => undefined);
        throw new Error(`Не удалось запустить ${command}`);
      }
      const exit = Promise.withResolvers<number | null>();
      child.once('error', exit.reject);
      child.once('exit', code => exit.resolve(code));
      return { child, pid: child.pid, exit: exit.promise };
    } finally {
      await err.close();
    }
  } finally {
    await out.close();
  }
}
