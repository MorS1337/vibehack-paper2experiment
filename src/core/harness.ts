import path from 'node:path';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { Store, atomicJSON } from './store.js';
import { importSource } from './source.js';
import { collectAndValidate } from './artifacts.js';
import { sourcePdfPath } from './paper.js';
import { readConversation, readArtifactPreview } from './conversation.js';
import { demoPlan, prepareDemoCode, demoReport } from './demo-agent.js';
import { converseWithPi, getAgentStatuses, planIssues } from '../integrations/pi.js';
import { transcribe, whisperStatus } from '../integrations/whisper.js';
import { LocalBackend } from '../compute/local.js';
import { VastBackend } from '../compute/vast.js';
import { selectCompute, getComputeStatuses } from '../compute/index.js';
import { SpecSchema } from '../shared/types.js';
import { SetupRequiredError } from '../shared/errors.js';
import { PiAuth } from '../integrations/pi-auth.js';
import type { AppSettings, ComputeBackend, ComputeContext, ConversationUpdate, ExperimentRun, ExperimentSpec, PiLoginMethod, RunEvent, Snapshot } from '../shared/types.js';

const InputSchema = z.object({ agentMode: z.enum(['demo', 'pi']), source: z.string().min(1).max(4096), task: z.string().min(1).max(30000), authorRepo: z.string().max(2048).optional(), dataDir: z.string().max(4096).optional(), mode: z.enum(['local', 'vast', 'auto']), timeSeconds: z.number().int().min(5).max(86400), maxHourlyUSD: z.number().finite().nonnegative(), maxTotalUSD: z.number().finite().nonnegative(), cleanup: z.enum(['destroy', 'retain']) });
const SettingsSchema = z.object({ piProvider: z.string().max(100), piModel: z.string().max(200), python: z.string().min(1).max(4096), whisperBinary: z.string().min(1).max(4096), whisperModel: z.string().max(4096), sshKeyPath: z.string().max(4096) });
const busyStatuses = ['importing', 'planning', 'coding', 'selecting_compute', 'awaiting_approval', 'preparing', 'running', 'collecting'];
interface Active {
  id: string; controller: AbortController; promise?: Promise<void>; session?: AgentSession;
  backend?: ComputeBackend; context?: ComputeContext; approval?: () => void; timedOut: boolean;
  queued: { text: string; delivery: 'steer' | 'followUp' }[];
  executionAttempts: number; executionDeadline?: number; executed: boolean;
  closing?: boolean;
}

export class Harness {
  readonly piAuth: PiAuth;
  private active?: Active;
  private stopping = false;
  private planSaving?: Promise<ExperimentSpec>;
  private transcription?: { id: string; controller: AbortController; promise: Promise<string> };
  private listeners = new Set<(event: RunEvent) => void>();
  private conversationListeners = new Set<(update: ConversationUpdate) => void>();
  constructor(readonly store: Store) { this.piAuth = new PiAuth(undefined, path.join(store.root, 'pi-device-id')); }
  startPiLogin(provider: string, method: PiLoginMethod) {
    if (this.stopping) throw new Error('Приложение закрывается');
    if (this.active) throw new Error('Сначала завершите активную операцию');
    return this.piAuth.start(provider, method);
  }
  onEvent(listener: (event: RunEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onConversation(listener: (update: ConversationUpdate) => void): () => void { this.conversationListeners.add(listener); return () => this.conversationListeners.delete(listener); }
  private publish(update: ConversationUpdate): void { for (const listener of this.conversationListeners) listener(update); }
  async initialize(): Promise<void> {
    await this.store.load();
    for (const run of this.store.list()) {
      if (run.provisioningUncertain && run.spec) {
        const ctx: ComputeContext = { run, spec: run.spec, projectDir: path.join(run.dir, 'project'), settings: this.store.settings, signal: AbortSignal.timeout(30000), persist: patch => this.store.patch(run.id, patch), emit: (type, message) => this.emit(run.id, type, message) };
        try { await new VastBackend().reconcile(ctx); }
        catch (error) { await this.emit(run.id, 'error', `Не удалось разрешить неопределённую аренду: ${String(error)}`); }
      }
      if (busyStatuses.includes(run.status) || run.provisioningUncertain) {
        await this.store.patch(run.id, { status: 'interrupted', cleanupRequired: !!run.instanceId || !!run.provisioningUncertain, error: run.provisioningUncertain ? `Ответ создания инстанса потерян. Метка ${run.provisioningLabel}; повторная аренда заблокирована. Повторите cleanup или проверьте Vast Console.` : run.instanceId ? 'Операция прервана. Инстанс может тарифицироваться: выполните cleanup.' : 'Операция прервана. История сохранена; автоматический перезапуск запрещён. PID после сбоя не считается безопасным для kill.' });
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
    if (this.stopping) throw new Error('Приложение закрывается');
    if (this.piAuth.busy) throw new Error('Сначала завершите вход в Pi');
    if (this.active || this.planSaving) throw new Error('Уже выполняется другая операция. Сначала остановите её');
    const active: Active = { id, controller: new AbortController(), timedOut: false, queued: [], executionAttempts: 0, executed: false };
    this.active = active;
    active.promise = work(active).catch(async error => {
      const run = this.store.get(id);
      const message = error instanceof Error ? error.message : String(error);
      const status = active.timedOut ? 'timed_out' : active.controller.signal.aborted ? 'cancelled' : error instanceof SetupRequiredError ? 'needs_setup' : 'failed';
      // A failed follow-up cannot erase a previously verified scientific result.
      await this.status(id, run.status === 'completed' ? 'completed' : status, { error: message });
      await this.emit(id, 'error', message);
    }).finally(async () => {
      if (this.active === active) this.active = undefined;
      this.publish({ runId: id, blocks: [], queued: [] });
      await this.emit(id, 'status', this.store.get(id).status);
    });
  }
  async create(input: unknown): Promise<ExperimentRun> {
    const parsed = InputSchema.parse(input);
    if (parsed.agentMode === 'demo' && parsed.mode !== 'local') throw new Error('Деморежим допускает только Local. Платная аренда запрещена.');
    if (parsed.authorRepo && !/^https:\/\/[^\s]+$/.test(parsed.authorRepo)) throw new Error('Авторский репозиторий: требуется HTTPS URL');
    return this.store.create(parsed);
  }
  async importPaper(source: unknown): Promise<ExperimentRun> {
    if (this.active || this.piAuth.busy) throw new Error('Сначала завершите активную операцию');
    const original = z.string().trim().min(1).max(4096).parse(source);
    const run = await this.store.create({ agentMode: 'pi', source: original, task: '', mode: 'local', timeSeconds: 300, maxHourlyUSD: 0, maxTotalUSD: 0, cleanup: 'destroy' });
    this.launch(run.id, async active => {
      await this.status(run.id, 'importing');
      const document = await importSource(run, active.controller.signal);
      await this.status(run.id, 'draft', { source: document, title: document.title ?? path.basename(original) });
      await this.emit(run.id, 'artifact', `Paper imported: ${document.pages.length} pages; SHA256 ${document.sha256}. No model called.`);
    });
    return run;
  }
  async setBrief(id: string, input: unknown): Promise<void> {
    if (this.active) throw new Error('Сначала дождитесь импорта статьи');
    const run = this.store.get(id);
    if (!run.source || run.input.task || run.sessionFile || run.spec) throw new Error('Research brief can only be set on an imported paper draft');
    const parsed = InputSchema.parse(input);
    if (parsed.source !== run.input.source) throw new Error('Brief must refer to the imported paper');
    if (parsed.agentMode === 'demo' && parsed.mode !== 'local') throw new Error('Demo supports Local only');
    if (parsed.authorRepo && !/^https:\/\/[^\s]+$/.test(parsed.authorRepo)) throw new Error('Author repository requires HTTPS');
    await this.store.patch(id, { input: parsed, title: run.source.title ?? parsed.task.slice(0, 80), error: undefined });
  }
  sourcePdfPath(id: string) { return sourcePdfPath(this.store.get(id)); }
  conversation(id: string, before?: number) { return readConversation(this.store.get(id), before, this.active?.id === id); }
  artifactPreview(id: string, file: string) { return readArtifactPreview(this.store.get(id), file); }

  async sendMessage(id: string, text: string, delivery: 'steer' | 'followUp' = 'followUp', pendingId?: string): Promise<void> {
    text = z.string().trim().min(1).max(30000).parse(text);
    const run = this.store.get(id);
    if (!run.input.task.trim()) throw new Error('Provide a research brief for the imported paper before starting the agent.');
    if (run.input.agentMode !== 'pi') throw new Error('Демо не является чат-агентом. Создайте эксперимент в режиме Pi.');
    if (this.active?.id === id && this.active.closing) {
      await this.active.promise;
      return this.sendMessage(id, text, delivery, pendingId);
    }
    if (this.active && this.active.id !== id) throw new Error('Сначала завершите активный эксперимент');
    if (pendingId) {
      const pending = run.pendingInputs?.find(item => item.id === pendingId);
      if (!pending || pending.text !== text || pending.delivery !== delivery) throw new Error('Pending input is no longer available');
    } else {
      pendingId = randomUUID();
      await this.store.patch(id, { pendingInputs: [...run.pendingInputs ?? [], { id: pendingId, text, delivery }] });
    }
    if (this.active?.id === id && this.active.closing) {
      await this.active.promise;
      return this.sendMessage(id, text, delivery, pendingId);
    }
    if (this.active) {
      if (this.active.id !== id) throw new Error('Сначала завершите активный эксперимент');
      if (this.active.session) {
        await this.active.session[delivery](text);
        this.publish({ runId: id, blocks: [], queued: [...this.active.session.getSteeringMessages().map(value => `Steer: ${value}`), ...this.active.session.getFollowUpMessages().map(value => `Next: ${value}`)] });
      } else {
        this.active.queued.push({ text, delivery });
        this.publish({ runId: id, blocks: [], queued: this.active.queued.map(item => `${item.delivery}: ${item.text}`) });
      }
      return;
    }
    this.launch(id, active => this.conversationWork(run, active, text));
  }
  private async conversationWork(run: ExperimentRun, active: Active, text: string): Promise<void> {
      const id = run.id;
      const previousStatus = run.status;
      if (!run.source) {
        await this.status(id, 'importing', { error: undefined });
        const source = await importSource(run, active.controller.signal);
        await this.store.patch(id, { source });
        await this.emit(id, 'artifact', `Источник сохранён: SHA256 ${source.sha256}; страниц ${source.pages.length}`);
      }
      if (['draft', 'failed', 'needs_setup', 'interrupted', 'cancelled'].includes(run.status)) await this.status(id, 'planning', { error: undefined });
      // Announce work even when the scientific run's state is already completed/ready.
      await this.emit(id, 'agent', 'Pi продолжает разговор');
      try {
      const answer = await converseWithPi({
        run, settings: this.store.settings, signal: active.controller.signal, projectDir: path.join(run.dir, 'project'), queued: active.queued,
        emit: (type, message) => this.emit(id, type, message), persist: patch => this.store.patch(id, patch),
        publish: update => this.publish(update), attach: session => { active.session = session; active.closing = !session; },
        acknowledge: async delivered => {
          const index = run.pendingInputs?.findIndex(item => item.text === delivered) ?? -1;
          if (index >= 0) await this.store.patch(id, { pendingInputs: run.pendingInputs!.filter((_item, position) => position !== index) });
        }
      }, text, {
        propose: spec => this.commitPlan(run, spec, false),
        execute: () => this.executeWork(run, active)
      });
      if (active.executed && answer) {
        await writeFile(path.join(run.dir, 'report.md'), answer);
        await this.store.patch(id, { report: answer });
      }
      if (run.status === 'planning' || run.status === 'coding') await this.status(id, previousStatus === 'completed' ? 'completed' : run.spec ? run.spec.missing.length ? 'needs_data' : 'ready' : 'draft');
      } finally {
        // A fresh chat turn must not reset the repair allowance under an old approval.
        if (active.executionAttempts) await this.store.patch(id, { approvedPlanVersion: undefined });
      }
  }
  async plan(id: string): Promise<void> {
    const run = this.store.get(id);
    if (!run.input.task.trim()) throw new Error('Provide a research brief for the imported paper before planning.');
    if (run.input.agentMode === 'pi') return this.sendMessage(id, run.sessionFile ? 'Review the current task and propose the next scientific plan for my approval.' : run.input.task);
    if (run.instanceId || run.provisioningUncertain) throw new Error('Сначала разрешите незавершённую аренду');
    this.launch(id, async active => {
      if (!run.source) {
        await this.status(id, 'importing', { error: undefined });
        const source = await importSource(run, active.controller.signal);
        await this.store.patch(id, { source });
        await this.emit(id, 'artifact', `Источник сохранён: SHA256 ${source.sha256}; страниц ${source.pages.length}`);
      } else {
        await sourcePdfPath(run);
      }
      await this.commitPlan(run, demoPlan(run), false);
      await this.emit(id, 'agent', 'ДЕМО / ЗАГЛУШКА: фиксированный план, модель не вызывалась');
    });
  }
  private async commitPlan(run: ExperimentRun, input: unknown, userEdit: boolean): Promise<ExperimentSpec> {
    const spec = SpecSchema.parse(input);
    if (!run.source) throw new Error('Сначала импортируйте документ');
    if (run.instanceId || run.provisioningUncertain) throw new Error('Сначала разрешите текущую аренду');
    const issues = planIssues(spec, run);
    if (issues.length) throw new Error(issues.join('; '));
    spec.version = run.planVersion + 1;
    if (!userEdit) spec.limits = { timeSeconds: run.input.timeSeconds, maxHourlyUSD: run.input.maxHourlyUSD, maxTotalUSD: run.input.maxTotalUSD };
    await atomicJSON(path.join(run.dir, 'plans', `v${spec.version}.json`), spec);
    await this.status(run.id, spec.missing.length ? 'needs_data' : 'ready', { spec, planVersion: spec.version, title: spec.title, approvedPlanVersion: undefined, error: undefined, ...(userEdit ? { input: { ...run.input, ...spec.limits } } : {}) });
    return spec;
  }
  async savePlan(id: string, input: unknown): Promise<void> {
    if (this.stopping) throw new Error('Приложение закрывается');
    if (this.active || this.planSaving) throw new Error('Во время операции план изменять нельзя');
    const saving = this.commitPlan(this.store.get(id), input, true);
    this.planSaving = saving;
    try { await saving; }
    finally { if (this.planSaving === saving) this.planSaving = undefined; }
  }
  async execute(id: string): Promise<void> {
    if (this.active || this.planSaving) throw new Error('Сначала дождитесь ответа агента или остановите его');
    const run = this.store.get(id);
    if (!run.spec || !run.source) throw new Error('Сначала сформируйте план');
    if (run.spec.missing.length) throw new Error('В плане остались недостающие сведения');
    const issues = planIssues(run.spec, run);
    if (issues.length) throw new Error(issues.join('; '));
    if (run.instanceId || run.provisioningUncertain) throw new Error('Сначала разрешите незавершённую аренду');
    if (!['ready', 'failed', 'needs_setup', 'cancelled', 'timed_out', 'interrupted'].includes(run.status)) throw new Error('Для нового запуска сначала предложите новую версию плана');
    this.launch(id, async active => {
      const projectDir = path.join(run.dir, 'project');
      // Reserve the global operation before touching an earlier execution's workspace.
      try {
        await readFile(path.join(projectDir, 'experiment.json'));
        await rename(projectDir, path.join(run.dir, `project-archive-${Date.now()}-${randomUUID()}`));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      active.controller.signal.throwIfAborted();
      await mkdir(projectDir, { recursive: true });
      await atomicJSON(path.join(projectDir, 'plan.json'), run.spec);
      await this.store.patch(id, { approvedPlanVersion: run.planVersion, executionStarted: false });
      if (run.input.agentMode === 'demo') await this.executeWork(run, active);
      else await this.conversationWork(run, active, `I approve scientific plan v${run.planVersion}. Implement it using the current contract from get_experiment, then call run_experiment. Explain and visualize the actual results. Do not change the science or limits.`);
    });
  }

  private async executeWork(run: ExperimentRun, active: Active): Promise<unknown> {
    const id = run.id;
    active.controller.signal.throwIfAborted();
    if (active.executed) throw new Error('This approved execution already completed. Propose a new plan and obtain explicit approval before running again.');
    if (!run.spec || !run.source) throw new Error('План и источник обязательны');
    if (run.input.agentMode === 'demo' && run.input.mode !== 'local') throw new Error('Демо никогда не арендует ресурсы');
    if (run.input.agentMode === 'pi' && run.approvedPlanVersion !== run.planVersion) throw new Error('Требуется подтверждение текущей версии плана');
    if (run.spec.missing.length || run.instanceId || run.provisioningUncertain) throw new Error('Разрешите missing/незавершённую аренду перед исполнением');
    const issues = planIssues(run.spec, run);
    if (issues.length) throw new Error(issues.join('; '));
    if (active.executionAttempts >= 3) throw new Error('Execution attempt limit (3) reached. Stop and review the failure before explicitly approving another run. Local execution does not incur cloud charges.');
    if (run.input.mode !== 'local' && active.executionAttempts > 0) throw new Error('Another cloud attempt requires a new explicit approval; no second paid instance will be provisioned in this turn.');
    const frozenSpec = SpecSchema.parse(structuredClone(run.spec));
    const projectDir = path.join(run.dir, 'project');
    await mkdir(projectDir, { recursive: true });
    if (run.input.agentMode === 'demo') {
      await atomicJSON(path.join(projectDir, 'plan.json'), frozenSpec);
      await prepareDemoCode(run, projectDir);
      await this.emit(id, 'agent', 'ДЕМО / ЗАГЛУШКА: эталонный код; далее настоящий Python');
    }
    const current = SpecSchema.parse(JSON.parse(await readFile(path.join(projectDir, 'plan.json'), 'utf8')));
    if (JSON.stringify(current) !== JSON.stringify(frozenSpec)) throw new Error('Научный план изменён: требуется новая версия и подтверждение');
    await this.status(id, 'selecting_compute', { attempts: active.executionAttempts++, error: undefined, artifacts: [], metrics: undefined, verification: undefined, report: undefined, target: undefined, artifactsCollected: false, executionStarted: false, cleanupRequired: false, pid: undefined });
    const ctx: ComputeContext = { run, spec: frozenSpec, projectDir, settings: this.store.settings, signal: active.controller.signal, persist: patch => this.store.patch(id, patch), emit: (type, message) => this.emit(id, type, message) };
    active.context = ctx;
    const target = await selectCompute(ctx, run.input.mode);
    await this.store.patch(id, { target });
    if (target.kind === 'vast') {
      const existing = this.store.list().find(other => other.instanceId || other.provisioningUncertain);
      if (existing) throw new Error(`Сначала разрешите аренду «${existing.title}»: допускается один Vast-инстанс`);
      if (!(frozenSpec.limits.maxHourlyUSD > 0 && frozenSpec.limits.maxTotalUSD > 0)) throw new Error('Платный запуск требует положительных бюджетов');
      await this.status(id, 'awaiting_approval');
      const approval = Promise.withResolvers<void>();
      const abort = () => approval.reject(active.controller.signal.reason ?? new Error('Отменено'));
      active.controller.signal.addEventListener('abort', abort, { once: true });
      active.approval = () => { active.controller.signal.removeEventListener('abort', abort); approval.resolve(); };
      if (active.controller.signal.aborted) abort();
      await approval.promise;
    }
    active.controller.signal.throwIfAborted();
    const backend: ComputeBackend = target.kind === 'local' ? new LocalBackend() : new VastBackend(); active.backend = backend;
    active.executionDeadline ??= Date.now() + frozenSpec.limits.timeSeconds * 1000;
    let timeoutCancellation: Promise<void> | undefined;
    const timer = setTimeout(() => {
      active.timedOut = true; active.controller.abort(new Error('Истёк лимит исполнения'));
      timeoutCancellation = backend.cancel(ctx).catch(error => this.emit(id, 'error', `Отмена по таймауту: ${String(error)}`));
    }, Math.max(1, active.executionDeadline - Date.now()));
    try {
      await this.store.patch(id, { deadlineAt: new Date(active.executionDeadline).toISOString() });
      await this.status(id, 'preparing'); await backend.prepare(ctx);
      await this.status(id, 'running'); const execution = await backend.run(ctx);
      active.controller.signal.throwIfAborted();
      if (execution.exitCode !== 0) throw new Error(`Python exit ${execution.exitCode}: ${execution.stderr.slice(-12000)}`);
      await this.status(id, 'collecting'); await backend.collectArtifacts(ctx);
      const validated = await collectAndValidate(run);
      await this.store.patch(id, { ...validated, artifactsCollected: true });
      await this.emit(id, 'artifact', `Проверены артефакты: ${validated.artifacts.length}`);
      await backend.cleanup(ctx);
      active.executed = true;
      if (run.input.agentMode === 'demo') {
        const report = demoReport(run); await writeFile(path.join(run.dir, 'report.md'), report); await this.store.patch(id, { report });
      }
      await this.status(id, 'completed');
      return { status: 'completed', ...validated, command: run.command };
    } catch (error) {
      try { await backend.cancel(ctx); } catch (cancelError) { await this.emit(id, 'error', `Отмена: ${String(cancelError)}`); }
      if (run.instanceId || run.provisioningUncertain) {
        const recoveryCtx = { ...ctx, signal: AbortSignal.timeout(90000) };
        try {
          if (run.executionStarted) {
            if (!run.artifactsCollected) await backend.collectArtifacts(recoveryCtx);
            try { await this.store.patch(id, await collectAndValidate(run)); }
            catch (validationError) { await this.emit(id, 'error', `Снимок получен, но научный результат невалиден: ${String(validationError)}`); }
          }
          await backend.cleanup(recoveryCtx);
        } catch (exportError) {
          await this.store.patch(id, { cleanupRequired: true });
          await this.emit(id, 'error', `Инстанс ${run.instanceId} сохранён: экспорт/cleanup не завершён; тарификация может продолжаться. ${String(exportError)}`);
        }
      }
      await this.status(id, 'failed', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally { clearTimeout(timer); await timeoutCancellation; }
  }
  approve(id: string): void {
    if (this.active?.id !== id || this.store.get(id).status !== 'awaiting_approval' || !this.active.approval) throw new Error('Нет ожидающего платного запуска');
    this.active.approval(); this.active.approval = undefined;
  }
  async cancel(id: string): Promise<void> {
    if (this.active?.id !== id) throw new Error('Нет активной операции');
    const active = this.active; active.controller.abort(new Error('Отменено пользователем'));
    if (active.backend && active.context) await active.backend.cancel(active.context).catch(error => this.emit(id, 'error', String(error)));
    await active.promise;
  }
  async cleanup(id: string): Promise<void> {
    if (this.active) throw new Error('Сначала остановите активную операцию');
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
        try { await this.store.patch(id, await collectAndValidate(run)); }
        catch (validationError) { await this.status(id, 'failed', { error: String(validationError) }); }
      }
      await backend.cleanup(ctx);
      await this.emit(id, 'compute', run.instanceId ? 'Инстанс сохранён по retain; завершите аренду через Vast Console' : 'Результаты получены; аренда завершена');
    });
  }
  async saveSettings(settings: unknown): Promise<void> { if (this.active) throw new Error('Нельзя менять настройки во время операции'); await this.store.saveSettings(SettingsSchema.parse(settings)); }
  async transcribe(audio: ArrayBuffer, requestId: string): Promise<string> {
    if (this.stopping) throw new Error('Приложение закрывается');
    if (this.transcription) throw new Error('Уже выполняется расшифровка');
    const controller = new AbortController();
    const promise = transcribe(new Uint8Array(audio), this.store.settings, controller.signal);
    this.transcription = { id: requestId, controller, promise };
    try { return await promise; } finally { if (this.transcription?.promise === promise) this.transcription = undefined; }
  }
  async cancelTranscription(requestId: string): Promise<void> {
    const transcription = this.transcription;
    if (!transcription || transcription.id !== requestId) return;
    transcription.controller.abort(new Error('Расшифровка отменена'));
    await transcription.promise.catch(() => undefined);
  }
  async shutdown(): Promise<void> {
    this.stopping = true;
    const operations: Promise<unknown>[] = [this.piAuth.shutdown()];
    if (this.planSaving) operations.push(this.planSaving.catch(() => undefined));
    if (this.transcription) { this.transcription.controller.abort(new Error('Приложение закрывается')); operations.push(this.transcription.promise.catch(() => undefined)); }
    if (this.active) operations.push(this.cancel(this.active.id));
    await Promise.all(operations);
  }
}
