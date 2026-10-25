import { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ExperimentRun, ExperimentSpec } from '../../shared/types.js';
import { formatDateTime, formatRelative } from '../lib/format.js';
import { RUN_MODE_LABEL } from '../lib/labels.js';
import { STATUS_META } from '../lib/status.js';
import { AlertIcon, FileIcon, PlusIcon } from './icons.js';
import { Button, EmptyState } from './ui.js';
import { DocumentView } from './DocumentView.js';
import { PlanEditor } from './PlanEditor.js';
import { StatusBadge } from './StatusBadge.js';

type WorkspaceView = 'plan' | 'document';

const VIEWS: { id: WorkspaceView; label: string }[] = [
  { id: 'plan', label: 'План' },
  { id: 'document', label: 'Документ' }
];

interface WorkspaceProps {
  run: ExperimentRun | null;
  busy: boolean;
  otherActive: boolean;
  onPlan: (id: string) => Promise<boolean>;
  onSavePlan: (id: string, spec: ExperimentSpec) => Promise<boolean>;
  onNewExperiment: () => void;
}

export function Workspace({ run, busy, otherActive, onPlan, onSavePlan, onNewExperiment }: WorkspaceProps) {
  const [view, setView] = useState<WorkspaceView>('plan');

  if (!run) {
    return (
      <div className="center-column">
        <div className="card center-empty">
          <EmptyState
            title="Выберите эксперимент"
            icon={<FileIcon size={24} />}
            actions={
              <Button variant="primary" onClick={onNewExperiment}>
                <PlusIcon /> Создать эксперимент
              </Button>
            }
          >
            Слева — история запусков. Новый эксперимент создаётся из PDF или ссылки arXiv.
          </EmptyState>
        </div>
      </div>
    );
  }

  const meta = STATUS_META[run.status];
  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % VIEWS.length;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + VIEWS.length) % VIEWS.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = VIEWS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    setView(VIEWS[nextIndex].id);
    document.getElementById(`workspace-tab-${VIEWS[nextIndex].id}`)?.focus();
  };

  return (
    <div className="center-column">
      <header className="card run-header-card">
        <div className="run-header-main">
          <div className="run-heading">
            <p className="eyebrow">Запуск · {formatRelative(run.createdAt)}</p>
            <h1 className="run-title">{run.title || 'Без названия'}</h1>
          </div>
          <StatusBadge status={run.status} />
        </div>
        <div className="run-meta-row">
          <span>{RUN_MODE_LABEL[run.input.mode]}</span>
          <span>{run.input.agentMode === 'demo' ? 'ДЕМО: заглушки агента · реальные вычисления' : 'Pi: реальный агент'}</span>
          <span>Создан {formatDateTime(run.createdAt)}</span>
          <span>План v{run.planVersion || 0}</span>
          <span title={run.spec?.metric.name ?? undefined}>
            {run.spec?.metric.name ? `Метрика: ${run.spec.metric.name}` : 'Метрика не задана'}
          </span>
          {run.attempts > 0 ? <span>Попыток: {run.attempts}</span> : null}
        </div>
        <p className="run-hint">{meta.hint}</p>
        {run.error ? (
          <div className="inline-alert is-error" role="alert">
            <AlertIcon />
            <span>{run.error}</span>
          </div>
        ) : null}
      </header>

      <div className="workspace-card">
        <div className="workspace-tabs" role="tablist" aria-label="Материалы эксперимента">
          {VIEWS.map((item, index) => (
            <button
              key={item.id}
              id={`workspace-tab-${item.id}`}
              type="button"
              role="tab"
              aria-selected={view === item.id}
              aria-controls="workspace-panel"
              tabIndex={view === item.id ? 0 : -1}
              className={`workspace-tab${view === item.id ? ' is-active' : ''}`}
              onClick={() => setView(item.id)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
            >
              {item.label}
              {item.id === 'document' ? (
                <span className="tab-count">
                  {run.source ? `${run.source.pages.length} стр.` : 'нет'}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        <div
          id="workspace-panel"
          role="tabpanel"
          aria-labelledby={`workspace-tab-${view}`}
          className="workspace-panel"
        >
          {view === 'plan' ? (
            <PlanEditor
              key={run.id}
              run={run}
              busy={busy}
              otherActive={otherActive}
              onPlan={onPlan}
              onSavePlan={onSavePlan}
            />
          ) : (
            <DocumentView key={run.id} run={run} />
          )}
        </div>
      </div>
    </div>
  );
}
