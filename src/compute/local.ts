import { createHash } from 'node:crypto';
import { access, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SetupRequiredError } from '../shared/errors.js';
import type { ComputeBackend, ComputeContext } from '../shared/types.js';
import { FileLogPump } from './logs.js';
import { assertConfigMatchesSpec, readProjectManifest, venvPython, type ValidatedProject } from './manifest.js';
import {
  executionEnv, isProcessAlive, readFileTail, runProcess, startDetached,
  terminateProcessGroup, type DetachedExecution
} from './process.js';

const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;
const VENV_TIMEOUT_MS = 5 * 60 * 1000;

export class LocalBackend implements ComputeBackend {
  private active?: { execution: DetachedExecution };
  private pump?: FileLogPump;

  private async projectFor(ctx: ComputeContext): Promise<ValidatedProject> {
    return readProjectManifest(ctx.projectDir);
  }

  private createPump(projectDir: string): FileLogPump {
    this.pump ??= new FileLogPump(projectDir);
    return this.pump;
  }

  async prepare(ctx: ComputeContext): Promise<void> {
    const project = await this.projectFor(ctx);
    await assertConfigMatchesSpec(project.configFile, ctx.spec);
    ctx.signal.throwIfAborted();
    const python = ctx.settings.python.trim() || 'python3';
    const venv = venvPython(project.projectDir);
    const venvDirectory = path.join(project.projectDir, '.venv');
    const venvInfo = await lstat(venvDirectory).catch(() => null);
    if (venvInfo?.isSymbolicLink()) throw new Error('Некорректное локальное окружение: .venv не может быть symlink');
    if (venvInfo && !venvInfo.isDirectory()) throw new Error('Некорректное локальное окружение: .venv должен быть каталогом');
    const deadline = this.deadline(ctx);
    const remaining = deadline - Date.now();
    if (remaining <= 1000) throw new Error('Лимит времени уже исчерпан до подготовки локального окружения');

    let venvReady = await access(venv).then(() => true, () => false);
    if (!venvReady) {
      await ctx.emit('compute', `Создаю локальное окружение .venv (${python} -m venv)`);
      const result = await runProcess(python, ['-m', 'venv', '.venv'], {
        cwd: project.projectDir,
        env: executionEnv(),
        signal: ctx.signal,
        timeoutMs: Math.min(remaining, VENV_TIMEOUT_MS)
      }).catch(error => {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
          throw new SetupRequiredError(`Python не найден: ${python}. Укажите существующий интерпретатор в настройках`);
        }
        throw error;
      });
      if (result.exitCode !== 0) throw new SetupRequiredError(`python -m venv завершился с кодом ${result.exitCode}: ${result.stderr.slice(-4000)}`);
      venvReady = true;
    }

    const requirementsText = await readFile(project.requirementsFile, 'utf8');
    const requirementsHash = createHash('sha256').update(requirementsText).digest('hex');
    const hasRequirements = requirementsText.split(/\r?\n/).some(line => line.trim() && !line.trim().startsWith('#'));
    const marker = path.join(venvDirectory, '.p2e-requirements.sha256');
    const installedHash = await readFile(marker, 'utf8').catch(() => '');
    if (!venvReady || (hasRequirements && installedHash.trim() !== requirementsHash)) {
      if (hasRequirements) {
        const stillRemaining = deadline - Date.now();
        if (stillRemaining <= 1000) throw new Error('Лимит времени исчерпан перед установкой зависимостей');
        await ctx.emit('compute', 'Устанавливаю зависимости проекта в .venv');
        const result = await runProcess(venv, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-r', project.manifest.requirements], {
          cwd: project.projectDir,
          env: executionEnv(),
          signal: ctx.signal,
          timeoutMs: Math.min(stillRemaining, INSTALL_TIMEOUT_MS)
        });
        if (result.exitCode !== 0) throw new Error(`pip install завершился с кодом ${result.exitCode}: ${result.stderr.slice(-8000)}`);
      }
      await writeFile(marker, requirementsHash + '\n', { mode: 0o600 });
    } else if (installedHash.trim() !== requirementsHash) {
      await writeFile(marker, requirementsHash + '\n', { mode: 0o600 });
    }
    const command = `${venv} ${project.manifest.entryPoint} --config ${project.manifest.config}`;
    await ctx.persist({ command });
    this.createPump(project.projectDir);
    await ctx.emit('compute', 'Локальное окружение готово');
  }

  async run(ctx: ComputeContext): Promise<{ exitCode: number; stderr: string }> {
    const project = await this.projectFor(ctx);
    await assertConfigMatchesSpec(project.configFile, ctx.spec);
    const venv = venvPython(project.projectDir);
    if (!await access(venv).then(() => true, () => false)) throw new Error('Локальное окружение .venv отсутствует: выполните prepare');
    ctx.signal.throwIfAborted();
    const deadline = this.deadline(ctx);
    if (deadline - Date.now() <= 1000) throw new Error('Лимит времени исполнения истёк');

    const pump = this.createPump(project.projectDir);
    await pump.stop();
    const artifactsDir = path.join(project.projectDir, 'artifacts');
    await rm(artifactsDir, { recursive: true, force: true });
    await mkdir(artifactsDir, { recursive: true });
    const stdoutFile = path.join(project.projectDir, 'stdout.log');
    const stderrFile = path.join(project.projectDir, 'stderr.log');
    const commandLine = `${venv} ${project.manifest.entryPoint} --config ${project.manifest.config}`;
    await ctx.persist({ executionStarted: true, artifactsCollected: false });
    const execution = await startDetached(venv, [project.manifest.entryPoint, '--config', project.manifest.config], project.projectDir, stdoutFile, stderrFile);
    this.active = { execution };
    const deadlineAt = ctx.run.deadlineAt ?? new Date(deadline).toISOString();
    await ctx.persist({ pid: execution.pid, command: commandLine, deadlineAt });
    await ctx.emit('compute', `Локальный процесс запущен: PID ${execution.pid}`);

    pump.reset();
    pump.attachSink(message => { void ctx.emit('log', message).catch(() => undefined); });
    pump.start();
    let timedOut = false;
    const abort = () => { void terminateProcessGroup(execution.pid, 5000); };
    ctx.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateProcessGroup(execution.pid, 5000);
    }, Math.max(1, deadline - Date.now()));

    let exitCode: number | null;
    try {
      exitCode = await execution.exit;
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', abort);
      pump.detachSink();
      await pump.stop();
      this.active = undefined;
    }
    if (ctx.signal.aborted) throw ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error('Отменено');
    const stderr = await readFileTail(stderrFile, 30_000);
    if (timedOut) {
      await ctx.emit('error', 'Локальный процесс остановлен по таймауту');
      return { exitCode: 124, stderr };
    }
    await ctx.emit('compute', `Локальный процесс завершился с кодом ${exitCode ?? 1}`);
    return { exitCode: exitCode ?? 1, stderr };
  }

  async getStatus(ctx: ComputeContext): Promise<'running' | 'stopped' | 'unknown'> {
    const active = this.active;
    if (active) return active.execution.child.exitCode === null && active.execution.child.signalCode === null ? 'running' : 'stopped';
    if (ctx.run.pid === undefined) return 'stopped';
    return isProcessAlive(ctx.run.pid) ? 'running' : 'stopped';
  }

  streamLogs(ctx: ComputeContext, listener: (line: string) => void): () => void {
    return this.createPump(ctx.projectDir).subscribe(listener);
  }

  async cancel(ctx: ComputeContext): Promise<void> {
    const active = this.active;
    if (active) {
      const pid = active.execution.pid;
      await terminateProcessGroup(pid, 5000);
      const timeout = Promise.withResolvers<void>();
      const timer = setTimeout(timeout.resolve, 10_000);
      await Promise.race([active.execution.exit.catch(() => null), timeout.promise]);
      clearTimeout(timer);
      this.active = undefined;
      await ctx.emit('compute', `Локальный процесс ${pid} остановлен`);
      return;
    }
    const pid = ctx.run.pid;
    if (pid === undefined) return;
    if (!isProcessAlive(pid)) return;
    const project = await this.projectFor(ctx);
    const ps = await runProcess('ps', ['-o', 'command=', '-p', String(pid)], { timeoutMs: 5000, env: executionEnv(), captureLimit: 16 * 1024 });
    const command = ps.stdout.trim();
    const expectedPython = venvPython(project.projectDir);
    if (ps.exitCode !== 0 || !command.includes(expectedPython) || !command.includes(project.manifest.entryPoint)) {
      throw new Error(`Отказываюсь завершать PID ${pid}: он не соответствует сохранённому локальному процессу`);
    }
    await terminateProcessGroup(pid, 5000);
    await ctx.emit('compute', `Локальный процесс ${pid} остановлен по сохранённому PID`);
  }

  async collectArtifacts(ctx: ComputeContext): Promise<void> {
    const project = await this.projectFor(ctx);
    await assertConfigMatchesSpec(project.configFile, ctx.spec);
    // Local outputs are already in project/. There is no transfer to verify; the
    // orchestrator owns collectAndValidate so science errors and export errors differ.
    await ctx.persist({ artifactsCollected: true, artifacts: [] });
    await ctx.emit('artifact', 'Локальные артефакты и логи готовы в project/; проверка выполняется оркестратором');
  }

  async cleanup(ctx: ComputeContext): Promise<void> {
    if (this.active) throw new Error('Нельзя очищать локальный запуск до остановки процесса');
    if (this.pump) await this.pump.stop();
    await ctx.persist({ cleanupRequired: false });
    await ctx.emit('compute', 'Локальный запуск очищен; внешних ресурсов не осталось');
  }

  private deadline(ctx: ComputeContext): number {
    const parsed = ctx.run.deadlineAt ? Date.parse(ctx.run.deadlineAt) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : Date.now() + ctx.spec.limits.timeSeconds * 1000;
  }
}
