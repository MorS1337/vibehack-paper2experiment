import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SetupRequiredError } from '../shared/errors.js';
import type { ComputeBackend, ComputeContext } from '../shared/types.js';
import { EXPORT_INVENTORY_FILE, extractVerifiedTarMember, hashFile, parseExportInventory, readTarMemberText } from './export.js';
import { LineDecoder } from './logs.js';
import { delay } from './process.js';
import { downloadRemoteFiles, expandHome, prepareKnownHosts, REMOTE_PROJECT, runSsh, shellQuote, type SshTarget } from './ssh.js';
import { resolveVastCredential, VastApiClient, type VastInstance } from './vast-api.js';
import { assertVastLaunchAllowed } from './vast-policy.js';
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

function instanceState(instance: VastInstance): 'running' | 'stopped' | 'transitional' | 'unknown' {
  if (instance.actualStatus === 'running') return 'running';
  if (instance.actualStatus === 'stopped') return 'stopped';
  if (FATAL_INSTANCE_STATES[instance.actualStatus]) return instance.actualStatus === 'unknown' ? 'unknown' : 'stopped';
  if (TRANSITIONAL_INSTANCE_STATES[instance.actualStatus]) return 'transitional';
  return 'unknown';
}

class RemoteLogPump {
  private offsets: Record<'stdout' | 'stderr', number> = { stdout: 0, stderr: 0 };
  private decoders: Record<'stdout' | 'stderr', LineDecoder> = { stdout: new LineDecoder(), stderr: new LineDecoder() };
  private listeners = new Set<(line: string) => void>();
  private timer?: NodeJS.Timeout;
  private queued: Promise<void> = Promise.resolve();

  constructor(private readonly target: SshTarget) {}

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
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) void this.stop();
    };
  }

  private deliver(stream: 'stdout' | 'stderr', line: string): void {
    const text = `[${stream}] ${line}`;
    for (const listener of this.listeners) {
      try { listener(text); } catch { /* UI listener isolation */ }
    }
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

  private async sshFor(ctx: ComputeContext, instance: VastInstance): Promise<SshTarget> {
    if (!instance.sshHost || !instance.sshPort) throw new Error(`Vast ${instance.id}: API не вернул SSH host/port`);
    const sshKeyPath = ctx.settings.sshKeyPath.trim();
    if (!sshKeyPath) throw new SetupRequiredError('SSH-ключ не настроен');
    const knownHostsFile = await prepareKnownHosts(ctx.run.dir);
    return { host: instance.sshHost, port: instance.sshPort, user: 'root', keyPath: expandHome(sshKeyPath), knownHostsFile };
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

  /** This release supports recovery of existing leases, never preparation or execution. */
  async prepare(_ctx: ComputeContext): Promise<void> {
    assertVastLaunchAllowed();
  }

  async run(_ctx: ComputeContext): Promise<{ exitCode: number; stderr: string }> {
    assertVastLaunchAllowed();
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
    if (!this.sshTarget || ctx.run.instanceId === undefined) throw new Error('Логи Vast доступны только после проверки существующего инстанса');
    this.pump ??= new RemoteLogPump(this.sshTarget);
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
    if (this.pump) await this.pump.stop();
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
