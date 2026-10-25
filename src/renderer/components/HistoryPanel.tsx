import type { AppAPI, ExperimentInput, Snapshot } from '../../shared/types.js';
import { formatRelative } from '../lib/format.js';
import { RUN_MODE_LABEL } from '../lib/labels.js';
import { STATUS_META } from '../lib/status.js';
import { AlertIcon, FileIcon, PlusIcon, RefreshIcon } from './icons.js';
import { Button, Dot, EmptyState, Segmented } from './ui.js';
import { CreateForm } from './CreateForm.js';

interface HistoryPanelProps {
  api: AppAPI;
  snapshot: Snapshot | null;
  loading: boolean;
  loadError: string | null;
  selectedId: string | null;
  mode: 'history' | 'create';
  busy: boolean;
  onModeChange: (mode: 'history' | 'create') => void;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  onCreate: (input: ExperimentInput) => Promise<boolean>;
}

const MODE_OPTIONS = [
  { value: 'history' as const, label: 'История' },
  { value: 'create' as const, label: 'Новый' }
];

export function HistoryPanel({
  api,
  snapshot,
  loading,
  loadError,
  selectedId,
  mode,
  busy,
  onModeChange,
  onSelect,
  onRefresh,
  onCreate
}: HistoryPanelProps) {
  const runs = snapshot
    ? [...snapshot.runs].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    : [];

  return (
    <aside className="sidebar" aria-label="Эксперименты">
      <div className="sidebar-head">
        <div className="sidebar-title-row">
          <div>
            <h2 className="sidebar-title">Эксперименты</h2>
            <p className="sidebar-subtitle">
              {snapshot ? `В истории: ${runs.length}` : 'Загрузка состояния'}
            </p>
          </div>
          <Button
            size="icon"
            variant="ghost"
            onClick={onRefresh}
            disabled={loading}
            loading={loading}
            aria-label="Обновить состояние"
            title="Обновить состояние"
          >
            {loading ? null : <RefreshIcon />}
          </Button>
        </div>
        <Segmented
          value={mode}
          options={MODE_OPTIONS}
          onChange={onModeChange}
          ariaLabel="История или создание эксперимента"
          disabled={busy}
        />
      </div>

      <div className="sidebar-body">
        {mode === 'create' ? (
          <CreateForm api={api} onCreate={onCreate} busy={busy} />
        ) : loadError && !snapshot ? (
          <div className="sidebar-error" role="alert">
            <AlertIcon />
            <p>{loadError}</p>
            <Button size="sm" onClick={onRefresh} loading={loading}>
              Повторить
            </Button>
          </div>
        ) : !snapshot ? (
          <div className="loading-state">
            <span className="spinner" aria-hidden="true" />
            Загрузка истории…
          </div>
        ) : runs.length === 0 ? (
          <EmptyState
            compact
            title="Запусков пока нет"
            icon={<FileIcon />}
            actions={
              <Button size="sm" variant="primary" onClick={() => onModeChange('create')}>
                <PlusIcon /> Создать
              </Button>
            }
          >
            Создайте первый эксперимент из PDF или arXiv. Ничего не запускается автоматически.
          </EmptyState>
        ) : (
          <>
            {loadError ? (
              <div className="inline-alert" role="alert">
                <AlertIcon />
                <span>{loadError}</span>
              </div>
            ) : null}
            <ul className="run-list">
              {runs.map((run) => {
                const meta = STATUS_META[run.status];
                const selected = selectedId === run.id;
                return (
                  <li key={run.id}>
                    <button
                      type="button"
                      className={`run-item${selected ? ' is-selected' : ''}`}
                      aria-current={selected ? 'true' : undefined}
                      onClick={() => onSelect(run.id)}
                    >
                      <Dot tone={meta.tone} pulse={meta.tone === 'active'} />
                      <span className="run-item-main">
                        <span className="run-item-title">{run.title || 'Без названия'}</span>
                        <span className="run-item-meta">
                          <span className={`run-item-status tone-text-${meta.tone}`}>{meta.label}</span>
                          {run.input.mode ? <span>{RUN_MODE_LABEL[run.input.mode]}</span> : null}
                          {run.input.agentMode === 'demo' ? <span>Заглушки агента</span> : null}
                          <span>{formatRelative(run.updatedAt || run.createdAt)}</span>
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>

      {mode === 'history' ? (
        <div className="sidebar-footer">
          <Button variant="primary" className="full-width" onClick={() => onModeChange('create')} disabled={busy}>
            <PlusIcon /> Новый эксперимент
          </Button>
        </div>
      ) : null}
    </aside>
  );
}
