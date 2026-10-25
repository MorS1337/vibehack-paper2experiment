import type { Artifact, ExperimentInput, ExperimentSpec, RunEvent } from '../../shared/types.js';

export const RUN_MODE_LABEL: Record<ExperimentInput['mode'], string> = {
  local: 'Локально',
  vast: 'Vast.ai',
  auto: 'Авто'
};

export const CLEANUP_LABEL: Record<ExperimentInput['cleanup'], string> = {
  destroy: 'Удалить инстанс',
  retain: 'Оставить инстанс'
};

export const ARTIFACT_KIND_LABEL: Record<Artifact['kind'], string> = {
  metrics: 'Метрики',
  plot: 'График',
  config: 'Конфигурация',
  log: 'Журнал',
  predictions: 'Предсказания',
  other: 'Файл'
};

export const EVENT_TYPE_LABEL: Record<RunEvent['type'], string> = {
  status: 'статус',
  log: 'журнал',
  agent: 'агент',
  compaction: 'контекст',
  compute: 'вычислитель',
  artifact: 'артефакт',
  error: 'ошибка'
};

export const IMPLEMENTATION_LABEL: Record<ExperimentSpec['implementation'], string> = {
  author: 'Код автора',
  independent: 'Независимая реализация'
};
