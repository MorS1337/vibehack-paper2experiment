import { access, statfs } from 'node:fs/promises';
import os from 'node:os';
import { checkJevStatus, chooseComputeTarget, JevNoSuitableOptionError } from '../integrations/jev.js';
import { SetupRequiredError } from '../shared/errors.js';
import type { AppSettings, ComputeContext, ComputeTarget, ConnectionStatus, ExperimentInput, ExperimentSpec } from '../shared/types.js';
import { executionEnv, runProcess } from './process.js';
import { expandHome } from './ssh.js';
import { resolveVastCredential, VastApiClient, VastApiError } from './vast-api.js';
import { selectVastTargets, vastSearchBody } from './vast-offers.js';

export { LocalBackend } from './local.js';
export { VastBackend } from './vast.js';
export { evaluateVastOffer, normalizeVastOffer, selectVastTargets, VAST_IMAGE } from './vast-offers.js';

interface NvidiaInfo { names: string[]; vramGB: number }

async function detectNvidia(): Promise<NvidiaInfo | null> {
  try {
    const result = await runProcess('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], {
      timeoutMs: 10_000,
      env: executionEnv(),
      captureLimit: 64 * 1024
    });
    if (result.exitCode !== 0) return null;
    const rows = result.stdout.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
      const [name, memory] = line.split(',').map(part => part.trim());
      return { name, memoryMB: Number(memory) };
    }).filter(row => row.name && Number.isFinite(row.memoryMB) && row.memoryMB > 0);
    if (rows.length === 0) return null;
    return { names: rows.map(row => row.name), vramGB: Math.max(...rows.map(row => row.memoryMB / 1024)) };
  } catch {
    // No nvidia-smi is a real absence of a local CUDA GPU, not an error to hide.
    return null;
  }
}

/** Describes the real local machine. A local GPU is reported only when nvidia-smi proves it. */
export async function localTarget(): Promise<ComputeTarget> {
  const cpuCores = Math.max(1, os.availableParallelism());
  const totalRamGB = os.totalmem() / 1024 ** 3;
  const home = os.homedir();
  const filesystem = await statfs(home).catch(error => {
    throw new Error(`Не удалось определить свободное место локального диска ${home}: ${String(error)}`);
  });
  const freeDiskGB = Number(filesystem.bavail) * Number(filesystem.bsize) / 1e9;
  if (!Number.isFinite(freeDiskGB) || freeDiskGB <= 0) throw new Error('Локальный диск: не удалось получить положительный объём свободного места');
  const nvidia = await detectNvidia();
  return {
    id: 'local',
    kind: 'local',
    label: nvidia
      ? `Локально · ${cpuCores} CPU · ${Math.floor(totalRamGB * 10) / 10} GiB RAM · ${nvidia.names[0]}`
      : `Локально · ${cpuCores} CPU · ${Math.floor(totalRamGB * 10) / 10} GiB RAM`,
    cpuCores,
    ramGB: Math.floor(totalRamGB * 10) / 10,
    gpu: !!nvidia,
    vramGB: nvidia ? Math.floor(nvidia.vramGB * 10) / 10 : 0,
    diskGB: Math.floor(freeDiskGB * 10) / 10,
    hourlyUSD: 0,
    estimatedUSD: 0,
    details: {
      platform: process.platform,
      arch: process.arch,
      home,
      disk: 'free space on home volume',
      ...(nvidia ? { gpuNames: nvidia.names } : {})
    }
  };
}

/** Returns a human-readable reason when the local machine cannot satisfy the frozen spec. */
export function localSuitability(target: ComputeTarget, spec: ExperimentSpec): string | null {
  if (target.cpuCores < spec.requirements.cpuCores) return `нужно CPU ≥ ${spec.requirements.cpuCores}, доступно ${target.cpuCores}`;
  if (target.ramGB < spec.requirements.ramGB) return `нужно RAM ≥ ${spec.requirements.ramGB} GiB, доступно ${target.ramGB} GiB`;
  if (target.diskGB < spec.requirements.diskGB) return `нужно свободного диска ≥ ${spec.requirements.diskGB} GB, доступно ${target.diskGB} GB`;
  if (spec.requirements.gpu && !target.gpu) return 'требуется GPU, локальный nvidia-smi не найден';
  if (spec.requirements.gpu && target.vramGB < spec.requirements.vramGB) return `нужно VRAM ≥ ${spec.requirements.vramGB} GiB, доступно ${target.vramGB} GiB`;
  return null;
}

async function vastCandidates(ctx: ComputeContext): Promise<ComputeTarget[]> {
  const credential = await resolveVastCredential();
  if (!credential) throw new SetupRequiredError('Vast не настроен: задайте VAST_API_KEY или ~/.config/vastai/vast_api_key (ключ не читается из настроек/рендерера)');
  if (!(ctx.spec.limits.maxHourlyUSD > 0) || !(ctx.spec.limits.maxTotalUSD > 0)) {
    throw new Error('Для Vast нужны положительные лимиты maxHourlyUSD и maxTotalUSD');
  }
  const client = new VastApiClient(credential.key);
  const offers = await client.searchOffers(vastSearchBody(ctx.spec), { signal: ctx.signal, timeoutMs: 30_000 });
  const targets = selectVastTargets(offers, ctx.spec);
  if (targets.length === 0) throw new Error(`Vast не вернул ни одного предложения, прошедшего ресурсные и бюджетные фильтры (получено ${offers.length})`);
  return targets;
}

function cheapest(targets: ComputeTarget[]): ComputeTarget {
  return [...targets].sort((a, b) => a.estimatedUSD - b.estimatedUSD || a.hourlyUSD - b.hourlyUSD || a.id.localeCompare(b.id))[0];
}

async function autoTarget(ctx: ComputeContext): Promise<ComputeTarget> {
  const candidates: ComputeTarget[] = [];
  let localReason: string | null = 'локальная машина недоступна';
  let local: ComputeTarget | undefined;
  try {
    local = await localTarget();
    localReason = localSuitability(local, ctx.spec);
    if (localReason === null) candidates.push(local);
  } catch (error) {
    localReason = String(error);
  }

  let vastError: string | null = null;
  if (ctx.spec.limits.maxHourlyUSD > 0 && ctx.spec.limits.maxTotalUSD > 0) {
    try {
      const targets = await vastCandidates(ctx);
      const room = candidates.length > 0 ? 5 : 6;
      candidates.push(...targets.slice(0, room));
    } catch (error) {
      vastError = error instanceof Error ? error.message : String(error);
      if (ctx.signal.aborted) throw error;
    }
  } else if (candidates.length === 0) {
    localReason = `${localReason ?? 'локальная машина не подходит'}; платные лимиты равны нулю`;
  }

  if (candidates.length === 0) {
    const details = [localReason ? `локально: ${localReason}` : '', vastError ? `Vast: ${vastError}` : ''].filter(Boolean).join('; ');
    throw new Error(`Автовыбор не нашёл подходящего варианта (${details || 'нет кандидатов'})`);
  }
  if (vastError) await ctx.emit('error', `Vast недоступен при автовыборе: ${vastError}`);
  const shortlist = candidates.slice(0, 6);
  if (shortlist.length === 1) return shortlist[0];
  if (process.env.TYPESAFE_API_KEY?.trim()) {
    try {
      const selected = await chooseComputeTarget(shortlist, ctx.spec, ctx.signal);
      await ctx.emit('compute', `Jev выбрал ${selected.target.id} (${selected.label}, confidence ${selected.confidence.toFixed(3)}, модель ${selected.model})`);
      return selected.target;
    } catch (error) {
      if (ctx.signal.aborted) throw ctx.signal.reason instanceof Error ? ctx.signal.reason : error;
      if (error instanceof JevNoSuitableOptionError) throw error;
      await ctx.emit('error', `Jev не смог выбрать compute; используется детерминированный минимальный тариф: ${String(error)}`);
    }
  } else {
    await ctx.emit('compute', 'TYPESAFE_API_KEY не задан: Jev пропущен, выбран детерминированный минимальный тариф');
  }
  return cheapest(shortlist);
}

/** Selection is read-only: Vast offer search only; no instance is created until approval + prepare. */
export async function selectCompute(ctx: ComputeContext, mode: ExperimentInput['mode']): Promise<ComputeTarget> {
  if (mode === 'local') {
    const target = await localTarget();
    const reason = localSuitability(target, ctx.spec);
    if (reason) throw new Error(`Локальный запуск невозможен: ${reason}`);
    await ctx.emit('compute', `Выбрана локальная машина: ${target.cpuCores} CPU, ${target.ramGB} GiB RAM, свободно ${target.diskGB} GB`);
    return target;
  }
  if (mode === 'vast') {
    const targets = await vastCandidates(ctx);
    const target = targets[0];
    await ctx.emit('compute', `Выбрано Vast-предложение ${target.offerId}: ${target.hourlyUSD}$/ч, резерв итога ${target.estimatedUSD}$ (до подтверждения инстанс не создаётся)`);
    return target;
  }
  const target = await autoTarget(ctx);
  await ctx.emit('compute', `Автовыбор: ${target.label}; ${target.hourlyUSD}$/ч, резерв итога ${target.estimatedUSD}$`);
  return target;
}

async function vastStatus(settings: AppSettings): Promise<ConnectionStatus> {
  const credential = await resolveVastCredential().catch(error => {
    return { error: error instanceof Error ? error.message : String(error) } as const;
  });
  if (!credential) return { component: 'vast', state: 'needs_setup', detail: 'Нет VAST_API_KEY и ~/.config/vastai/vast_api_key' };
  if ('error' in credential) return { component: 'vast', state: 'error', detail: credential.error.slice(0, 400) };
  if (!settings.sshKeyPath.trim()) {
    return { component: 'vast', state: 'needs_setup', detail: `Ключ Vast найден (${credential.source}); SSH-ключ не настроен` };
  }
  if (!await access(expandHome(settings.sshKeyPath)).then(() => true, () => false)) {
    return { component: 'vast', state: 'needs_setup', detail: `Ключ Vast найден (${credential.source}); файл SSH-ключа не найден: ${settings.sshKeyPath}` };
  }
  try {
    const client = new VastApiClient(credential.key);
    try {
      await client.ping({ timeoutMs: 8000 });
    } catch (error) {
      if (!(error instanceof VastApiError) || error.status !== 404) throw error;
    }
    return { component: 'vast', state: 'ready', detail: `Ключ Vast принят (${credential.source}); SSH: ${settings.sshKeyPath}` };
  } catch (error) {
    return { component: 'vast', state: 'error', detail: (error instanceof Error ? error.message : String(error)).slice(0, 400) };
  }
}

/** Returns exactly the two compute providers; pi/opencode/whisper statuses belong to other integrations. */
export async function getComputeStatuses(settings: AppSettings): Promise<ConnectionStatus[]> {
  return Promise.all([checkJevStatus(), vastStatus(settings)]);
}
