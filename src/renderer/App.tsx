import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react';
import type {
  AppAPI,
  AppSettings,
  ExperimentInput,
  ExperimentRun,
  ExperimentSpec,
  RunEvent,
  Snapshot
} from '../shared/types.js';
import { getApi, errorMessage } from './lib/api.js';
import {
  COMPONENT_META,
  CONNECTION_ORDER,
  CONNECTION_STATE_META
} from './lib/status.js';
import type { Tone } from './lib/tone.js';
import { BridgeUnavailable } from './components/BridgeUnavailable.js';
import { HistoryPanel } from './components/HistoryPanel.js';
import { ResultsView } from './components/ResultsView.js';
import { RunPanel } from './components/RunPanel.js';
import { SettingsView } from './components/SettingsView.js';
import { Workspace } from './components/Workspace.js';
import {
  AlertIcon,
  FileIcon,
  RefreshIcon,
  SettingsIcon,
  TerminalIcon
} from './components/icons.js';
import { Button, EmptyState, Notice } from './components/ui.js';

type Tab = 'workspace' | 'results' | 'settings';
type NoticeState = { tone: 'error' | 'success' | 'info'; text: string };

const TABS: { id: Tab; label: string; icon: ReactNode; shortcut: string }[] = [
  { id: 'workspace', label: 'Эксперимент', icon: <FileIcon size={14} />, shortcut: '⌘/Ctrl+1' },
  { id: 'results', label: 'Результаты', icon: <TerminalIcon size={14} />, shortcut: '⌘/Ctrl+2' },
  { id: 'settings', label: 'Настройки', icon: <SettingsIcon size={14} />, shortcut: '⌘/Ctrl+3' }
];

const TAB_SHORTCUTS: Record<string, Tab> = {
  '1': 'workspace',
  '2': 'results',
  '3': 'settings'
};

const SNAPSHOT_EVENT_TYPES: RunEvent['type'][] = ['status', 'artifact', 'compute', 'error'];

function boundEvents(events: RunEvent[]): RunEvent[] {
  return [...events]
    .sort((left, right) => {
      const diff = Date.parse(left.at) - Date.parse(right.at);
      return diff !== 0 ? diff : left.id.localeCompare(right.id);
    })
    .slice(-500);
}

function connectionTone(state: 'ready' | 'needs_setup' | 'error' | undefined): Tone {
  if (!state) return 'neutral';
  return CONNECTION_STATE_META[state].tone;
}

export function App() {
  const api = getApi();
  if (!api) return <BridgeUnavailable />;
  return <AppShell api={api} />;
}

function AppShell({ api }: { api: AppAPI }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('workspace');
  const [historyMode, setHistoryMode] = useState<'history' | 'create'>('history');
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [operation, setOperation] = useState<string | null>(null);

  const selectedIdRef = useRef<string | null>(null);
  const operationRef = useRef<string | null>(null);
  const initializedRef = useRef(false);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const refresh = useCallback(async () => {
    try {
      const next = await api.snapshot();
      setSnapshot(next);
      setLoadError(null);
      setSelectedId((previous) => {
        if (previous && next.runs.some((run) => run.id === previous)) return previous;
        const active = next.runs.find((run) => run.id === next.activeId);
        return active?.id ?? next.runs[0]?.id ?? null;
      });
    } catch (error) {
      setLoadError(errorMessage(error));
      throw error;
    }
  }, [api]);

  const loadEvents = useCallback(
    async (id: string) => {
      try {
        const list = await api.events(id);
        if (selectedIdRef.current !== id) return;
        setEvents((previous) =>
          boundEvents([
            ...list,
            ...previous.filter((event) => !list.some((item) => item.id === event.id))
          ])
        );
        setEventsError(null);
      } catch (error) {
        if (selectedIdRef.current !== id) return;
        setEventsError(errorMessage(error));
      }
    },
    [api]
  );

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    setLoading(true);
    refresh()
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [refresh]);

  useEffect(() => {
    if (!snapshot || initializedRef.current) return;
    initializedRef.current = true;
    if (snapshot.runs.length === 0) setHistoryMode('create');
  }, [snapshot]);

  useEffect(() => {
    if (!selectedId) {
      setEvents([]);
      setEventsError(null);
      return;
    }
    setEvents([]);
    setEventsError(null);
    void loadEvents(selectedId);
  }, [selectedId, loadEvents]);

  const refreshRef = useRef(refresh);
  const loadEventsRef = useRef(loadEvents);

  useEffect(() => {
    refreshRef.current = refresh;
    loadEventsRef.current = loadEvents;
  }, [refresh, loadEvents]);

  useEffect(() => {
    let timer: number | undefined;
    let needsSnapshot = false;
    const unsubscribe = api.onEvent((event) => {
      const selected = selectedIdRef.current;
      if (event.runId === selected) {
        setEvents((previous) => boundEvents([...previous.filter((item) => item.id !== event.id), event]));
      }
      if (SNAPSHOT_EVENT_TYPES.includes(event.type)) needsSnapshot = true;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = undefined;
        if (needsSnapshot) {
          needsSnapshot = false;
          refreshRef.current().catch(() => undefined);
        }
        const id = selectedIdRef.current;
        if (id) void loadEventsRef.current(id);
      }, 500);
    });
    return () => {
      unsubscribe();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [api]);

  useEffect(() => {
    if (notice?.tone !== 'success') return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.isComposing) return;
      const target = TAB_SHORTCUTS[event.key];
      if (!target) return;
      event.preventDefault();
      setTab(target);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const perform = useCallback(
    async (label: string, action: () => Promise<unknown>, success: string) => {
      if (operationRef.current) return false;
      operationRef.current = label;
      setOperation(label);
      setNotice(null);
      try {
        await action();
      } catch (error) {
        setNotice({ tone: 'error', text: `${label}: ${errorMessage(error)}` });
        return false;
      } finally {
        try {
          await refresh();
        } catch {
          // refresh() already exposed the load error banner.
        }
        const currentId = selectedIdRef.current;
        if (currentId) await loadEvents(currentId);
        operationRef.current = null;
        setOperation(null);
      }
      setNotice({ tone: 'success', text: success });
      return true;
    },
    [refresh, loadEvents]
  );

  const selectRun = useCallback(
    (id: string) => {
      selectedIdRef.current = id;
      setSelectedId(id);
      setHistoryMode('history');
      if (tab === 'settings') setTab('workspace');
    },
    [tab]
  );

  const handleCreate = useCallback(
    async (input: ExperimentInput) => {
      if (operationRef.current) return false;
      operationRef.current = 'Создание эксперимента';
      setOperation('Создание эксперимента');
      setNotice(null);
      try {
        let created: ExperimentRun | null = null;
        try {
          created = await api.create(input);
        } catch (error) {
          setNotice({ tone: 'error', text: `Создание эксперимента: ${errorMessage(error)}` });
          return false;
        }
        if (!created) return false;
        selectedIdRef.current = created.id;
        setSelectedId(created.id);
        try {
          await refresh();
        } catch {
          // The load error banner explains that state could not be refreshed.
        }
        selectedIdRef.current = created.id;
        setSelectedId(created.id);
        setHistoryMode('history');
        setTab('workspace');
        setNotice({
          tone: 'success',
          text: `Эксперимент «${created.title}» создан. Запуск не начат — сначала сформируйте план.`
        });
        return true;
      } finally {
        operationRef.current = null;
        setOperation(null);
      }
    },
    [api, refresh]
  );

  const handleRefresh = useCallback(async () => {
    setLoading(true);
    try {
      await refresh();
    } catch {
      // Exposed through loadError.
    } finally {
      setLoading(false);
    }
  }, [refresh]);

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % TABS.length;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + TABS.length) % TABS.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = TABS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    setTab(TABS[nextIndex].id);
    tabRefs.current[nextIndex]?.focus();
  };

  const selectedRun = snapshot?.runs.find((run) => run.id === selectedId) ?? null;
  const activeRun = snapshot?.runs.find((run) => run.id === snapshot.activeId) ?? null;
  const otherActive = Boolean(activeRun && selectedRun && activeRun.id !== selectedRun.id);
  const busy = operation !== null;
  const readyConnections = snapshot?.connections.filter((connection) => connection.state === 'ready').length ?? 0;
  const totalConnections = snapshot?.connections.length ?? 0;

  return (
    <div className="app-shell">
      <button
        type="button"
        className="skip-link"
        onClick={() => document.getElementById('main-content')?.focus()}
      >
        Перейти к содержимому
      </button>
      <header className="app-header">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">P2E</span>
          <span className="brand-text">
            <span className="brand-title">Paper2Experiment</span>
            <span className="brand-sub">исследовательский стенд</span>
          </span>
        </div>

        <nav className="tabbar" role="tablist" aria-label="Разделы приложения">
          {TABS.map((item, index) => (
            <button
              key={item.id}
              id={`tab-${item.id}`}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              aria-controls={`panel-${item.id}`}
              tabIndex={tab === item.id ? 0 : -1}
              className={`tab${tab === item.id ? ' is-active' : ''}`}
              title={`${item.label} (${item.shortcut})`}
              onClick={() => setTab(item.id)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="header-spacer" />

        {operation ? (
          <span className="operation-pill" role="status">
            <span className="spinner" aria-hidden="true" />
            <span>{operation}</span>
          </span>
        ) : activeRun ? (
          <button
            type="button"
            className="active-pill"
            onClick={() => {
              selectRun(activeRun.id);
              setTab('workspace');
            }}
            title={activeRun.title}
          >
            <span className="live-dot" aria-hidden="true" />
            <span className="active-pill-text">Активен: {activeRun.title}</span>
          </button>
        ) : null}

        <button
          type="button"
          className="conn-summary"
          onClick={() => setTab('settings')}
          aria-label={`Подключения: готово ${readyConnections} из ${totalConnections || 5}`}
          title="Открыть настройки подключений"
        >
          <span className="conn-dots" aria-hidden="true">
            {CONNECTION_ORDER.map((component) => {
              const connection = snapshot?.connections.find((item) => item.component === component);
              const tone = connectionTone(connection?.state);
              const stateLabel = connection
                ? CONNECTION_STATE_META[connection.state].label
                : 'Нет данных';
              return (
                <span
                  key={component}
                  className={`mini-dot tone-bg-${tone}`}
                  title={`${COMPONENT_META[component].label}: ${stateLabel}`}
                />
              );
            })}
          </span>
          <span className="conn-summary-text">
            {snapshot ? `${readyConnections}/${totalConnections || 5}` : 'Подключения'}
          </span>
        </button>

        <button
          type="button"
          className="header-icon-button"
          onClick={() => void handleRefresh()}
          disabled={loading}
          aria-label="Обновить состояние"
          title="Обновить состояние"
        >
          <RefreshIcon />
        </button>
      </header>

      {loadError ? (
        <div className="load-banner" role="alert">
          <AlertIcon />
          <span>{loadError}</span>
          <Button size="sm" variant="secondary" onClick={() => void handleRefresh()} loading={loading}>
            Повторить
          </Button>
        </div>
      ) : null}

      {notice ? (
        <Notice tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Notice>
      ) : null}

      <main className="app-main" id="main-content" tabIndex={-1}>
        <HistoryPanel
          api={api}
          snapshot={snapshot}
          loading={loading}
          loadError={loadError}
          selectedId={selectedId}
          mode={historyMode}
          busy={busy}
          onModeChange={setHistoryMode}
          onSelect={selectRun}
          onRefresh={() => void handleRefresh()}
          onCreate={handleCreate}
        />

        {tab === 'workspace' ? (
          <div
            className="workspace-grid"
            role="tabpanel"
            id="panel-workspace"
            aria-labelledby="tab-workspace"
          >
            <Workspace
              run={selectedRun}
              busy={busy}
              otherActive={otherActive}
              onPlan={(id) => perform('Формирование плана', () => api.plan(id), 'План сформирован.')}
              onSavePlan={(id: string, spec: ExperimentSpec) =>
                perform(
                  'Сохранение плана',
                  () => api.savePlan(id, spec),
                  'Новая версия плана сохранена.'
                )
              }
              onNewExperiment={() => {
                setHistoryMode('create');
                setTab('workspace');
              }}
            />
            <RunPanel
              run={selectedRun}
              events={events}
              eventsError={eventsError}
              activeRunTitle={activeRun && activeRun.id !== selectedRun?.id ? activeRun.title : null}
              otherActive={otherActive}
              busy={busy}
              onExecute={(id) =>
                perform('Запуск эксперимента', () => api.execute(id), 'Запуск инициирован.')
              }
              onApprove={(id) =>
                perform('Подтверждение оплаты', () => api.approve(id), 'Подтверждение отправлено.')
              }
              onCancel={(id) => perform('Отмена запуска', () => api.cancel(id), 'Команда отмены отправлена.')}
              onCleanup={(id) =>
                perform('Очистка', () => api.cleanup(id), 'Запрос очистки выполнен.')
              }
              onOpenResults={() => setTab('results')}
              onOpenSettings={() => setTab('settings')}
            />
          </div>
        ) : tab === 'results' ? (
          <div
            className="wide-panel"
            role="tabpanel"
            id="panel-results"
            aria-labelledby="tab-results"
          >
            <ResultsView
              run={selectedRun}
              busy={busy}
              otherActive={otherActive}
              onOpenFolder={(id) =>
                perform('Открытие папки', () => api.openFolder(id), 'Папка запуска открыта.')
              }
              onCleanup={(id) =>
                perform('Очистка', () => api.cleanup(id), 'Запрос очистки выполнен.')
              }
            />
          </div>
        ) : snapshot ? (
          <div
            className="wide-panel"
            role="tabpanel"
            id="panel-settings"
            aria-labelledby="tab-settings"
          >
            <SettingsView
              api={api}
              snapshot={snapshot}
              busy={busy}
              onSave={(settings: AppSettings) =>
                perform('Сохранение настроек', () => api.saveSettings(settings), 'Настройки сохранены.')
              }
              onRefresh={async () => {
                await refresh();
              }}
            />
          </div>
        ) : (
          <div
            className="wide-panel"
            role="tabpanel"
            id="panel-settings"
            aria-labelledby="tab-settings"
          >
            <div className="card center-empty">
              <EmptyState
                title={loading ? 'Загрузка настроек' : 'Настройки недоступны'}
                icon={loading ? undefined : <AlertIcon size={22} />}
                actions={
                  loading ? undefined : (
                    <Button variant="primary" onClick={() => void handleRefresh()}>
                      Повторить
                    </Button>
                  )
                }
              >
                {loading
                  ? 'Получаем состояние подключений из Electron.'
                  : loadError ?? 'Нативный мост не вернул состояние.'}
              </EmptyState>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
