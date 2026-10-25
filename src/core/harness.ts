import path from 'node:path';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { z } from 'zod';
import { Store, atomicJSON } from './store.js';
import { importSource, validateSourceRefs } from './source.js';
import { collectAndValidate } from './artifacts.js';
import { demoPlan, prepareDemoCode, demoReport } from './demo-agent.js';
import { planWithPi, codeWithPi, reportWithPi, getAgentStatuses } from '../integrations/pi.js';
import { transcribe, whisperStatus } from '../integrations/whisper.js';
import { LocalBackend } from '../compute/local.js';
import { VastBackend } from '../compute/vast.js';
import { selectCompute, getComputeStatuses } from '../compute/index.js';
import { SpecSchema } from '../shared/types.js';
import { SetupRequiredError } from '../shared/errors.js';
import type { AppSettings, ComputeBackend, ComputeContext, ExperimentRun, RunEvent, Snapshot } from '../shared/types.js';

const InputSchema = z.object({ agentMode: z.enum(['demo', 'pi']), source: z.string().min(1).max(4096), task: z.string().min(1).max(30000), authorRepo: z.string().max(2048).optional(), dataDir: z.string().max(4096).optional(), mode: z.enum(['local', 'vast', 'auto']), timeSeconds: z.number().int().min(5).max(86400), maxHourlyUSD: z.number().finite().nonnegative(), maxTotalUSD: z.number().finite().nonnegative(), cleanup: z.enum(['destroy', 'retain']) });
const SettingsSchema = z.object({ piProvider: z.string().max(100), piModel: z.string().max(200), python: z.string().min(1).max(4096), whisperBinary: z.string().min(1).max(4096), whisperModel: z.string().max(4096), sshKeyPath: z.string().max(4096) });
const busyStatuses = ['importing', 'planning', 'coding', 'selecting_compute', 'awaiting_approval', 'preparing', 'running', 'collecting'];
interface Active { id: string; controller: AbortController; promise?: Promise<void>; backend?: ComputeBackend; context?: ComputeContext; approval?: () => void; timedOut: boolean; }

export class Harness {
  private active?: Active;
  private transcription?: { controller: AbortController; promise: Promise<string> };
  private listeners = new Set<(event: RunEvent) => void>();
  constructor(readonly store: Store) {}
  onEvent(listener: (event: RunEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async initialize(): Promise<void> {
    await this.store.load();
    for (const run of this.store.list()) {
      if (run.provisioningUncertain && run.spec) {
        const ctx: ComputeContext = { run, spec: run.spec, projectDir: path.join(run.dir, 'project'), settings: this.store.settings, signal: AbortSignal.timeout(30000), persist: patch => this.store.patch(run.id, patch), emit: (type, message) => this.emit(run.id, type, message) };
        try { await new VastBackend().reconcile(ctx); }
        catch (error) { await this.emit(run.id, 'error', `Не удалось разрешить неопределённую аренду: ${String(error)}`); }
      }
      if (busyStatuses.includes(run.status) || run.provisioningUncertain) {
        await this.store.patch(run.id, { status: 'interrupted', cleanupRequired: !!run.instanceId || !!run.provisioningUncertain, error: run.provisioningUncertain ? `Ответ создания инстанса потерян. Метка ${run.provisioningLabel}; повторная аренда заблокирована. Повторите проверку/cleanup или проверьте Vast Console.` : run.instanceId ? 'Приложение было прервано. Инстанс может тарифицироваться: нажмите «Забрать и очистить».' : `Приложение было прервано. Проверьте локальный процесс ${run.pid ?? 'не создан'}; PID после сбоя не считается безопасным для автоматического kill.` });
        await this.emit(run.id, 'status', 'Восстановлена прерванная операция; автоматический повторный запуск запрещён');
      }
    }
  }
  private async emit(id: string, type: RunEvent['type'], message: string): Promise<void> {
    const event = await this.store.event(id, type, message); for (const listener of this.listeners) listener(event);
  }
  private async status(id: string, status: ExperimentRun['status'], extra: Partial<ExperimentRun> = {}): Promise<void> {
    await this.store.patch(id, { status, ...extra }); await this.emit(id, 'status', status);
  }
  async snapshot(): Promise<Snapshot> {
    const settings = this.store.settings;
    const connections = (await Promise.all([getAgentStatuses(settings), getComputeStatuses(settings), whisperStatus(settings).then(status => [status])])).flat();
    return { runs: this.store.list(), activeId: this.active?.id, settings, connections };
  }
  private launch(id: string, work: (active: Active) => Promise<void>): void {
    if (this.active) throw new Error('Уже выполняется другая операция. Сначала отмените её');
    const active: Active = { id, controller: new AbortController(), timedOut: false };
    this.active = active;
    active.promise = work(active).catch(async error => {
      const status = active.timedOut ? 'timed_out' : active.controller.signal.aborted ? 'cancelled' : error instanceof SetupRequiredError ? 'needs_setup' : 'failed';
      await this.status(id, status, { error: String(error instanceof Error ? error.message : error) });
      await this.emit(id, 'error', String(error instanceof Error ? error.message : error));
    }).finally(() => { if (this.active === active) this.active = undefined; });
  }
  async create(input: unknown): Promise<ExperimentRun> {
    const parsed = InputSchema.parse(input);
    if (parsed.agentMode === 'demo' && parsed.mode !== 'local') throw new Error('Деморежим с заглушками допускает только Local. Платная аренда запрещена.');
    if (parsed.authorRepo && !/^https:\/\/[^\s]+$/.test(parsed.authorRepo)) throw new Error('Авторский репозиторий: требуется HTTPS URL');
    return this.store.create(parsed);
  }
  plan(id: string): void {
    const run = this.store.get(id);
    if (run.instanceId || run.provisioningUncertain) throw new Error('Сначала разрешите незавершённую аренду старого инстанса');
    this.launch(id, async active => {
      await this.status(id, 'importing', { error: undefined });
      const source = await importSource(run, active.controller.signal);
      await this.store.patch(id, { source });
      await this.emit(id, 'artifact', `Источник сохранён: SHA256 ${source.sha256}; страниц ${source.pages.length}`);
      await this.status(id, 'planning');
      const spec = SpecSchema.parse(run.input.agentMode === 'demo' ? demoPlan(run) : await planWithPi({ run, settings: this.store.settings, signal: active.controller.signal, emit: (type, message) => this.emit(id, type, message) }));
      if (run.input.agentMode === 'demo') await this.emit(id, 'agent', 'ДЕМО / ЗАГЛУШКА: план взят из фиксированного кейса, модель не вызывалась');
      validateSourceRefs(spec, source);
      spec.version = run.planVersion + 1;
      spec.limits = { timeSeconds: run.input.timeSeconds, maxHourlyUSD: run.input.maxHourlyUSD, maxTotalUSD: run.input.maxTotalUSD };
      await atomicJSON(path.join(run.dir, 'plans', `v${spec.version}.json`), spec);
      await this.status(id, spec.missing.length ? 'needs_data' : 'ready', { spec, planVersion: spec.version, title: spec.title });
    });
  }
  async savePlan(id: string, input: unknown): Promise<void> {
    if (this.active) throw new Error('Во время операции план изменять нельзя');
    const run = this.store.get(id), spec = SpecSchema.parse(input);
    if (!run.source) throw new Error('Сначала импортируйте документ и создайте план');
    if (run.instanceId || run.provisioningUncertain) throw new Error('Сначала разрешите текущую аренду');
    validateSourceRefs(spec, run.source);
    spec.version = run.planVersion + 1;
    await atomicJSON(path.join(run.dir, 'plans', `v${spec.version}.json`), spec);
    // Keep each executed project immutable and attributable to its own plan version.
    await this.status(id, spec.missing.length ? 'needs_data' : 'ready', { spec, planVersion: spec.version, error: undefined });
  }
  execute(id: string): void {
    const run = this.store.get(id);
    if (run.input.agentMode === 'demo' && run.input.mode !== 'local') throw new Error('Деморежим никогда не арендует ресурсы');
    if (!run.spec || !run.source) throw new Error('Сначала сформируйте план');
    if (run.spec.missing.length) throw new Error('В плане остались недостающие сведения; исправьте их перед исполнением');
    if (run.instanceId || run.provisioningUncertain) throw new Error('Аренда уже существует или её результат неизвестен; сначала заберите результаты и завершите cleanup');
    if (!['ready', 'failed', 'needs_setup', 'cancelled', 'timed_out', 'interrupted'].includes(run.status)) throw new Error('Для нового запуска сохраните новую версию плана');
    const frozenSpec = SpecSchema.parse(JSON.parse(JSON.stringify(run.spec)));
    this.launch(id, async active => {
      const projectDir = path.join(run.dir, 'project');
      // A previous execution must not silently contaminate a repaired or new scientific plan.
      try { await readFile(path.join(projectDir, 'experiment.json')); await rename(projectDir, path.join(run.dir, `project-archive-${Date.now()}`)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await mkdir(projectDir, { recursive: true });
      await atomicJSON(path.join(projectDir, 'plan.json'), frozenSpec);
      await this.status(id, 'coding', { attempts: 0, error: undefined, artifacts: [], metrics: undefined, verification: undefined, report: undefined, target: undefined, artifactsCollected: false, executionStarted: false, cleanupRequired: false, pid: undefined, deadlineAt: undefined });
      const agentContext = { run, settings: this.store.settings, signal: active.controller.signal, emit: (type: RunEvent['type'], message: string) => this.emit(id, type, message), persist: (patch: Partial<ExperimentRun>) => this.store.patch(id, patch), projectDir };
      const assertFrozenPlan = async () => {
        const current = SpecSchema.parse(JSON.parse(await readFile(path.join(projectDir, 'plan.json'), 'utf8')));
        if (JSON.stringify(current) !== JSON.stringify(frozenSpec)) throw new Error('Worker изменил научный план: требуется новая версия и подтверждение пользователя');
      };
      if (run.input.agentMode === 'demo') { await prepareDemoCode(run, projectDir); await this.emit(id, 'agent', 'ДЕМО / ЗАГЛУШКА: скопирован эталонный код; далее запускается настоящий Python'); }
      else await codeWithPi(agentContext);
      active.controller.signal.throwIfAborted();
      await assertFrozenPlan();
      await this.status(id, 'selecting_compute');
      const ctx: ComputeContext = { ...agentContext, spec: frozenSpec };
      active.context = ctx;
      const target = await selectCompute(ctx, run.input.mode);
      await this.store.patch(id, { target });
      if (target.kind === 'vast') {
        const existing = this.store.list().find(other => other.instanceId || other.provisioningUncertain);
        if (existing) throw new Error(`Сначала разрешите аренду эксперимента «${existing.title}»: разрешён только один Vast-инстанс`);
        if (!(frozenSpec.limits.maxHourlyUSD > 0 && frozenSpec.limits.maxTotalUSD > 0)) throw new Error('Для платного запуска задайте положительный почасовой и общий бюджет');
        await this.status(id, 'awaiting_approval');
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        const abort = () => reject(active.controller.signal.reason ?? new Error('Отменено'));
        active.controller.signal.addEventListener('abort', abort, { once: true });
        active.approval = () => { active.controller.signal.removeEventListener('abort', abort); resolve(); };
        if (active.controller.signal.aborted) abort();
        await promise;
      }
      active.controller.signal.throwIfAborted();
      const backend: ComputeBackend = target.kind === 'local' ? new LocalBackend() : new VastBackend(); active.backend = backend;
      let timeoutCancellation: Promise<void> | undefined;
      const timer = setTimeout(() => {
        active.timedOut = true; active.controller.abort(new Error('Истёк лимит исполнения'));
        timeoutCancellation = backend.cancel(ctx).catch(error => this.emit(id, 'error', `Отмена по таймауту: ${String(error)}`));
      }, frozenSpec.limits.timeSeconds * 1000);
      try {
        await this.store.patch(id, { deadlineAt: new Date(Date.now() + frozenSpec.limits.timeSeconds * 1000).toISOString() });
        await this.status(id, 'preparing'); await backend.prepare(ctx);
        let execution: { exitCode: number; stderr: string };
        for (;;) {
          await this.status(id, 'running'); execution = await backend.run(ctx);
          active.controller.signal.throwIfAborted();
          if (execution.exitCode === 0 || run.attempts >= 2 || run.input.agentMode === 'demo') break;
          // Technical repairs may change code, never the frozen scientific plan.
          await this.store.patch(id, { attempts: run.attempts + 1 });
          await this.status(id, 'coding');
          await codeWithPi({ ...agentContext, repair: execution.stderr.slice(-20000) });
          await assertFrozenPlan();
          await this.status(id, 'preparing'); await backend.prepare(ctx);
        }
        if (execution.exitCode !== 0) throw new Error(`Эксперимент завершился с кодом ${execution.exitCode}: ${execution.stderr.slice(-4000)}`);
        await this.status(id, 'collecting'); await backend.collectArtifacts(ctx);
        const validated = await collectAndValidate(run);
        await this.store.patch(id, { ...validated, artifactsCollected: true });
        await this.emit(id, 'artifact', `Проверены артефакты: ${validated.artifacts.length}`);
        await backend.cleanup(ctx);
        clearTimeout(timer);
        let report: string;
        try { report = run.input.agentMode === 'demo' ? demoReport(run) : await reportWithPi(agentContext); }
        catch (error) { report = `Вычисления и проверка артефактов завершены. Отчёт pi недоступен: ${String(error)}. ${validated.verification}`; await this.emit(id, 'error', report); }
        active.controller.signal.throwIfAborted();
        await writeFile(path.join(run.dir, 'report.md'), report);
        await this.status(id, 'completed', { report });
      } catch (error) {
        try { await backend.cancel(ctx); } catch (cancelError) { await this.emit(id, 'error', `Не удалось остановить процесс: ${String(cancelError)}`); }
        if (run.instanceId || run.provisioningUncertain) {
          // Cancellation is separate from export/cleanup; aborted agent signal cannot prevent safe recovery.
          const recoveryCtx = { ...ctx, signal: AbortSignal.timeout(90000) };
          try {
            if (run.executionStarted) {
              if (!run.artifactsCollected) await backend.collectArtifacts(recoveryCtx);
              try { const validated = await collectAndValidate(run); await this.store.patch(id, validated); }
              catch (validationError) { await this.emit(id, 'error', `Снимок файлов получен, но научный результат невалиден: ${String(validationError)}`); }
            }
            await backend.cleanup(recoveryCtx);
          }
          catch (exportError) { await this.store.patch(id, { cleanupRequired: true }); await this.emit(id, 'error', `Инстанс ${run.instanceId} сохранён: экспорт/cleanup не завершён. Тарификация может продолжаться. ${String(exportError)}`); }
        }
        throw error;
      } finally { clearTimeout(timer); await timeoutCancellation; }
    });
  }
  approve(id: string): void {
    if (this.active?.id !== id || this.store.get(id).status !== 'awaiting_approval' || !this.active.approval) throw new Error('Нет ожидающего платного запуска');
    this.active.approval(); this.active.approval = undefined;
  }
  async cancel(id: string): Promise<void> {
    if (this.active?.id !== id) throw new Error('Нет активной операции для отмены');
    const active = this.active; active.controller.abort(new Error('Отменено пользователем'));
    if (active.backend && active.context) await active.backend.cancel(active.context).catch(error => this.emit(id, 'error', `Не удалось отменить процесс: ${String(error)}`));
    await active.promise;
  }
  async cleanup(id: string): Promise<void> {
    if (this.active) throw new Error('Сначала отмените активную операцию');
    const run = this.store.get(id);
    if ((!run.instanceId && !run.provisioningUncertain) || !run.spec) throw new Error('Нет сохранённой или неопределённой аренды');
    this.launch(id, async active => {
      const backend = new VastBackend();
      const ctx: ComputeContext = { run, spec: run.spec!, projectDir: path.join(run.dir, 'project'), signal: active.controller.signal, settings: this.store.settings, persist: patch => this.store.patch(id, patch), emit: (type, message) => this.emit(id, type, message) };
      active.backend = backend; active.context = ctx;
      if (run.provisioningUncertain) await backend.reconcile(ctx);
      await backend.cancel(ctx);
      if (run.executionStarted) {
        if (!run.artifactsCollected) await backend.collectArtifacts(ctx);
        try { const validated = await collectAndValidate(run); await this.store.patch(id, validated); }
        catch (validationError) { await this.store.patch(id, { status: 'failed', error: String(validationError) }); await this.emit(id, 'error', `Файлы выгружены; результат не прошёл проверку: ${String(validationError)}`); }
      }
      await backend.cleanup(ctx);
      await this.emit(id, 'compute', run.instanceId ? 'Инстанс сохранён согласно политике retain; завершите аренду через Vast Console' : run.executionStarted ? 'Результаты получены; аренда завершена' : 'Эксперимент ещё не запускался; аренда завершена');
    });
  }
  async saveSettings(settings: unknown): Promise<void> { if (this.active) throw new Error('Нельзя менять настройки во время операции'); await this.store.saveSettings(SettingsSchema.parse(settings)); }
  async transcribe(audio: ArrayBuffer): Promise<string> {
    if (this.transcription) throw new Error('Уже выполняется расшифровка');
    const controller = new AbortController();
    const promise = transcribe(new Uint8Array(audio), this.store.settings, controller.signal);
    this.transcription = { controller, promise };
    try { return await promise; } finally { if (this.transcription?.promise === promise) this.transcription = undefined; }
  }
  async shutdown(): Promise<void> {
    const operations: Promise<unknown>[] = [];
    const transcription = this.transcription;
    if (transcription) { transcription.controller.abort(new Error('Приложение закрывается')); operations.push(transcription.promise.catch(() => undefined)); }
    if (this.active) operations.push(this.cancel(this.active.id));
    await Promise.all(operations);
  }
}
