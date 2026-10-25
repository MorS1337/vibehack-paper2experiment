import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Model } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
  createBashToolDefinition,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION as PI_VERSION,
  type AgentSession,
  type ToolDefinition
} from '@earendil-works/pi-coding-agent';
import { SetupRequiredError } from '../shared/errors.js';
import { SpecSchema } from '../shared/types.js';
import type { AppSettings, ComputeContext, ConnectionStatus, ExperimentRun, ExperimentSpec } from '../shared/types.js';
import { executionEnv } from '../compute/process.js';

const PLAN_TIMEOUT_MS = 180_000;
const REPORT_TIMEOUT_MS = 180_000;
const CODE_TIMEOUT_MS = 600_000;
const STATUS_TIMEOUT_MS = 15_000;
const MAX_SOURCE_CHARS = 220_000;
const moduleRequire = createRequire(path.join(process.cwd(), 'package.json'));

export interface PiAgentContext {
  run: ExperimentRun;
  settings: AppSettings;
  signal: AbortSignal;
  emit: ComputeContext['emit'];
}

export interface PiCodeAgentContext extends PiAgentContext {
  projectDir: string;
  repair?: string;
}

interface Deadline {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
}

function createDeadline(parent: AbortSignal, timeoutMs: number, label: string): Deadline {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(parent.reason ?? new Error('Отменено'));
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`${label}: превышен лимит ${Math.round(timeoutMs / 1000)} с`));
  }, timeoutMs);
  if (parent.aborted) onAbort();
  else parent.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', onAbort);
    }
  };
}

function errorMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const [name, value] of Object.entries(process.env)) {
    if (value && value.length >= 8 && /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name)) message = message.split(value).join('[redacted]');
  }
  return message;
}

function asAgentError(error: unknown): Error {
  const message = errorMessage(error);
  return error instanceof SetupRequiredError ? new SetupRequiredError(message) : new Error(message);
}

async function emitSafe(context: PiAgentContext, type: 'agent' | 'log' | 'error' | 'compaction' | 'artifact', message: string): Promise<void> {
  try {
    await context.emit(type, errorMessage(message).slice(0, 2_000));
  } catch {
    // A vanished run must not mask the original agent failure.
  }
}

function smartCompactPackage(): { version: string; extensionPath: string } {
  const packageJson = moduleRequire.resolve('smartcompact/package.json');
  const parsed: unknown = JSON.parse(readFileSync(packageJson, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || typeof parsed.version !== 'string') {
    throw new Error(`SmartCompact: в ${packageJson} отсутствует version`);
  }
  const extensionPath = path.join(path.dirname(packageJson), 'adapters', 'pi', 'index.ts');
  if (!existsSync(extensionPath)) throw new Error(`SmartCompact: расширение не найдено по пути ${extensionPath}`);
  return { version: parsed.version, extensionPath };
}

export interface SmartCompactProbe {
  version: string;
  extensionPath: string;
  loaded: boolean;
  extensionCount: number;
  errors: Array<{ path: string; error: string }>;
  warnings: Array<{ path: string; warning: string }>;
}

let smartCompactProbeCache: Promise<SmartCompactProbe> | undefined;

async function loadSmartCompactProbe(): Promise<SmartCompactProbe> {
  const info = smartCompactPackage();
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    additionalExtensionPaths: [info.extensionPath],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    settingsManager: SettingsManager.inMemory({})
  });
  await loader.reload();
  const result = loader.getExtensions();
  return {
    version: info.version,
    extensionPath: info.extensionPath,
    loaded: result.extensions.length > 0,
    extensionCount: result.extensions.length,
    errors: result.errors,
    warnings: result.warnings ?? []
  };
}

/**
 * Explicit smoke hook for the real npm extension load. It does not need provider credentials and
 * never asks the model to compact anything.
 */
export function probeSmartCompact(): Promise<SmartCompactProbe> {
  smartCompactProbeCache ??= loadSmartCompactProbe().catch(error => {
    throw new Error(`SmartCompact: реальная загрузка расширения не удалась: ${errorMessage(error)}`);
  });
  return smartCompactProbeCache;
}

async function smartCompactStatus(): Promise<ConnectionStatus> {
  try {
    const probe = await probeSmartCompact();
    if (probe.errors.length) {
      return { component: 'smartcompact', state: 'error', detail: `Ошибки загрузки: ${probe.errors.slice(0, 3).map(entry => `${path.basename(entry.path)}: ${errorMessage(entry.error)}`).join('; ')}` };
    }
    if (!probe.loaded) return { component: 'smartcompact', state: 'error', detail: `SmartCompact ${probe.version} не зарегистрировал ни одного расширения (${probe.extensionPath}).` };
    const warnings = probe.warnings.length ? `; предупреждений: ${probe.warnings.length}` : '';
    return { component: 'smartcompact', state: 'ready', detail: `SmartCompact ${probe.version} загружен из ${probe.extensionPath}${warnings}. Пассивно сообщает о реальных событиях компакции.` };
  } catch (error) {
    return { component: 'smartcompact', state: 'error', detail: errorMessage(error) };
  }
}

interface PiModelSelection {
  runtime: ModelRuntime;
  model: Model<any>;
  authSource: string;
}

async function selectPiModel(settings: AppSettings, signal: AbortSignal): Promise<PiModelSelection> {
  const runtime = await ModelRuntime.create({ signal });
  const provider = settings.piProvider.trim();
  const modelId = settings.piModel.trim();
  if (Boolean(provider) !== Boolean(modelId)) throw new SetupRequiredError('pi: укажите и провайдера, и модель (или оставьте оба поля пустыми для выбора доступной модели).');
  if (provider) {
    if (!runtime.getProvider(provider)) throw new SetupRequiredError(`pi: провайдер «${provider}» не найден в каталоге моделей. Проверьте настройки или выполните /login.`);
    const available = await runtime.getAvailable(provider, { signal });
    if (!available.length) {
      const auth = runtime.getProviderAuthStatus(provider);
      if (!auth.configured) throw new SetupRequiredError(`pi: для провайдера «${provider}» нет учётных данных. Выполните pi, затем /login ${provider} (OAuth или API-ключ), или задайте переменную окружения провайдера.`);
      throw new SetupRequiredError(`pi: у провайдера «${provider}» нет доступных чат-моделей. Проверьте модели и лимиты ключа.`);
    }
    if (!available.some(model => model.id === modelId)) throw new SetupRequiredError(`pi: модель «${provider}/${modelId}» недоступна с текущими учётными данными.`);
  }
  const available = provider ? await runtime.getAvailable(provider, { signal }) : await runtime.getAvailable(undefined, { signal });
  const selected = provider ? runtime.getModel(provider, modelId) : available[0];
  if (!selected) {
    const configured = runtime.getProviders().filter(entry => runtime.getProviderAuthStatus(entry.id).configured).map(entry => entry.id);
    if (!configured.length) throw new SetupRequiredError('pi: не найдено ни одного провайдера с учётными данными. Выполните pi, затем /login (OAuth или API-ключ), или задайте переменную окружения провайдера.');
    throw new SetupRequiredError(`pi: нет доступной модели. Настроены провайдеры: ${configured.join(', ')}. Выберите провайдера и модель в настройках.`);
  }
  const auth = runtime.getProviderAuthStatus(selected.provider);
  return { runtime, model: selected, authSource: auth.source === 'stored' ? 'auth.json/OAuth' : auth.source === 'environment' ? 'переменная окружения' : auth.source === 'runtime' ? 'ключ процесса' : auth.label ?? 'настроено' };
}

async function piStatus(settings: AppSettings): Promise<ConnectionStatus> {
  try {
    const selection = await selectPiModel(settings, AbortSignal.timeout(STATUS_TIMEOUT_MS));
    return {
      component: 'pi',
      state: 'ready',
      detail: `pi ${PI_VERSION}; модель ${selection.model.provider}/${selection.model.id}; учётные данные: ${selection.authSource}.`
    };
  } catch (error) {
    const message = errorMessage(error);
    if (error instanceof SetupRequiredError) return { component: 'pi', state: 'needs_setup', detail: message };
    return { component: 'pi', state: 'error', detail: message };
  }
}

/** Snapshot-safe health check; it does not perform model inference. */
export async function getAgentStatuses(settings: AppSettings): Promise<ConnectionStatus[]> {
  return Promise.all([
    piStatus(settings).catch(error => ({ component: 'pi' as const, state: 'error' as const, detail: errorMessage(error) })),
    smartCompactStatus()
  ]);
}

async function createPiSession(context: PiAgentContext, options: {
  cwd: string;
  systemPrompt: string;
  tools: string[];
  customTools?: ToolDefinition<any, any, any>[];
  signal: AbortSignal;
}): Promise<{ session: AgentSession; close: () => void }> {
  const selection = await selectPiModel(context.settings, options.signal);
  const smartcompact = smartCompactPackage();
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: getAgentDir(),
    additionalExtensionPaths: [smartcompact.extensionPath],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    settingsManager: SettingsManager.inMemory({}),
    systemPrompt: options.systemPrompt
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  for (const entry of loaded.errors.slice(0, 3)) await emitSafe(context, 'error', `SmartCompact не загрузился (${entry.path}): ${entry.error}`);
  for (const entry of (loaded.warnings ?? []).slice(0, 3)) await emitSafe(context, 'log', `SmartCompact: ${entry.warning}`);

  const { session } = await createAgentSession({
    cwd: options.cwd,
    modelRuntime: selection.runtime,
    model: selection.model,
    tools: options.tools,
    customTools: options.customTools,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(options.cwd),
    settingsManager: SettingsManager.inMemory({})
  });
  const unsubscribe = session.subscribe(event => {
    if (event.type === 'tool_execution_start') void emitSafe(context, 'agent', `pi выполняет инструмент ${event.toolName}`);
    if (event.type === 'tool_execution_end') void emitSafe(context, event.isError ? 'error' : 'agent', `pi: ${event.toolName} ${event.isError ? 'завершился ошибкой' : 'завершён'}`);
    if (event.type === 'compaction_start') void emitSafe(context, 'compaction', `pi начал компакцию (${event.reason}); SmartCompact не форсирует её.`);
    if (event.type === 'compaction_end') {
      const freed = event.result ? ` до ~${event.result.estimatedTokensAfter ?? '?'} токенов (было ${event.result.tokensBefore})` : '';
      void emitSafe(context, 'compaction', event.errorMessage ? `pi: компакция не удалась (${event.reason}): ${event.errorMessage}` : `pi завершил компакцию (${event.reason})${freed}${event.aborted ? ', прервана' : ''}.`);
    }
  });
  try {
    await session.bindExtensions({
      mode: 'print',
      abortHandler: () => {
        void session.abort().catch(() => undefined);
      },
      onError: error => {
        void emitSafe(context, 'error', `Расширение pi (${error.event || 'event'}): ${error.error}`);
      }
    });
  } catch (error) {
    unsubscribe();
    session.dispose();
    throw error;
  }
  return {
    session,
    close: () => {
      unsubscribe();
      session.dispose();
    }
  };
}

function abortMessage(deadline: Deadline, label: string, signal: AbortSignal): Error {
  if (deadline.timedOut()) return new Error(`${label}: превышен лимит времени`);
  const reason = signal.reason;
  return new Error(`${label}: ${reason instanceof Error ? reason.message : 'отменено'}`);
}

async function promptPi(session: AgentSession, text: string, deadline: Deadline, label: string, allowEmpty = false): Promise<string> {
  if (deadline.signal.aborted) throw abortMessage(deadline, label, deadline.signal);
  const onAbort = () => {
    void session.abort().catch(() => undefined);
  };
  deadline.signal.addEventListener('abort', onAbort, { once: true });
  try {
    await session.prompt(text, { expandPromptTemplates: false });
  } catch (error) {
    if (deadline.signal.aborted) throw abortMessage(deadline, label, deadline.signal);
    throw new Error(`${label}: ${errorMessage(error)}`);
  } finally {
    deadline.signal.removeEventListener('abort', onAbort);
  }
  if (deadline.signal.aborted) throw abortMessage(deadline, label, deadline.signal);
  const answer = session.getLastAssistantText()?.trim() ?? '';
  if (!answer && !allowEmpty) throw new Error(`${label}: pi завершил работу без текстового ответа.`);
  return answer;
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  if (start < 0) throw new Error('в ответе нет JSON-объекта');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < candidate.length; index += 1) {
    const char = candidate[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(candidate.slice(start, index + 1));
    }
  }
  throw new Error('JSON-объект в ответе не закрыт');
}

function normalized(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function demoParameterIssues(parameters: Record<string, unknown>): string[] {
  const issues: string[] = [];
  const p = parameters.p;
  const epsilon = parameters.epsilon;
  if (typeof p !== 'number' || !(p > 0 && p < 1)) issues.push('parameters.p должен быть числом 0<p<1');
  if (typeof epsilon !== 'number' || !(epsilon > 0 && epsilon <= 1)) issues.push('parameters.epsilon должен быть числом 0<epsilon<=1');
  if (typeof p === 'number' && typeof epsilon === 'number' && p + epsilon > 1) issues.push('parameters: требуется p+epsilon<=1');
  const nValues = parameters.n_values;
  if (!Array.isArray(nValues) || nValues.length < 2 || nValues.length > 32 || !nValues.every(value => Number.isSafeInteger(value) && value >= 1 && value <= 100_000)) {
    issues.push('parameters.n_values должен быть массивом из 2..32 целых n в [1,100000]');
  } else {
    for (let index = 1; index < nValues.length; index += 1) {
      if (nValues[index] <= nValues[index - 1]) { issues.push('parameters.n_values должен строго возрастать'); break; }
    }
  }
  const trials = parameters.trials_per_n;
  if (typeof trials !== 'number' || !Number.isSafeInteger(trials) || trials < 1 || trials > 200_000) issues.push('parameters.trials_per_n должен быть целым в [1,200000]');
  if (Array.isArray(nValues) && typeof trials === 'number' && nValues.length * trials > 2_000_000) issues.push('parameters: n_values.length * trials_per_n превышает 2 000 000 строк');
  if (Array.isArray(nValues) && typeof epsilon === 'number') {
    for (const value of nValues) {
      if (typeof value === 'number' && !(Math.exp(-2 * value * epsilon * epsilon) > 0)) {
        issues.push('parameters: exp(-2*n*epsilon^2) должно быть представимо больше нуля для всех n');
        break;
      }
    }
  }
  const seed = parameters.seed;
  if (typeof seed !== 'number' || !Number.isSafeInteger(seed) || seed < 0 || seed > 4_294_967_295) issues.push('parameters.seed должен быть целым в [0,4294967295]');
  const primaryN = parameters.primary_n;
  if (typeof primaryN !== 'number' || !Number.isSafeInteger(primaryN)) issues.push('parameters.primary_n должен быть целым n');
  else if (Array.isArray(nValues) && !nValues.includes(primaryN)) issues.push('parameters.primary_n должен входить в n_values');
  if (parameters.tail_side !== 'greater') issues.push('parameters.tail_side должен быть "greater"');
  return issues;
}

function planIssues(spec: ExperimentSpec, run: ExperimentRun): string[] {
  const issues: string[] = [];
  for (const ref of spec.sourceRefs) {
    const page = run.source?.pages.find(entry => entry.page === ref.page);
    if (!page) issues.push(`sourceRefs: страницы ${ref.page} нет в импортированном документе`);
    else if (!normalized(page.text).includes(normalized(ref.quote))) issues.push(`sourceRefs: цитата не найдена дословно на странице ${ref.page}`);
  }
  if (spec.implementation === 'author' && !run.input.authorRepo) issues.push('implementation: author допустим только при заданном authorRepo; иначе independent');
  if (run.input.authorRepo && spec.implementation === 'author' && !/^https:\/\//.test(run.input.authorRepo)) issues.push('authorRepo должен быть HTTPS URL');
  if (spec.demo === 'bernoulli-hoeffding') {
    issues.push(...demoParameterIssues(spec.parameters));
    if (spec.metric.publishedValue !== null || spec.metric.comparable) issues.push('демо не воспроизводит опубликованное число: publishedValue=null, comparable=false');
    if (spec.implementation !== 'independent') issues.push('демо реализуется независимо: implementation="independent"');
  }
  return issues;
}

function buildPlanPrompt(run: ExperimentRun): string {
  if (!run.source?.pages.length) throw new Error('pi: источник ещё не импортирован, планирование невозможно.');
  const fullSource = run.source.pages.map(page => `\n=== СТРАНИЦА ${page.page} ===\n${page.text}`).join('\n');
  const source = fullSource.length > MAX_SOURCE_CHARS
    ? `${fullSource.slice(0, MAX_SOURCE_CHARS)}\n\n[... текст источника обрезан по бюджету; цитируйте только показанные страницы ...]`
    : fullSource;
  return [
    'Составь проверяемый план воспроизведения научного эксперимента. Верни ТОЛЬКО один JSON-объект по схеме ExperimentSpec, без markdown и комментариев.',
    'Все строки, кроме дословных цитат, пиши по-русски. Цитаты sourceRefs должны дословно присутствовать на указанной странице (нормализуются только пробелы и регистр).',
    'Не выдумывай страницы, цитаты, опубликованные числа или данные. Если чего-то нет в статье, укажи это в missing и assumptions.',
    '',
    'Схема (все поля обязательны):',
    JSON.stringify({
      version: 1,
      title: 'короткое название',
      objective: 'что именно воспроизводим',
      paperResult: 'главный результат статьи',
      sourceRefs: [{ page: 1, quote: 'дословная цитата со страницы 1' }],
      data: { description: 'данные', split: 'разбиение', preprocessing: 'обработка' },
      method: 'метод',
      baseline: 'сравнение/базовая линия',
      parameters: { name: 'значение или описание' },
      metric: { name: 'имя_метрики', computation: 'как считается', publishedValue: null, comparable: false },
      requirements: { cpuCores: 1, ramGB: 1, gpu: false, vramGB: 0, diskGB: 1 },
      limits: { timeSeconds: run.input.timeSeconds, maxHourlyUSD: run.input.maxHourlyUSD, maxTotalUSD: run.input.maxTotalUSD },
      implementation: run.input.authorRepo ? 'author' : 'independent',
      assumptions: [],
      missing: [],
      demo: null
    }, null, 2),
    '',
    `Задача пользователя: ${run.input.task}`,
    `Режим вычислений: ${run.input.mode}; лимиты: ${run.input.timeSeconds} с, $${run.input.maxHourlyUSD}/ч, всего $${run.input.maxTotalUSD}.`,
    run.input.dataDir ? `Данные пользователя: ${run.input.dataDir}` : 'Отдельная папка данных не задана.',
    run.input.authorRepo ? `Авторский репозиторий: ${run.input.authorRepo}. implementation должен быть "author".` : 'Авторский репозиторий не задан. implementation должен быть "independent".',
    'demo: "bernoulli-hoeffding" только если задача прямо просит воспроизвести встроенное демо Бернулли–Хёффдинга; иначе null.',
    'Если demo="bernoulli-hoeffding", parameters обязан содержать ключи p, epsilon, n_values, trials_per_n, seed, primary_n, tail_side со значениями, точно указанными в задаче; не подставляй значения по умолчанию. metric publishedValue=null, comparable=false, implementation="independent".',
    'limits должны точно совпадать с лимитами выше. requirements — реалистичные ресурсы метода; gpu=true только если он действительно нужен.',
    '',
    'ИСТОЧНИК:',
    source
  ].join('\n');
}

function buildPlanCorrection(issues: string[], previous: string): string {
  return [
    'Предыдущий JSON не прошёл проверку. Исправь его и верни ТОЛЬКО полный JSON-объект ExperimentSpec, без markdown.',
    `Ошибки: ${issues.join('; ')}`,
    'Не добавляй выдуманные цитаты. Если ошибка в sourceRefs, скопируй дословный фрагмент с существующей страницы.',
    'Предыдущий ответ:',
    previous.slice(-20_000)
  ].join('\n');
}

export async function planWithPi(context: PiAgentContext): Promise<ExperimentSpec> {
  const deadline = createDeadline(context.signal, PLAN_TIMEOUT_MS, 'План pi');
  try {
    const opened = await createPiSession(context, {
      cwd: context.run.dir,
      systemPrompt: 'Ты планировщик научного эксперимента. Ты не пишешь код и не запускаешь вычисления. Возвращай только валидный JSON ExperimentSpec. Никогда не выдумывай источник, цитаты, числа или данные.',
      tools: [],
      signal: deadline.signal
    });
    try {
      let answer = await promptPi(opened.session, buildPlanPrompt(context.run), deadline, 'План pi');
      let lastIssues: string[] = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const parsed = extractJson(answer);
          const checked = SpecSchema.safeParse(parsed);
          lastIssues = checked.success ? planIssues(checked.data, context.run) : checked.error.issues.map(issue => `${issue.path.join('.') || 'spec'}: ${issue.message}`);
          if (checked.success && lastIssues.length === 0) return checked.data;
        } catch (error) {
          lastIssues = [errorMessage(error)];
        }
        if (attempt === 0) {
          await emitSafe(context, 'agent', `План pi требует исправлений: ${lastIssues.slice(0, 4).join('; ')}`);
          answer = await promptPi(opened.session, buildPlanCorrection(lastIssues, answer), deadline, 'План pi');
        }
      }
      throw new Error(`pi не вернул валидный план: ${lastIssues.slice(0, 8).join('; ')}`);
    } finally {
      opened.close();
    }
  } catch (error) {
    if (!context.signal.aborted) await emitSafe(context, 'error', `План pi: ${errorMessage(error)}`);
    throw asAgentError(error);
  } finally {
    deadline.cleanup();
  }
}

function invalidProjectPath(value: string): boolean {
  const normalizedPath = value.replaceAll('\\', '/');
  if (!normalizedPath.trim() || normalizedPath.includes('\0')) return true;
  if (normalizedPath.startsWith('/') || /^[A-Za-z]:/.test(normalizedPath)) return true;
  return normalizedPath.split('/').some(segment => !segment || segment === '.' || segment === '..');
}

const ProjectManifestSchema = z.object({
  entryPoint: z.string().min(1),
  config: z.string().min(1),
  requirements: z.string().min(1),
  artifacts: z.array(z.string().min(1)).min(1)
}).passthrough();
const ProjectConfigSchema = z.record(z.string(), z.unknown());
const ProvenanceSchema = z.object({ repo: z.string().min(1), commit: z.string().min(1) }).passthrough();

async function projectIssues(projectDir: string, context: PiCodeAgentContext): Promise<string[]> {
  const issues: string[] = [];
  let manifest: z.infer<typeof ProjectManifestSchema>;
  try {
    const parsed = ProjectManifestSchema.safeParse(JSON.parse(await readFile(path.join(projectDir, 'experiment.json'), 'utf8')));
    if (!parsed.success) return parsed.error.issues.map(issue => `experiment.json.${issue.path.join('.') || 'root'}: ${issue.message}`);
    manifest = parsed.data;
  } catch (error) {
    return [`experiment.json отсутствует или не читается: ${errorMessage(error)}`];
  }
  for (const [key, value] of Object.entries({ entryPoint: manifest.entryPoint, config: manifest.config, requirements: manifest.requirements })) {
    if (invalidProjectPath(value)) issues.push(`experiment.json: ${key} должен быть простым относительным путём (${value})`);
  }
  const artifactPaths: string[] = [];
  for (const [index, value] of manifest.artifacts.entries()) {
    if (invalidProjectPath(value)) issues.push(`experiment.json: artifacts[${index}] должен быть относительным путём (${value})`);
    else artifactPaths.push(value.replaceAll('\\', '/'));
  }
  if (!artifactPaths.some(value => path.posix.basename(value) === 'metrics.json')) issues.push('experiment.json: artifacts обязан объявлять metrics.json (относительно project/artifacts)');
  if (context.run.spec?.demo === 'bernoulli-hoeffding') {
    for (const required of ['metrics.json', 'samples.csv', 'plot.svg']) {
      if (!artifactPaths.includes(required)) issues.push(`experiment.json: демо обязано объявлять artifacts/${required}`);
    }
  }
  for (const [label, relative] of [['entryPoint', manifest.entryPoint], ['config', manifest.config], ['requirements', manifest.requirements]] as const) {
    if (invalidProjectPath(relative)) continue;
    const info = await stat(path.join(projectDir, relative)).catch(() => undefined);
    if (!info?.isFile()) issues.push(`${label} не найден в project: ${relative}`);
  }
  if (context.run.spec && !invalidProjectPath(manifest.config)) {
    try {
      const parsed = ProjectConfigSchema.safeParse(JSON.parse(await readFile(path.join(projectDir, manifest.config), 'utf8')));
      if (!parsed.success) issues.push(`config.json: ${parsed.error.issues.map(issue => issue.message).join('; ')}`);
      else {
        for (const [key, expected] of Object.entries(context.run.spec.parameters)) {
          if (!(key in parsed.data)) issues.push(`config.json: отсутствует научный параметр ${key}`);
          else if (!isDeepStrictEqual(parsed.data[key], expected)) issues.push(`config.json: ${key} не совпадает с замороженным plan.parameters`);
        }
      }
    } catch (error) {
      issues.push(`config.json не читается: ${errorMessage(error)}`);
    }
  }
  try {
    const frozenPlan: unknown = JSON.parse(await readFile(path.join(projectDir, 'plan.json'), 'utf8'));
    if (!isDeepStrictEqual(frozenPlan, context.run.spec)) issues.push('plan.json изменён или отсутствует: научный план заморожен, создайте новую версию плана через интерфейс');
  } catch (error) {
    issues.push(`plan.json не читается: ${errorMessage(error)}`);
  }
  if (context.run.input.authorRepo && context.run.spec?.implementation === 'author') {
    try {
      const parsed = ProvenanceSchema.safeParse(JSON.parse(await readFile(path.join(projectDir, 'provenance.json'), 'utf8')));
      if (!parsed.success) issues.push(`provenance.json: ${parsed.error.issues.map(issue => issue.message).join('; ')}`);
    } catch {
      issues.push('provenance.json отсутствует: авторский репозиторий должен быть реально склонирован, а commit записан');
    }
  }
  return issues;
}

const DEMO_CODE_CONTRACT = [
  'Замороженный контракт демо Бернулли–Хёффдинга:',
  '- experiment.json: entryPoint "main.py", config "config.json", requirements "requirements.txt", artifacts ровно ["metrics.json","samples.csv","plot.svg"]; все пути относительны project/, артефакты — относительно project/artifacts/.',
  '- config.json: научные ключи верхнего уровня должны точно совпадать с plan.parameters (p, epsilon, n_values, trials_per_n, seed, primary_n, tail_side); дополнительные служебные ключи допустимы, но не противоречат плану.',
  '- artifacts/samples.csv: заголовок ровно "trial,successes,n,p,epsilon"; для каждого n — все trials 1..trials_per_n, successes 0..n, p и epsilon в каждой строке равны конфигу, детерминированный PRNG от seed. Хвостовое событие: successes >= ceil(n*(p+epsilon)-1e-12).',
  '- artifacts/metrics.json: плоский объект только из конечных чисел. Обязательны: empirical_tail_probability, hoeffding_bound, exact_binomial_tail_probability, bound_minus_empirical, bound_minus_exact, empirical_to_bound_ratio, monte_carlo_standard_error = sqrt(theta*(1-theta)/trials_per_n), где theta — основная эмпирическая оценка хвоста (не выборочная дисперсия с n-1), max_empirical_minus_bound, all_exact_tails_within_bound, tail_count_primary, n_primary, p, epsilon, trials_per_n, seed, n_configurations, total_rows. Не округляй агрессивно.',
  '- artifacts/plot.svg: самостоятельный SVG без скриптов, минимум две серии/метки (circle/polyline/path), показывающие empirical, Hoeffding и exact; читаемые подписи серий и осей n/probability нужны человеку, но не проверяются дословно.',
  '- stdout.log создаёт вычислитель; печатай краткий JSON-итог, stderr — только ошибки. requirements.txt может быть только комментарием: стандартная библиотека предпочтительна.',
  '- Не копируй reference/ из demos: эталоны служат только для smoke-теста; файлы проекта должен создать ты сам. publishedValue не воспроизводится, comparable=false.'
].join('\n');

function buildCodePrompt(context: PiCodeAgentContext): string {
  const spec = context.run.spec;
  if (!spec) throw new Error('План эксперимента отсутствует: кодирование невозможно.');
  const manifest = { entryPoint: 'main.py', config: 'config.json', requirements: 'requirements.txt', artifacts: ['metrics.json', '<другие относительные артефакты>'] };
  return [
    'Ты автономный инженер-исполнитель. Работай только в текущем каталоге проекта. Ты должен реально создать и проверить файлы, а не описывать намерения.',
    'Не читай и не копируй ~/.pi, auth.json, ключи, токены, переменные Vast/Jev. Не выходи за каталог проекта и не меняй plan.json: научный план заморожен.',
    '',
    'КОНТРАКТ ИСПОЛНЕНИЯ:',
    `- experiment.json в корне: ${JSON.stringify(manifest)}; artifacts — пути относительно каталога artifacts/ (например "metrics.json").`,
    '- main.py запускается как `python main.py --config config.json`, читает замороженные научные значения из config.json (не переписывает их) и пишет результаты в artifacts/.',
    '- artifacts/metrics.json — JSON-объект, все значения которого конечные числа; обязательно содержит метрику плана.',
    '- config.json: каждый ключ из plan.parameters обязан присутствовать на верхнем уровне с тем же значением; вычислителю запрещено менять научные параметры.',
    '- Все обязательные пути — простые относительные, без абсолютных путей и ".."; stdout.log/stderr.log пишутся в корень project вычислителем.',
    '- requirements.txt содержит реальные зависимости; config.json — валидный JSON.',
    '',
    ...(spec.demo === 'bernoulli-hoeffding' ? [DEMO_CODE_CONTRACT, ''] : []),
    'НАУЧНЫЙ ПЛАН (не изменять plan.json):',
    JSON.stringify(spec, null, 2),
    '',
    context.run.input.authorRepo && spec.implementation === 'author'
      ? `РЕАЛЬНЫЙ АВТОРСКИЙ ИСТОЧНИК: склонируй ${context.run.input.authorRepo} в подкаталог author-source/ внутри проекта (git clone), используй его код, запиши provenance.json с полями repo, commit (git rev-parse HEAD), clonedAt. Не выдумывай реализацию вместо репозитория.`
      : 'Авторский репозиторий не используется: реализуй метод независимо по плану.',
    context.repair ? `\nТЕХНИЧЕСКАЯ ПОЧИНКА (stderr эксперимента):\n${context.repair.slice(-18_000)}` : '',
    '',
    'Используй свои инструменты read/write/edit/bash и действительно создай файлы. Допустима только проверка синтаксиса. Не запускай эксперимент: исполнение, установка зависимостей, аренда и лимиты принадлежат harness.'
  ].join('\n');
}


function buildCodeCorrection(issues: string[]): string {
  return [
    'Проверка проекта не прошла. Используй свои файловые инструменты и исправь реальные файлы. Не меняй plan.json и научные параметры.',
    `Ошибки: ${issues.join('; ')}`,
    'Обязательный контракт: experiment.json, main.py, config.json, requirements.txt и artifacts/metrics.json с числовым объектом; artifacts — относительно project/artifacts.'
  ].join('\n');
}


export async function codeWithPi(context: PiCodeAgentContext): Promise<void> {
  const deadline = createDeadline(context.signal, CODE_TIMEOUT_MS, 'Написание кода pi');
  await mkdir(context.projectDir, { recursive: true });
  const tools = [
    createReadToolDefinition(context.projectDir),
    createWriteToolDefinition(context.projectDir),
    createEditToolDefinition(context.projectDir),
    createBashToolDefinition(context.projectDir, { exposeSessionEnvironment: false, spawnHook: spawn => ({ ...spawn, cwd: context.projectDir, env: executionEnv() }) })
  ];
  try {
    const opened = await createPiSession(context, {
      cwd: context.projectDir,
      systemPrompt: 'Ты исследовательский coding-агент pi. Сам создавай и исправляй файлы в рабочем каталоге через read/write/edit/bash. Не обращайся к секретам, не арендуй ресурсы, не запускай эксперимент и не меняй plan.json. Научный план и лимиты контролирует harness.',
      tools: tools.map(tool => tool.name),
      customTools: tools,
      signal: deadline.signal
    });
    try {
      await emitSafe(context, 'agent', 'Pi готовит код собственными файловыми и shell-инструментами.');
      await promptPi(opened.session, buildCodePrompt(context), deadline, 'Написание кода pi', true);
      let issues = await projectIssues(context.projectDir, context);
      if (issues.length) {
        await emitSafe(context, 'error', `Проверка проекта: ${issues.slice(0, 5).join('; ')}`);
        await promptPi(opened.session, buildCodeCorrection(issues), deadline, 'Починка проекта pi', true);
        issues = await projectIssues(context.projectDir, context);
      }
      if (issues.length) throw new Error(`Контракт проекта не выполнен: ${issues.slice(0, 8).join('; ')}`);
      await emitSafe(context, 'agent', 'Файлы проекта pi проверены: manifest, точка входа, замороженный конфиг, зависимости и план.');
    } finally {
      opened.close();
    }
  } catch (error) {
    if (!context.signal.aborted) await emitSafe(context, 'error', `Написание кода pi: ${errorMessage(error)}`);
    throw asAgentError(error);
  } finally {
    deadline.cleanup();
  }
}

function buildReportPrompt(run: ExperimentRun): string {
  const spec = run.spec;
  if (!spec) throw new Error('pi: нет плана эксперимента для отчёта.');
  const metrics = run.metrics ? JSON.stringify(run.metrics, null, 2) : 'метрики отсутствуют';
  const artifacts = run.artifacts.length
    ? run.artifacts.map(artifact => `- ${artifact.path} (${artifact.bytes} байт, ${artifact.kind}, SHA256 ${artifact.sha256.slice(0, 16)}…)`).join('\n')
    : 'артефакты отсутствуют';
  return [
    'Составь итоговый научный отчёт на русском в Markdown. Не выдумывай числа и не обещай того, чего нет в данных.',
    'Структура: цель, метод, фактические метрики, сравнение с опубликованным результатом (если comparable), проверка артефактов, ограничения и следующий шаг.',
    `Название: ${spec.title}`,
    `Цель: ${spec.objective}`,
    `Опубликованный результат: ${spec.paperResult}`,
    `Метрика плана: ${spec.metric.name}; вычисление: ${spec.metric.computation}; publishedValue: ${spec.metric.publishedValue ?? 'нет'}; comparable: ${spec.metric.comparable}`,
    `Предположения: ${spec.assumptions.join('; ') || 'нет'}`,
    `Недостающие сведения: ${spec.missing.join('; ') || 'нет'}`,
    '',
    'ФАКТИЧЕСКИЕ МЕТРИКИ:',
    metrics,
    '',
    'АРТЕФАКТЫ:',
    artifacts,
    '',
    'ПРОВЕРКА:',
    run.verification ?? 'проверка не записана',
    '',
    'Если метрика не совпала с публикацией, скажи это прямо и объясни возможные причины. Не используй инструменты.'
  ].join('\n');
}

export async function reportWithPi(context: PiAgentContext): Promise<string> {
  const deadline = createDeadline(context.signal, REPORT_TIMEOUT_MS, 'Отчёт pi');
  try {
    const opened = await createPiSession(context, {
      cwd: context.run.dir,
      systemPrompt: 'Ты научный редактор. Пиши точный отчёт только по предоставленным фактам. Не вызывай инструменты и не выдумывай результаты.',
      tools: [],
      signal: deadline.signal
    });
    try {
      const report = await promptPi(opened.session, buildReportPrompt(context.run), deadline, 'Отчёт pi');
      if (report.length < 80) throw new Error('pi вернул слишком короткий отчёт.');
      return report;
    } finally {
      opened.close();
    }
  } catch (error) {
    if (!context.signal.aborted) await emitSafe(context, 'error', `Отчёт pi: ${errorMessage(error)}`);
    throw asAgentError(error);
  } finally {
    deadline.cleanup();
  }
}
