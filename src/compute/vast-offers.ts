import type { ComputeTarget, ExperimentSpec } from '../shared/types.js';

export const VAST_IMAGE = 'pytorch/pytorch:2.4.0-cuda12.4-cudnn9-runtime';
export const VAST_RELIABILITY_MIN = 0.98;
export const VAST_MAX_CANDIDATES = 6;
export const VAST_BOOT_RESERVE_SECONDS = 900;
export const VAST_NETWORK_RESERVE_GB = 5;

export interface VastOffer {
  id: number;
  gpuName: string;
  numGpus: number;
  cpuCores: number;
  cpuRamMB: number;
  gpuRamMB: number;
  diskSpaceGB: number;
  dphTotal: number;
  storageCostPerGBMonth: number;
  inetDownCostPerGB: number;
  inetUpCostPerGB: number;
  reliability: number;
  verified: boolean;
  rentable: boolean;
  geolocation?: string;
  machineId?: number;
}

export interface VastFilterOptions {
  /** Reserved GB counted for each direction (upload and download) at that direction's $/GB. */
  transferGB?: number;
  /** Boot/setup reserve charged against the total budget. */
  bootSeconds?: number;
  reliabilityMin?: number;
}

export interface VastEvaluation {
  offer: VastOffer;
  target: ComputeTarget;
  allocatedDiskGB: number;
  storageHourlyUSD: number;
  networkReserveUSD: number;
  durationSeconds: number;
  hourlyUSD: number;
  estimatedUSD: number;
}

type UnknownRecord = Record<string, unknown>;

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Returns null when a price/capacity field is missing or unbounded, never a guessed value. */
export function normalizeVastOffer(raw: unknown): VastOffer | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const object = raw as UnknownRecord;
  const id = finiteNumber(object.id);
  const numGpus = finiteNumber(object.num_gpus);
  const cpuCores = finiteNumber(object.cpu_cores_effective) ?? finiteNumber(object.cpu_cores);
  const cpuRamMB = finiteNumber(object.cpu_ram);
  const gpuRamMB = finiteNumber(object.gpu_ram);
  const diskSpaceGB = finiteNumber(object.disk_space);
  const dphTotal = finiteNumber(object.dph_total);
  const storageCost = finiteNumber(object.storage_cost);
  const inetDown = finiteNumber(object.inet_down_cost);
  const inetUp = finiteNumber(object.inet_up_cost);
  const reliability = finiteNumber(object.reliability);
  const gpuName = typeof object.gpu_name === 'string' ? object.gpu_name.trim() : '';
  const verification = typeof object.verification === 'string' ? object.verification : '';
  const verified = object.verified === true || verification === 'verified';
  const rentable = object.rentable === true;
  if (id === null || !Number.isSafeInteger(id) || id <= 0) return null;
  if (numGpus === null || !Number.isInteger(numGpus) || numGpus < 1) return null;
  if (cpuCores === null || cpuCores <= 0) return null;
  if (cpuRamMB === null || cpuRamMB <= 0) return null;
  if (gpuRamMB === null || gpuRamMB <= 0) return null;
  if (diskSpaceGB === null || diskSpaceGB <= 0) return null;
  if (dphTotal === null || dphTotal <= 0) return null;
  if (storageCost === null || storageCost < 0) return null;
  if (inetDown === null || inetDown < 0) return null;
  if (inetUp === null || inetUp < 0) return null;
  if (reliability === null || reliability < 0 || reliability > 1) return null;
  if (!gpuName) return null;
  const geolocation = typeof object.geolocation === 'string' ? object.geolocation : undefined;
  const machineId = finiteNumber(object.machine_id);
  return {
    id,
    gpuName,
    numGpus,
    cpuCores,
    cpuRamMB,
    gpuRamMB,
    diskSpaceGB,
    dphTotal,
    storageCostPerGBMonth: storageCost,
    inetDownCostPerGB: inetDown,
    inetUpCostPerGB: inetUp,
    reliability,
    verified,
    rentable,
    ...(geolocation ? { geolocation } : {}),
    ...(machineId !== null && Number.isSafeInteger(machineId) ? { machineId } : {})
  };
}

/**
 * Vast units are documented as: cpu_ram/gpu_ram in MB, disk_space and allocated disk
 * in GB, storage_cost in $/GB/month, network costs in $/GB, dph_total in $/hour.
 * RAM/VRAM are compared as MiB/1024 (GiB) so capacity is never overstated.
 */
export function evaluateVastOffer(raw: unknown, spec: ExperimentSpec, options: VastFilterOptions = {}): VastEvaluation | null {
  const offer = normalizeVastOffer(raw);
  if (!offer) return null;
  const reliabilityMin = options.reliabilityMin ?? VAST_RELIABILITY_MIN;
  const transferGB = options.transferGB ?? VAST_NETWORK_RESERVE_GB;
  const bootSeconds = options.bootSeconds ?? VAST_BOOT_RESERVE_SECONDS;
  if (!Number.isFinite(transferGB) || transferGB < 0) return null;
  if (!Number.isFinite(bootSeconds) || bootSeconds < 0) return null;
  if (!offer.verified || !offer.rentable || offer.reliability < reliabilityMin) return null;
  if (offer.numGpus !== 1) return null;
  if (offer.cpuCores < spec.requirements.cpuCores) return null;
  const ramGB = offer.cpuRamMB / 1024;
  const vramGB = offer.gpuRamMB / 1024;
  if (ramGB < spec.requirements.ramGB) return null;
  if (spec.requirements.gpu && vramGB < spec.requirements.vramGB) return null;
  const allocatedDiskGB = Math.max(16, Math.ceil(spec.requirements.diskGB));
  if (offer.diskSpaceGB < allocatedDiskGB) return null;
  const maxHourly = spec.limits.maxHourlyUSD;
  const maxTotal = spec.limits.maxTotalUSD;
  if (!(maxHourly > 0) || !(maxTotal > 0)) return null;
  const storageHourlyUSD = offer.storageCostPerGBMonth * allocatedDiskGB / (30 * 24);
  const networkReserveUSD = transferGB * (offer.inetUpCostPerGB + offer.inetDownCostPerGB);
  const hourlyUSD = offer.dphTotal + storageHourlyUSD;
  if (!Number.isFinite(hourlyUSD) || hourlyUSD > maxHourly + 1e-9) return null;
  const durationSeconds = spec.limits.timeSeconds + bootSeconds;
  const estimatedUSD = hourlyUSD * durationSeconds / 3600 + networkReserveUSD;
  if (!Number.isFinite(estimatedUSD) || estimatedUSD > maxTotal + 1e-9) return null;
  const target: ComputeTarget = {
    id: `vast-${offer.id}`,
    kind: 'vast',
    label: `Vast · ${offer.gpuName}${offer.geolocation ? ` · ${offer.geolocation}` : ''}`,
    cpuCores: Math.max(1, Math.floor(offer.cpuCores)),
    ramGB: Math.floor(ramGB * 100) / 100,
    gpu: true,
    vramGB: Math.floor(vramGB * 100) / 100,
    diskGB: allocatedDiskGB,
    hourlyUSD: Math.round(hourlyUSD * 1e6) / 1e6,
    estimatedUSD: Math.round(estimatedUSD * 1e4) / 1e4,
    offerId: offer.id,
    details: {
      image: VAST_IMAGE,
      gpuName: offer.gpuName,
      reliability: offer.reliability,
      verified: offer.verified,
      rentable: offer.rentable,
      offerDiskGB: offer.diskSpaceGB,
      offerDphTotalUSD: offer.dphTotal,
      storageCostPerGBMonthUSD: offer.storageCostPerGBMonth,
      storageHourlyUSD,
      networkReserveUSD,
      transferReserveGB: transferGB,
      bootReserveSeconds: bootSeconds,
      durationReserveSeconds: durationSeconds,
      cpuRamMB: offer.cpuRamMB,
      gpuRamMB: offer.gpuRamMB,
      ...(offer.geolocation ? { geolocation: offer.geolocation } : {}),
      ...(offer.machineId !== undefined ? { machineId: offer.machineId } : {})
    }
  };
  return { offer, target, allocatedDiskGB, storageHourlyUSD, networkReserveUSD, durationSeconds, hourlyUSD, estimatedUSD };
}

/** Deterministic suitability/cost filter. No provider call and no provisioning happens here. */
export function selectVastTargets(rawOffers: unknown[], spec: ExperimentSpec, options: VastFilterOptions = {}): ComputeTarget[] {
  const seen = new Set<number>();
  const selected: VastEvaluation[] = [];
  for (const raw of rawOffers) {
    const evaluation = evaluateVastOffer(raw, spec, options);
    if (!evaluation || seen.has(evaluation.offer.id)) continue;
    seen.add(evaluation.offer.id);
    selected.push(evaluation);
  }
  selected.sort((a, b) => a.estimatedUSD - b.estimatedUSD || a.hourlyUSD - b.hourlyUSD || a.offer.id - b.offer.id);
  return selected.slice(0, VAST_MAX_CANDIDATES).map(item => item.target);
}

/** Read-only Vast offer query. `allocated_storage` reserves the project's disk allocation. */
export function vastSearchBody(spec: ExperimentSpec, options: VastFilterOptions = {}): Record<string, unknown> {
  const allocatedDiskGB = Math.max(16, Math.ceil(spec.requirements.diskGB));
  const cpuRamMB = Math.ceil(spec.requirements.ramGB * 1024);
  const gpuRamMB = Math.ceil(spec.requirements.vramGB * 1024);
  const reliabilityMin = options.reliabilityMin ?? VAST_RELIABILITY_MIN;
  return {
    type: 'ondemand',
    verified: { eq: true },
    rentable: { eq: true },
    rented: { eq: false },
    num_gpus: { eq: 1 },
    gpu_arch: { eq: 'nvidia' },
    reliability: { gte: reliabilityMin },
    cpu_cores_effective: { gte: spec.requirements.cpuCores },
    cpu_ram: { gte: cpuRamMB },
    disk_space: { gte: allocatedDiskGB },
    ...(spec.requirements.gpu ? { gpu_ram: { gte: gpuRamMB } } : {}),
    allocated_storage: allocatedDiskGB,
    limit: 100,
    order: [['dph_total', 'asc']]
  };
}
