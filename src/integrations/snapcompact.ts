import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createJiti } from 'jiti';
import { convertToLlm, DefaultResourceLoader, type ContextEvent, type ContextEventResult, type ExtensionEvent, type ExtensionContext, type LoadExtensionsResult, type SessionBeforeCompactResult, type SettingsManager } from '@earendil-works/pi-coding-agent';

const require = createRequire(import.meta.url);
export const SNAPCOMPACT_VERSION = '0.1.1';
export const SNAPCOMPACT_LIMITS = { frames: 12, frameBytes: 512 * 1024, requestBytes: 3_000_000, sourceChars: 250_000, inputBytes: 2_000_000 };
interface Frame { file?: string; data: string; mimeType: string; cols: number; rows: number; chars: number }
export interface SnapArchive { framesDir?: string; frames: Frame[]; text?: string; totalChars: number; truncatedChars: number; mac?: string }
interface ArchiveLibrary {
  getArchive(details: Record<string, unknown> | undefined): SnapArchive | undefined;
  verifyArchive(archive: SnapArchive, key: Uint8Array): boolean;
  isFramesDirName(value: unknown): value is string;
  frameFileMatches(file: string, png: Uint8Array): boolean;
}
interface IntegrityLibrary { loadOrCreateKey(): Uint8Array | undefined; verificationDisabled(): boolean }
interface SettingsLibrary { loadSettings(cwd: string): { enabled: boolean; maxFrameBytes?: number; includeThinking: boolean } }
interface SerializeLibrary { serializeConversation(messages: unknown[], options?: unknown): string }
export type SnapDiagnostic = (message: string, error?: boolean) => void;

export function snapCompactPackage(): { version: string; extensionPath: string; root: string } {
  const json = require.resolve('@nomeelnoj/pi-snap-compact/package.json');
  const { version } = JSON.parse(readFileSync(json, 'utf8'));
  if (version !== SNAPCOMPACT_VERSION) throw new Error(`SnapCompact: требуется проверенная версия ${SNAPCOMPACT_VERSION}, установлена ${version}`);
  const root = path.dirname(json);
  return { version, root, extensionPath: path.join(root, 'extensions', 'index.ts') };
}

/** Real upstream extension; this host policy blocks its lossy/default fallbacks. */
export async function createSnapCompactResources(options: {
  cwd: string; agentDir: string; settingsManager: SettingsManager; systemPrompt?: string; diagnostic?: SnapDiagnostic;
}) {
  const info = snapCompactPackage();
  const jiti = createJiti(import.meta.url);
  const [archiveLib, integrity, settingsLib, serializer] = await Promise.all([
    jiti.import<ArchiveLibrary>(path.join(info.root, 'src/archive.ts')),
    jiti.import<IntegrityLibrary>(path.join(info.root, 'src/integrity.ts')),
    jiti.import<SettingsLibrary>(path.join(info.root, 'src/settings.ts')),
    jiti.import<SerializeLibrary>(path.join(info.root, 'src/serialize.ts'))
  ]);
  let failure: Error | undefined;
  const pending = new Set<string>();
  const diagnostic = options.diagnostic ?? (() => {});
  const fail = (error: unknown): Error => {
    failure = error instanceof Error ? error : new Error(String(error));
    diagnostic(`strategy=snapcompact error=${failure.message} fallback=blocked`, true);
    return failure;
  };
  const assertHealthy = () => { if (failure) throw failure; };
  const configuration = () => {
    const settings = settingsLib.loadSettings(options.cwd);
    if (!settings.enabled || integrity.verificationDisabled()) throw new Error('SnapCompact: отключение расширения или проверки HMAC не допускается; native fallback заблокирован');
    return settings;
  };
  const vision = (ctx: ExtensionContext) => {
    if (!ctx.model?.input.includes('image')) throw new Error('SnapCompact: требуется vision-модель (input: image); текстовый fallback заблокирован, история сохранена');
    if (ctx.model.api === 'pi-virtual') throw new Error('SnapCompact: выберите физическую vision-модель; динамическая смена reader пока не проверена');
    configuration();
  };
  const frameDirectory = (sessionDir: string, name: string): string => {
    if (!archiveLib.isFramesDirName(name)) throw new Error('SnapCompact: недопустимый каталог кадров');
    const dir = path.join(sessionDir, name);
    if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) throw new Error('SnapCompact: каталог кадров должен быть обычной директорией');
    if (path.dirname(realpathSync(dir)) !== realpathSync(sessionDir)) throw new Error('SnapCompact: каталог кадров выходит за sessionDir');
    return dir;
  };
  const validateArchive = (details: Record<string, unknown> | undefined, sessionDir: string): SnapArchive => {
    const archive = archiveLib.getArchive(details);
    const raw = details?.snapcompact as SnapArchive | undefined;
    const key = integrity.loadOrCreateKey();
    if (!archive || !raw || !key || !archiveLib.verifyArchive(archive, key)) throw new Error('SnapCompact: архив отсутствует или HMAC не совпал');
    if (!Array.isArray(raw.frames) || raw.frames.length !== archive.frames.length || archive.truncatedChars !== 0 || !Number.isFinite(archive.totalChars) || archive.totalChars > SNAPCOMPACT_LIMITS.sourceChars || (archive.text?.length ?? 0) > SNAPCOMPACT_LIMITS.sourceChars || archive.frames.length > SNAPCOMPACT_LIMITS.frames) throw new Error('SnapCompact: превышен лимит архива или часть истории усечена');
    const dir = archive.frames.length ? frameDirectory(sessionDir, archive.framesDir ?? '') : undefined;
    let bytes = 0;
    for (const frame of archive.frames) {
      if (!frame.file || !/^[a-f0-9]{64}\.png$/.test(frame.file) || frame.data) throw new Error('SnapCompact: требуется content-addressed PNG на диске');
      const file = path.join(dir!, frame.file);
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > SNAPCOMPACT_LIMITS.frameBytes) throw new Error('SnapCompact: небезопасный или слишком большой PNG');
      const png = readFileSync(file);
      if (!archiveLib.frameFileMatches(frame.file, png) || png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || png.readUInt32BE(16) > 2576 || png.readUInt32BE(20) > 2576) throw new Error('SnapCompact: PNG повреждён, SHA256 или размер не совпал');
      bytes += Math.ceil(png.length / 3) * 4;
      // Upstream prices file-backed frames conservatively before loading them.
      if (bytes > Math.min(configuration().maxFrameBytes ?? SNAPCOMPACT_LIMITS.requestBytes, SNAPCOMPACT_LIMITS.requestBytes)) throw new Error('SnapCompact: превышен лимит PNG payload');
      chmodSync(file, 0o600);
    }
    if (dir) chmodSync(dir, 0o700);
    return archive;
  };
  const activeArchives = (ctx: ExtensionContext) => ctx.sessionManager.buildContextEntries()
    .filter(entry => entry.type === 'compaction')
    .map(entry => validateArchive(entry.details as Record<string, unknown> | undefined, ctx.sessionManager.getSessionDir()));
  const removePending = () => {
    for (const dir of pending) { rmSync(dir, { recursive: true, force: true }); pending.delete(dir); }
  };
  const wrap = (loaded: LoadExtensionsResult): LoadExtensionsResult => {
    for (const extension of loaded.extensions) {
      // The harness owns strategy selection. A model-generated /off must not enable a hidden fallback.
      extension.commands.delete('snapcompact');
      for (const [eventName, handlers] of extension.handlers) {
        extension.handlers.set(eventName, handlers.map(handler => async (...args: unknown[]) => {
          const event = args[0] as ExtensionEvent;
          const ctx = args[1] as ExtensionContext;
          try {
            if (event.type === 'session_start') vision(ctx);
            if (event.type === 'session_before_compact') {
              assertHealthy(); vision(ctx);
              const previous = activeArchives(ctx);
              if (event.customInstructions) throw new Error('SnapCompact: directed LLM compaction не поддерживается');
              const messages = [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages];
              if (JSON.stringify(messages).length > SNAPCOMPACT_LIMITS.inputBytes) throw new Error('SnapCompact: превышен входной лимит архива');
              const llmMessages = convertToLlm(messages);
              const serialized = serializer.serializeConversation(llmMessages, { includeThinking: configuration().includeThinking });
              if (serialized.length + previous.reduce((sum, archive) => sum + (archive.text?.length ?? archive.totalChars), 0) > SNAPCOMPACT_LIMITS.sourceChars || /\[…\d+ch elided…\]/.test(serialized) || llmMessages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'image'))) throw new Error('SnapCompact: сериализация потеряла бы исходные данные; история сохранена в JSONL');
            }
            if (event.type === 'context') { assertHealthy(); vision(ctx); activeArchives(ctx); }
            const sessionDir = ctx.sessionManager.getSessionDir();
            const before = event.type === 'session_before_compact' ? new Set(readdirSync(sessionDir)) : undefined;
            let result: (SessionBeforeCompactResult & ContextEventResult) | undefined;
            try { result = await handler(event, ctx) as typeof result; }
            finally {
              // Also find partial writes when upstream catches a filesystem error and returns no result.
              if (before) for (const name of readdirSync(sessionDir)) {
                if (!before.has(name) && archiveLib.isFramesDirName(name)) pending.add(frameDirectory(sessionDir, name));
              }
            }
            if (event.type === 'session_before_compact') {
              const details = result?.compaction?.details as Record<string, unknown> | undefined;
              const name = (details?.snapcompact as SnapArchive | undefined)?.framesDir;
              if (archiveLib.isFramesDirName(name)) pending.add(frameDirectory(ctx.sessionManager.getSessionDir(), name));
              const archive = validateArchive(details, ctx.sessionManager.getSessionDir());
              diagnostic(`strategy=snapcompact trigger=${event.reason} archiveChars=${archive.totalChars} frames=${archive.frames.length} shape=${archive.frames.map(frame => `${frame.cols}x${frame.rows}`).join(',')} fallback=none`);
            }
            if (event.type === 'session_compact') {
              const name = ((event.compactionEntry.details as Record<string, unknown> | undefined)?.snapcompact as SnapArchive | undefined)?.framesDir;
              if (archiveLib.isFramesDirName(name)) pending.delete(path.join(ctx.sessionManager.getSessionDir(), name));
            }
            if (event.type === 'context') {
              const archives = activeArchives(ctx);
              const expected = archives.flatMap(archive => archive.frames.map(frame => frame.file));
              const actual = convertToLlm(result?.messages ?? event.messages).flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'image').map(block => `${createHash('sha256').update(Buffer.from(block.data, 'base64')).digest('hex')}.png`) : []);
              if (expected.some((hash, index) => actual[index] !== hash) || actual.length < expected.length) throw new Error('SnapCompact: PNG blocks потеряны или переупорядочены при восстановлении');
            }
            return result;
          } catch (error) {
            fail(error);
            if (eventName === 'session_before_compact') { removePending(); return { cancel: true }; }
            // SDK records hook errors. The host request guard below propagates failure before inference.
            throw error;
          }
        }));
      }
      extension.handlers.set('session_compact_failed', [async () => { removePending(); }]);
      extension.handlers.set('session_shutdown', [async () => { removePending(); }]);
    }
    return loaded;
  };
  const loader = new DefaultResourceLoader({
    ...options, additionalExtensionPaths: [info.extensionPath], extensionsOverride: wrap,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  if (loaded.errors.length || loaded.extensions.length !== 1) throw new Error(`SnapCompact: загрузка не удалась: ${JSON.stringify(loaded.errors)}`);
  const validateRequest = (messages: ContextEvent['messages']) => {
    assertHealthy();
    const images = convertToLlm(messages).flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'image') : []);
    if (images.length > SNAPCOMPACT_LIMITS.frames || images.reduce((sum, image) => sum + image.data.length, 0) > SNAPCOMPACT_LIMITS.requestBytes) throw fail(new Error('SnapCompact: превышен общий лимит изображений запроса; данные не отбрасываются'));
  };
  return { loader, assertHealthy, validateArchive, validateRequest, version: info.version };
}

export function privateSessionDirectory(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) throw new Error('Pi: небезопасный каталог сессии');
  chmodSync(dir, 0o700);
  return dir;
}
