import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createOpencodeClient, type Config, type OpencodeClient } from '@opencode-ai/sdk';
import { SetupRequiredError } from '../shared/errors.js';
import type { AppSettings, ConnectionStatus } from '../shared/types.js';

/** Pinned together with @opencode-ai/sdk in package.json. */
export const OPENCODE_VERSION = '1.19.4';
const SERVER_START_TIMEOUT_MS = 20_000;
const SERVER_STOP_GRACE_MS = 3_000;
const MAX_CAPTURED_OUTPUT = 64 * 1024;

const moduleRequire = createRequire(path.join(process.cwd(), 'package.json'));

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

function delay(ms: number): Promise<void> {
  const result = deferred<void>();
  const timer = setTimeout(() => result.resolve(), ms);
  timer.unref();
  return result.promise;
}

/** Provider ids that OpenCode reads from the environment, without ever materialising their values. */
const ENV_PROVIDERS: Record<string, string> = {
  ANTHROPIC_API_KEY: 'anthropic',
  OPENAI_API_KEY: 'openai',
  AZURE_OPENAI_API_KEY: 'azure',
  GEMINI_API_KEY: 'google',
  GOOGLE_GENERATIVE_AI_API_KEY: 'google',
  OPENROUTER_API_KEY: 'openrouter',
  OPENCODE_API_KEY: 'opencode',
  DEEPSEEK_API_KEY: 'deepseek',
  GROQ_API_KEY: 'groq',
  MISTRAL_API_KEY: 'mistral',
  XAI_API_KEY: 'xai',
  CEREBRAS_API_KEY: 'cerebras',
  TOGETHER_API_KEY: 'togetherai',
  FIREWORKS_API_KEY: 'fireworks',
  HF_TOKEN: 'huggingface',
  COPILOT_GITHUB_TOKEN: 'github-copilot',
  ZAI_API_KEY: 'zai'
};

export interface OpenCodeAuth {
  authPath: string;
  providers: string[];
  sources: Array<'auth.json' | 'environment'>;
}

function defaultDataHome(): string {
  if (process.env.XDG_DATA_HOME?.trim()) return process.env.XDG_DATA_HOME.trim();
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return process.env.LOCALAPPDATA;
  return path.join(os.homedir(), '.local', 'share');
}

export function openCodeAuthPath(): string {
  return path.join(defaultDataHome(), 'opencode', 'auth.json');
}

/**
 * The user's global OpenCode database can be written by another, incompatible OpenCode release.
 * Keep this worker's database sandboxed, but link the standard auth store instead of copying secrets.
 */
function prepareIsolatedDataHome(): string {
  // The only durable state this integration creates; it never lives in a project directory.
  const root = path.join(os.homedir(), '.paper2experiment', 'opencode-data');
  mkdirSync(path.join(root, 'opencode'), { recursive: true, mode: 0o700 });
  const globalAuth = openCodeAuthPath();
  const isolatedAuth = path.join(root, 'opencode', 'auth.json');
  if (existsSync(globalAuth) && !existsSync(isolatedAuth)) {
    try {
      symlinkSync(globalAuth, isolatedAuth);
    } catch (error) {
      throw new SetupRequiredError(`OpenCode: не удалось связать ${globalAuth} с изолированным профилем: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return root;
}

export interface OpenCodeBinary {
  path: string;
  version: string;
}

export function resolveOpenCodeBinary(): string {
  const packageJson = moduleRequire.resolve('opencode-ai/package.json');
  const binary = path.join(path.dirname(packageJson), 'bin', 'opencode.exe');
  if (!existsSync(binary)) throw new SetupRequiredError(`OpenCode: бинарник не найден по пути ${binary}. Переустановите opencode-ai@${OPENCODE_VERSION}`);
  return binary;
}

function probeVersion(binary: string): string {
  const result = spawnSync(binary, ['--version'], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
    env: safeProcessEnv(process.env)
  });
  if (result.error) throw new SetupRequiredError(`OpenCode: не удалось запустить ${binary}: ${result.error.message}`);
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  if (result.status !== 0) throw new SetupRequiredError(`OpenCode: ${binary} --version завершился с кодом ${result.status}${output ? `: ${redactSecrets(output)}` : ''}`);
  const match = output.match(/(\d+\.\d+\.\d+)/);
  if (!match) throw new SetupRequiredError(`OpenCode: не удалось определить версию из «${redactSecrets(output.slice(0, 200))}»`);
  return match[1];
}

export function openCodeBinary(): OpenCodeBinary {
  const binary = resolveOpenCodeBinary();
  return { path: binary, version: probeVersion(binary) };
}

export function detectOpenCodeAuth(): OpenCodeAuth {
  const authPath = openCodeAuthPath();
  const providers = new Set<string>();
  const sources = new Set<'auth.json' | 'environment'>();
  if (existsSync(authPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(authPath, 'utf8'));
    } catch (error) {
      throw new SetupRequiredError(`OpenCode: файл ${authPath} не читается как JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SetupRequiredError(`OpenCode: ${authPath} должен содержать JSON-объект`);
    for (const [provider, credential] of Object.entries(parsed)) {
      if (!credential || typeof credential !== 'object') continue;
      if ('type' in credential || 'key' in credential || 'access' in credential || 'refresh' in credential) {
        providers.add(provider);
        sources.add('auth.json');
      }
    }
  }
  for (const [variable, provider] of Object.entries(ENV_PROVIDERS)) {
    if (process.env[variable]?.trim()) {
      providers.add(provider);
      sources.add('environment');
    }
  }
  return { authPath, providers: [...providers].sort(), sources: [...sources] };
}

/** Strip Vast/Jev credentials and Pi process markers before any agent child process starts. */
export function safeProcessEnv(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    if (/^(VAST|JEV|TYPESAFE)_/i.test(key)) continue;
    if (/^PI_/i.test(key)) continue;
    result[key] = value;
  }
  return result;
}

/** Error text may quote a provider response; never echo a known credential value. */
export function redactSecrets(text: string, environment: NodeJS.ProcessEnv = process.env): string {
  let result = text;
  for (const [key, value] of Object.entries(environment)) {
    if (!value || value.length < 8) continue;
    if (!/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)) continue;
    result = result.split(value).join('[redacted]');
  }
  return result;
}

export function parseOpenCodeModel(value: string): { providerID: string; modelID: string } {
  const trimmed = value.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1 || trimmed.includes(' ')) {
    throw new SetupRequiredError(`OpenCode: модель должна быть в формате provider/model, получено «${trimmed || 'пусто'}»`);
  }
  return { providerID: trimmed.slice(0, slash), modelID: trimmed.slice(slash + 1) };
}

export async function openCodeStatus(settings: AppSettings): Promise<ConnectionStatus> {
  try {
    const binary = openCodeBinary();
    if (binary.version !== OPENCODE_VERSION) {
      return { component: 'opencode', state: 'needs_setup', detail: `OpenCode ${binary.version} не совпадает с SDK ${OPENCODE_VERSION}. Используйте opencode-ai@${OPENCODE_VERSION} из node_modules, а не глобальный бинарник.` };
    }
    const model = settings.openCodeModel.trim();
    if (!model) return { component: 'opencode', state: 'needs_setup', detail: 'Укажите модель OpenCode в формате provider/model (например, openrouter/anthropic/claude-sonnet-4).' };
    parseOpenCodeModel(model);
    const auth = detectOpenCodeAuth();
    if (!auth.providers.length) {
      return {
        component: 'opencode',
        state: 'needs_setup',
        detail: `Учётные данные OpenCode не найдены (${auth.authPath}). Выполните ${binary.path} auth login; настройки pi и OpenCode независимы.`
      };
    }
    const source = auth.sources.includes('auth.json') && auth.sources.includes('environment') ? 'auth.json и переменные окружения' : auth.sources[0] === 'auth.json' ? 'auth.json' : 'переменные окружения';
    return { component: 'opencode', state: 'ready', detail: `OpenCode ${binary.version}; провайдеры: ${auth.providers.join(', ')}; источник: ${source}; модель: ${model}` };
  } catch (error) {
    return { component: 'opencode', state: error instanceof SetupRequiredError ? 'needs_setup' : 'error', detail: redactSecrets(error instanceof Error ? error.message : String(error)) };
  }
}

export interface OpenCodeServer {
  url: string;
  client: OpencodeClient;
  close: () => Promise<void>;
  warning: string | undefined;
}

function freePort(): Promise<number> {
  const result = deferred<number>();
  const server = net.createServer();
  server.unref();
  server.once('error', result.reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      result.reject(new Error('OpenCode: не удалось выделить локальный порт'));
      return;
    }
    const port = address.port;
    server.close(() => result.resolve(port));
  });
  return result.promise;
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = deferred<void>();
  const onExit = () => exited.resolve();
  child.once('exit', onExit);
  child.once('close', onExit);
  try {
    child.kill('SIGTERM');
  } catch {
    // Already gone.
  }
  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }, SERVER_STOP_GRACE_MS);
  timer.unref();
  await Promise.race([exited.promise, delay(SERVER_STOP_GRACE_MS + 1_000)]);
  clearTimeout(timer);
  child.off('exit', onExit);
  child.off('close', onExit);
}

interface StartServerOptions {
  projectDir: string;
  signal: AbortSignal;
  settings: AppSettings;
}

export async function startOpenCodeServer(options: StartServerOptions): Promise<OpenCodeServer> {
  const binary = openCodeBinary();
  if (binary.version !== OPENCODE_VERSION) throw new SetupRequiredError(`OpenCode ${binary.version} не совпадает с SDK ${OPENCODE_VERSION}; запустите бинарник из node_modules/.bin/opencode`);
  const dataHome = prepareIsolatedDataHome();
  const port = await freePort();
  const config: Config = {
    autoupdate: false,
    share: 'disabled',
    ...(options.settings.openCodeModel.trim() ? { model: options.settings.openCodeModel.trim() } : {}),
    permission: {
      edit: 'allow',
      // The worker needs scripts, tests and package installation inside the project. Out-of-project
      // paths and network fetches are denied by the permission engine where OpenCode exposes them.
      bash: 'allow',
      webfetch: 'deny',
      external_directory: 'deny',
      doom_loop: 'deny'
    },
    tools: { webfetch: false, websearch: false, task: false }
  };
  const env = {
    ...safeProcessEnv(process.env),
    XDG_DATA_HOME: dataHome,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config)
  };
  const args = ['serve', `--hostname=127.0.0.1`, `--port=${port}`];
  const child = spawn(binary.path, args, {
    cwd: options.projectDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let captured = '';
  const append = (chunk: Buffer | string) => {
    captured = `${captured}${chunk.toString()}`.slice(-MAX_CAPTURED_OUTPUT);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);

  const started = deferred<string>();
  let settled = false;
  let startupTimer: NodeJS.Timeout | undefined;
  let outputBuffer = '';
  const cleanupStartup = () => {
    clearTimeout(startupTimer);
    options.signal.removeEventListener('abort', onAbort);
    child.stdout?.off('data', onStartupData);
    child.stderr?.off('data', onStartupData);
    child.off('exit', onExit);
    child.off('error', onError);
  };
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    cleanupStartup();
    started.reject(error);
    void stopProcess(child);
  };
  const onStartupData = (chunk: Buffer) => {
    if (settled) return;
    outputBuffer = `${outputBuffer}${chunk.toString()}`.slice(-MAX_CAPTURED_OUTPUT);
    const match = outputBuffer.match(/opencode server listening on\s+(https?:\/\/[^\s]+)/);
    if (!match) return;
    settled = true;
    cleanupStartup();
    started.resolve(match[1]);
  };
  const onExit = (code: number | null) => fail(new Error(`OpenCode server завершился с кодом ${code}. ${redactSecrets(captured.slice(-2_000))}`));
  const onError = (error: Error) => fail(new Error(`OpenCode server: ${error.message}`));
  const onAbort = () => fail(new Error('OpenCode server: запуск отменён'));
  options.signal.addEventListener('abort', onAbort, { once: true });
  child.stdout?.on('data', onStartupData);
  child.stderr?.on('data', onStartupData);
  child.once('exit', onExit);
  child.once('error', onError);
  startupTimer = setTimeout(() => fail(new Error(`OpenCode server не ответил за ${SERVER_START_TIMEOUT_MS / 1000} с. ${redactSecrets(captured.slice(-2_000))}`)), SERVER_START_TIMEOUT_MS);
  startupTimer.unref();
  if (options.signal.aborted) onAbort();

  let url: string;
  try {
    url = await started.promise;
  } catch (error) {
    await stopProcess(child);
    throw error instanceof Error ? error : new Error(String(error));
  }
  const warning = /OPENCODE_SERVER_PASSWORD is not set/i.test(captured)
    ? 'OpenCode слушает только 127.0.0.1 без пароля; сервер живёт только на время вызова агента.'
    : undefined;
  let closed = false;
  const client = createOpencodeClient({ baseUrl: url, directory: options.projectDir });
  return {
    url,
    client,
    warning,
    close: async () => {
      if (closed) return;
      closed = true;
      child.stdout?.destroy();
      child.stderr?.destroy();
      await stopProcess(child);
    }
  };
}

export interface OpenCodeWorkerOptions {
  projectDir: string;
  settings: AppSettings;
  signal: AbortSignal;
  prompt: string;
  /** Reuse an earlier session for a technical repair. */
  sessionId?: string;
  onSession?: (sessionId: string) => Promise<void> | void;
}

export interface OpenCodeWorkerResult {
  sessionId: string;
  text: string;
  toolErrors: string[];
}

function apiErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export async function runOpenCodeWorker(options: OpenCodeWorkerOptions): Promise<OpenCodeWorkerResult> {
  const auth = detectOpenCodeAuth();
  if (!auth.providers.length) {
    throw new SetupRequiredError(`OpenCode: нет учётных данных (${auth.authPath}). Выполните opencode auth login; ключи pi сюда не копируются.`);
  }
  const model = parseOpenCodeModel(options.settings.openCodeModel);
  options.signal.throwIfAborted();
  const server = await startOpenCodeServer({ projectDir: options.projectDir, signal: options.signal, settings: options.settings });
  let activeSessionId = options.sessionId;
  const abort = () => {
    if (activeSessionId) {
      void server.client.session.abort({ path: { id: activeSessionId }, query: { directory: options.projectDir }, signal: AbortSignal.timeout(2_000) }).catch(() => undefined);
    }
    void server.close();
  };
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    options.signal.throwIfAborted();
    let sessionId = options.sessionId;
    if (sessionId) {
      const existing = await server.client.session.get({ path: { id: sessionId }, query: { directory: options.projectDir }, signal: options.signal });
      if (existing.error || !existing.data) sessionId = undefined;
    }
    if (!sessionId) {
      const created = await server.client.session.create({
        body: { title: `Paper2Experiment coding ${new Date().toISOString()}` },
        query: { directory: options.projectDir },
        signal: options.signal
      });
      if (created.error || !created.data) throw new Error(`OpenCode: не удалось создать сессию: ${redactSecrets(apiErrorText(created.error ?? 'пустой ответ'))}`);
      sessionId = created.data.id;
      activeSessionId = sessionId;
      await options.onSession?.(sessionId);
    } else {
      activeSessionId = sessionId;
      await options.onSession?.(sessionId);
    }
    options.signal.throwIfAborted();
    const response = await server.client.session.prompt({
      path: { id: sessionId },
      query: { directory: options.projectDir },
      body: {
        model,
        parts: [{ type: 'text' as const, text: options.prompt }]
      },
      signal: options.signal
    });
    if (response.error || !response.data) throw new Error(`OpenCode: ${redactSecrets(apiErrorText(response.error ?? 'пустой ответ модели'))}`);
    const info = response.data.info;
    if (info.error?.name === 'ProviderAuthError') throw new SetupRequiredError(`OpenCode: провайдер отклонил учётные данные: ${redactSecrets(apiErrorText(info.error))}`);
    if (info.error) throw new Error(`OpenCode: ${redactSecrets(apiErrorText(info.error))}`);
    const text = response.data.parts
      .flatMap(part => (part.type === 'text' ? [part.text] : []))
      .join('\n')
      .trim();
    const toolErrors = response.data.parts.flatMap(part => {
      if (part.type !== 'tool' || part.state.status !== 'error') return [];
      return [`${part.tool}: ${redactSecrets(part.state.error)}`];
    });
    if (!text && !response.data.parts.length) throw new Error('OpenCode: модель завершилась без ответа');
    return { sessionId, text, toolErrors };
  } catch (error) {
    if (options.signal.aborted) {
      const reason = options.signal.reason instanceof Error ? options.signal.reason.message : 'отменено';
      throw new Error(`OpenCode worker остановлен: ${reason}`);
    }
    if (error instanceof SetupRequiredError) throw error;
    throw new Error(redactSecrets(error instanceof Error ? error.message : String(error)));
  } finally {
    options.signal.removeEventListener('abort', abort);
    await server.close();
  }
}

export interface OpenCodeProbe {
  url: string;
  version: string;
  authProviders: string[];
  configProviders: number;
  healthy: boolean;
  warning?: string;
}

/**
 * Explicit smoke hook: starts the pinned headless server once, checks its HTTP health and shuts it
 * down. It never prompts a model, so it also works without provider credentials. Normal snapshots
 * must use openCodeStatus() instead of starting a server.
 */
export async function probeOpenCodeServer(settings: AppSettings, options: { projectDir?: string; signal?: AbortSignal } = {}): Promise<OpenCodeProbe> {
  const projectDir = options.projectDir ?? os.tmpdir();
  await mkdir(projectDir, { recursive: true });
  const signal = options.signal ?? AbortSignal.timeout(30_000);
  const binary = openCodeBinary();
  const auth = detectOpenCodeAuth();
  const server = await startOpenCodeServer({ projectDir, settings, signal });
  try {
    const response = await server.client.config.get({ signal: AbortSignal.timeout(10_000) });
    if (response.error || !response.data) throw new Error(`OpenCode health: ${redactSecrets(apiErrorText(response.error ?? 'пустой ответ'))}`);
    const providers = await server.client.config.providers({ query: { directory: projectDir }, signal: AbortSignal.timeout(10_000) });
    if (providers.error || !providers.data) throw new Error(`OpenCode providers: ${redactSecrets(apiErrorText(providers.error ?? 'пустой ответ'))}`);
    return {
      url: server.url,
      version: binary.version,
      authProviders: auth.providers,
      configProviders: providers.data.providers.length,
      healthy: true,
      warning: server.warning
    };
  } finally {
    await server.close();
  }
}
