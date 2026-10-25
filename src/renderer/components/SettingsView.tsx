import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AppAPI, AppSettings, Snapshot } from '../../shared/types.js';
import { errorMessage } from '../lib/api.js';
import {
  COMPONENT_META,
  CONNECTION_ORDER,
  CONNECTION_STATE_META
} from '../lib/status.js';
import {
  AlertIcon,
  InfoIcon,
  LockIcon,
  RefreshIcon,
  SaveIcon,
  SettingsIcon
} from './icons.js';
import { Badge, Button, PathField, TextInput } from './ui.js';
import { PiLogin } from './PiLogin.js';

interface SettingsViewProps {
  api: AppAPI;
  snapshot: Snapshot;
  busy: boolean;
  onSave: (settings: AppSettings) => Promise<boolean>;
  onRefresh: () => Promise<void>;
}

export function SettingsView({ api, snapshot, busy, onSave, onRefresh }: SettingsViewProps) {
  const external = JSON.stringify(snapshot.settings);
  const [form, setForm] = useState<AppSettings>(snapshot.settings);
  const [stale, setStale] = useState(false);
  const [saving, setSaving] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const baseRef = useRef(external);
  const formRef = useRef(form);

  useEffect(() => {
    formRef.current = form;
  }, [form]);

  useEffect(() => {
    if (external === baseRef.current) return;
    const wasDirty = JSON.stringify(formRef.current) !== baseRef.current;
    baseRef.current = external;
    if (wasDirty) {
      setStale(true);
    } else {
      setForm(snapshot.settings);
      setStale(false);
    }
  }, [external, snapshot.settings]);

  const dirty = JSON.stringify(form) !== baseRef.current;
  const activeRun = snapshot.runs.find((run) => run.id === snapshot.activeId);
  const locked = Boolean(snapshot.activeId);

  const updateField = (key: keyof AppSettings, value: string) => {
    setForm((previous) => {
      const next = { ...previous };
      next[key] = value;
      return next;
    });
    setFormError(null);
  };

  const choose = async (kind: 'binary' | 'model' | 'key', key: keyof AppSettings) => {
    if (choosing || locked) return;
    setChoosing(true);
    setFormError(null);
    try {
      const chosen = await api.choose(kind);
      if (chosen) updateField(key, chosen);
    } catch (error) {
      setFormError(`Не удалось выбрать путь: ${errorMessage(error)}`);
    } finally {
      setChoosing(false);
    }
  };

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || saving || choosing || locked) return;
    setFormError(null);
    setSaving(true);
    const normalized: AppSettings = {
      piProvider: form.piProvider.trim(),
      piModel: form.piModel.trim(),
      python: form.python.trim(),
      whisperBinary: form.whisperBinary.trim(),
      whisperModel: form.whisperModel.trim(),
      sshKeyPath: form.sshKeyPath.trim()
    };
    if (!normalized.python || !normalized.whisperBinary) {
      setFormError('Python и бинарник Whisper обязательны для локальных операций.');
      setSaving(false);
      return;
    }
    try {
      const saved = await onSave(normalized);
      if (saved) {
        setForm(normalized);
        baseRef.current = JSON.stringify(normalized);
        setStale(false);
      } else {
        setFormError('Настройки не сохранены. Подробности — в уведомлении.');
      }
    } finally {
      setSaving(false);
    }
  };

  const refreshConnections = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setFormError(null);
    try {
      await onRefresh();
    } catch (error) {
      setFormError(`Не удалось обновить подключения: ${errorMessage(error)}`);
    } finally {
      setRefreshing(false);
    }
  };

  const loadExternalSettings = () => {
    setForm(snapshot.settings);
    baseRef.current = JSON.stringify(snapshot.settings);
    setStale(false);
    setFormError(null);
  };

  const readyCount = snapshot.connections.filter((connection) => connection.state === 'ready').length;
  const problemCount = CONNECTION_ORDER.filter(
    (component) =>
      snapshot.connections.find((connection) => connection.component === component)?.state !== 'ready'
  ).length;

  return (
    <div className="wide-view settings-view">
      <header className="card settings-header">
        <div className="card-title-group">
          <p className="eyebrow">Нативные интеграции</p>
          <h1>Подключения и настройки</h1>
          <p className="settings-lead">
            Компоненты проверяются независимо. Статус и подсказка приходят из Electron;
            интерфейс не подменяет результат проверки.
          </p>
        </div>
        <div className="connection-summary">
          <Badge tone={readyCount === CONNECTION_ORDER.length ? 'success' : readyCount > 0 ? 'warning' : 'danger'}>
            Готово: {readyCount} из {CONNECTION_ORDER.length}
          </Badge>
          {problemCount > 0 ? <span>{problemCount} требуют внимания</span> : null}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void refreshConnections()}
            loading={refreshing}
            disabled={busy}
          >
            <RefreshIcon /> Обновить статусы
          </Button>
        </div>
      </header>

      {formError ? (
        <div className="form-alert" role="alert">
          <AlertIcon />
          <div>
            <strong>Действие не выполнено</strong>
            <p>{formError}</p>
          </div>
        </div>
      ) : null}

      {locked && !busy ? (
        <div className="inline-alert is-warning settings-locked" role="status">
          <InfoIcon />
          <span>
            Настройки заблокированы, пока активен запуск
            {activeRun ? ` «${activeRun.title}»` : ''}. Сначала завершите или отмените его.
          </span>
        </div>
      ) : null}

      <section className="card integrations-card" aria-labelledby="integrations-heading">
        <div className="card-head">
          <div className="card-title-group">
            <h2 id="integrations-heading">Интеграции</h2>
            <p className="card-subtitle">Статусы и инструкции по устранению проблем</p>
          </div>
        </div>
        <div className="integration-grid">
          {CONNECTION_ORDER.map((component) => {
            const meta = COMPONENT_META[component];
            const connection = snapshot.connections.find((item) => item.component === component);
            const stateMeta = connection ? CONNECTION_STATE_META[connection.state] : null;
            return (
              <article
                key={component}
                className={`integration-card${connection ? ` is-${connection.state}` : ''}`}
              >
                <div className="integration-head">
                  <div>
                    <h3>{meta.label}</h3>
                    <p>{meta.purpose}</p>
                  </div>
                  <Badge tone={stateMeta?.tone ?? 'neutral'}>
                    {stateMeta?.label ?? 'Нет данных'}
                  </Badge>
                </div>
                <p className="integration-detail">
                  {!connection
                    ? 'Статус не получен от нативного моста.'
                    : connection.detail?.trim() ||
                      (connection.state === 'ready'
                        ? 'Компонент доступен; дополнительных указаний нет.'
                        : 'Нет подробностей. Проверьте инструкцию ниже.')}
                </p>
                <p className="integration-instruction">{meta.instruction}</p>
              </article>
            );
          })}
        </div>
      </section>
      {api.remote ? <div className="quiet-banner">Provider credentials are managed on the desktop. Configured models remain available here.</div> : (
      <PiLogin
        api={api}
        disabled={busy || locked}
        onConnected={(provider, model) => { updateField('piProvider', provider); updateField('piModel', model); }}
        onRefresh={onRefresh}
      />
      )}


      <form className="card settings-form" onSubmit={handleSave}>
        <div className="card-head">
          <div className="card-title-group">
            <h2>Параметры приложения</h2>
            <p className="card-subtitle">Только пути и идентификаторы. Секреты сюда не входят.</p>
          </div>
          <div className="settings-form-state">
            {dirty ? <Badge tone="warning">Есть изменения</Badge> : <Badge tone="neutral">Сохранено</Badge>}
          </div>
        </div>

        {stale ? (
          <div className="inline-alert is-warning settings-stale" role="status">
            <InfoIcon />
            <span>Настройки обновились в приложении. Ваши правки сохранены локально.</span>
            <Button size="sm" variant="ghost" onClick={loadExternalSettings}>
              Загрузить новые
            </Button>
          </div>
        ) : null}

        <div className="security-note" role="note">
          <LockIcon />
          <div>
            <strong>Ключи не хранятся в настройках</strong>
            <p>
              Вход в Pi доступен выше; секрет передаётся только штатному потоку авторизации и хранится в Pi.
              Остальные интеграции используют CLI и переменные окружения. Настройки эксперимента не содержат ключей.
            </p>
          </div>
        </div>

        <div className="settings-body">
          <fieldset className="form-section">
            <legend>
              <SettingsIcon size={14} /> Pi
            </legend>
            <div className="form-grid">
              <TextInput
                id="pi-provider"
                label="Провайдер"
                value={form.piProvider}
                onChange={(event) => updateField('piProvider', event.target.value)}
                placeholder="например, anthropic"
                disabled={busy || saving || locked}
                spellCheck={false}
                hint="Идентификатор провайдера Pi, не ключ."
              />
              <TextInput
                id="pi-model"
                label="Модель Pi"
                value={form.piModel}
                onChange={(event) => updateField('piModel', event.target.value)}
                placeholder="например, claude-sonnet-4-5"
                disabled={busy || saving || locked}
                spellCheck={false}
                hint="Планирование и реализация."
              />
            </div>
          </fieldset>

          <fieldset className="form-section">
            <legend>Локальное окружение</legend>
            <PathField
              id="python-path"
              label="Python"
              value={form.python}
              onChange={(value) => updateField('python', value)}
              onChoose={() => void choose('binary', 'python')}
              chooseLabel={choosing ? 'Открыт выбор…' : 'Выбрать бинарник'}
              placeholder="/usr/bin/python3"
              hint="Интерпретатор для локальных экспериментов."
              disabled={busy || saving || choosing || locked}
            />
          </fieldset>

          <fieldset className="form-section">
            <legend>Голосовой ввод</legend>
            <PathField
              id="whisper-binary"
              label="Бинарник Whisper"
              value={form.whisperBinary}
              onChange={(value) => updateField('whisperBinary', value)}
              onChoose={() => void choose('binary', 'whisperBinary')}
              chooseLabel={choosing ? 'Открыт выбор…' : 'Выбрать бинарник'}
              placeholder="/usr/local/bin/whisper"
              hint="Единственный источник распознавания речи."
              disabled={busy || saving || choosing || locked}
            />
            <PathField
              id="whisper-model"
              label="Файл модели Whisper"
              value={form.whisperModel}
              onChange={(value) => updateField('whisperModel', value)}
              onChoose={() => void choose('model', 'whisperModel')}
              chooseLabel={choosing ? 'Открыт выбор…' : 'Выбрать модель'}
              placeholder="/путь/к/model.bin"
              hint="Локальная модель; запись обрабатывается на этом компьютере."
              disabled={busy || saving || choosing || locked}
            />
          </fieldset>

          <fieldset className="form-section">
            <legend>Удалённый доступ</legend>
            <PathField
              id="ssh-key"
              label="SSH-ключ для Vast.ai"
              value={form.sshKeyPath}
              onChange={(value) => updateField('sshKeyPath', value)}
              onChoose={() => void choose('key', 'sshKeyPath')}
              chooseLabel={choosing ? 'Открыт выбор…' : 'Выбрать ключ'}
              placeholder="~/.ssh/id_ed25519"
              hint="Хранится только путь. Содержимое ключа не читается интерфейсом."
              disabled={busy || saving || choosing || locked}
            />
          </fieldset>
        </div>

        <div className="settings-actions">
          <Button
            size="sm"
            variant="ghost"
            onClick={loadExternalSettings}
            disabled={!dirty || busy || saving || choosing || locked}
          >
            Сбросить
          </Button>
          <span className="settings-save-hint">
            Изменения применяются после сохранения. Ключи сюда не входят.
          </span>
          <Button
            type="submit"
            variant="primary"
            loading={saving}
            disabled={busy || !dirty || choosing || locked}
            title={dirty ? 'Сохранить безопасные настройки' : 'Нет изменений'}
          >
            <SaveIcon /> Сохранить настройки
          </Button>
        </div>
      </form>
    </div>
  );
}
