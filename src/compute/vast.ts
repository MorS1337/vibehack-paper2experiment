import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SetupRequiredError } from '../shared/errors.js';
import type { ComputeBackend, ComputeContext, ComputeTarget } from '../shared/types.js';
import { EXPORT_INVENTORY_FILE, extractVerifiedTarMember, hashFile, parseExportInventory, readTarMemberText } from './export.js';
import { LineDecoder } from './logs.js';
import { assertConfigMatchesSpec, readProjectManifest, type ValidatedProject } from './manifest.js';
import { delay } from './process.js';
import { derivePublicKey, downloadRemoteFiles, expandHome, listUploadFiles, prepareKnownHosts, REMOTE_PROJECT, runSsh, shellQuote, uploadProject, type SshTarget } from './ssh.js';
import { resolveVastCredential, VastApiClient, VastApiError, VastCreateRejectedError, type VastInstance } from './vast-api.js';
import {
  evaluateVastOffer, VAST_BOOT_RESERVE_SECONDS, VAST_IMAGE, VAST_NETWORK_RESERVE_GB,
  type VastEvaluation
} from './vast-offers.js';

const BOOT_TIMEOUT_MS = 15 * 60 * 1000;
const REMOTE_SETUP_LIMIT_MS = 20 * 60 * 1000;
const REMOTE_LOG_CHUNK = 256 * 1024;
const RECONCILE_TIMEOUT_MS = 30_000;

const FATAL_INSTANCE_STATES: Record<string, true> = {
  exited: true,
  unknown: true,
  offline: true,
  error: true,
  failed: true,
  destroyed: true,
  deallocated: true
};

const TRANSITIONAL_INSTANCE_STATES: Record<string, true> = {
  created: true,
  scheduling: true,
  loading: true,
  starting: true,
  pulling: true,
  installing: true,
  queued: true
};

interface VastSession {
  client: VastApiClient;
  keyPath: string;
  publicKey: string;
}

function instanceState(instance: VastInstance): 'running' | 'stopped' | 'transitional' | 'unknown' {
  if (instance.actualStatus === 'running') return 'running';
  if (instance.actualStatus === 'stopped') return 'stopped';
  if (FATAL_INSTANCE_STATES[instance.actualStatus]) return instance.actualStatus === 'unknown' ? 'unknown' : 'stopped';
  if (TRANSITIONAL_INSTANCE_STATES[instance.actualStatus]) return 'transitional';
  return 'unknown';
}

/** The workload and deadline enforcer must not share a session/process group. */
export function vastLaunchCommand(projectDir: string, entryPoint: string, config: string, deadline: number): string {
  const watchdog = [
    'set -u',
    `cd ${shellQuote(projectDir)} || exit 1`,
    'pgid="$1"',
    `remaining=$(( ${Math.floor(deadline / 1000)} - $(date +%s) ))`,
    'if [ "$remaining" -gt 0 ]; then sleep "$remaining"; fi',
    'if kill -0 -- "-$pgid" 2>/dev/null; then',
    '  echo timeout > .timed_out',
    '  kill -TERM -- "-$pgid" 2>/dev/null || true',
    '  sleep 5',
    '  kill -KILL -- "-$pgid" 2>/dev/null || true',
    'fi'
  ].join('\n');
  const script = [
    'set -u',
    `cd ${shellQuote(projectDir)} || exit 1`,
    'rm -rf artifacts',
    'mkdir -p artifacts',
    'rm -f stdout.log stderr.log .exitcode .timed_out .watchdog.pid',
    // Arm the independent watchdog before publishing a PID or starting Python.
    `nohup setsid /bin/bash -c ${shellQuote(watchdog)} p2e-watchdog "$$" >/dev/null 2>&1 &`,
    'echo $! > .watchdog.pid',
    'echo $$ > .pid',
    `( env -i HOME=/root TMPDIR=/tmp PATH=/opt/conda/bin:/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 LD_LIBRARY_PATH=/usr/local/nvidia/lib:/usr/local/nvidia/lib64 PYTHONUNBUFFERED=1 PYTHONNOUSERSITE=1 .venv/bin/python ${shellQuote(entryPoint)} --config ${shellQuote(config)} > stdout.log 2> stderr.log; echo $? > .exitcode ) &`,
    'child=$!',
    'wait "$child" || true'
  ].join('\n');
  const pidFile = shellQuote(`${projectDir}/.pid`);
  return [
    'command -v nohup setsid /bin/bash >/dev/null || exit 1',
    `rm -f ${pidFile} || exit 1`,
    `nohup setsid /bin/bash -c ${shellQuote(script)} >/dev/null 2>&1 &`,
    `i=0; while [ ! -s ${pidFile} ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done`,
    `if [ -s ${pidFile} ]; then cat ${pidFile}; else echo PID_MISSING >&2; exit 1; fi`
  ].join('\n');
}

class RemoteLogPump {
  private offsets: Record<'stdout' | 'stderr', number> = { stdout: 0, stderr: 0 };
  private decoders: Record<'stdout' | 'stderr', LineDecoder> = { stdout: new LineDecoder(), stderr: new LineDecoder() };
  private listeners = new Set<(line: string) => void>();
  private sink?: (message: string) => void;
  private timer?: NodeJS.Timeout;
  private queued: Promise<void> = Promise.resolve();

  constructor(private readonly target: SshTarget) {}

  attachSink(sink: (message: string) => void): void { this.sink = sink; }
  detachSink(): void { this.sink = undefined; }
  reset(): void {
    this.offsets = { stdout: 0, stderr: 0 };
    this.decoders = { stdout: new LineDecoder(), stderr: new LineDecoder() };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.queued = this.queued.then(() => this.poll()).catch(() => undefined);
    }, 2500);
    this.timer.unref();
    this.queued = this.queued.then(() => this.poll()).catch(() => undefined);
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.queued;
    await this.poll().catch(() => undefined);
    this.decoders.stdout.flush(line => this.deliver('stdout', line));
    this.decoders.stderr.flush(line => this.deliver('stderr', line));
  }

  subscribe(listener: (line: string) => void): () => void {
    this.listeners.add(listener);
    this.start();
    return () => { this.listeners.delete(listener); };
  }

  private deliver(stream: 'stdout' | 'stderr', line: string): void {
    const text = `[${stream}] ${line}`;
    for (const listener of this.listeners) {
      try { listener(text); } catch { /* UI listener isolation */ }
    }
    try { this.sink?.(text); } catch { /* orchestrator persistence errors surface elsewhere */ }
  }

  private async poll(): Promise<void> {
    for (const stream of ['stdout', 'stderr'] as const) {
      const offset = this.offsets[stream];
      const remoteFile = `${REMOTE_PROJECT}/${stream}.log`;
      const command = `tail -c +${offset + 1} -- ${shellQuote(remoteFile)} | head -c ${REMOTE_LOG_CHUNK} | base64`;
      const result = await runSsh(this.target, command, { timeoutMs: 20_000, captureLimit: REMOTE_LOG_CHUNK * 2 });
      if (result.exitCode !== 0 || !result.stdout.trim()) continue;
      const chunk = Buffer.from(result.stdout.replace(/\s+/g, ''), 'base64');
      if (chunk.length === 0) continue;
      this.offsets[stream] += chunk.length;
      this.decoders[stream].push(chunk, line => this.deliver(stream, line));
    }
  }
}

export class VastBackend implements ComputeBackend {
  private pump?: RemoteLogPump;
  private sshTarget?: SshTarget;

  private async session(ctx: ComputeContext): Promise<VastSession> {
    const credential = await resolveVastCredential();
    if (!credential) throw new SetupRequiredError('Vast не настроен: задайте VAST_API_KEY или ~/.config/vastai/vast_api_key');
    const configured = ctx.settings.sshKeyPath.trim();
    if (!configured) throw new SetupRequiredError('Vast не настроен: укажите SSH-ключ в настройках');
    const keyPath = expandHome(configured);
    if (!await access(keyPath).then(() => true, () => false)) throw new SetupRequiredError(`SSH-ключ не найден: ${configured}`);
    const publicKey = await derivePublicKey(keyPath, ctx.signal).catch(error => {
      throw new SetupRequiredError(error instanceof Error ? error.message : String(error));
    });
    return { client: new VastApiClient(credential.key), keyPath, publicKey };
  }

  private target(ctx: ComputeContext): ComputeTarget & { offerId: number } {
    const target = ctx.run.target;
    if (!target || target.kind !== 'vast') throw new Error('Цель вычислений не является Vast-инстансом');
    const offerId = target.offerId;
    if (offerId === undefined || !Number.isSafeInteger(offerId) || offerId <= 0) throw new Error('В цели Vast отсутствует offerId');
    return { ...target, offerId };
  }

  private deadline(ctx: ComputeContext): number {
    const parsed = ctx.run.deadlineAt ? Date.parse(ctx.run.deadlineAt) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : Date.now() + ctx.spec.limits.timeSeconds * 1000;
  }

  private filterOptions(ctx: ComputeContext, target: ComputeTarget): { transferGB: number; bootSeconds: number } {
    const details = target.details ?? {};
    const transferGB = typeof details.transferReserveGB === 'number' && Number.isFinite(details.transferReserveGB)
      ? details.transferReserveGB : VAST_NETWORK_RESERVE_GB;
    const bootSeconds = typeof details.bootReserveSeconds === 'number' && Number.isFinite(details.bootReserveSeconds)
      ? details.bootReserveSeconds : VAST_BOOT_RESERVE_SECONDS;
    return { transferGB, bootSeconds };
  }

  private async revalidateOffer(client: VastApiClient, ctx: ComputeContext, target: ComputeTarget & { offerId: number }): Promise<VastEvaluation> {
    const offers = await client.searchOffers({
      id: { eq: target.offerId }, type: 'ondemand', verified: { eq: true }, rentable: { eq: true }, rented: { eq: false },
      allocated_storage: Math.max(16, Math.ceil(ctx.spec.requirements.diskGB)), limit: 5
    }, { signal: ctx.signal, timeoutMs: 20_000 });
    const raw = offers.find(offer => offer && typeof offer === 'object' && 'id' in offer && offer.id === target.offerId);
    if (!raw) throw new Error(`Предложение Vast ${target.offerId} больше недоступно; требуется новое подтверждение выбора`);
    const evaluation = evaluateVastOffer(raw, ctx.spec, this.filterOptions(ctx, target));
    if (!evaluation) throw new Error(`Предложение Vast ${target.offerId} больше не соответствует ресурсам/бюджету; требуется новый выбор`);
    if (evaluation.hourlyUSD > target.hourlyUSD + 1e-6 || evaluation.estimatedUSD > target.estimatedUSD + 1e-4) {
      throw new Error(`Тариф Vast ${target.offerId} вырос после подтверждения (${target.hourlyUSD}$/ч → ${evaluation.hourlyUSD}$/ч; итог ${target.estimatedUSD}$ → ${evaluation.estimatedUSD}$). Требуется новое подтверждение`);
    }
    return evaluation;
  }

  private async ensureSshKey(session: VastSession, signal: AbortSignal): Promise<void> {
    const wanted = session.publicKey.split(/\s+/).slice(0, 2).join(' ');
    const existing = await session.client.listSshKeys({ signal, timeoutMs: 15_000 });
    if (existing.some(item => item.key.trim().split(/\s+/).slice(0, 2).join(' ') === wanted)) return;
    try {
      await session.client.registerSshKey(session.publicKey, { signal, timeoutMs: 15_000 });
    } catch (error) {
      if (!(error instanceof VastApiError) || error.status !== 400) throw error;
      const after = await session.client.listSshKeys({ signal, timeoutMs: 15_000 });
      if (!after.some(item => item.key.trim().split(/\s+/).slice(0, 2).join(' ') === wanted)) throw error;
    }
  }

  private async waitForRunning(client: VastApiClient, ctx: ComputeContext, id: number): Promise<VastInstance> {
    const deadline = this.deadline(ctx);
    const bootDeadline = Math.min(deadline, Date.now() + BOOT_TIMEOUT_MS);
    let lastState = '';
    for (;;) {
      if (ctx.signal.aborted) throw ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error('Отменено');
      const instance = await client.showInstance(id, { signal: ctx.signal, timeoutMs: 20_000 });
      if (!instance) throw new Error(`Vast-инстанс ${id} не найден после создания`);
      if (lastState !== instance.actualStatus) {
        lastState = instance.actualStatus;
        await ctx.emit('compute', `Vast ${id}: ${instance.actualStatus}${instance.statusMessage ? ` (${instance.statusMessage})` : ''}`);
      }
      if (instance.actualStatus === 'running') return instance;
      if (FATAL_INSTANCE_STATES[instance.actualStatus]) {
        throw new Error(`Vast-инстанс ${id} перешёл в состояние ${instance.actualStatus}${instance.statusMessage ? `: ${instance.statusMessage}` : ''}`);
      }
      if (Date.now() >= bootDeadline) throw new Error(`Vast-инстанс ${id} не запустился за отведённое время (состояние ${instance.actualStatus}); очистка обязательна`);
      await delay(Math.min(5000, Math.max(100, bootDeadline - Date.now())), ctx.signal);
    }
  }

  private async sshFor(ctx: ComputeContext, instance: VastInstance): Promise<SshTarget> {
    if (!instance.sshHost || !instance.sshPort) throw new Error(`Vast ${instance.id}: API не вернул SSH host/port`);
    const sshKeyPath = ctx.settings.sshKeyPath.trim();
    if (!sshKeyPath) throw new SetupRequiredError('SSH-ключ не настроен');
    const knownHostsFile = await prepareKnownHosts(ctx.run.dir);
    return { host: instance.sshHost, port: instance.sshPort, user: 'root', keyPath: expandHome(sshKeyPath), knownHostsFile };
  }

  private async waitForSsh(ctx: ComputeContext, target: SshTarget): Promise<void> {
    const deadline = Math.min(this.deadline(ctx), Date.now() + BOOT_TIMEOUT_MS);
    let lastError = 'SSH ещё недоступен';
    while (Date.now() < deadline) {
      if (ctx.signal.aborted) throw ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error('Отменено');
      const result = await runSsh(target, 'true', { timeoutMs: 20_000, signal: ctx.signal, captureLimit: 16 * 1024 });
      if (result.exitCode === 0) return;
      lastError = result.stderr.trim().slice(-1000) || `ssh exit ${result.exitCode}`;
      await delay(3000, ctx.signal);
    }
    throw new Error(`SSH к Vast не поднялся за отведённое время: ${lastError}`);
  }

  /**
   * Recover a possibly accepted create without reissuing it. An empty listing is
   * not proof of rejection: provider visibility may lag the create transaction.
   * This deliberately ignores the experiment's aborted/expired execution signal.
   */
  async reconcile(ctx: ComputeContext): Promise<void> {
    if (!ctx.run.provisioningUncertain) return;
    await ctx.persist({ cleanupRequired: true });
    const label = ctx.run.provisioningLabel;
    if (!label) throw new Error('Vast: неизвестна метка незавершённого создания; проверьте аренды вручную в Vast Console');
    const credential = await resolveVastCredential();
    if (!credential) throw new SetupRequiredError(`Vast-ключ недоступен: требуется сверка инстанса с меткой ${label}`);
    const client = new VastApiClient(credential.key);
    const signal = AbortSignal.timeout(RECONCILE_TIMEOUT_MS);
    let lastError: unknown;
    while (!signal.aborted) {
      try {
        const instances = await client.listInstances({
          signal, timeoutMs: 10_000, label,
          onInstance: async instance => {
            if (instance.label === label && ctx.run.instanceId === undefined) {
              await ctx.persist({ instanceId: instance.id, cleanupRequired: true });
            }
          }
        });
        const matches = instances.filter(instance => instance.label === label);
        if (matches.length > 0) {
          const instance = matches[0];
          if (ctx.run.instanceId !== undefined && ctx.run.instanceId !== instance.id) {
            throw new Error(`Vast: инстанс с меткой ${label} изменился при сверке; требуется ручная проверка в Vast Console`);
          }
          await ctx.persist({
            instanceId: instance.id,
            provisioningUncertain: matches.length !== 1,
            cleanupRequired: true,
            ...(ctx.run.target ? { target: { ...ctx.run.target, details: { ...ctx.run.target.details, instanceId: instance.id } } } : {})
          });
          if (matches.length !== 1) throw new Error(`Vast: несколько инстансов с меткой ${label}; требуется ручная сверка в Vast Console`);
          await ctx.emit('compute', `Vast-инстанс ${instance.id} восстановлен по точной метке ${label}`);
          return;
        }
        lastError = new Error('инстанс пока не виден в списке аккаунта');
      } catch (error) {
        lastError = error;
        // A found lease or duplicate stays durably uncertain if pagination or
        // persistence fails; never hide it by selecting another lease on retry.
        if (ctx.run.instanceId !== undefined) throw error;
      }
      await delay(2000, signal).catch(() => undefined);
    }
    throw new Error(`Vast: результат создания ${label} остаётся неизвестным (${String(lastError)}). Повторите сверку или проверьте Vast Console; повторное создание запрещено`);
  }

  private async setupRemote(ctx: ComputeContext, target: SshTarget, project: ValidatedProject): Promise<void> {
    const remaining = this.deadline(ctx) - Date.now();
    if (remaining <= 1000) throw new Error('Лимит времени истёк перед установкой зависимостей на Vast');
    const seconds = Math.max(1, Math.min(REMOTE_SETUP_LIMIT_MS / 1000, Math.ceil(remaining / 1000)));
    const requirementsText = await readFile(project.requirementsFile, 'utf8');
    const requirementsHash = createHash('sha256').update(requirementsText).digest('hex');
    const hasRequirements = requirementsText.split(/\r?\n/).some(line => line.trim() && !line.trim().startsWith('#'));
    const script = [
      'set -euo pipefail',
      `cd ${REMOTE_PROJECT}`,
      'mkdir -p artifacts',
      // The pinned PyTorch image installs Python and CUDA-enabled torch in Conda.
      // Inherit those image packages; explicit requirements may override them.
      'if [ ! -x .venv/bin/python ] || ! .venv/bin/python -c \'import sys; assert sys.base_prefix == "/opt/conda"\' 2>/dev/null; then rm -rf .venv; fi',
      '/opt/conda/bin/python -m venv --system-site-packages .venv',
      `H=${shellQuote(requirementsHash)}`,
      'if [ "$(cat .venv/.p2e-requirements.sha256 2>/dev/null || true)" != "$H" ]; then',
      ...(hasRequirements ? [`  .venv/bin/python -m pip install --disable-pip-version-check --no-input -r ${shellQuote(project.manifest.requirements)}`] : []),
      '  printf "%s\\n" "$H" > .venv/.p2e-requirements.sha256',
      'fi'
    ].join('\n');
    const command = [
      `timeout --signal=TERM --kill-after=10 ${seconds}`,
      'env -i HOME=/root TMPDIR=/tmp PATH=/opt/conda/bin:/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8',
      'PYTHONUNBUFFERED=1 PYTHONNOUSERSITE=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_INPUT=1',
      `/bin/bash -c ${shellQuote(script)}`
    ].join(' ');
    await ctx.emit('compute', 'Готовлю Python-окружение на Vast (.venv + requirements)');
    const result = await runSsh(target, command, { timeoutMs: (seconds + 30) * 1000, signal: ctx.signal, captureLimit: 256 * 1024 });
    if (result.exitCode !== 0) throw new Error(`Подготовка зависимостей на Vast не удалась (код ${result.exitCode}): ${result.stderr.slice(-6000)}`);
  }

  async prepare(ctx: ComputeContext): Promise<void> {
    const project = await readProjectManifest(ctx.projectDir);
    await assertConfigMatchesSpec(project.configFile, ctx.spec);
    ctx.signal.throwIfAborted();
    if (this.deadline(ctx) - Date.now() <= 1000) throw new Error('Лимит времени истёк до подготовки Vast');
    const target = this.target(ctx);
    const session = await this.session(ctx);
    await this.ensureSshKey(session, ctx.signal);

    if (ctx.run.provisioningUncertain) await this.reconcile(ctx);
    let id = ctx.run.instanceId;
    if (id === undefined) {
      const evaluation = await this.revalidateOffer(session.client, ctx, target);
      const deadlineAt = ctx.run.deadlineAt ?? new Date(Date.now() + ctx.spec.limits.timeSeconds * 1000).toISOString();
      const disk = Math.max(16, Math.ceil(ctx.spec.requirements.diskGB));
      await ctx.emit('compute', `Создаю Vast-инстанс из предложения ${target.offerId}: ${evaluation.target.hourlyUSD}$/ч, резерв итога ${evaluation.target.estimatedUSD}$`);
      const provisioningLabel = `p2e-${ctx.run.id}`;
      // Commit intent BEFORE dispatch: a lost create reply is still a possible
      // billable instance, including a crash between HTTP dispatch and persist.
      await ctx.persist({
        provisioningLabel,
        provisioningUncertain: true,
        deadlineAt,
        cleanupRequired: true,
        target: {
          ...evaluation.target,
          details: {
            ...evaluation.target.details,
            provisioningRequestedAt: new Date().toISOString(),
            approvedHourlyUSD: target.hourlyUSD,
            approvedEstimatedUSD: target.estimatedUSD
          }
        }
      });
      try {
        id = await session.client.createInstance(target.offerId, {
          image: VAST_IMAGE,
          label: provisioningLabel,
          disk,
          runtype: 'ssh_direct',
          target_state: 'running',
          cancel_unavail: true
        }, { signal: ctx.signal, timeoutMs: 60_000 });
      } catch (error) {
        if (error instanceof VastCreateRejectedError) {
          await ctx.persist({ provisioningUncertain: false, cleanupRequired: false });
          throw error;
        }
        try {
          await this.reconcile(ctx);
        } catch (reconcileError) {
          throw new Error(`Vast: ответ создания потерян (${String(error)}); ${String(reconcileError)}`);
        }
        id = ctx.run.instanceId;
      }
      if (id === undefined) throw new Error('Vast: создание остаётся неопределённым; повторная аренда запрещена');
      await ctx.persist({
        instanceId: id,
        provisioningUncertain: false,
        target: { ...this.target(ctx), details: { ...this.target(ctx).details, instanceId: id, instanceCreatedAt: new Date().toISOString() } }
      });
      await ctx.emit('compute', `Vast-инстанс ${id} создан; PID будет сохранён после запуска. Тарификация началась`);
    } else {
      await ctx.emit('compute', `Повторная подготовка существующего Vast-инстанса ${id}: второй инстанс не создаётся`);
      const instance = await session.client.showInstance(id, { signal: ctx.signal, timeoutMs: 20_000 });
      if (!instance) throw new Error(`Vast-инстанс ${id} из сохранённого запуска не найден`);
      if (instance.actualStatus === 'stopped' || instance.actualStatus === 'created') {
        await session.client.manageInstance(id, { state: 'running' }, { signal: ctx.signal, timeoutMs: 20_000 });
      } else if (FATAL_INSTANCE_STATES[instance.actualStatus] || instanceState(instance) === 'unknown') {
        throw new Error(`Vast-инстанс ${id} в состоянии ${instance.actualStatus}; повторный запуск запрещён, требуется очистка`);
      }
    }
    if (id === undefined) throw new Error('Vast: идентификатор инстанса не сохранился');
    ctx.signal.throwIfAborted();

    const instance = await this.waitForRunning(session.client, ctx, id);
    const sshTarget = await this.sshFor(ctx, instance);
    this.sshTarget = sshTarget;
    await this.waitForSsh(ctx, sshTarget);
    await ctx.emit('compute', `SSH к Vast ${id} доступен (known_hosts: ${sshTarget.knownHostsFile})`);
    const files = await listUploadFiles(project.projectDir, project.manifest);
    await ctx.emit('compute', `Загружаю ${files.length} allowlisted файлов проекта и data/ (без .venv, .git и секретов)`);
    const stale = await runSsh(sshTarget, `mkdir -p ${REMOTE_PROJECT} && cd ${REMOTE_PROJECT} && find . -mindepth 1 -maxdepth 1 ! -name .venv ! -name artifacts -exec rm -rf {} +`, { timeoutMs: 60_000, signal: ctx.signal, captureLimit: 16 * 1024 });
    if (stale.exitCode !== 0) throw new Error(`Не удалось очистить устаревшие файлы на Vast: ${stale.stderr.slice(-1000)}`);
    await uploadProject(sshTarget, project.projectDir, files, ctx.signal);
    await this.setupRemote(ctx, sshTarget, project);
    await ctx.persist({
      target: {
        ...this.target(ctx),
        details: { ...this.target(ctx).details, sshHost: sshTarget.host, sshPort: sshTarget.port }
      },
      command: `.venv/bin/python ${project.manifest.entryPoint} --config ${project.manifest.config}`
    });
    this.pump ??= new RemoteLogPump(sshTarget);
    await ctx.emit('compute', 'Vast подготовлен: проект загружен, зависимости установлены');
  }

  async run(ctx: ComputeContext): Promise<{ exitCode: number; stderr: string }> {
    const project = await readProjectManifest(ctx.projectDir);
    await assertConfigMatchesSpec(project.configFile, ctx.spec);
    const id = ctx.run.instanceId;
    if (id === undefined) throw new Error('Нет Vast-инстанса: prepare не завершён');
    const session = await this.session(ctx);
    const instance = await session.client.showInstance(id, { signal: ctx.signal, timeoutMs: 20_000 });
    if (!instance || instance.actualStatus !== 'running') throw new Error(`Vast-инстанс ${id} не запущен (${instance?.actualStatus ?? 'не найден'})`);
    const sshTarget = this.sshTarget ?? await this.sshFor(ctx, instance);
    this.sshTarget = sshTarget;
    const deadline = this.deadline(ctx);
    if (this.pump) await this.pump.stop();
    const remaining = deadline - Date.now();
    if (remaining <= 1000) throw new Error('Лимит времени истёк до запуска эксперимента на Vast');
    const watchdogSeconds = Math.max(1, Math.ceil(remaining / 1000));
    const startCommand = vastLaunchCommand(REMOTE_PROJECT, project.manifest.entryPoint, project.manifest.config, deadline);
    const deadlineAt = ctx.run.deadlineAt ?? new Date(deadline).toISOString();
    // Durable intent marker: from here on an SSH command may have reached the provider
    // even if this process dies before the PID reply is persisted. A new attempt also
    // invalidates any artifacts collected from an earlier attempt.
    await ctx.persist({ executionStarted: true, artifactsCollected: false, artifacts: [], metrics: undefined, verification: undefined });
    let startError: Error | undefined;
    const started = await runSsh(sshTarget, startCommand, { timeoutMs: 30_000, signal: ctx.signal, captureLimit: 16 * 1024 }).catch(error => {
      startError = error instanceof Error ? error : new Error(String(error));
      return null;
    });
    let pidText = started?.stdout.trim().split('\n').at(-1) ?? '';
    let pid = Number(pidText);
    if (!started || started.exitCode !== 0 || !Number.isSafeInteger(pid) || pid <= 0) {
      // The SSH channel may die after the detached start succeeded; recover the persisted
      // remote PID so harness cancellation can still target the real process group.
      const rescued = await runSsh(sshTarget, `cat ${REMOTE_PROJECT}/.pid 2>/dev/null || true`, { timeoutMs: 10_000, captureLimit: 4096 }).catch(() => null);
      pidText = rescued?.stdout.trim() ?? '';
      pid = Number(pidText);
      if (Number.isSafeInteger(pid) && pid > 0) {
        await ctx.persist({ pid, deadlineAt, cleanupRequired: true, command: `.venv/bin/python ${project.manifest.entryPoint} --config ${project.manifest.config}` });
        await ctx.emit('compute', `SSH-канал запуска прервался, но удалённый PID ${pid} восстановлен; продолжаю наблюдение`);
      } else {
        if (startError) throw startError;
        throw new Error(`Не удалось запустить процесс на Vast (код ${started?.exitCode ?? 'нет ответа'}): ${started?.stderr.slice(-3000) || pidText}`);
      }
    }
    await ctx.persist({ pid, deadlineAt, cleanupRequired: true, command: `.venv/bin/python ${project.manifest.entryPoint} --config ${project.manifest.config}` });
    await ctx.emit('compute', `Vast-процесс запущен: PID ${pid}; watchdog ${watchdogSeconds}с; PID сохранён`);

    const pump = this.pump ??= new RemoteLogPump(sshTarget);
    pump.reset();
    pump.attachSink(message => { void ctx.emit('log', message).catch(() => undefined); });
    pump.start();
    let timedOut = false;
    const abort = () => { void this.killRemote(ctx, sshTarget, false); };
    ctx.signal.addEventListener('abort', abort, { once: true });
    try {
      for (;;) {
        if (ctx.signal.aborted) break;
        if (Date.now() >= deadline) {
          timedOut = true;
          await this.killRemote(ctx, sshTarget, false);
          break;
        }
        const state = await this.getStatus(ctx);
        if (state === 'stopped') break;
        try {
          await delay(Math.min(2500, Math.max(100, deadline - Date.now())), ctx.signal);
        } catch {
          break;
        }
      }
    } finally {
      ctx.signal.removeEventListener('abort', abort);
      pump.detachSink();
      await pump.stop();
    }
    if (ctx.signal.aborted) throw ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error('Отменено');
    const markers = await runSsh(sshTarget, [
      `printf 'CODE='; cat ${REMOTE_PROJECT}/.exitcode 2>/dev/null || printf missing; printf '\\n'`,
      `if [ -f ${REMOTE_PROJECT}/.timed_out ]; then echo TIMEOUT=yes; else echo TIMEOUT=no; fi`
    ].join('; '), { timeoutMs: 20_000, captureLimit: 16 * 1024 });
    const codeMatch = /CODE=(-?\d+|missing)/.exec(markers.stdout);
    const exitCode = codeMatch && codeMatch[1] !== 'missing' ? Number(codeMatch[1]) : 1;
    const timedOutMarker = /TIMEOUT=yes/.test(markers.stdout);
    const stderr = await runSsh(sshTarget, `tail -c 30000 -- ${REMOTE_PROJECT}/stderr.log 2>/dev/null || true`, { timeoutMs: 20_000, captureLimit: 64 * 1024 })
      .then(result => result.stdout).catch(() => '');
    if (timedOut || timedOutMarker) {
      await ctx.emit('error', 'Vast-процесс остановлен по таймауту серверным watchdog');
      return { exitCode: 124, stderr };
    }
    await ctx.emit('compute', `Vast-процесс завершился с кодом ${exitCode}`);
    return { exitCode, stderr };
  }

  async getStatus(ctx: ComputeContext): Promise<'running' | 'stopped' | 'unknown'> {
    const id = ctx.run.instanceId;
    if (id === undefined) return ctx.run.provisioningUncertain ? 'unknown' : 'stopped';
    const credential = await resolveVastCredential();
    if (!credential) return 'unknown';
    const client = new VastApiClient(credential.key);
    let instance: VastInstance | null;
    try {
      instance = await client.showInstance(id, { timeoutMs: 15_000 });
    } catch {
      return 'unknown';
    }
    if (!instance) return 'stopped';
    const state = instanceState(instance);
    if (state === 'stopped') return 'stopped';
    if (state !== 'running') return 'unknown';
    try {
      const sshTarget = this.sshTarget ?? await this.sshFor(ctx, instance);
      this.sshTarget = sshTarget;
      const result = await runSsh(sshTarget, [
        `if [ ! -s ${REMOTE_PROJECT}/.pid ]; then`,
        '  echo missing',
        '  exit 3',
        'fi',
        `pid=$(cat ${REMOTE_PROJECT}/.pid)`,
        'if kill -0 "$pid" 2>/dev/null; then',
        '  echo running',
        `elif [ -f ${REMOTE_PROJECT}/.exitcode ]; then`,
        '  echo stopped',
        'else',
        '  echo stopped',
        'fi'
      ].join('\n'), { timeoutMs: 15_000, captureLimit: 16 * 1024 });
      if (result.exitCode === 0 && result.stdout.includes('running')) return 'running';
      if (result.exitCode === 0 && result.stdout.includes('stopped')) return 'stopped';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  streamLogs(ctx: ComputeContext, listener: (line: string) => void): () => void {
    if (!this.pump) throw new Error('Логи Vast доступны только после prepare');
    return this.pump.subscribe(listener);
  }

  private async killRemote(ctx: ComputeContext, target: SshTarget, includeApiFallback: boolean): Promise<void> {
    // Cancellation must work even when ctx.signal is already aborted.
    const result = await runSsh(target, [
      `cd ${REMOTE_PROJECT}`,
      'if [ -s .pid ]; then pid=$(cat .pid); kill -TERM -$pid 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true; sleep 3; kill -KILL -$pid 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; fi',
      'if [ -s .watchdog.pid ]; then wd=$(cat .watchdog.pid); kill -TERM "$wd" 2>/dev/null || true; fi',
      'echo STOPPED'
    ].join('; '), { timeoutMs: 45_000, captureLimit: 32 * 1024 });
    if (result.exitCode !== 0) {
      if (includeApiFallback) throw new Error(`Не удалось остановить Vast-процесс по SSH: ${result.stderr.slice(-2000)}. Серверный watchdog продолжит действовать по deadline`);
      await ctx.emit('error', `SSH-отмена Vast не удалась: ${result.stderr.slice(-1000)}. Серверный watchdog продолжит действовать по deadline`);
    }
  }

  async cancel(ctx: ComputeContext): Promise<void> {
    const id = ctx.run.instanceId;
    if (id === undefined) return;
    if (ctx.run.executionStarted !== true && ctx.run.pid === undefined) return;
    const credential = await resolveVastCredential();
    if (!credential) throw new SetupRequiredError('Vast-ключ недоступен: невозможно остановить удалённый процесс');
    const client = new VastApiClient(credential.key);
    const instance = await client.showInstance(id, { timeoutMs: 20_000 });
    if (!instance || instanceState(instance) !== 'running') return;
    try {
      const target = this.sshTarget ?? await this.sshFor(ctx, instance);
      this.sshTarget = target;
      await this.killRemote(ctx, target, true);
      await ctx.emit('compute', `Vast-процесс ${ctx.run.pid ?? '(PID неизвестен)'} остановлен`);
    } catch (error) {
      throw new Error(`Отмена Vast не завершена: ${String(error)}`);
    }
  }

  private async exportRemoteSnapshot(ctx: ComputeContext, target: SshTarget, id: number): Promise<void> {
    const remoteArchive = `${REMOTE_PROJECT}/.p2e-export.tar.gz`;
    const localArchive = path.join(ctx.run.dir, 'export', `vast-${id}-${Date.now()}.tar.gz`);
    const script = [
      'set -euo pipefail',
      `cd ${REMOTE_PROJECT}`,
      `rm -f ${EXPORT_INVENTORY_FILE} .p2e-export.tar.gz`,
      'if [ -d artifacts ]; then',
      '  special=$(find artifacts ! -type f ! -type d -print -quit)',
      '  if [ -n "$special" ]; then echo "artifacts contain symlink or special file" >&2; exit 2; fi',
      '  find artifacts -type f -exec sha256sum {} + | sort > .p2e-artifacts.sha256',
      'else',
      '  : > .p2e-artifacts.sha256',
      'fi',
      'if [ -f stdout.log ]; then sha256sum stdout.log >> .p2e-artifacts.sha256; fi',
      'if [ -f stderr.log ]; then sha256sum stderr.log >> .p2e-artifacts.sha256; fi',
      'members=".p2e-artifacts.sha256"',
      'if [ -f stdout.log ]; then members="$members stdout.log"; fi',
      'if [ -f stderr.log ]; then members="$members stderr.log"; fi',
      'if [ -d artifacts ]; then members="$members artifacts"; fi',
      'tar -czf .p2e-export.tar.gz $members',
      'sha256sum .p2e-export.tar.gz',
      'wc -c < .p2e-export.tar.gz'
    ].join('\n');
    try {
      const prepared = await runSsh(target, script, { timeoutMs: 180_000, captureLimit: 64 * 1024 });
      if (prepared.exitCode !== 0) throw new Error(`Vast не смог сформировать snapshot экспорта: ${prepared.stderr.slice(-2000)}`);
      const hashMatch = /^([a-f0-9]{64})\s+\S+$/m.exec(prepared.stdout);
      const sizeMatch = /^(\d+)$/m.exec(prepared.stdout.split('\n').filter(line => /^\d+$/.test(line.trim())).at(-1)?.trim() ?? '');
      if (!hashMatch || !sizeMatch) throw new Error('Vast вернул некорректные hash/size архива экспорта');
      const remoteBytes = Number(sizeMatch[1]);
      await mkdir(path.dirname(localArchive), { recursive: true });
      const downloaded = await downloadRemoteFiles(target, [{ remote: remoteArchive, local: localArchive }], undefined, 300_000);
      if (downloaded[0]?.error) throw new Error(`Не удалось скачать архив экспорта: ${downloaded[0].error}`);
      const local = await hashFile(localArchive, 1024 * 1024 * 1024);
      if (local.sha256 !== hashMatch[1] || local.bytes !== remoteBytes) {
        throw new Error(`Транспорт архива экспорта повреждён: удалённо ${hashMatch[1]}/${remoteBytes}B, локально ${local.sha256}/${local.bytes}B`);
      }
      const inventoryText = await readTarMemberText(localArchive, EXPORT_INVENTORY_FILE);
      const records = parseExportInventory(inventoryText);
      if (records.length > 5000) throw new Error(`Слишком много файлов в snapshot экспорта: ${records.length}`);

      const projectDir = path.resolve(ctx.projectDir);
      await mkdir(projectDir, { recursive: true });
      const artifactsDir = path.join(projectDir, 'artifacts');
      await rm(artifactsDir, { recursive: true, force: true });
      await mkdir(artifactsDir, { recursive: true });
      await rm(path.join(projectDir, 'stdout.log'), { force: true });
      await rm(path.join(projectDir, 'stderr.log'), { force: true });
      let totalBytes = 0;
      for (const record of records) {
        const destination = path.resolve(projectDir, record.path);
        if (destination !== projectDir && !destination.startsWith(projectDir + path.sep)) throw new Error(`Экспорт выходит за project: ${record.path}`);
        await mkdir(path.dirname(destination), { recursive: true });
        const bytes = await extractVerifiedTarMember(localArchive, record.path, destination, record.sha256, 512 * 1024 * 1024);
        totalBytes += bytes;
        if (totalBytes > 512 * 1024 * 1024) throw new Error('Snapshot экспорта превышает 512 MiB');
      }
      const exportDir = path.join(ctx.run.dir, 'export');
      await mkdir(exportDir, { recursive: true });
      await writeFile(path.join(exportDir, 'manifest.json'), JSON.stringify({
        instanceId: id,
        exportedAt: new Date().toISOString(),
        archiveSha256: local.sha256,
        archiveBytes: local.bytes,
        totalBytes,
        records
      }, null, 2) + '\n', { mode: 0o600 });
      await ctx.persist({ artifactsCollected: true, artifacts: [] });
      await ctx.emit('artifact', `Snapshot Vast перенесён и сверен по SHA256: файлов ${records.length}, байт ${totalBytes}`);
    } finally {
      await runSsh(target, `rm -f ${REMOTE_PROJECT}/.p2e-export.tar.gz ${REMOTE_PROJECT}/${EXPORT_INVENTORY_FILE}`, { timeoutMs: 20_000, captureLimit: 4096 }).catch(() => undefined);
      await rm(localArchive, { force: true });
    }
  }

  async collectArtifacts(ctx: ComputeContext): Promise<void> {
    try {
      const id = ctx.run.instanceId;
      if (id === undefined) throw new Error('Нет Vast-инстанса для сбора артефактов');
      const credential = await resolveVastCredential();
      if (!credential) throw new SetupRequiredError('Vast-ключ недоступен: невозможно скачать артефакты');
      const client = new VastApiClient(credential.key);
      const instance = await client.showInstance(id, { timeoutMs: 20_000 });
      if (!instance) throw new Error(`Vast-инстанс ${id} уже удалён; артефакты недоступны`);
      const keyPath = ctx.settings.sshKeyPath.trim();
      if (!keyPath) throw new SetupRequiredError('SSH-ключ не настроен: невозможно скачать артефакты');
      const sshTarget = this.sshTarget ?? {
        host: instance.sshHost ?? '',
        port: instance.sshPort ?? 0,
        user: 'root',
        keyPath: expandHome(keyPath),
        knownHostsFile: await prepareKnownHosts(ctx.run.dir)
      };
      this.sshTarget = sshTarget;
      await this.exportRemoteSnapshot(ctx, sshTarget, id);
    } catch (error) {
      await ctx.persist({ artifactsCollected: false });
      throw error;
    }
  }

  async cleanup(ctx: ComputeContext): Promise<void> {
    if (ctx.run.provisioningUncertain) await this.reconcile(ctx);
    const id = ctx.run.instanceId;
    if (id === undefined) {
      await ctx.persist({ cleanupRequired: false });
      await ctx.emit('compute', 'Vast-инстанс уже отсутствует');
      return;
    }
    if (ctx.run.input.cleanup === 'retain') {
      await ctx.persist({ cleanupRequired: false });
      await ctx.emit('compute', `Политика retain: Vast-инстанс ${id} сохранён и ПРОДОЛЖАЕТ тарифицироваться. Завершите аренду вручную в Vast Console`);
      return;
    }
    const executionStarted = ctx.run.executionStarted === true || (ctx.run.executionStarted === undefined && ctx.run.pid !== undefined);
    if (!ctx.run.artifactsCollected && executionStarted) {
      try {
        await this.collectArtifacts(ctx);
      } catch (error) {
        await ctx.persist({ cleanupRequired: true });
        throw new Error(`Отказываюсь уничтожать Vast-инстанс ${id}: экспорт артефактов не удался (${String(error)}). Повторите сбор или завершите аренду вручную в Vast Console с явным пониманием потери данных`);
      }
    }
    const credential = await resolveVastCredential();
    if (!credential) throw new SetupRequiredError('Vast-ключ недоступен: невозможно уничтожить инстанс');
    const client = new VastApiClient(credential.key);
    try {
      await client.destroyInstance(id, { timeoutMs: 30_000 });
    } catch (error) {
      await ctx.persist({ cleanupRequired: true });
      throw new Error(`Не удалось уничтожить Vast-инстанс ${id}: ${String(error)}`);
    }
    await ctx.persist({ instanceId: undefined, pid: undefined, cleanupRequired: false });
    this.sshTarget = undefined;
    this.pump = undefined;
    await ctx.emit('compute', `Vast-инстанс ${id} уничтожен; тарификация прекращена`);
  }
}
