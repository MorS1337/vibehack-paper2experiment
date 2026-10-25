import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executionEnv, runProcess, signalProcessGroup, type CommandResult } from './process.js';
import { validateRelativePath } from './manifest.js';
import type { ProjectManifest } from '../shared/types.js';

export const REMOTE_PROJECT = '/workspace/paper2experiment';

const UPLOAD_DENY_DIRS: Record<string, true> = {
  '.venv': true,
  venv: true,
  env: true,
  '.git': true,
  '.ssh': true,
  '.cache': true,
  '__pycache__': true,
  node_modules: true,
  artifacts: true,
  '.pytest_cache': true,
  '.mypy_cache': true,
  '.ruff_cache': true
};

const UPLOAD_ALLOW_FILES: Record<string, true> = {
  'pyproject.toml': true,
  'setup.py': true,
  'setup.cfg': true,
  'tox.ini': true,
  'pytest.ini': true,
  'environment.yml': true,
  'requirements.txt': true,
  LICENSE: true,
  README: true,
  NOTICE: true
};

const UPLOAD_ALLOW_EXTENSIONS: Record<string, true> = {
  '.py': true, '.json': true, '.txt': true, '.yaml': true, '.yml': true, '.toml': true,
  '.ini': true, '.cfg': true, '.csv': true, '.tsv': true, '.npy': true, '.npz': true,
  '.parquet': true, '.feather': true, '.h5': true, '.hdf5': true, '.pkl': true,
  '.joblib': true, '.pt': true, '.pth': true, '.onnx': true, '.png': true, '.jpg': true,
  '.jpeg': true, '.svg': true, '.pdf': true, '.md': true, '.sh': true, '.zip': true,
  '.gz': true, '.bz2': true, '.xz': true, '.tar': true
};

const SECRET_NAME_PATTERNS = [
  /^\.env(?:\.|$)/i,
  /(?:^|[._-])credentials?(?:[._-]|$)/i,
  /(?:^|[._-])secrets?(?:[._-]|$)/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/i,
  /\.(?:pem|key|p12|pfx|keystore|jks)$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^known_hosts(?:\.|$)/i
];

export interface SshTarget {
  host: string;
  port: number;
  user: string;
  keyPath: string;
  knownHostsFile: string;
}

export interface SshRunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  captureLimit?: number;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

export async function prepareKnownHosts(runDir: string): Promise<string> {
  const directory = path.join(runDir, 'ssh');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'known_hosts');
  const handle = await open(file, 'a', 0o600);
  await handle.close();
  return file;
}

export async function derivePublicKey(privateKeyPath: string, signal?: AbortSignal): Promise<string> {
  const keyPath = expandHome(privateKeyPath);
  const result = await runProcess('ssh-keygen', ['-y', '-f', keyPath], { timeoutMs: 15_000, signal, env: executionEnv(), captureLimit: 32 * 1024 });
  if (result.exitCode !== 0) throw new Error(`Не удалось прочитать SSH-ключ ${privateKeyPath}: ssh-keygen завершился с кодом ${result.exitCode}. ${result.stderr.slice(-1000)}`);
  const publicKey = result.stdout.trim().split('\n').find(line => /^(ssh-|ecdsa-)/.test(line))?.trim();
  if (!publicKey) throw new Error(`SSH-ключ ${privateKeyPath}: ssh-keygen не вернул публичный ключ (возможно, ключ защищён паролем)`);
  return publicKey;
}

export function sshArgs(target: SshTarget, remoteCommand: string): string[] {
  if (!/^[A-Za-z0-9.-]+$/.test(target.host)) throw new Error(`Некорректный SSH host от Vast: ${target.host}`);
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) throw new Error(`Некорректный SSH port от Vast: ${target.port}`);
  return [
    '-F', '/dev/null',
    '-i', target.keyPath,
    '-p', String(target.port),
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', `UserKnownHostsFile=${target.knownHostsFile}`,
    '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=4',
    `${target.user}@${target.host}`,
    remoteCommand
  ];
}

export function runSsh(target: SshTarget, remoteCommand: string, options: SshRunOptions = {}): Promise<CommandResult> {
  return runProcess('ssh', sshArgs(target, remoteCommand), {
    timeoutMs: options.timeoutMs ?? 30_000,
    signal: options.signal,
    env: executionEnv(),
    captureLimit: options.captureLimit ?? 2 * 1024 * 1024
  });
}

/** Uploads only allowlisted project/data files. Symlinks, .venv, git metadata and secrets are excluded. */
export async function listUploadFiles(projectDir: string, manifest: ProjectManifest): Promise<string[]> {
  const exact = new Set([manifest.entryPoint, manifest.config, manifest.requirements]);
  const files: string[] = [];
  let totalBytes = 0;
  const walk = async (relativeDir: string): Promise<void> => {
    const absolute = path.join(projectDir, relativeDir);
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries) {
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.name.startsWith('.') || entry.name.includes('\n') || entry.name.includes('\0')) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (UPLOAD_DENY_DIRS[entry.name]) continue;
        if (SECRET_NAME_PATTERNS.some(pattern => pattern.test(entry.name))) continue;
        await walk(relative);
        continue;
      }
      if (!entry.isFile()) continue;
      const isExact = exact.has(relative);
      const isData = relative === 'data' || relative.startsWith('data/');
      // Real author repositories may contain native sources, R, notebooks, models and
      // other resources. They stay inside project/author-source and are still filtered
      // for secrets/symlinks; the demo path remains on the strict extension allowlist.
      const isAuthorSource = relative === 'author-source' || relative.startsWith('author-source/');
      const extension = path.extname(entry.name).toLowerCase();
      if (!isExact && !isData && !isAuthorSource && !UPLOAD_ALLOW_FILES[entry.name] && !UPLOAD_ALLOW_EXTENSIONS[extension]) continue;
      if (SECRET_NAME_PATTERNS.some(pattern => pattern.test(entry.name))) continue;
      const info = await lstat(path.join(projectDir, relative));
      if (!info.isFile()) continue;
      totalBytes += info.size;
      if (files.length >= 50_000) throw new Error('Проект содержит слишком много файлов для загрузки (лимит 50000)');
      if (totalBytes > 20 * 1024 ** 3) throw new Error('Проект превышает лимит загрузки 20 GiB');
      files.push(relative);
    }
  };
  await walk('');
  for (const relative of exact) validateRelativePath(relative, 'manifest');
  if (!files.includes(manifest.entryPoint)) throw new Error(`entryPoint не попал в allowlist загрузки: ${manifest.entryPoint}`);
  if (!files.includes(manifest.config)) throw new Error(`config не попал в allowlist загрузки: ${manifest.config}`);
  if (!files.includes(manifest.requirements)) throw new Error(`requirements не попал в allowlist загрузки: ${manifest.requirements}`);
  return files.sort();
}

/** Streams a local tar into SSH so the remote never needs credentials or a .venv upload. */
export async function uploadProject(target: SshTarget, projectDir: string, files: string[], signal?: AbortSignal): Promise<void> {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'p2e-upload-'));
  const listFile = path.join(temporaryDirectory, 'files.list');
  try {
    await writeFile(listFile, files.map(file => `./${file}`).join('\n') + '\n', { mode: 0o600 });
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const tar = spawn('tar', ['-czf', '-', '-C', projectDir, '-T', listFile], { env: executionEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    const tunnel = spawn('ssh', sshArgs(target, `mkdir -p ${REMOTE_PROJECT} && tar -xzf - -C ${REMOTE_PROJECT}`), { env: executionEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let tarCode: number | null = null;
    let sshCode: number | null = null;
    let tarError = '';
    let sshError = '';
    let settled = false;
    const abort = () => {
      if (tar.pid) signalProcessGroup(tar.pid, 'SIGTERM');
      if (tunnel.pid) signalProcessGroup(tunnel.pid, 'SIGTERM');
    };
    const finish = () => {
      if (settled || tarCode === null || sshCode === null) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (tarCode !== 0) reject(new Error(`tar не смог упаковать проект (код ${tarCode}): ${tarError.slice(-2000)}`));
      else if (sshCode !== 0) reject(new Error(`SCP/SSH не смог загрузить проект (код ${sshCode}): ${sshError.slice(-2000)}`));
      else resolve();
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    tunnel.stdin.on('error', () => { /* SSHD closed the upload pipe */ });
    tar.stdout.on('error', () => { /* SSH closed the upload pipe */ });
    tar.stdout.pipe(tunnel.stdin);
    tar.stderr.on('data', (chunk: Buffer) => { tarError = (tarError + chunk.toString('utf8')).slice(-20_000); });
    tunnel.stderr.on('data', (chunk: Buffer) => { sshError = (sshError + chunk.toString('utf8')).slice(-20_000); });
    tunnel.stdout.on('data', () => { /* drain banners */ });
    tar.once('error', error => { tarCode = 1; tarError += String(error); finish(); });
    tunnel.once('error', error => { sshCode = 1; sshError += String(error); if (tar.pid) signalProcessGroup(tar.pid, 'SIGTERM'); finish(); });
    tar.once('close', code => { tarCode = code ?? 1; if (tarCode !== 0) tunnel.stdin.destroy(); finish(); });
    tunnel.once('close', code => {
      sshCode = code ?? 1;
      if (sshCode !== 0 && tar.pid) signalProcessGroup(tar.pid, 'SIGTERM');
      finish();
    });
    await promise;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export interface RemoteDownload {
  remote: string;
  local: string;
}

/** Fetches explicit remote files. Missing optional files are reported, never invented. */
export async function downloadRemoteFiles(target: SshTarget, downloads: RemoteDownload[], signal?: AbortSignal, timeoutMs = 120_000): Promise<{ local: string; error?: string }[]> {
  const results: { local: string; error?: string }[] = [];
  for (const item of downloads) {
    await mkdir(path.dirname(item.local), { recursive: true });
    const result = await runProcess('scp', [
      '-q',
      '-F', '/dev/null',
      '-P', String(target.port),
      '-i', target.keyPath,
      '-o', 'BatchMode=yes',
      '-o', 'IdentitiesOnly=yes',
      '-o', `UserKnownHostsFile=${target.knownHostsFile}`,
      '-o', 'GlobalKnownHostsFile=/dev/null',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ConnectTimeout=15',
      `${target.user}@${target.host}:${item.remote}`,
      item.local
    ], { timeoutMs, signal, env: executionEnv(), captureLimit: 64 * 1024 });
    if (result.exitCode !== 0) results.push({ local: item.local, error: result.stderr.slice(-1000) || `scp exit ${result.exitCode}` });
    else results.push({ local: item.local });
  }
  return results;
}
