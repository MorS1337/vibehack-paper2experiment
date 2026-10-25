import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AppAPI, ExperimentInput } from '../../shared/types.js';
import { useVoiceTask } from '../hooks/useVoiceTask.js';
import { errorMessage } from '../lib/api.js';
import { RECORDING_MAX_SECONDS } from '../lib/recorder.js';
import {
  AlertIcon,
  CloseIcon,
  FileIcon,
  InfoIcon,
  MicIcon,
  ShieldIcon,
  StopIcon
} from './icons.js';
import { Button, PathField, Segmented, TextArea, TextInput } from './ui.js';

const MODE_OPTIONS: { value: ExperimentInput['mode']; label: string; title: string }[] = [
  { value: 'local', label: 'Локально', title: 'Код выполняется на этом компьютере' },
  { value: 'vast', label: 'Vast.ai', title: 'Платный облачный вычислитель; требуется подтверждение' },
  { value: 'auto', label: 'Авто', title: 'Локальная цель или Vast.ai в рамках лимитов' }
];

const CLEANUP_OPTIONS: { value: ExperimentInput['cleanup']; label: string; title: string }[] = [
  { value: 'destroy', label: 'Удалить', title: 'Удалить удалённый инстанс после работы' },
  { value: 'retain', label: 'Оставить', title: 'Сохранить инстанс; за него может продолжаться оплата' }
];

const DEMO_URL = 'https://arxiv.org/abs/1910.02884v1';
const DEMO_TASK = 'Демо Хёффдинга: Bernoulli(p=0.5), epsilon=0.08, n=[10,20,40,80,160], 10000 повторений, seed=20261025. Основная метрика при n=160. План и код — заглушки; Python и результаты — реальные.';

const ARXIV_HOSTS = ['arxiv.org', 'www.arxiv.org', 'export.arxiv.org'];

function normalizeArxivUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!ARXIV_HOSTS.includes(url.hostname.toLowerCase())) return null;
    if (!/^\/(abs|pdf)\/[^/?#]+/.test(url.pathname)) return null;
    return candidate;
  } catch {
    return null;
  }
}

interface CreateFormProps {
  api: AppAPI;
  busy: boolean;
  onCreate: (input: ExperimentInput) => Promise<boolean>;
}

export function CreateForm({ api, busy, onCreate }: CreateFormProps) {
  const [agentMode, setAgentMode] = useState<ExperimentInput['agentMode']>('demo');
  const [sourceType, setSourceType] = useState<'pdf' | 'arxiv'>('arxiv');
  const [pdfPath, setPdfPath] = useState('');
  const [arxivUrl, setArxivUrl] = useState(DEMO_URL);
  const [task, setTask] = useState(DEMO_TASK);
  const [authorRepo, setAuthorRepo] = useState('');
  const [dataDir, setDataDir] = useState('');
  const [mode, setMode] = useState<ExperimentInput['mode']>('local');
  const [timeSeconds, setTimeSeconds] = useState('120');
  const [maxHourly, setMaxHourly] = useState('0');
  const [maxTotal, setMaxTotal] = useState('0');
  const [cleanup, setCleanup] = useState<ExperimentInput['cleanup']>('destroy');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState<'pdf' | 'data' | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const summaryRef = useRef<HTMLDivElement>(null);

  const clearError = (key: string) =>
    setErrors((previous) => {
      if (!(key in previous)) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });

  const voice = useVoiceTask(api, (text) => {
    setTask((previous) => (previous.trim() ? `${previous.trimEnd()} ${text}` : text));
    clearError('task');
  });

  useEffect(() => {
    if (voice.phase === 'idle') return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        voice.cancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [voice.phase, voice.cancel]);

  const choosePath = async (kind: 'pdf' | 'data') => {
    setChoosing(kind);
    setFormError(null);
    try {
      const chosen = await api.choose(kind);
      if (chosen) {
        if (kind === 'pdf') {
          setPdfPath(chosen);
          setSourceType('pdf');
          clearError('source');
        } else {
          setDataDir(chosen);
          clearError('dataDir');
        }
      }
    } catch (error) {
      setFormError(`Не удалось открыть выбор файла: ${errorMessage(error)}`);
    } finally {
      setChoosing(null);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || submitting || voice.phase !== 'idle') return;
    setFormError(null);

    const nextErrors: Record<string, string> = {};
    const normalizedArxiv = normalizeArxivUrl(arxivUrl);
    if (sourceType === 'pdf') {
      if (!pdfPath.trim()) nextErrors.source = 'Выберите PDF статьи';
    } else if (!arxivUrl.trim()) {
      nextErrors.source = 'Укажите ссылку arXiv';
    } else if (!normalizedArxiv) {
      nextErrors.source = 'Нужна ссылка arxiv.org/abs/… или arxiv.org/pdf/…';
    }
    if (!task.trim()) nextErrors.task = 'Опишите задачу эксперимента';
    else if (task.trim().length > 30_000) nextErrors.task = 'Не более 30 000 символов';
    if (authorRepo.trim() && !/^https:\/\/[^\s]+$/.test(authorRepo.trim())) {
      nextErrors.authorRepo = 'Нужен HTTPS URL авторского репозитория';
    } else if (authorRepo.trim().length > 2048) {
      nextErrors.authorRepo = 'Слишком длинный URL (до 2048 символов)';
    }
    if (dataDir.trim().length > 4096) nextErrors.dataDir = 'Слишком длинный путь (до 4096 символов)';
    if (sourceType === 'pdf' && pdfPath.trim().length > 4096) {
      nextErrors.source = 'Слишком длинный путь (до 4096 символов)';
    }
    if (sourceType === 'arxiv' && (normalizedArxiv?.length ?? 0) > 4096) {
      nextErrors.source = 'Слишком длинная ссылка (до 4096 символов)';
    }

    const seconds = Number(timeSeconds);
    if (!timeSeconds.trim() || !Number.isInteger(seconds) || seconds < 5 || seconds > 86_400) {
      nextErrors.time = 'Целое число секунд от 5 до 86 400';
    }
    const hourlyValue = Number(maxHourly);
    if (!maxHourly.trim() || !Number.isFinite(hourlyValue) || hourlyValue < 0) {
      nextErrors.hourly = 'Неотрицательное значение в USD';
    }
    const totalValue = Number(maxTotal);
    if (!maxTotal.trim() || !Number.isFinite(totalValue) || totalValue < 0) {
      nextErrors.total = 'Неотрицательное значение в USD';
    }

    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      window.requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }

    setErrors({});
    setSubmitting(true);
    const input: ExperimentInput = {
      source: sourceType === 'pdf' ? pdfPath.trim() : (normalizedArxiv ?? ''),
      agentMode,
      task: task.trim(),
      authorRepo: authorRepo.trim() || undefined,
      dataDir: dataDir.trim() || undefined,
      mode,
      timeSeconds: seconds,
      maxHourlyUSD: hourlyValue,
      maxTotalUSD: totalValue,
      cleanup
    };

    try {
      const created = await onCreate(input);
      if (created) {
        setAgentMode('demo');
        setSourceType('arxiv');
        setPdfPath('');
        setArxivUrl(DEMO_URL);
        setTask(DEMO_TASK);
        setAuthorRepo('');
        setDataDir('');
        setMode('local');
        setTimeSeconds('120');
        setMaxHourly('0');
        setMaxTotal('0');
        setCleanup('destroy');
        setErrors({});
        setFormError(null);
      } else {
        setFormError('Создание не выполнено. Подробности — в уведомлении.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const errorList = Object.values(errors);
  const voiceClock = `${Math.floor(voice.elapsed / 60)}:${String(voice.elapsed % 60).padStart(2, '0')}`;
  const disabled = busy || submitting;

  return (
    <form className="create-form" onSubmit={handleSubmit} noValidate>
      <div className="create-heading">
        <p className="eyebrow">Новый эксперимент</p>
        <h2>Воспроизвести статью</h2>
        <p>
          Сначала создаётся карточка и план. Импорт, распознавание речи и запуск — разные действия.
        </p>
      </div>

      <fieldset className="form-section">
        <legend>Режим агента</legend>
        <Segmented value={agentMode} options={[{ value: 'demo', label: 'Демо · заглушки' }, { value: 'pi', label: 'Настоящий Pi' }]} onChange={value => { setAgentMode(value); if (value === 'demo') setMode('local'); }} ariaLabel="Режим агента" disabled={disabled} />
        <p className="field-hint">{agentMode === 'demo' ? 'Без ключей: фиксированный кейс Хёффдинга. План и подготовка кода — явные заглушки, свободная задача не анализируется. Вычисления и метрики настоящие. Только Local, без аренды.' : 'Pi анализирует источник и сам готовит код. Нужна авторизация модели. Лимиты и исполнение контролирует harness.'}</p>
        <Button type="button" size="sm" variant="secondary" disabled={disabled} onClick={() => { setAgentMode('demo'); setSourceType('arxiv'); setArxivUrl(DEMO_URL); setTask(DEMO_TASK); setAuthorRepo(''); setDataDir(''); setMode('local'); setTimeSeconds('120'); setMaxHourly('0'); setMaxTotal('0'); setErrors({}); }}>Заполнить демо Хёффдинга</Button>
      </fieldset>

      {errorList.length > 0 || formError ? (
        <div className="form-alert" ref={summaryRef} tabIndex={-1} role="alert">
          <AlertIcon />
          <div>
            <strong>Проверьте форму</strong>
            {formError ? <p>{formError}</p> : null}
            {errorList.length > 0 ? (
              <ul>
                {errorList.map((message, index) => (
                  <li key={`${index}-${message}`}>{message}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      ) : null}

      <fieldset className="form-section">
        <legend>Источник</legend>
        <Segmented
          value={sourceType}
          options={[
            { value: 'pdf', label: 'PDF', title: 'Локальный файл статьи' },
            { value: 'arxiv', label: 'arXiv', title: 'Страница или PDF arXiv' }
          ]}
          onChange={(value) => {
            setSourceType(value);
            clearError('source');
          }}
          ariaLabel="Тип источника"
          disabled={disabled}
        />

        {sourceType === 'pdf' ? (
          <PathField
            id="source-pdf"
            label="PDF статьи"
            value={pdfPath}
            onChange={(value) => {
              setPdfPath(value);
              clearError('source');
            }}
            onChoose={() => void choosePath('pdf')}
            chooseLabel={choosing === 'pdf' ? 'Открываем…' : 'Выбрать PDF'}
            placeholder="/путь/к/статье.pdf"
            hint="Нативный выбор файла. Текст извлекает Electron."
            error={errors.source}
            disabled={disabled || choosing !== null}
            required
          />
        ) : (
          <TextInput
            id="source-arxiv"
            label="Ссылка arXiv"
            value={arxivUrl}
            onChange={(event) => {
              setArxivUrl(event.target.value);
              clearError('source');
            }}
            placeholder="https://arxiv.org/abs/2401.00001"
            hint="Страница abs или PDF. Ссылка без схемы тоже принимается."
            error={errors.source}
            disabled={disabled}
            spellCheck={false}
            inputMode="url"
            maxLength={4096}
            required
          />
        )}
      </fieldset>

      <fieldset className="form-section">
        <legend>Задача</legend>
        <TextArea
          id="task"
          label="Что воспроизвести"
          value={task}
          onChange={(event) => {
            setTask(event.target.value);
            clearError('task');
          }}
          placeholder="Например: воспроизвести основной эксперимент на датасете статьи и сравнить метрику."
          rows={4}
          maxLength={30_000}
          error={errors.task}
          disabled={disabled}
          required
        />

        <div className="voice-block">
          <div className="voice-row">
            {voice.phase === 'recording' ? (
              <>
                <Button
                  variant="danger"
                  onClick={() => void voice.stop()}
                  title="Остановить запись и распознать"
                >
                  <StopIcon /> Остановить · {voiceClock}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={voice.cancel}
                  aria-label="Отменить запись"
                  title="Отменить запись (Esc)"
                >
                  <CloseIcon />
                </Button>
              </>
            ) : (
              <Button
                variant="secondary"
                onClick={() => void voice.start()}
                disabled={disabled || voice.phase === 'transcribing'}
                loading={voice.phase === 'requesting' || voice.phase === 'transcribing'}
              >
                {voice.phase === 'requesting' ? (
                  'Доступ к микрофону…'
                ) : voice.phase === 'transcribing' ? (
                  'Распознаём…'
                ) : (
                  <>
                    <MicIcon /> Наговорить задачу
                  </>
                )}
              </Button>
            )}
            {voice.phase === 'requesting' || voice.phase === 'transcribing' ? (
              <Button variant="ghost" onClick={voice.cancel} title="Отменить диктовку (Esc)">
                <CloseIcon /> Отменить
              </Button>
            ) : null}
            <span className="voice-caption">Whisper · до {RECORDING_MAX_SECONDS} с</span>
          </div>

          {voice.phase === 'requesting' ? (
            <p className="field-hint" role="status">Разрешите доступ в системном диалоге. Если он не появился, проверьте разрешение микрофона в настройках ОС. Ожидание можно отменить; через 15 секунд оно завершится.</p>
          ) : null}
          {voice.phase === 'recording' && voice.device ? <p className="field-hint" role="status">Микрофон: {voice.device}</p> : null}

          {voice.phase === 'recording' ? (
            <progress
              className="voice-progress"
              max={RECORDING_MAX_SECONDS}
              value={voice.elapsed}
              aria-label="Длительность записи"
            />
          ) : null}

          <p className="field-hint voice-hint">
            Запись добавляется в задачу для проверки. Эксперимент не запускается автоматически.
          </p>
          {voice.error ? (
            <p className="field-error" role="alert">
              {voice.error}
            </p>
          ) : null}
        </div>

        <TextInput
          id="author-repo"
          label="Репозиторий автора, необязательно"
          value={authorRepo}
          onChange={(event) => {
            setAuthorRepo(event.target.value);
            clearError('authorRepo');
          }}
          placeholder="https://github.com/…"
          disabled={disabled}
          spellCheck={false}
          maxLength={2048}
          hint="Только HTTPS URL авторского кода или материалов для сверки."
          error={errors.authorRepo}
        />
      </fieldset>

      <fieldset className="form-section">
        <legend>Данные и вычислитель</legend>
        <PathField
          id="data-dir"
          label="Папка с данными, необязательно"
          value={dataDir}
          onChange={(value) => {
            setDataDir(value);
            clearError('dataDir');
          }}
          onChoose={() => void choosePath('data')}
          chooseLabel={choosing === 'data' ? 'Открываем…' : 'Выбрать папку'}
          placeholder="/путь/к/данным"
          hint="Датасет или исходные файлы для эксперимента."
          error={errors.dataDir}
          disabled={disabled || choosing !== null}
        />

        <Segmented
          value={mode}
          options={MODE_OPTIONS}
          onChange={setMode}
          ariaLabel="Вычислитель"
          disabled={disabled || agentMode === 'demo'}
        />
        <p className="field-hint">
          {mode === 'local'
            ? 'Код выполняет этот компьютер. Стоимость не начисляется.'
            : mode === 'vast'
              ? 'Платный GPU Vast.ai. Цена и время подтверждаются отдельно.'
              : 'Локальная цель или Vast.ai. Платный выбор потребует подтверждения.'}
        </p>

        {mode === 'local' || mode === 'auto' ? (
          <div className="risk-callout" role="note">
            <ShieldIcon />
            <div>
              <strong>Права на локальный код</strong>
              <p>
                {mode === 'local'
                  ? 'Код автора будет запущен на этом компьютере под вашей учётной записью.'
                  : 'Если система выберет локальную цель, код автора будет запущен на этом компьютере под вашей учётной записью.'}
                {' '}Убедитесь, что у вас есть право его использовать, и проверьте код перед запуском.
                Вы отвечаете за последствия исполнения.
              </p>
            </div>
          </div>
        ) : (
          <p className="form-note">
            <InfoIcon /> Выбранная платная цель, цена за час и итоговая оценка будут показаны перед
            подтверждением оплаты.
          </p>
        )}

        <div className="budget-grid">
          <TextInput
            id="time-seconds"
            label="Время, сек"
            type="number"
            min={5}
            max={86_400}
            step={1}
            value={timeSeconds}
            onChange={(event) => {
              setTimeSeconds(event.target.value);
              clearError('time');
            }}
            error={errors.time}
            disabled={disabled}
            inputMode="numeric"
          />
          <TextInput
            id="max-hourly"
            label="USD/ч"
            type="number"
            min={0}
            step="0.01"
            value={maxHourly}
            onChange={(event) => {
              setMaxHourly(event.target.value);
              clearError('hourly');
            }}
            error={errors.hourly}
            disabled={disabled}
            inputMode="decimal"
          />
          <TextInput
            id="max-total"
            label="Лимит, USD"
            type="number"
            min={0}
            step="0.01"
            value={maxTotal}
            onChange={(event) => {
              setMaxTotal(event.target.value);
              clearError('total');
            }}
            error={errors.total}
            disabled={disabled}
            inputMode="decimal"
          />
        </div>
        <p className="field-hint">
          Время — от 5 секунд до 24 часов. Лимиты 0 USD означают, что расходы не разрешены.
        </p>
      </fieldset>

      <fieldset className="form-section">
        <legend>После запуска</legend>
        <Segmented
          value={cleanup}
          options={CLEANUP_OPTIONS}
          onChange={setCleanup}
          ariaLabel="Очистка вычислителя"
          disabled={disabled}
        />
        <p className={`field-hint${cleanup === 'retain' ? ' is-warning' : ''}`}>
          {cleanup === 'retain'
            ? 'Инстанс останется после работы и может продолжать стоить. Удалите его отдельно.'
            : 'Удалённый инстанс Vast.ai будет удалён после сбора результатов.'}
        </p>
      </fieldset>

      <div className="create-actions">
        <Button
          type="submit"
          variant="primary"
          className="full-width"
          loading={submitting}
          disabled={busy || voice.phase !== 'idle'}
        >
          Создать эксперимент
        </Button>
        <p className="form-note">
          <FileIcon /> Создание не запускает код. Запуск выполняется отдельным действием после плана.
        </p>
      </div>
    </form>
  );
}
