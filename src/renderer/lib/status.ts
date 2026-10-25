import type { ConnectionStatus, RunStatus } from '../../shared/types.js';
import type { Tone } from './tone.js';

export interface StatusMeta {
  label: string;
  hint: string;
  tone: Tone;
}

export const STATUS_META: Record<RunStatus, StatusMeta> = {
  draft: {
    label: 'Черновик',
    hint: 'Импортируйте статью, задайте задачу и сформируйте план эксперимента.',
    tone: 'neutral'
  },
  importing: {
    label: 'Импорт источника',
    hint: 'Извлекаем текст и сохраняем копию документа.',
    tone: 'info'
  },
  planning: {
    label: 'Планирование',
    hint: 'Агент составляет проверяемый план эксперимента.',
    tone: 'active'
  },
  needs_setup: {
    label: 'Нужна настройка',
    hint: 'Не готовы подключения. Откройте «Настройки» и устраните причины.',
    tone: 'warning'
  },
  needs_data: {
    label: 'Нужны данные',
    hint: 'В плане или входных данных не хватает сведений. Заполните пробелы и сохраните план.',
    tone: 'warning'
  },
  ready: {
    label: 'Готов к запуску',
    hint: 'План сохранён. Проверьте вычислитель и запустите эксперимент.',
    tone: 'success'
  },
  coding: {
    label: 'Написание кода',
    hint: 'Агент реализует эксперимент в рабочей папке.',
    tone: 'active'
  },
  selecting_compute: {
    label: 'Выбор вычислителя',
    hint: 'Подбираем локальную или облачную цель в рамках заданных лимитов.',
    tone: 'active'
  },
  awaiting_approval: {
    label: 'Ждёт подтверждения',
    hint: 'Платный вычислитель выбран. Подтвердите точную цель и стоимость.',
    tone: 'warning'
  },
  preparing: {
    label: 'Подготовка',
    hint: 'Готовим окружение, данные и зависимости.',
    tone: 'active'
  },
  running: {
    label: 'Выполняется',
    hint: 'Эксперимент выполняется; следите за журналом.',
    tone: 'active'
  },
  collecting: {
    label: 'Сбор результатов',
    hint: 'Собираем метрики, отчёт и артефакты.',
    tone: 'active'
  },
  completed: {
    label: 'Завершено',
    hint: 'Запуск завершён. Проверка результата — на вкладке «Результаты».',
    tone: 'success'
  },
  failed: {
    label: 'Ошибка',
    hint: 'Запуск завершился ошибкой. Изучите журнал и повторите при необходимости.',
    tone: 'danger'
  },
  cancelled: {
    label: 'Отменено',
    hint: 'Запуск отменён пользователем.',
    tone: 'neutral'
  },
  timed_out: {
    label: 'Тайм-аут',
    hint: 'Лимит времени исчерпан; проверьте журнал и артефакты.',
    tone: 'warning'
  },
  interrupted: {
    label: 'Прервано',
    hint: 'Запуск прерван до завершения.',
    tone: 'warning'
  }
};

/** Local processes or agent calls that must not be disturbed by a second operation. */
export const BUSY_STATUSES: RunStatus[] = [
  'importing',
  'planning',
  'coding',
  'selecting_compute',
  'preparing',
  'running',
  'collecting'
];

export const EXECUTABLE_STATUSES: RunStatus[] = [
  'ready',
  'needs_setup',
  'failed',
  'cancelled',
  'timed_out',
  'interrupted'
];
export const PLANNABLE_STATUSES: RunStatus[] = [
  'draft',
  'needs_setup',
  'needs_data',
  'ready',
  'failed',
  'cancelled',
  'timed_out',
  'interrupted'
];
export const CANCELLABLE_STATUSES: RunStatus[] = [...BUSY_STATUSES, 'awaiting_approval'];

export interface Stage {
  label: string;
  detail: string;
}

export const STAGES: Stage[] = [
  { label: 'Источник', detail: 'PDF или arXiv' },
  { label: 'План', detail: 'ExperimentSpec' },
  { label: 'Код', detail: 'реализация' },
  { label: 'Вычислитель', detail: 'local или Vast.ai' },
  { label: 'Запуск', detail: 'выполнение' },
  { label: 'Результаты', detail: 'метрики и отчёт' }
];

export const STAGE_INDEX: Record<RunStatus, number> = {
  draft: 0,
  importing: 0,
  planning: 1,
  needs_setup: 0,
  needs_data: 0,
  ready: 3,
  coding: 2,
  selecting_compute: 3,
  awaiting_approval: 3,
  preparing: 4,
  running: 4,
  collecting: 5,
  completed: 5,
  failed: -1,
  cancelled: -1,
  timed_out: -1,
  interrupted: -1
};

export type StageState = 'done' | 'active' | 'wait' | 'warning';

export function stageState(status: RunStatus, index: number): StageState {
  if (status === 'completed') return 'done';
  const current = STAGE_INDEX[status];
  if (current < 0) return 'wait';
  if (index < current) return 'done';
  if (index > current) return 'wait';
  if (status === 'awaiting_approval' || status === 'needs_setup' || status === 'needs_data') {
    return 'warning';
  }
  return 'active';
}

export interface ComponentMeta {
  label: string;
  purpose: string;
  instruction: string;
}

export const COMPONENT_META: Record<ConnectionStatus['component'], ComponentMeta> = {
  pi: {
    label: 'Pi',
    purpose: 'Планирование и реализация эксперимента',
    instruction: 'Укажите провайдера и модель Pi. Авторизация выполняется в CLI Pi, ключи здесь не хранятся.'
  },
  jev: {
    label: 'JEV',
    purpose: 'Выбор вычислительной среды',
    instruction: 'Задайте TYPESAFE_API_KEY в окружении запуска. Jev выбирает из допустимых вариантов compute.'
  },
  vast: {
    label: 'Vast.ai',
    purpose: 'Платный удалённый вычислитель',
    instruction: 'Ключ Vast.ai задаётся в окружении. SSH-ключ для инстансов выбирается в настройках.'
  },
  whisper: {
    label: 'Whisper',
    purpose: 'Распознавание голосовой задачи',
    instruction: 'Выберите бинарник whisper и файл модели. Голос не покидает компьютер.'
  },
  smartcompact: {
    label: 'SmartCompact',
    purpose: 'Сжатие контекста агента',
    instruction: 'Проверьте пакет SmartCompact и его доступность для агентских сессий.'
  }
};

export const CONNECTION_STATE_META: Record<ConnectionStatus['state'], { label: string; tone: Tone }> = {
  ready: { label: 'Готово', tone: 'success' },
  needs_setup: { label: 'Нужна настройка', tone: 'warning' },
  error: { label: 'Ошибка', tone: 'danger' }
};

export const CONNECTION_ORDER: ConnectionStatus['component'][] = [
  'pi',
  'jev',
  'vast',
  'whisper',
  'smartcompact'
];

export const TERMINAL_STATUSES: RunStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'interrupted'
];
