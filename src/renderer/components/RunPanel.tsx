import { useEffect, useRef, useState } from 'react';
import type { ExperimentRun, RunEvent } from '../../shared/types.js';
import {
  formatClock,
  formatDateTime,
  formatDuration,
  formatHours,
  formatUSD
} from '../lib/format.js';
import { CLEANUP_LABEL, EVENT_TYPE_LABEL } from '../lib/labels.js';
import {
  BUSY_STATUSES,
  CANCELLABLE_STATUSES,
  EXECUTABLE_STATUSES,
  STAGES,
  STATUS_META,
  stageState,
  TERMINAL_STATUSES
} from '../lib/status.js';
import {
  AlertIcon,
  CheckIcon,
  ClockIcon,
  PlayIcon,
  ServerIcon,
  SettingsIcon,
  ShieldIcon,
  TerminalIcon,
  TrashIcon
} from './icons.js';
import { Button, CopyButton, EmptyState } from './ui.js';
import { StatusBadge } from './StatusBadge.js';

type ActionKey = 'execute' | 'approve' | 'cancel' | 'cleanup';
type LogFilter = 'all' | 'status' | 'log' | 'error';

const LOG_FILTERS: { value: LogFilter; label: string }[] = [
  { value: 'all', label: 'Все события' },
  { value: 'status', label: 'Статусы' },
  { value: 'log', label: 'Журнал и агент' },
  { value: 'error', label: 'Ошибки' }
];

interface RunPanelProps {
  run: ExperimentRun | null;
  events: RunEvent[];
  eventsError: string | null;
  activeRunTitle: string | null;
  otherActive: boolean;
  busy: boolean;
  onExecute: (id: string) => Promise<boolean>;
  onApprove: (id: string) => Promise<boolean>;
  onCancel: (id: string) => Promise<boolean>;
  onCleanup: (id: string) => Promise<boolean>;
  onOpenResults: () => void;
  onOpenSettings: () => void;
}

export function RunPanel({
  run,
  events,
  eventsError,
  activeRunTitle,
  otherActive,
  busy,
  onExecute,
  onApprove,
  onCancel,
  onCleanup,
  onOpenResults,
  onOpenSettings
}: RunPanelProps) {
  const [filter, setFilter] = useState<LogFilter>('all');
  const [follow, setFollow] = useState(true);
  const [pending, setPending] = useState<ActionKey | null>(null);
  const [cancelArmed, setCancelArmed] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setPending(null);
    setCancelArmed(false);
    setFilter('all');
  }, [run?.id]);

  useEffect(() => {
    if (!cancelArmed) return;
    const timer = window.setTimeout(() => setCancelArmed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [cancelArmed]);

  const filteredEvents = events.filter((event) => {
    if (filter === 'all') return true;
    if (filter === 'status') return event.type === 'status';
    if (filter === 'error') return event.type === 'error';
    return event.type === 'log' || event.type === 'agent' || event.type === 'compaction';
  });
  const visibleEvents = filteredEvents.slice(-300);

  useEffect(() => {
    if (!follow) return;
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [events, filter, follow]);

  if (!run) {
    return (
      <aside className="rail" aria-label="Ход запуска и журнал">
        <div className="card rail-empty">
          <EmptyState compact title="Нет активного запуска" icon={<TerminalIcon size={22} />}>
            Выберите эксперимент в истории, чтобы увидеть этапы, вычислитель и журнал.
          </EmptyState>
        </div>
      </aside>
    );
  }

  const meta = STATUS_META[run.status];
  const target = run.target;
  const planLimits = run.spec?.limits ?? {
    timeSeconds: run.input.timeSeconds,
    maxHourlyUSD: run.input.maxHourlyUSD,
    maxTotalUSD: run.input.maxTotalUSD
  };
  const canExecute =
    EXECUTABLE_STATUSES.includes(run.status) &&
    Boolean(run.spec) &&
    Boolean(run.source) &&
    typeof run.instanceId !== 'number' &&
    !run.provisioningUncertain &&
    !otherActive &&
    !busy &&
    pending === null;
  const canApprove =
    run.status === 'awaiting_approval' &&
    Boolean(target) &&
    Boolean(run.spec) &&
    !otherActive &&
    !busy &&
    pending === null;
  const canCancel =
    CANCELLABLE_STATUSES.includes(run.status) && !otherActive && !busy && pending === null;

  const executeReason = busy
    ? 'Дождитесь завершения текущего действия.'
    : otherActive
      ? `Активен «${activeRunTitle ?? 'другой эксперимент'}». Дождитесь завершения.`
      : typeof run.instanceId === 'number' || run.provisioningUncertain
        ? 'Сначала заберите результаты и завершите аренду инстанса.'
        : !run.spec || !run.source
          ? 'Сначала сформируйте и сохраните план.'
        : run.status === 'awaiting_approval'
        ? 'Сначала подтвердите выбранную цель и стоимость.'
        : run.status === 'draft'
          ? 'Сначала сформируйте план.'
          : run.status === 'needs_data'
            ? 'В плане не хватает сведений или данных.'
            : BUSY_STATUSES.includes(run.status)
              ? 'Операция уже выполняется.'
              : run.status === 'completed'
                ? 'Запуск завершён; смотрите результаты.'
                : 'Запуск недоступен в текущем статусе.';

  const perform = async (key: ActionKey, action: () => Promise<boolean>) => {
    if (pending !== null || busy) return;
    setPending(key);
    try {
      await action();
    } catch {
      // The shell renders operation errors in the global notice.
    } finally {
      setPending(null);
    }
  };

  const handleCancelClick = () => {
    if (!canCancel) return;
    if (!cancelArmed) {
      setCancelArmed(true);
      return;
    }
    setCancelArmed(false);
    void perform('cancel', () => onCancel(run.id));
  };

  const runFinished = TERMINAL_STATUSES.includes(run.status);
  const cleanupNeeded =
    Boolean(run.cleanupRequired) ||
    Boolean(run.provisioningUncertain) ||
    (runFinished && typeof run.instanceId === 'number');
  const canCleanup =
    Boolean(run.spec) &&
    (typeof run.instanceId === 'number' || Boolean(run.provisioningUncertain)) &&
    !otherActive &&
    !busy &&
    pending === null;
  const cleanupBlockedReason = otherActive
    ? 'Сначала завершите активную операцию или дождитесь её окончания.'
    : typeof run.instanceId !== 'number' && !run.provisioningUncertain
      ? 'Сохранённый инстанс не найден; проверьте Vast Console и папку запуска.'
      : !run.spec
        ? 'Нет сохранённого плана для восстановления инстанса.'
        : null;

  const targetExceedsLimits = target
    ? target.hourlyUSD > planLimits.maxHourlyUSD || target.estimatedUSD > planLimits.maxTotalUSD
    : false;

  const logCopyText = visibleEvents
    .map((event) => `[${formatClock(event.at)}] ${EVENT_TYPE_LABEL[event.type]}: ${event.message}`)
    .join('\n');

  return (
    <aside className="rail" aria-label="Ход запуска и журнал">
      <section className="card status-card" aria-labelledby="status-heading">
        <div className="card-head compact">
          <h2 id="status-heading">Ход запуска</h2>
          <StatusBadge status={run.status} />
        </div>
        <div className="status-body">
          <p className="status-hint">{meta.hint}</p>
          {otherActive ? (
            <div className="inline-alert is-warning" role="status">
              <AlertIcon />
              <span>
                Активен другой запуск{activeRunTitle ? `: «${activeRunTitle}»` : ''}. Исполнение
                заблокировано до его завершения.
              </span>
            </div>
          ) : null}
          {run.status === 'awaiting_approval' ? (
            <div className="inline-alert is-warning" role="status">
              <ClockIcon />
              <span>Запуск приостановлен: требуется подтверждение платной цели.</span>
            </div>
          ) : null}
          {run.status === 'needs_setup' ? (
            <div className="action-row">
              <Button size="sm" variant="secondary" onClick={onOpenSettings}>
                <SettingsIcon /> Настройки подключений
              </Button>
            </div>
          ) : null}

          <ol className="phase-list" aria-label="Этапы эксперимента">
            {STAGES.map((stage, index) => {
              const state = stageState(run.status, index);
              return (
                <li key={stage.label} className={`phase is-${state}`}>
                  <span className="phase-marker" aria-hidden="true">
                    <span className="phase-dot">
                      {state === 'done' ? <CheckIcon size={9} /> : null}
                    </span>
                    {index < STAGES.length - 1 ? <span className="phase-line" /> : null}
                  </span>
                  <span className="phase-copy">
                    <span className="phase-label">{stage.label}</span>
                    <span className="phase-detail">{stage.detail}</span>
                  </span>
                </li>
              );
            })}
          </ol>

          <div className="rail-actions">
            <Button
              variant="primary"
              className="full-width"
              onClick={() => void perform('execute', () => onExecute(run.id))}
              disabled={!canExecute}
              loading={pending === 'execute'}
              title={canExecute ? 'Запустить эксперимент' : executeReason}
            >
              <PlayIcon /> Запустить эксперимент
            </Button>
            {!canExecute ? <p className="action-hint">{executeReason}</p> : null}
            <div className="action-row">
              {CANCELLABLE_STATUSES.includes(run.status) ? (
                <Button
                  variant={cancelArmed ? 'danger' : 'secondary'}
                  size="sm"
                  className="grow"
                  onClick={handleCancelClick}
                  disabled={!canCancel}
                  loading={pending === 'cancel'}
                  title={cancelArmed ? 'Нажмите ещё раз для отмены' : 'Отменить запуск'}
                >
                  {cancelArmed ? 'Подтвердить отмену' : 'Отменить'}
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                className="grow"
                onClick={onOpenResults}
                title="Открыть вкладку результатов"
              >
                Результаты
              </Button>
            </div>
          </div>
        </div>
      </section>

      <section className="card compute-card" aria-labelledby="compute-heading">
        <div className="card-head compact">
          <h2 id="compute-heading">Вычислитель</h2>
          {target ? (
            <span className={`kind-chip kind-${target.kind}`}>
              {target.kind === 'vast' ? 'Vast.ai' : 'Локально'}
            </span>
          ) : (
            <span className="meta-tag">не выбран</span>
          )}
        </div>
        <div className="compute-body">
          {target ? (
            <>
              <div className="target-title-row">
                <strong className="target-label">{target.label}</strong>
                <span className="target-hourly">{formatUSD(target.hourlyUSD)}/ч</span>
              </div>
              <div className="target-specs">
                <span>
                  <b>{target.cpuCores}</b> CPU
                </span>
                <span>
                  <b>{target.ramGB}</b> ГБ RAM
                </span>
                <span>
                  <b>{target.gpu ? 'GPU' : 'CPU'}</b>
                  {target.gpu ? ` · ${target.vramGB} ГБ VRAM` : ' · без GPU'}
                </span>
                <span>
                  <b>{target.diskGB}</b> ГБ диск
                </span>
              </div>
              <div className="price-table">
                <div>
                  <span>Оценка цели</span>
                  <b>{formatUSD(target.estimatedUSD)}</b>
                </div>
                <div>
                  <span>Время из плана</span>
                  <b>
                    {formatDuration(planLimits.timeSeconds)} · {formatHours(planLimits.timeSeconds)}
                  </b>
                </div>
                <div>
                  <span>Лимит цены из плана</span>
                  <b>{formatUSD(planLimits.maxHourlyUSD)}/ч</b>
                </div>
                <div>
                  <span>Общий лимит из плана</span>
                  <b>{formatUSD(planLimits.maxTotalUSD)}</b>
                </div>
                {typeof target.offerId === 'number' ? (
                  <div>
                    <span>Offer ID</span>
                    <b>{target.offerId}</b>
                  </div>
                ) : null}
                {typeof run.instanceId === 'number' ? (
                  <div>
                    <span>Инстанс</span>
                    <b>{run.instanceId}</b>
                  </div>
                ) : null}
                {typeof run.pid === 'number' ? (
                  <div>
                    <span>PID</span>
                    <b>{run.pid}</b>
                  </div>
                ) : null}
              </div>

              {target.kind === 'local' ? (
                <div className="risk-callout compact" role="note">
                  <ShieldIcon />
                  <div>
                    <strong>Локальный код под вашей учётной записью</strong>
                    <p>Убедитесь в правах на код автора и проверьте его перед запуском.</p>
                  </div>
                </div>
              ) : null}

              {targetExceedsLimits ? (
                <div className="inline-alert is-danger" role="alert">
                  <AlertIcon />
                  <span>Цена цели превышает заданные лимиты. Проверьте условия до подтверждения.</span>
                </div>
              ) : null}

              {run.status === 'awaiting_approval' ? (
                <div className="approval-box">
                  <div className="approval-head">
                    <strong>
                      {target.kind === 'vast'
                        ? 'Подтверждение оплаты'
                        : 'Подтверждение локального запуска'}
                    </strong>
                    <span>{target.kind === 'vast' ? 'платный вычислитель' : 'локальная цель'}</span>
                  </div>
                  <p className="approval-note">
                    Проверьте точную цель, цену, время и итоговую оценку. Лимиты берутся из
                    сохранённой версии плана и фиксируются для запуска. Это отдельное действие, не
                    запуск из формы и не голосовой ввод.
                  </p>
                  <Button
                    variant="primary"
                    className="approve-button"
                    onClick={() => void perform('approve', () => onApprove(run.id))}
                    disabled={!canApprove}
                    loading={pending === 'approve'}
                    title={canApprove ? 'Подтвердить выбранную цель и стоимость' : 'Подтверждение сейчас недоступно'}
                  >
                    <span className="approve-main">
                      {target.kind === 'vast'
                        ? 'Подтвердить оплату'
                        : 'Подтвердить локальный запуск'}
                    </span>
                    <span className="approve-detail">
                      {target.label} · {formatUSD(target.hourlyUSD)}/ч ·{' '}
                      {formatDuration(planLimits.timeSeconds)} ·{' '}
                      {target.kind === 'vast' ? (
                        <>цель {formatUSD(target.estimatedUSD)} · лимит {formatUSD(planLimits.maxTotalUSD)}</>
                      ) : (
                        <>без оплаты</>
                      )}
                    </span>
                  </Button>
                  <div className="approval-caps">
                    <span>Лимит/ч из плана: {formatUSD(planLimits.maxHourlyUSD)}</span>
                    <span>Итог цели: {formatUSD(target.estimatedUSD)}</span>
                    <span>Общий лимит из плана: {formatUSD(planLimits.maxTotalUSD)}</span>
                  </div>
                  {!run.spec ? (
                    <p className="field-error">Сохранённый план отсутствует — подтверждение недоступно.</p>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <EmptyState compact title="Цель ещё не выбрана" icon={<ServerIcon size={22} />}>
              {run.status === 'selecting_compute'
                ? 'Идёт подбор вычислителя в рамках лимитов.'
                : 'Вычислитель появится после подготовки плана и выбора цели.'}
            </EmptyState>
          )}

          {run.deadlineAt ? (
            <div className="deadline-row">
              <ClockIcon />
              <span>Дедлайн: {formatDateTime(run.deadlineAt)}</span>
            </div>
          ) : null}
        </div>
      </section>

      {cleanupNeeded ? (
        <section className="card cleanup-card" aria-labelledby="cleanup-heading">
          <div className="card-head compact">
            <h2 id="cleanup-heading">Очистка</h2>
            <span className="meta-tag">{CLEANUP_LABEL[run.input.cleanup]}</span>
          </div>
          <div className="cleanup-body">
            <div className={`inline-alert ${run.cleanupRequired ? 'is-danger' : 'is-warning'}`} role="status">
              <TrashIcon />
              <span>
                {run.provisioningUncertain
                  ? `Ответ создания потерян. Метка: ${run.provisioningLabel ?? run.id}. Новая аренда заблокирована до проверки Vast.`
                  : run.cleanupRequired
                  ? 'Очистка или экспорт завершились ошибкой. Инстанс мог сохраниться.'
                  : run.input.cleanup === 'retain'
                    ? 'Инстанс оставлен по настройке retain и может продолжать стоить. Завершите аренду в Vast Console, если он больше не нужен.'
                    : 'Инстанс ещё не удалён.'}
              </span>
            </div>
            <Button
              size="sm"
              variant="secondary"
              className="full-width"
              onClick={() => void perform('cleanup', () => onCleanup(run.id))}
              disabled={!canCleanup}
              loading={pending === 'cleanup'}
            >
              <TrashIcon /> Повторить очистку
            </Button>
            <p className="action-hint">
              {cleanupBlockedReason ??
                'Повторная проверка сначала ищет неопределённую аренду, затем выгружает файлы и выполняет выбранную политику cleanup.'}
            </p>
          </div>
        </section>
      ) : null}

      <section className="card log-card" aria-labelledby="log-heading">
        <div className="card-head compact log-head">
          <div className="log-title-row">
            <h2 id="log-heading">Журнал</h2>
            <span className="log-count">{events.length}</span>
          </div>
          <div className="log-tools">
            <label className="visually-hidden" htmlFor="log-filter">
              Фильтр журнала
            </label>
            <select
              id="log-filter"
              className="select select-compact"
              value={filter}
              onChange={(event) => {
                const next = LOG_FILTERS.find((option) => option.value === event.target.value);
                if (next) setFilter(next.value);
              }}
            >
              {LOG_FILTERS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <label className="check-row">
              <input
                type="checkbox"
                checked={follow}
                onChange={(event) => setFollow(event.target.checked)}
              />
              <span>Следовать</span>
            </label>
          </div>
        </div>

        {eventsError ? (
          <div className="inline-alert is-danger log-alert" role="alert">
            <AlertIcon />
            <span>{eventsError}</span>
          </div>
        ) : null}

        <div
          className="log-list"
          ref={logRef}
          role="log"
          aria-live="off"
          tabIndex={0}
          aria-label="События эксперимента"
        >
          {visibleEvents.length === 0 ? (
            <p className="log-empty">
              {events.length === 0 ? 'Событий пока нет.' : 'По фильтру событий нет.'}
            </p>
          ) : (
            <ol className="log-items">
              {visibleEvents.map((event) => (
                <li key={event.id} className={`log-item log-${event.type}`}>
                  <span className="log-time">{formatClock(event.at)}</span>
                  <span className="log-type">{EVENT_TYPE_LABEL[event.type]}</span>
                  <span className="log-message">{event.message}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className="log-footer">
          <span>
            {filteredEvents.length > 300
              ? `Показаны последние 300 из ${filteredEvents.length}`
              : `${visibleEvents.length} событий`}
          </span>
          <div className="log-footer-actions">
            {visibleEvents.length > 0 ? <CopyButton text={logCopyText} label="Копировать" /> : null}
            <span className="log-bound">Хранится до 500 событий</span>
          </div>
        </div>
      </section>
    </aside>
  );
}
