import { createHash } from 'node:crypto';
import { constants as fsConstants, createReadStream } from 'node:fs';
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { Transform } from 'node:stream';
import type { Artifact, ExperimentRun } from '../shared/types.js';

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_METRICS_BYTES = 4 * 1024 * 1024;
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_PLOT_BYTES = 32 * 1024 * 1024;
const MAX_CSV_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_LOG_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_ARTIFACT_FILES = 1000;
const MAX_CSV_ROWS = 2_000_000;
const MAX_N = 100_000;
const MAX_TRIALS_PER_N = 200_000;

const DEMO_PRIMARY_METRIC = 'empirical_tail_probability';
const DEMO_PARAMETERS = ['p', 'epsilon', 'n_values', 'trials_per_n', 'seed', 'primary_n', 'tail_side'] as const;
const DEMO_METRICS = [
  DEMO_PRIMARY_METRIC,
  'hoeffding_bound',
  'exact_binomial_tail_probability',
  'bound_minus_empirical',
  'bound_minus_exact',
  'empirical_to_bound_ratio',
  'monte_carlo_standard_error',
  'max_empirical_minus_bound',
  'all_exact_tails_within_bound',
  'tail_count_primary',
  'n_primary',
  'p',
  'epsilon',
  'trials_per_n',
  'seed',
  'n_configurations',
  'total_rows'
] as const;

type JsonObject = Record<string, unknown>;

interface DemoConfig {
  p: number;
  epsilon: number;
  nValues: number[];
  trialsPerN: number;
  seed: number;
  primaryN: number;
}

interface SampleStats {
  rows: number;
  tails: number;
  trials: Set<number>;
}

function fail(message: string): never {
  throw new Error(message);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(object: JsonObject, key: string): string {
  const value = object[key];
  if (typeof value !== 'string' || !value.trim()) fail(`experiment.json: поле ${key} должно быть непустой строкой`);
  return value as string;
}

function readNumber(object: JsonObject, key: string, label: string): number {
  const value = object[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label}: ${key} должно быть конечным числом`);
  return value as number;
}

function readInteger(object: JsonObject, key: string, label: string): number {
  const value = readNumber(object, key, label);
  if (!Number.isSafeInteger(value)) fail(`${label}: ${key} должно быть целым числом`);
  return value;
}

/** Rejects absolute paths, traversal segments, symlinks and paths outside the project. */
async function resolveProjectPath(projectDir: string, relative: string, label: string): Promise<string> {
  if (!relative.trim() || relative.includes('\0')) fail(`${label}: некорректный путь`);
  const normalized = relative.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) fail(`${label}: абсолютный путь запрещён (${relative})`);
  const segments = normalized.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    fail(`${label}: подозрительный путь (${relative})`);
  }
  let cursor = projectDir;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    const info = await lstat(cursor).catch(() => fail(`${label}: файл не найден (${relative})`));
    if (info.isSymbolicLink()) fail(`${label}: symlink запрещён (${relative})`);
  }
  const canonical = await realpath(cursor);
  if (canonical !== projectDir && !canonical.startsWith(projectDir + path.sep)) fail(`${label}: путь выходит за каталог проекта (${relative})`);
  return canonical;
}

async function requireRegularFile(projectDir: string, relative: string, label: string, maxBytes: number): Promise<{ file: string; bytes: number }> {
  const file = await resolveProjectPath(projectDir, relative, label);
  const info = await lstat(file);
  if (!info.isFile()) fail(`${label}: требуется обычный файл (${relative})`);
  if (info.size > maxBytes) fail(`${label}: файл превышает лимит ${Math.round(maxBytes / 1024 / 1024)} MiB (${relative})`);
  return { file, bytes: info.size };
}

async function readJsonObject(file: string, label: string, maxBytes: number): Promise<JsonObject> {
  const info = await lstat(file);
  if (!info.isFile()) fail(`${label}: требуется обычный файл`);
  if (info.size > maxBytes) fail(`${label}: файл слишком большой`);
  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    fail(`${label}: некорректный JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!isJsonObject(parsed)) fail(`${label}: ожидается JSON-объект`);
  return parsed;
}

async function sha256File(file: string, label: string, maxBytes: number): Promise<{ sha256: string; bytes: number }> {
  // O_NOFOLLOW closes the lstat/open race: an artifact replaced by a symlink is rejected.
  const handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) fail(`${label}: требуется обычный файл`);
    if (info.size > maxBytes) fail(`${label}: файл превышает лимит`);
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    for (;;) {
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;
      if (bytes > maxBytes) fail(`${label}: размер файла изменился во время чтения`);
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    return { sha256: hash.digest('hex'), bytes };
  } finally {
    await handle.close();
  }
}

function artifactKind(relative: string): Artifact['kind'] {
  const base = path.posix.basename(relative).toLowerCase();
  if (base === 'metrics.json') return 'metrics';
  if (/\.(svg|png|jpe?g|webp|pdf)$/.test(base)) return 'plot';
  if (base === 'config.json' || base === 'experiment.json' || base.endsWith('.config.json')) return 'config';
  if (base.endsWith('.log')) return 'log';
  return 'other';
}

function relativeToRun(runDir: string, file: string): string {
  const relative = path.relative(runDir, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail(`Артефакт вне каталога запуска: ${file}`);
  return relative.split(path.sep).join('/');
}

async function walkArtifactFiles(root: string, current: string, output: string[]): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.' || entry.name === '..') fail('Каталог артефактов содержит некорректное имя');
    const file = path.join(current, entry.name);
    if (entry.isSymbolicLink()) fail(`Артефакт-симлинк запрещён: ${path.relative(root, file)}`);
    if (entry.isDirectory()) {
      await walkArtifactFiles(root, file, output);
      continue;
    }
    if (!entry.isFile()) fail(`Неподдерживаемый тип артефакта: ${path.relative(root, file)}`);
    output.push(file);
    if (output.length > MAX_ARTIFACT_FILES) fail(`Слишком много файлов артефактов (лимит ${MAX_ARTIFACT_FILES})`);
  }
}

function tailThreshold(n: number, p: number, epsilon: number): number {
  // Integer comparison avoids platform-dependent double rounding at successes/n - p == epsilon.
  return Math.min(n + 1, Math.max(0, Math.ceil(n * (p + epsilon) - 1e-12)));
}

function logFactorials(maxN: number): Float64Array {
  const table = new Float64Array(maxN + 1);
  for (let n = 1; n <= maxN; n++) table[n] = table[n - 1] + Math.log(n);
  return table;
}

function binomialUpperTail(n: number, p: number, threshold: number, logFacts: Float64Array): number {
  if (threshold <= 0) return 1;
  if (threshold > n) return 0;
  if (p <= 0 || p >= 1) return 0;
  const logP = Math.log(p);
  const logQ = Math.log1p(-p);
  let sum = 0;
  let compensation = 0;
  for (let k = threshold; k <= n; k++) {
    const logTerm = logFacts[n] - logFacts[k] - logFacts[n - k] + k * logP + (n - k) * logQ;
    const term = Math.exp(logTerm);
    const adjusted = term - compensation;
    const next = sum + adjusted;
    compensation = (next - sum) - adjusted;
    sum = next;
  }
  return Math.min(1, Math.max(0, sum));
}

function validateDemoConfig(config: JsonObject): DemoConfig {
  for (const key of DEMO_PARAMETERS) {
    if (!(key in config)) fail(`config.json: отсутствует научный параметр ${key}`);
  }
  const p = readNumber(config, 'p', 'config.json');
  const epsilon = readNumber(config, 'epsilon', 'config.json');
  if (!(p > 0 && p < 1)) fail('config.json: p должно быть в интервале (0, 1)');
  if (!(epsilon > 0 && epsilon <= 1)) fail('config.json: epsilon должно быть в интервале (0, 1]');
  if (p + epsilon > 1 + 1e-12) fail('config.json: p + epsilon не может превышать 1 для верхней хвостовой проверки');

  const rawN = config.n_values;
  if (!Array.isArray(rawN) || rawN.length < 2 || rawN.length > 32) fail('config.json: n_values должен содержать от 2 до 32 значений');
  const nValues = (rawN as unknown[]).map((value, index) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_N) {
      fail(`config.json: n_values[${index}] должно быть целым числом от 1 до ${MAX_N}`);
    }
    return value as number;
  });
  for (let index = 1; index < nValues.length; index++) {
    if (nValues[index] <= nValues[index - 1]) fail('config.json: n_values должны быть строго возрастающими');
  }
  if (new Set(nValues).size !== nValues.length) fail('config.json: n_values содержит дубликаты');

  const trialsPerN = readInteger(config, 'trials_per_n', 'config.json');
  if (trialsPerN < 1 || trialsPerN > MAX_TRIALS_PER_N) fail(`config.json: trials_per_n должно быть от 1 до ${MAX_TRIALS_PER_N}`);
  const seed = readInteger(config, 'seed', 'config.json');
  if (seed < 0 || seed > 0xffffffff) fail('config.json: seed должен быть целым от 0 до 4294967295');
  const primaryN = readInteger(config, 'primary_n', 'config.json');
  if (!nValues.includes(primaryN)) fail('config.json: primary_n должно входить в n_values');
  if (config.tail_side !== 'greater') fail("config.json: поддерживается только tail_side = 'greater'");
  if (nValues.length * trialsPerN > MAX_CSV_ROWS) fail(`config.json: строк ${nValues.length * trialsPerN} превышает лимит ${MAX_CSV_ROWS}`);
  for (const n of nValues) {
    if (!(Math.exp(-2 * n * epsilon * epsilon) > 0)) fail(`config.json: для n=${n} граница Hoeffding не представима числом с плавающей точкой`);
  }
  return { p, epsilon, nValues, trialsPerN, seed, primaryN };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => deepEqual(value, b[index]));
  }
  return a === b;
}

function verifyParametersAgainstSpec(configObject: JsonObject, parameters: Record<string, unknown>): void {
  for (const key of DEMO_PARAMETERS) {
    if (!(key in parameters)) fail(`plan.parameters: отсутствует научный параметр ${key}; изменяйте условия только новой версией плана`);
  }
  for (const [key, expected] of Object.entries(parameters)) {
    if (!(key in configObject)) fail(`config.json: отсутствует параметр замороженного плана ${key}`);
    if (!deepEqual(configObject[key], expected)) fail(`plan/config: ${key} не совпадает с замороженным планом`);
  }
}

interface SampleSummary {
  sha256: string;
  bytes: number;
  rows: number;
  stats: Map<number, SampleStats>;
}

async function parseSamplesCsv(file: string, config: DemoConfig): Promise<SampleSummary> {
  const size = (await lstat(file)).size;
  if (size > MAX_CSV_BYTES) fail('samples.csv превышает лимит 64 MiB');
  const declaredN = new Set(config.nValues);
  const stats = new Map<number, SampleStats>(config.nValues.map(n => [n, { rows: 0, tails: 0, trials: new Set<number>() }]));
  const hash = createHash('sha256');
  let bytes = 0;
  let lineNumber = 0;
  let headerSeen = false;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_CSV_BYTES) {
        callback(new Error('samples.csv превышает лимит 64 MiB'));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    }
  });
  const input = createReadStream(file).pipe(meter);
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const rawLine of lines) {
      lineNumber++;
      const line = lineNumber === 1 && rawLine.startsWith('\ufeff') ? rawLine.slice(1) : rawLine;
      if (line.length > 4096) fail(`samples.csv: слишком длинная строка ${lineNumber}`);
      if (!line.trim()) fail(`samples.csv: пустая строка ${lineNumber}`);
      if (lineNumber === 1) {
        if (line !== 'trial,successes,n,p,epsilon') {
          fail('samples.csv: ожидается заголовок trial,successes,n,p,epsilon');
        }
        headerSeen = true;
        continue;
      }
      if (lineNumber - 1 > MAX_CSV_ROWS) fail(`samples.csv: превышен лимит ${MAX_CSV_ROWS} строк`);
      if (line.includes('"')) fail(`samples.csv: кавычки не поддерживаются (строка ${lineNumber})`);
      const fields = line.split(',');
      if (fields.length !== 5) fail(`samples.csv: строка ${lineNumber} должна содержать 5 колонок`);
      const [trialText, successesText, nText, pText, epsilonText] = fields;
      if (!/^\d+$/.test(trialText) || !/^\d+$/.test(successesText) || !/^\d+$/.test(nText)) {
        fail(`samples.csv: trial, successes и n должны быть неотрицательными целыми (строка ${lineNumber})`);
      }
      if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(pText) || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(epsilonText)) {
        fail(`samples.csv: p и epsilon должны быть десятичными числами (строка ${lineNumber})`);
      }
      const trial = Number(trialText);
      const successes = Number(successesText);
      const n = Number(nText);
      const p = Number(pText);
      const epsilon = Number(epsilonText);
      if (![trial, successes, n, p, epsilon].every(Number.isFinite)) fail(`samples.csv: нечисловое значение (строка ${lineNumber})`);
      if (!Number.isSafeInteger(trial) || trial < 1 || trial > config.trialsPerN) {
        fail(`samples.csv: trial вне диапазона 1..${config.trialsPerN} (строка ${lineNumber})`);
      }
      if (!Number.isSafeInteger(n) || !declaredN.has(n)) fail(`samples.csv: n=${n} не объявлено в config.json (строка ${lineNumber})`);
      if (!Number.isSafeInteger(successes) || successes < 0 || successes > n) {
        fail(`samples.csv: successes должно быть целым от 0 до n (строка ${lineNumber})`);
      }
      if (p !== config.p) fail(`samples.csv: p=${p} не совпадает с config.json p=${config.p} (строка ${lineNumber})`);
      if (epsilon !== config.epsilon) fail(`samples.csv: epsilon=${epsilon} не совпадает с config.json epsilon=${config.epsilon} (строка ${lineNumber})`);
      const entry = stats.get(n)!;
      if (entry.trials.has(trial)) fail(`samples.csv: повтор trial=${trial} для n=${n}`);
      entry.trials.add(trial);
      entry.rows++;
      if (successes >= tailThreshold(n, config.p, config.epsilon)) entry.tails++;
      if (lineNumber - 1 > MAX_CSV_ROWS) fail(`samples.csv: превышен лимит ${MAX_CSV_ROWS} строк`);
    }
  } finally {
    lines.close();
    input.destroy();
  }
  if (!headerSeen) fail('samples.csv: отсутствует заголовок');
  for (const n of config.nValues) {
    const entry = stats.get(n)!;
    if (entry.rows !== config.trialsPerN) fail(`samples.csv: для n=${n} ожидалось ${config.trialsPerN} строк, получено ${entry.rows}`);
    // Trials are unique and restricted to 1..trials_per_n, so a full-size set is exactly 1..R.
    if (entry.trials.size !== config.trialsPerN) fail(`samples.csv: для n=${n} неполный набор trial`);
  }
  if (bytes !== size) fail('samples.csv: размер файла изменился во время проверки');
  return { sha256: hash.digest('hex'), bytes, rows: lineNumber - 1, stats };
}

function requireMetric(metrics: Record<string, number>, key: string): number {
  const value = metrics[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`metrics.json: обязательная метрика ${key} отсутствует или не является конечным числом`);
  return value;
}

function assertMetric(metrics: Record<string, number>, key: string, expected: number, tolerance = 1e-12): void {
  const actual = requireMetric(metrics, key);
  const scale = Math.max(1, Math.abs(expected), Math.abs(actual));
  if (Math.abs(actual - expected) > tolerance * scale) {
    fail(`Независимая проверка не совпала с artifacts/metrics.json: ${key}=${actual}, пересчитано=${expected}`);
  }
}

function assertExactMetric(metrics: Record<string, number>, key: string, expected: number): void {
  const actual = requireMetric(metrics, key);
  if (actual !== expected) fail(`Независимая проверка не совпала с artifacts/metrics.json: ${key}=${actual}, пересчитано=${expected}`);
}

function formatNumber(value: number): string {
  return Number(value.toPrecision(9)).toString();
}

function compareMetricToPublished(spec: ExperimentRun['spec'], metrics: Record<string, number>): string[] {
  const notes: string[] = [];
  if (!spec) {
    notes.push('ExperimentSpec отсутствует: сравнение с публикацией невозможно.');
    return notes;
  }
  const observed = metrics[spec.metric.name];
  if (spec.metric.publishedValue === null) {
    notes.push(`Для метрики «${spec.metric.name}» не задано опубликованное числовое значение; числовое воспроизведение статьи не проверяется.`);
  } else {
    notes.push(`Наблюдаемое «${spec.metric.name}» = ${observed}; опубликованное = ${spec.metric.publishedValue}; абсолютная разница = ${Math.abs(observed - spec.metric.publishedValue)}. Разница описательна и не доказывает воспроизведение: нужны совпадающие данные, split и preprocessing.`);
  }
  notes.push(spec.metric.comparable
    ? 'План помечает метрику как сопоставимую с публикацией. Harness не подтверждает эквивалентность условий автоматически.'
    : 'План помечает метрику как несопоставимую с публикацией; успешное исполнение не является воспроизведением опубликованного результата.');
  if (spec.missing.length) notes.push(`Недостающие сведения плана: ${spec.missing.join('; ')}`);
  return notes;
}

/**
 * Reads the generated project, validates required outputs and produces a hash for every artifact.
 * For the Bernoulli/Hoeffding demo it recomputes the primary metric from samples.csv instead of
 * trusting metrics.json. Artifact paths in the result are relative to run.dir.
 */
export async function collectAndValidate(run: ExperimentRun): Promise<{ artifacts: Artifact[]; metrics: Record<string, number>; verification: string }> {
  const spec = run.spec;
  if (!spec) throw new Error('ExperimentSpec отсутствует: невозможно проверить объявленную метрику');
  const runDir = await realpath(run.dir).catch(() => fail(`Каталог запуска не найден: ${run.dir}`));
  const projectCandidate = path.join(runDir, 'project');
  const projectInfo = await lstat(projectCandidate).catch(() => fail('Каталог project отсутствует'));
  if (projectInfo.isSymbolicLink()) fail('Каталог project не может быть symlink');
  if (!projectInfo.isDirectory()) fail('project должен быть каталогом');
  const projectDir = await realpath(projectCandidate);
  if (projectDir !== path.join(runDir, 'project')) fail('project выходит за каталог запуска');

  const manifestInfo = await requireRegularFile(projectDir, 'experiment.json', 'Манифест', MAX_MANIFEST_BYTES);
  const manifest = await readJsonObject(manifestInfo.file, 'experiment.json', MAX_MANIFEST_BYTES);
  const entryPoint = readString(manifest, 'entryPoint');
  const configRelative = readString(manifest, 'config');
  const requirements = readString(manifest, 'requirements');
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) fail('experiment.json: artifacts должен быть непустым массивом');
  const declared = (manifest.artifacts as unknown[]).map((value, index) => {
    if (typeof value !== 'string' || !value.trim()) fail(`experiment.json: artifacts[${index}] должен быть непустой строкой`);
    return value as string;
  });

  await requireRegularFile(projectDir, entryPoint, 'entryPoint', MAX_MANIFEST_BYTES);
  await requireRegularFile(projectDir, requirements, 'requirements', MAX_MANIFEST_BYTES);
  const configFile = await requireRegularFile(projectDir, configRelative, 'config', MAX_CONFIG_BYTES);
  const configObject = await readJsonObject(configFile.file, 'config.json', MAX_CONFIG_BYTES);

  const artifactsCandidate = path.join(projectDir, 'artifacts');
  const artifactsInfo = await lstat(artifactsCandidate).catch(() => fail('Каталог project/artifacts отсутствует'));
  if (artifactsInfo.isSymbolicLink()) fail('Каталог artifacts не может быть symlink');
  if (!artifactsInfo.isDirectory()) fail('project/artifacts должен быть каталогом');
  const artifactsDir = await realpath(artifactsCandidate);
  if (!artifactsDir.startsWith(projectDir + path.sep)) fail('Каталог artifacts выходит за project');

  const declaredPaths = declared.map(value => value.replaceAll('\\', '/'));
  if (new Set(declaredPaths).size !== declaredPaths.length) fail('experiment.json: artifacts содержит повторяющиеся пути');
  for (const relative of declaredPaths) {
    const resolved = await resolveProjectPath(projectDir, `artifacts/${relative}`, 'Обязательный артефакт');
    if (!resolved.startsWith(artifactsDir + path.sep)) fail(`Обязательный артефакт вне project/artifacts: ${relative}`);
  }

  const walked: string[] = [];
  await walkArtifactFiles(artifactsDir, artifactsDir, walked);
  const available = new Set(walked.map(file => path.relative(artifactsDir, file).split(path.sep).join('/')));
  for (const relative of declaredPaths) {
    if (!available.has(relative)) fail(`Обязательный артефакт не найден: artifacts/${relative}`);
  }

  const metricsRelative = declaredPaths.find(value => path.posix.basename(value) === 'metrics.json');
  if (!metricsRelative) fail('experiment.json: artifacts должен объявлять metrics.json');
  const metricsFile = await resolveProjectPath(projectDir, `artifacts/${metricsRelative}`, 'metrics.json');
  const rawMetrics = await readJsonObject(metricsFile, 'metrics.json', MAX_METRICS_BYTES);
  // Null prototype prevents a JSON key such as "__proto__" from mutating the result object.
  const metrics: Record<string, number> = Object.create(null) as Record<string, number>;
  if (Object.keys(rawMetrics).length === 0) fail('metrics.json: объект метрик пуст');
  for (const [key, value] of Object.entries(rawMetrics)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(`metrics.json: метрика ${key} должна быть конечным числом`);
    metrics[key] = value;
  }
  if (!(spec.metric.name in metrics)) fail(`metrics.json: отсутствует объявленная метрика «${spec.metric.name}»`);
  requireMetric(metrics, spec.metric.name);

  const artifactFiles = new Set(walked);
  artifactFiles.add(configFile.file);
  const stdoutInfo = await requireRegularFile(projectDir, 'stdout.log', 'stdout.log', MAX_LOG_BYTES);
  artifactFiles.add(stdoutInfo.file);
  const stderrCandidate = path.join(projectDir, 'stderr.log');
  const stderrInfo = await lstat(stderrCandidate).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (stderrInfo) {
    if (stderrInfo.isSymbolicLink()) fail('stderr.log: symlink запрещён');
    if (!stderrInfo.isFile()) fail('stderr.log: требуется обычный файл');
    if (stderrInfo.size > MAX_LOG_BYTES) fail('stderr.log превышает лимит');
    artifactFiles.add(stderrCandidate);
  }

  const artifacts: Artifact[] = [];
  let totalBytes = 0;
  for (const file of [...artifactFiles].sort()) {
    const relative = relativeToRun(runDir, file);
    const kind = artifactKind(relative);
    const limit = kind === 'log' ? MAX_LOG_BYTES : MAX_ARTIFACT_BYTES;
    const hashed = await sha256File(file, relative, limit);
    totalBytes += hashed.bytes;
    if (totalBytes > MAX_TOTAL_BYTES) fail(`Суммарный размер артефактов превышает ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)} MiB`);
    artifacts.push({ path: relative, kind, bytes: hashed.bytes, sha256: hashed.sha256 });
  }

  if (spec.demo === 'bernoulli-hoeffding') {
    if (spec.metric.name !== DEMO_PRIMARY_METRIC) fail(`Демо требует основную метрику ${DEMO_PRIMARY_METRIC}`);
    if (spec.implementation !== 'independent') fail('Демо-кейс является независимой реализацией; implementation должен быть independent');
    if (spec.metric.publishedValue !== null || spec.metric.comparable) {
      fail('Демо не воспроизводит опубликованное число: publishedValue должен быть null, comparable — false');
    }
    const plotRelative = declaredPaths.find(value => value.toLowerCase().endsWith('.svg'));
    if (!plotRelative) fail('Демо требует обязательный SVG-график в experiment.json artifacts');
    const plotFile = await resolveProjectPath(projectDir, `artifacts/${plotRelative}`, 'plot');
    const plotInfo = await lstat(plotFile);
    if (plotInfo.size > MAX_PLOT_BYTES) fail('SVG-график превышает лимит');
    const plot = await readFile(plotFile, 'utf8');
    if (plot.length < 256 || !/<svg[\s>]/i.test(plot) || !/<\/svg>/i.test(plot)) fail('SVG-график пуст или повреждён');
    if (!plot.toLowerCase().includes('empirical') || !plot.toLowerCase().includes('hoeffding')) {
      fail('SVG-график должен содержать серии «empirical» и «Hoeffding bound»');
    }
    if ((plot.match(/<(?:circle|polyline|path)\b/gi) ?? []).length < 2) fail('SVG-график не содержит точек/линий данных');

    const config = validateDemoConfig(configObject);
    verifyParametersAgainstSpec(configObject, spec.parameters);
    const samplesRelative = declaredPaths.find(value => value.toLowerCase().endsWith('.csv'));
    if (!samplesRelative) fail('Демо требует samples.csv в experiment.json artifacts');
    const samplesFile = await resolveProjectPath(projectDir, `artifacts/${samplesRelative}`, 'samples.csv');
    const samples = await parseSamplesCsv(samplesFile, config);
    const primaryStats = samples.stats.get(config.primaryN)!;
    const empirical = primaryStats.tails / config.trialsPerN;
    const bound = Math.exp(-2 * config.primaryN * config.epsilon * config.epsilon);
    const threshold = tailThreshold(config.primaryN, config.p, config.epsilon);
    const logFacts = logFactorials(config.nValues[config.nValues.length - 1]);
    const exact = binomialUpperTail(config.primaryN, config.p, threshold, logFacts);
    const standardError = Math.sqrt(Math.max(0, empirical * (1 - empirical) / config.trialsPerN));
    let maxExcess = -Infinity;
    let allExactWithinBound = 1;
    for (const n of config.nValues) {
      const entry = samples.stats.get(n)!;
      const tail = entry.tails / config.trialsPerN;
      const nBound = Math.exp(-2 * n * config.epsilon * config.epsilon);
      maxExcess = Math.max(maxExcess, tail - nBound);
      const nExact = binomialUpperTail(n, config.p, tailThreshold(n, config.p, config.epsilon), logFacts);
      if (nExact > nBound + 1e-12 * Math.max(1, nBound)) allExactWithinBound = 0;
    }
    if (!allExactWithinBound) fail('Точный биномиальный хвост превысил границу Hoeffding: проверьте параметры и формулу');
    for (const key of DEMO_METRICS) requireMetric(metrics, key);

    assertMetric(metrics, 'empirical_tail_probability', empirical);
    assertMetric(metrics, 'hoeffding_bound', bound);
    assertMetric(metrics, 'exact_binomial_tail_probability', exact);
    assertMetric(metrics, 'bound_minus_empirical', bound - empirical);
    assertMetric(metrics, 'bound_minus_exact', bound - exact);
    assertMetric(metrics, 'empirical_to_bound_ratio', empirical / bound);
    assertMetric(metrics, 'monte_carlo_standard_error', standardError);
    assertMetric(metrics, 'max_empirical_minus_bound', maxExcess);
    assertExactMetric(metrics, 'all_exact_tails_within_bound', allExactWithinBound);
    assertExactMetric(metrics, 'tail_count_primary', primaryStats.tails);
    assertExactMetric(metrics, 'n_primary', config.primaryN);
    assertMetric(metrics, 'p', config.p);
    assertMetric(metrics, 'epsilon', config.epsilon);
    assertExactMetric(metrics, 'trials_per_n', config.trialsPerN);
    assertExactMetric(metrics, 'seed', config.seed);
    assertExactMetric(metrics, 'n_configurations', config.nValues.length);
    assertExactMetric(metrics, 'total_rows', samples.rows);

    const verification = [
      'Независимая проверка демо Bernoulli/Hoeffding (по samples.csv, не по metrics.json):',
      `  primary n=${config.primaryN}, trials=${config.trialsPerN}, p=${config.p}, epsilon=${config.epsilon}, seed=${config.seed}`,
      `  эмпирическая односторонняя хвостовая вероятность = ${formatNumber(empirical)} (${primaryStats.tails}/${config.trialsPerN})`,
      `  граница Hoeffding = ${formatNumber(bound)}; точный биномиальный хвост = ${formatNumber(exact)}`,
      `  граница − эмпирика = ${formatNumber(bound - empirical)}; эмпирика / граница = ${formatNumber(empirical / bound)}`,
      `  стандартная ошибка Монте-Карло ≈ ${formatNumber(standardError)}; max(эмпирика − граница) по всем n = ${formatNumber(maxExcess)}`,
      `  все точные хвосты не превышают границу; файлов захэшировано: ${artifacts.length}; samples.csv SHA256 ${samples.sha256.slice(0, 16)}…`,
      'Ограничения сопоставимости:',
      '  • это независимая проверка теоремы, а не воспроизведение опубликованного числа (publishedValue=null, comparable=false);',
      '  • эмпирическая доля — оценка истинной вероятности по конечной Монте-Карло выборке; теорема ограничивает истинный хвост, поэтому превышение границы выборочной долей само по себе не является нарушением;',
      `  • проверены только n ∈ {${config.nValues.join(', ')}} при p=${config.p}, epsilon=${config.epsilon};`,
      '  • уникальность trial, полнота строк, seed и согласованность параметров проверены, но один набор артефактов не доказывает детерминизм ГПСЧ;',
      '  • успешное завершение процесса не означает воспроизведение результата статьи.'
    ].join('\n');
    return { artifacts, metrics, verification };
  }

  const limitations = [
    `Артефакты проверены: ${artifacts.length} файлов; обязательные выходы на месте; SHA256 рассчитан.`,
    `Основная метрика «${spec.metric.name}» = ${formatNumber(metrics[spec.metric.name])}.`,
    ...compareMetricToPublished(spec, metrics),
    'Проверка подтверждает наличие и числовой формат объявленных артефактов и метрики. Она не перезапускает эксперимент и не воспроизводит необъявленные метрики.',
    'Успешное завершение процесса само по себе не означает воспроизведение научного результата статьи.'
  ];
  if (spec.assumptions.length) limitations.push(`Допущения плана: ${spec.assumptions.join('; ')}`);
  return { artifacts, metrics, verification: limitations.join('\n') };
}
