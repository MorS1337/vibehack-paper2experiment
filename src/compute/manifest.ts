import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ExperimentSpec, ProjectManifest } from '../shared/types.js';

const MANIFEST_LIMIT = 256 * 1024;

export interface ValidatedProject {
  projectDir: string;
  manifest: ProjectManifest;
  entryPointFile: string;
  configFile: string;
  requirementsFile: string;
  artifactsDir: string;
}

function fail(message: string): never {
  throw new Error(`Некорректный проект: ${message}`);
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/** Rejects absolute paths, traversal, backslashes and control characters. */
export function validateRelativePath(relative: string, label: string): string {
  if (typeof relative !== 'string' || !relative.trim()) fail(`${label}: пустой путь`);
  if (relative.length > 512) fail(`${label}: путь слишком длинный`);
  if (/[\u0000-\u001f\\]/.test(relative)) fail(`${label}: недопустимые символы в пути (${relative})`);
  if (relative.startsWith('/') || /^[A-Za-z]:/.test(relative)) fail(`${label}: абсолютный путь запрещён (${relative})`);
  const segments = relative.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    fail(`${label}: небезопасный путь (${relative})`);
  }
  return segments.join('/');
}

export function venvPython(projectDir: string): string {
  return process.platform === 'win32'
    ? path.join(projectDir, '.venv', 'Scripts', 'python.exe')
    : path.join(projectDir, '.venv', 'bin', 'python');
}

async function canonicalProjectDir(projectDir: string): Promise<string> {
  const absolute = path.resolve(projectDir);
  const info = await lstat(absolute).catch(() => fail(`каталог project отсутствует (${projectDir})`));
  if (info.isSymbolicLink()) fail('каталог project не может быть symlink');
  if (!info.isDirectory()) fail('project должен быть каталогом');
  // Resolve legitimate OS aliases (for example /var → /private/var on macOS);
  // every declared path is still checked against the canonical project root.
  return realpath(absolute);
}

async function resolveExistingFile(projectDir: string, relative: string, label: string, limit: number): Promise<string> {
  const normalized = validateRelativePath(relative, label);
  let cursor = projectDir;
  for (const segment of normalized.split('/')) {
    cursor = path.join(cursor, segment);
    const info = await lstat(cursor).catch(() => fail(`${label}: файл не найден (${relative})`));
    if (info.isSymbolicLink()) fail(`${label}: symlink запрещён (${relative})`);
  }
  const canonical = await realpath(cursor);
  if (!isInside(projectDir, canonical) || canonical === projectDir) fail(`${label}: путь выходит за project (${relative})`);
  const info = await lstat(canonical);
  if (!info.isFile()) fail(`${label}: требуется обычный файл (${relative})`);
  if (info.size > limit) fail(`${label}: файл слишком большой (${relative})`);
  return canonical;
}

async function validateArtifactPath(projectDir: string, relative: string, index: number): Promise<string> {
  const normalized = validateRelativePath(relative, `artifacts[${index}]`);
  if (!/^[A-Za-z0-9._/-]+$/.test(normalized)) fail(`artifacts[${index}]: допустимы только безопасные символы имени (${relative})`);
  const artifactsDir = path.join(projectDir, 'artifacts');
  let cursor = artifactsDir;
  const segments = normalized.split('/');
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    cursor = path.join(cursor, segments[segmentIndex]);
    const info = await lstat(cursor).catch(() => null);
    if (!info) continue;
    if (info.isSymbolicLink()) fail(`artifacts[${index}]: symlink запрещён (${relative})`);
    if (segmentIndex < segments.length - 1 && !info.isDirectory()) fail(`artifacts[${index}]: родитель не является каталогом (${relative})`);
    if (segmentIndex === segments.length - 1 && !info.isFile()) fail(`artifacts[${index}]: требуется файл (${relative})`);
    const canonical = await realpath(cursor);
    if (!isInside(projectDir, canonical)) fail(`artifacts[${index}]: путь выходит за project (${relative})`);
  }
  return normalized;
}

/**
 * Reads the worker-owned experiment.json and verifies every declared path before any
 * dependency installation or process launch. Artifact outputs are relative to
 * project/artifacts; inputs are relative to the project root.
 */
export async function readProjectManifest(projectDir: string): Promise<ValidatedProject> {
  const canonical = await canonicalProjectDir(projectDir);
  const manifestFile = path.join(canonical, 'experiment.json');
  const manifestInfo = await lstat(manifestFile).catch(() => fail('experiment.json отсутствует'));
  if (manifestInfo.isSymbolicLink()) fail('experiment.json не может быть symlink');
  if (!manifestInfo.isFile()) fail('experiment.json должен быть файлом');
  if (manifestInfo.size > MANIFEST_LIMIT) fail('experiment.json слишком большой');
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestFile, 'utf8'));
  } catch (error) {
    fail(`experiment.json: некорректный JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('experiment.json: ожидается JSON-объект');
  const object = raw as Record<string, unknown>;
  for (const key of ['entryPoint', 'config', 'requirements'] as const) {
    if (typeof object[key] !== 'string' || !object[key].trim()) fail(`experiment.json: ${key} должен быть непустой строкой`);
  }
  if (!Array.isArray(object.artifacts) || object.artifacts.length === 0) fail('experiment.json: artifacts должен быть непустым массивом');
  if (object.artifacts.length > 256) fail('experiment.json: слишком много артефактов');
  const entryPoint = object.entryPoint as string;
  const config = object.config as string;
  const requirements = object.requirements as string;
  const declared = object.artifacts.map((value, index) => {
    if (typeof value !== 'string') fail(`experiment.json: artifacts[${index}] должен быть строкой`);
    return validateRelativePath(value, `artifacts[${index}]`);
  });
  if (new Set(declared).size !== declared.length) fail('experiment.json: artifacts содержит повторяющиеся пути');

  const entryPointFile = await resolveExistingFile(canonical, entryPoint, 'entryPoint', 1024 * 1024);
  const configFile = await resolveExistingFile(canonical, config, 'config', 1024 * 1024);
  const requirementsFile = await resolveExistingFile(canonical, requirements, 'requirements', 1024 * 1024);
  const normalizedArtifacts: string[] = [];
  for (let index = 0; index < declared.length; index++) normalizedArtifacts.push(await validateArtifactPath(canonical, declared[index], index));

  let artifactsDir = path.join(canonical, 'artifacts');
  const artifactsInfo = await lstat(artifactsDir).catch(() => null);
  if (artifactsInfo) {
    if (artifactsInfo.isSymbolicLink()) fail('каталог artifacts не может быть symlink');
    if (!artifactsInfo.isDirectory()) fail('project/artifacts должен быть каталогом');
    artifactsDir = await realpath(artifactsDir);
    if (!isInside(canonical, artifactsDir) || artifactsDir === canonical) fail('каталог artifacts выходит за project');
  }

  const manifest: ProjectManifest = {
    entryPoint: validateRelativePath(entryPoint, 'entryPoint'),
    config: validateRelativePath(config, 'config'),
    requirements: validateRelativePath(requirements, 'requirements'),
    artifacts: normalizedArtifacts
  };
  return { projectDir: canonical, manifest, entryPointFile, configFile, requirementsFile, artifactsDir };
}

function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJSON(item)}`).join(',')}}`;
}

/**
 * The frozen plan is the only source of scientific parameters. A worker may add
 * operational config keys but cannot silently change or omit a planned value.
 */
export async function assertConfigMatchesSpec(configFile: string, spec: ExperimentSpec): Promise<void> {
  const info = await lstat(configFile).catch(() => fail(`${configFile}: config недоступен`));
  if (!info.isFile()) fail('config должен быть обычным файлом');
  if (info.size > 1024 * 1024) fail('config слишком большой');
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(configFile, 'utf8'));
  } catch (error) {
    fail(`config: некорректный JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('config: ожидается JSON-объект');
  const config = raw as Record<string, unknown>;
  for (const [key, value] of Object.entries(spec.parameters)) {
    if (!(key in config)) fail(`config не содержит параметр плана «${key}»`);
    if (canonicalJSON(config[key]) !== canonicalJSON(value)) fail(`config изменяет параметр плана «${key}»; научные изменения требуют новой версии плана`);
  }
}
