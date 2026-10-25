import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

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

/** A departed leader does not imply that its detached process group is empty. */
export function isProcessGroupAlive(pgid: number): boolean {
  if (process.platform === 'win32') return isProcessAlive(pgid);
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      if (error.code === 'ESRCH') return false;
      if (error.code === 'EPERM') return true;
    }
    throw error;
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

const execFileAsync = promisify(execFile);
const terminatingGroups = new Map<number, Promise<void>>();

async function hasLiveGroupMembers(pgid: number): Promise<boolean> {
  if (!isProcessGroupAlive(pgid)) return false;
  // Orphaned zombies can remain visible to kill(0) until the OS reaps them.
  // They cannot execute or write artifacts and must not hold cancellation open.
  const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pgid=,stat='], {
    env: executionEnv(), timeout: 5000, maxBuffer: 8 * 1024 * 1024
  });
  return stdout.split('\n').some(line => {
    const [group, state] = line.trim().split(/\s+/);
    return Number(group) === pgid && state !== undefined && !state.startsWith('Z');
  });
}

async function stopProcessGroup(pgid: number, graceMs: number): Promise<void> {
  if (!isProcessGroupAlive(pgid)) return;
  if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/pid', String(pgid), '/T', '/F'], { windowsHide: true }).catch(error => {
      if (isProcessAlive(pgid)) throw error;
    });
    while (isProcessAlive(pgid)) await delay(50);
    return;
  }
  const signal = (value: NodeJS.Signals): boolean => {
    try {
      process.kill(-pgid, value);
      return true;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') return false;
      throw error;
    }
  };
  if (!signal('SIGTERM')) return;
  const deadline = Date.now() + Math.max(0, graceMs);
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(pgid)) return;
    await delay(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  if (!isProcessGroupAlive(pgid) || !signal('SIGKILL')) return;
  while (await hasLiveGroupMembers(pgid)) await delay(50);
}

/**
 * Track only this in-flight group: never fall back to a possibly reused leader
 * PID or leave a delayed KILL scheduled after the original group disappears.
 * Concurrent cancel/timeout callers share the same TERM/KILL/exit barrier.
 */
export function terminateProcessGroup(pgid: number, graceMs = 5000): Promise<void> {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return Promise.resolve();
  const existing = terminatingGroups.get(pgid);
  if (existing) return existing;
  const termination = stopProcessGroup(pgid, graceMs).finally(() => {
    if (terminatingGroups.get(pgid) === termination) terminatingGroups.delete(pgid);
  });
  terminatingGroups.set(pgid, termination);
  return termination;
}

function appendLimited(current: string, chunk: Buffer, limit: number): string {
  if (current.length >= limit) return current;
  const text = chunk.toString('utf8');
  return (current + text).slice(-limit);
}

/** Runs one bounded child with a private environment and kills its group on abort/timeout. */
export function runProcess(command: string, args: string[], options: CommandOptions): Promise<CommandResult> {
  if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new Error('Отменено'));
  const { promise, resolve, reject } = Promise.withResolvers<CommandResult>();
  const limit = options.captureLimit ?? 2 * 1024 * 1024;
  let stdout = '';
  let stderr = '';
  let settled = false;
  let termination: Error | undefined;
  let terminationTask: Promise<void> | undefined;
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? executionEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true
  });
  const finish = async (result: CommandResult | Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    try {
      await terminationTask;
      if (result instanceof Error) reject(result);
      else resolve(result);
    } catch (error) {
      reject(error);
    }
  };
  const terminate = (reason: Error) => {
    if (termination || settled) return;
    termination = reason;
    if (child.pid) {
      terminationTask = terminateProcessGroup(child.pid, 5000);
      void terminationTask.catch(() => undefined);
    }
  };
  const abort = () => terminate(options.signal?.reason instanceof Error ? options.signal.reason : new Error('Отменено'));
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => terminate(new Error(`Команда превысила лимит ${Math.round(options.timeoutMs / 1000)} с: ${path.basename(command)}`)), Math.max(1, options.timeoutMs));
  if (options.signal?.aborted) abort();
  child.stdout?.on('data', (chunk: Buffer) => { stdout = appendLimited(stdout, chunk, limit); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr = appendLimited(stderr, chunk, limit); });
  child.once('error', error => { void finish(error); });
  child.once('close', (code, signal) => {
    if (termination) void finish(termination);
    else if (signal) void finish(new Error(`Команда завершена сигналом ${signal}: ${path.basename(command)}\n${stderr.slice(-4000)}`));
    else void finish({ exitCode: code ?? 1, stdout, stderr });
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
  if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new Error('Отменено'));
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
  let terminationTask: Promise<void> | undefined;
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? executionEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true
  });
  const finish = async () => {
    if (settled || !childClosed || !outClosed) return;
    settled = true;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    try {
      await terminationTask;
      if (termination) reject(termination);
      else if (exitCode !== 0) reject(new Error(`Команда завершилась с кодом ${exitCode}: ${path.basename(command)}\n${stderr.slice(-4000)}`));
      else resolve({ exitCode: exitCode ?? 1, stderr, bytes, sha256: hash.digest('hex') });
    } catch (error) {
      reject(error);
    }
  };
  const terminate = (reason: Error) => {
    if (termination || settled) return;
    termination = reason;
    if (child.pid) {
      terminationTask = terminateProcessGroup(child.pid, 5000);
      void terminationTask.catch(() => undefined);
    }
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
    terminate(error);
    out.destroy();
  });
  child.once('close', code => {
    childClosed = true;
    exitCode = code;
    if (!outEnded) {
      outEnded = true;
      out.end();
    }
    void finish();
  });
  out.once('close', () => { outClosed = true; void finish(); });
  out.once('error', error => {
    terminate(error);
    out.destroy();
  });
  return promise;
}

/** Starts the scientific process in its own group with stdout/stderr persisted to files. */
export async function startDetached(command: string, args: string[], cwd: string, stdoutFile: string, stderrFile: string, signal: AbortSignal): Promise<DetachedExecution> {
  let execution: DetachedExecution | undefined;
  try {
    const out = await open(stdoutFile, 'w', 0o600);
    try {
      const err = await open(stderrFile, 'w', 0o600);
      try {
        signal.throwIfAborted();
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
        execution = { child, pid: child.pid, exit: exit.promise };
        return execution;
      } finally {
        await err.close();
      }
    } finally {
      await out.close();
    }
  } catch (error) {
    // Closing the inherited log descriptors can fail after spawn as well.
    if (execution) {
      await terminateProcessGroup(execution.pid);
      await execution.exit.catch(() => null);
    }
    throw error;
  }
}
