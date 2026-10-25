import { choice, APIError, TypeSafeClient } from '@typesafe-ai/sdk';
import { SetupRequiredError } from '../shared/errors.js';
import type { ComputeTarget, ConnectionStatus, ExperimentSpec } from '../shared/types.js';

export interface JevSelection {
  target: ComputeTarget;
  label: string;
  confidence: number;
  probabilities: Record<string, number>;
  model: string;
}

/** The model was reachable and explicitly rejected every deterministically suitable candidate. */
export class JevNoSuitableOptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JevNoSuitableOptionError';
  }
}

function apiKey(): string | null {
  const key = process.env.TYPESAFE_API_KEY?.trim();
  return key ? key : null;
}

function jevClient(key: string): TypeSafeClient {
  return new TypeSafeClient({
    apiKey: key,
    logLevel: 'off',
    compression: false,
    timeout: 15_000,
    retry: { maxRetries: 1, backoffInitialMs: 250, backoffMaxMs: 1000 }
  });
}

export async function checkJevStatus(): Promise<ConnectionStatus> {
  const key = apiKey();
  if (!key) {
    return { component: 'jev', state: 'needs_setup', detail: 'Не задан TYPESAFE_API_KEY для Jev (ключ читается только из окружения main-процесса)' };
  }
  try {
    const models = await jevClient(key).models.list({ timeout: 8000, retry: { maxRetries: 0 } });
    return { component: 'jev', state: 'ready', detail: `Jev доступен; моделей: ${models.length}` };
  } catch (error) {
    if (error instanceof APIError && (error.status === 401 || error.status === 403)) {
      return { component: 'jev', state: 'error', detail: `Ключ Jev отклонён (HTTP ${error.status})` };
    }
    const message = (error instanceof Error ? error.message : String(error)).replaceAll(key, '[redacted]');
    return { component: 'jev', state: 'error', detail: `Ошибка Jev: ${message.slice(0, 400)}` };
  }
}

/**
 * Jev receives only deterministically pre-filtered candidates (at most six) plus an
 * explicit "none" option. All hard resource/budget checks have already happened.
 */
export async function chooseComputeTarget(candidates: ComputeTarget[], spec: ExperimentSpec, signal?: AbortSignal): Promise<JevSelection> {
  if (candidates.length === 0) throw new Error('Jev: нет кандидатов для выбора');
  if (candidates.length > 6) throw new Error('Jev: допускается не более 6 кандидатов');
  const key = apiKey();
  if (!key) throw new SetupRequiredError('Jev не настроен: задайте TYPESAFE_API_KEY в окружении main-процесса');
  const criteria: Record<string, string> = {
    none: 'Ни один вариант не подходит: не выбирай его, если хотя бы один кандидат удовлетворяет требованиям и бюджету.'
  };
  const byLabel = new Map<string, ComputeTarget>();
  candidates.forEach((target, index) => {
    const label = `option_${index + 1}`;
    byLabel.set(label, target);
    criteria[label] = [
      `${target.label}; ${target.kind}`,
      `CPU ${target.cpuCores} ядер, RAM ${target.ramGB} GiB, GPU ${target.gpu ? `да (${target.vramGB} GiB VRAM)` : 'нет'}, диск ${target.diskGB} GB`,
      `$ ${target.hourlyUSD}/ч, оценка $${target.estimatedUSD}`,
      target.kind === 'vast' ? `Vast offer ${target.offerId}, reliability ${String(target.details?.reliability ?? 'n/a')}` : 'локальный бесплатный запуск'
    ].join('; ');
  });
  const state = {
    experiment: spec.title,
    objective: spec.objective,
    method: spec.method,
    requirements: spec.requirements,
    limits: spec.limits,
    candidates: candidates.map((target, index) => ({
      id: `option_${index + 1}`,
      kind: target.kind,
      label: target.label,
      cpuCores: target.cpuCores,
      ramGB: target.ramGB,
      gpu: target.gpu,
      vramGB: target.vramGB,
      diskGB: target.diskGB,
      hourlyUSD: target.hourlyUSD,
      estimatedUSD: target.estimatedUSD
    }))
  };
  const question = choice(
    'Выбери единственный вариант вычислений для эксперимента. Все кандидаты уже прошли обязательные проверки ресурсов и бюджета; предпочти более надёжный и быстрый GPU, если он в бюджете, иначе локальный вариант. Выбери none только если ни один кандидат не подходит.',
    criteria
  );
  const response = await jevClient(key).systemOne(
    { state, questions: { selection: question } },
    { signal, timeout: 20_000, retry: { maxRetries: 1, backoffInitialMs: 250, backoffMaxMs: 1000 } }
  ).catch(error => {
    const message = (error instanceof Error ? error.message : String(error)).replaceAll(key, '[redacted]');
    throw new Error(`Jev не смог выбрать compute: ${message.slice(0, 600)}`);
  });
  const answer = response.answers.selection;
  if (answer.choice === 'none') {
    throw new JevNoSuitableOptionError(`Jev не выбрал ни один вариант (confidence ${answer.confidence}); требуется новый выбор вычислений`);
  }
  const target = byLabel.get(answer.choice);
  if (!target) throw new Error(`Jev вернул неизвестный вариант ${answer.choice}`);
  return {
    target,
    label: answer.choice,
    confidence: answer.confidence,
    probabilities: { ...answer.probabilities },
    model: response.model
  };
}
