import { useEffect, useState } from 'react';
import type { ExperimentRun } from '../../shared/types.js';
import {
  formatBytes,
  formatDateTime,
  formatMetric,
  formatPercent,
  formatUSD,
  shortHash
} from '../lib/format.js';
import { ARTIFACT_KIND_LABEL, RUN_MODE_LABEL } from '../lib/labels.js';
import { TERMINAL_STATUSES } from '../lib/status.js';
import {
  AlertIcon,
  FileIcon,
  FolderIcon,
  InfoIcon,
  TerminalIcon,
  TrashIcon
} from './icons.js';
import { Badge, Button, CopyButton, EmptyState } from './ui.js';
import { StatusBadge } from './StatusBadge.js';

interface ResultsViewProps {
  run: ExperimentRun | null;
  busy: boolean;
  otherActive: boolean;
  onOpenFolder: (id: string) => Promise<boolean>;
  onCleanup: (id: string) => Promise<boolean>;
}

type ResultAction = 'folder' | 'cleanup';

export function ResultsView({ run, busy, otherActive, onOpenFolder, onCleanup }: ResultsViewProps) {
  const [pending, setPending] = useState<ResultAction | null>(null);

  useEffect(() => {
    setPending(null);
  }, [run?.id]);

  if (!run) {
    return (
      <div className="wide-view">
        <section className="card center-empty">
          <EmptyState title="Результаты не выбраны" icon={<TerminalIcon size={24} />}>
            Выберите запуск в истории слева. Здесь появятся метрики, верификация, отчёт, артефакты и
            команда повторного запуска.
          </EmptyState>
        </section>
      </div>
    );
  }

  const perform = async (key: ResultAction, action: () => Promise<boolean>) => {
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

  const metric = run.spec?.metric;
  const rawMeasured = metric ? run.metrics?.[metric.name] : undefined;
  const measured = typeof rawMeasured === 'number' && Number.isFinite(rawMeasured) ? rawMeasured : null;
  const published = metric?.publishedValue ?? null;
  const difference = measured !== null && published !== null ? measured - published : null;
  const relative =
    difference !== null && published !== null && published !== 0 ? difference / published : null;
  const verification = run.verification?.trim() ?? '';
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
    ? 'Дождитесь завершения активной операции.'
    : typeof run.instanceId !== 'number' && !run.provisioningUncertain
      ? 'Сохранённый инстанс не найден; проверьте Vast Console и папку запуска.'
      : !run.spec
        ? 'Нет сохранённого плана для восстановления инстанса.'
        : null;
  const verificationTone = verification ? 'info' : runFinished ? 'warning' : 'neutral';

  return (
    <div className="wide-view results-view">
      <header className="card results-header">
        <div className="run-header-main">
          <div className="run-heading">
            <p className="eyebrow">Результаты · обновлено {formatDateTime(run.updatedAt)}</p>
            <h1 className="run-title">{run.title || 'Без названия'}</h1>
          </div>
          <StatusBadge status={run.status} />
        </div>
        <div className="run-meta-row">
          <span>{RUN_MODE_LABEL[run.input.mode]}</span>
          <span>{run.input.agentMode === 'demo' ? 'ДЕМО: план и код — заглушки; результат вычислен' : 'Pi: реальный агент'}</span>
          <span>Создан {formatDateTime(run.createdAt)}</span>
          <span>План v{run.planVersion || 0}</span>
          {metric?.name ? <span>Метрика: {metric.name}</span> : null}
          {typeof run.target?.estimatedUSD === 'number' ? (
            <span>Оценка: {formatUSD(run.target.estimatedUSD)}</span>
          ) : null}
        </div>
        <div className="results-toolbar">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void perform('folder', () => onOpenFolder(run.id))}
            loading={pending === 'folder'}
            disabled={busy || pending !== null}
          >
            <FolderIcon /> Открыть папку запуска
          </Button>
          <CopyButton text={run.dir} label="Путь запуска" />
          {cleanupNeeded ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void perform('cleanup', () => onCleanup(run.id))}
              loading={pending === 'cleanup'}
              disabled={!canCleanup}
              title={cleanupBlockedReason ?? 'Повторить очистку инстанса'}
            >
              <TrashIcon /> Повторить очистку
            </Button>
          ) : null}
        </div>
        {run.error ? (
          <div className="inline-alert is-danger" role="alert">
            <AlertIcon />
            <span>{run.error}</span>
          </div>
        ) : null}
      </header>

      {cleanupNeeded ? (
        <div className="inline-alert is-warning results-cleanup" role="status">
          <TrashIcon />
          <span>
            {run.provisioningUncertain
              ? `Результат создания неизвестен. Метка ${run.provisioningLabel ?? run.id}; повторная аренда заблокирована. Повторите проверку.`
              : run.cleanupRequired
              ? 'Очистка или экспорт завершились ошибкой. Проверьте папку запуска.'
              : run.input.cleanup === 'retain'
                ? 'Инстанс оставлен по настройке retain и может продолжать стоить. Завершите аренду в Vast Console, если он больше не нужен.'
                : 'Инстанс ещё не очищен.'}
            {cleanupBlockedReason ? ` ${cleanupBlockedReason}` : ''}
          </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void perform('cleanup', () => onCleanup(run.id))}
            loading={pending === 'cleanup'}
            disabled={!canCleanup}
            title={cleanupBlockedReason ?? 'Повторить очистку инстанса'}
          >
            Повторить
          </Button>
        </div>
      ) : null}

      <div className="results-grid">
        <section className="card result-card verification-card" aria-labelledby="verification-heading">
          <div className="card-head compact">
            <h2 id="verification-heading">Верификация</h2>
            <Badge tone={verificationTone}>
              {verification
                ? 'Верификация присутствует'
                : runFinished
                  ? 'Верификация отсутствует'
                  : 'Ожидает данных'}
            </Badge>
          </div>
          <div className="result-body">
            {verification ? (
              <div className="verification-text">{verification}</div>
            ) : (
              <div className="inline-alert is-warning" role="status">
                <InfoIcon />
                <span>
                  {runFinished
                    ? 'Завершение запуска само по себе не подтверждает воспроизведение. Верификация в результате отсутствует.'
                    : 'Верификация пока не сформирована. Завершение запуска само по себе не подтверждает воспроизведение.'}
                </span>
              </div>
            )}

            <div className="comparison">
              <h3>Сравнение метрики</h3>
              {metric ? (
                <>
                  <div className="metric-definition">
                    <span className="metric-name">{metric.name}</span>
                    {metric.computation ? <span>{metric.computation}</span> : null}
                    <Badge tone={metric.comparable ? 'info' : 'warning'}>
                      {metric.comparable ? 'сопоставима' : 'не сопоставима'}
                    </Badge>
                  </div>
                  <div className="comparison-values">
                    <div>
                      <span>Измерено</span>
                      <strong>{measured !== null ? formatMetric(measured) : 'нет данных'}</strong>
                    </div>
                    <div>
                      <span>Опубликовано</span>
                      <strong>{published !== null ? formatMetric(published) : 'не указано'}</strong>
                    </div>
                    <div>
                      <span>Разница</span>
                      <strong>
                        {difference !== null
                          ? `${difference > 0 ? '+' : ''}${formatMetric(difference)}`
                          : '—'}
                      </strong>
                    </div>
                    <div>
                      <span>Относительно</span>
                      <strong>
                        {relative !== null
                          ? `${relative > 0 ? '+' : ''}${formatPercent(relative)}`
                          : '—'}
                      </strong>
                    </div>
                  </div>
                  {!metric.comparable ? (
                    <p className="result-note">
                      Метрика помечена как несопоставимая. Числа показаны только для контекста и не
                      интерпретируются как воспроизведение.
                    </p>
                  ) : measured === null ? (
                    <p className="result-note">Измеренное значение отсутствует в собранных метриках.</p>
                  ) : published === null ? (
                    <p className="result-note">В спецификации нет опубликованного значения.</p>
                  ) : (
                    <p className="result-note">
                      Интерфейс показывает арифметическую разницу. Автоматический вердикт о
                      воспроизведении не выносится.
                    </p>
                  )}
                </>
              ) : (
                <p className="result-note">В спецификации нет определения метрики.</p>
              )}
            </div>
          </div>
        </section>

        <section className="card result-card" aria-labelledby="metrics-heading">
          <div className="card-head compact">
            <h2 id="metrics-heading">Метрики запуска</h2>
            <span className="meta-tag">{run.metrics ? Object.keys(run.metrics).length : 0}</span>
          </div>
          <div className="result-body">
            {run.metrics && Object.keys(run.metrics).length > 0 ? (
              <table className="metric-table">
                <thead>
                  <tr>
                    <th scope="col">Название</th>
                    <th scope="col">Фактическое значение</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(run.metrics).map(([name, value]) => (
                    <tr key={name}>
                      <td>
                        <code>{name}</code>
                      </td>
                      <td className="numeric">{formatMetric(value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyState compact title="Метрики не собраны" icon={<InfoIcon size={20} />}>
                {TERMINAL_STATUSES.includes(run.status)
                  ? 'Запуск не передал числовые метрики. Проверьте журнал и артефакты.'
                  : 'Значения появятся после сбора результатов.'}
              </EmptyState>
            )}
          </div>
        </section>

        <section className="card result-card report-card" aria-labelledby="report-heading">
          <div className="card-head compact">
            <h2 id="report-heading">Отчёт</h2>
          </div>
          <div className="result-body">
            {run.report?.trim() ? (
              <div className="report-text">{run.report}</div>
            ) : (
              <EmptyState compact title="Отчёт не сформирован" icon={<FileIcon size={20} />}>
                Текстовый отчёт появится после сбора результатов. Отсутствие отчёта не означает успех.
              </EmptyState>
            )}
          </div>
        </section>

        <section className="card result-card command-card" aria-labelledby="command-heading">
          <div className="card-head compact">
            <h2 id="command-heading">Повторный запуск</h2>
            {run.command ? <CopyButton text={run.command} label="Команда" /> : null}
          </div>
          <div className="result-body">
            {run.command ? (
              <>
                <pre className="command-block">
                  <code>{run.command}</code>
                </pre>
                <p className="result-note">
                  Команда зафиксирована в манифесте. Интерфейс не запускает её автоматически —
                  выполните вручную в папке запуска.
                </p>
              </>
            ) : (
              <EmptyState compact title="Команда не зафиксирована" icon={<TerminalIcon size={20} />}>
                Манифест проекта не содержит команды повторного запуска.
              </EmptyState>
            )}
            <div className="run-dir-row">
              <span>Папка запуска</span>
              <code title={run.dir}>{run.dir}</code>
              <CopyButton text={run.dir} label="Путь" />
            </div>
          </div>
        </section>

        <section className="card result-card artifacts-card" aria-labelledby="artifacts-heading">
          <div className="card-head compact">
            <div className="card-title-group">
              <h2 id="artifacts-heading">Артефакты</h2>
              <span className="meta-row">
                {run.artifacts.length} файлов
                {run.artifactsCollected === false ? ' · сбор не завершён' : ''}
              </span>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void perform('folder', () => onOpenFolder(run.id))}
              disabled={busy || pending !== null}
            >
              <FolderIcon /> Открыть папку
            </Button>
          </div>
          <div className="result-body">
            {run.artifacts.length > 0 ? (
              <ul className="artifact-list">
                {run.artifacts.map((artifact) => (
                  <li key={artifact.path} className="artifact-row">
                    <div className="artifact-main">
                      <span className="artifact-kind">{ARTIFACT_KIND_LABEL[artifact.kind]}</span>
                      <code className="artifact-path" title={artifact.path}>{artifact.path}</code>
                    </div>
                    <div className="artifact-meta">
                      <span>{formatBytes(artifact.bytes)}</span>
                      <span title={artifact.sha256}>sha256 {shortHash(artifact.sha256)}</span>
                      <CopyButton text={artifact.path} label="Путь" />
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState compact title="Артефакты отсутствуют" icon={<FolderIcon size={20} />}>
                {run.artifactsCollected === false
                  ? 'Сбор артефактов не завершён. Проверьте папку запуска и журнал; для Vast используйте очистку.'
                  : 'Запуск не передал файлов. Это не подтверждает успешное воспроизведение.'}
              </EmptyState>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
