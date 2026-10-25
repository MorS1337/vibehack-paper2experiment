import { SpecSchema, type ExperimentSpec } from '../../shared/types.js';

export interface SpecField {
  key: string;
  label: string;
}

export const SPEC_FIELDS: SpecField[] = [
  { key: 'version', label: 'Версия' },
  { key: 'title', label: 'Название' },
  { key: 'objective', label: 'Цель' },
  { key: 'paperResult', label: 'Результат статьи' },
  { key: 'sourceRefs', label: 'Ссылки на источник' },
  { key: 'data', label: 'Данные' },
  { key: 'method', label: 'Метод' },
  { key: 'baseline', label: 'Базовая линия' },
  { key: 'parameters', label: 'Параметры' },
  { key: 'metric', label: 'Метрика' },
  { key: 'requirements', label: 'Требования' },
  { key: 'limits', label: 'Лимиты' },
  { key: 'implementation', label: 'Реализация' },
  { key: 'assumptions', label: 'Допущения' },
  { key: 'missing', label: 'Пробелы' },
  { key: 'demo', label: 'Демо' }
];

export type SpecFieldState = 'present' | 'missing' | 'invalid';

export interface SpecIssue {
  path: string;
  message: string;
}

export interface SpecValidation {
  raw: Record<string, unknown> | null;
  value: ExperimentSpec | null;
  jsonError: string | null;
  issues: SpecIssue[];
  valid: boolean;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function translateIssue(issue: { code: string; message: string; path: readonly PropertyKey[] }): string {
  if (issue.message.includes('undefined') || issue.message.includes('required')) {
    return 'Обязательное поле не заполнено';
  }
  switch (issue.code) {
    case 'invalid_type':
      return 'Неверный тип значения';
    case 'too_small':
      return 'Значение меньше допустимого';
    case 'too_big':
      return 'Значение больше допустимого';
    case 'invalid_format':
      return 'Неверный формат значения';
    case 'invalid_value':
      return 'Недопустимое значение';
    case 'invalid_union':
      return 'Значение не соответствует ни одному допустимому варианту';
    case 'unrecognized_keys':
      return 'Лишние поля в объекте';
    case 'invalid_key':
      return 'Недопустимый ключ';
    case 'invalid_element':
      return 'Недопустимый элемент';
    default:
      return issue.message || 'Значение не прошло проверку';
  }
}

export function validateSpecText(text: string): SpecValidation {
  if (!text.trim()) {
    return {
      raw: null,
      value: null,
      jsonError: 'JSON-спецификация пуста',
      issues: [],
      valid: false
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      raw: null,
      value: null,
      jsonError: error instanceof Error ? error.message : 'Не удалось разобрать JSON',
      issues: [],
      valid: false
    };
  }

  if (!isJsonObject(parsed)) {
    return {
      raw: null,
      value: null,
      jsonError: 'Корень спецификации должен быть JSON-объектом',
      issues: [],
      valid: false
    };
  }

  const result = SpecSchema.safeParse(parsed);
  if (!result.success) {
    return {
      raw: parsed,
      value: null,
      jsonError: null,
      issues: result.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? issue.path.map(String).join('.') : 'корень',
        message: translateIssue(issue)
      })),
      valid: false
    };
  }

  return {
    raw: parsed,
    value: result.data,
    jsonError: null,
    issues: [],
    valid: true
  };
}

export function specFieldState(validation: SpecValidation, key: string): SpecFieldState {
  if (!validation.raw || !(key in validation.raw)) return 'missing';
  const invalid = validation.issues.some((issue) => issue.path === key || issue.path.startsWith(`${key}.`));
  return invalid ? 'invalid' : 'present';
}

