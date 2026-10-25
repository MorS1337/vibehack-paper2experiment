import { useEffect, useMemo, useRef, useState } from 'react';
import type { ExperimentRun, ExperimentSpec } from '../../shared/types.js';
import { RUN_MODE_LABEL } from '../lib/labels.js';
import { SPEC_FIELDS, specFieldState, validateSpecText } from '../lib/spec.js';
import { BUSY_STATUSES, PLANNABLE_STATUSES } from '../lib/status.js';
import { AlertIcon, CheckIcon, InfoIcon, SaveIcon, WandIcon } from './icons.js';
import { Badge, Button } from './ui.js';

interface PlanEditorProps {
  run: ExperimentRun;
  busy: boolean;
  otherActive: boolean;
  onPlan: (id: string) => Promise<boolean>;
  onSavePlan: (id: string, spec: ExperimentSpec) => Promise<boolean>;
}

export function PlanEditor({ run, busy, otherActive, onPlan, onSavePlan }: PlanEditorProps) {
  const external = run.spec ? JSON.stringify(run.spec, null, 2) : '';
  const [text, setText] = useState(external);
  const [stale, setStale] = useState(false);
  const [saving, setSaving] = useState(false);
  const baseRef = useRef(external);
  const textRef = useRef(text);
  const externalRef = useRef(external);

  useEffect(() => {
    textRef.current = text;
  }, [text]);

  useEffect(() => {
    externalRef.current = external;
    if (external === baseRef.current) return;
    const wasDirty = textRef.current !== baseRef.current;
    baseRef.current = external;
    if (wasDirty && textRef.current !== external) {
      setStale(true);
    } else {
      setText(external);
      setStale(false);
    }
  }, [external]);

  const validation = useMemo(() => validateSpecText(text), [text]);
  const blankSpec = text.trim().length === 0;
  const rawVersion = validation.raw?.version;
  const parsedVersion =
    typeof rawVersion === 'number' && Number.isFinite(rawVersion) ? rawVersion : null;
  const nextPlanVersion = (run.planVersion || 0) + 1;

  const hasInstance = typeof run.instanceId === 'number' || Boolean(run.provisioningUncertain);
  const canPlan =
    PLANNABLE_STATUSES.includes(run.status) && !hasInstance && !otherActive && !busy;
  const canSave =
    PLANNABLE_STATUSES.includes(run.status) &&
    !busy &&
    !saving &&
    !blankSpec &&
    Boolean(run.source) &&
    !hasInstance &&
    !otherActive &&
    validation.valid &&
    Boolean(validation.value);

  const planDisabledReason = busy
    ? 'Дождитесь завершения текущего действия.'
    : hasInstance
      ? 'Сначала завершите аренду текущего инстанса.'
      : otherActive
        ? 'Активен другой эксперимент — дождитесь его завершения.'
        : run.status === 'completed'
        ? 'Запуск завершён; новый план создаётся для нового эксперимента.'
        : BUSY_STATUSES.includes(run.status)
          ? 'Идёт операция; план можно будет сформировать после завершения.'
          : 'Планирование недоступно в текущем статусе.';

  const saveDisabledReason = blankSpec
    ? 'Сначала сформируйте план или вставьте JSON.'
    : !validation.valid
      ? 'Исправьте JSON и ошибки схемы.'
      : !run.source
        ? 'Сначала импортируйте документ: без источника план не сохранить.'
        : hasInstance
          ? 'Сначала завершите аренду текущего инстанса.'
          : otherActive
            ? 'Активен другой эксперимент — дождитесь его завершения.'
            : run.status === 'completed'
              ? 'План завершённого запуска нельзя перезаписать.'
            : BUSY_STATUSES.includes(run.status) || run.status === 'awaiting_approval'
              ? 'Идёт выполнение или ожидается подтверждение.'
              : 'Сохранение недоступно.';

  const handleSave = async () => {
    if (!canSave || !validation.value) return;
    const submitted = text;
    const baseAtStart = baseRef.current;
    setSaving(true);
    try {
      const saved = await onSavePlan(run.id, validation.value);
      if (saved) {
        const canonical = externalRef.current;
        if (textRef.current === submitted || textRef.current === canonical) {
          if (canonical !== baseAtStart) { baseRef.current = canonical; textRef.current = canonical; setText(canonical); }
          else baseRef.current = submitted;
          setStale(false);
        } else setStale(true);
      }
    } finally {
      setSaving(false);
    }
  };

  const missingFields = validation.value?.missing ?? [];

  return (
    <section className="card plan-card" aria-labelledby="plan-heading">
      <div className="card-head">
        <div className="card-title-group">
          <h2 id="plan-heading">План эксперимента</h2>
          <div className="meta-row">
            <Badge tone={validation.valid ? 'success' : validation.raw ? 'warning' : 'neutral'}>
              {parsedVersion !== null ? `Спецификация v${parsedVersion}` : 'JSON ExperimentSpec'}
            </Badge>
            <span>Версия плана: {run.planVersion || 0}</span>
            {validation.valid ? (
              <span className="validation-ok">
                <CheckIcon size={13} /> Схема валидна
              </span>
            ) : null}
          </div>
        </div>
        <div className="card-actions">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void onPlan(run.id)}
            disabled={!canPlan}
            title={canPlan ? 'Сформировать план агентом' : planDisabledReason}
          >
            <WandIcon /> Сформировать план
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => void handleSave()}
            disabled={!canSave}
            loading={saving}
            title={canSave ? 'Сохранить новую версию плана' : saveDisabledReason}
          >
            <SaveIcon /> Сохранить версию
          </Button>
        </div>
      </div>

      <div className="task-block">
        <div className="task-label-row">
          <span className="field-label">Задача</span>
          <span className="meta-tag">{RUN_MODE_LABEL[run.input.mode]}</span>
        </div>
        <p className="task-text">{run.input.task || 'Задача не задана'}</p>
      </div>

      <div className="plan-body">
        {stale ? (
          <div className="inline-alert" role="status">
            <InfoIcon />
            <span>План обновлён в приложении. Ваши правки не перезаписаны.</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setText(external);
                baseRef.current = external;
                setStale(false);
              }}
            >
              Загрузить версию
            </Button>
          </div>
        ) : null}

        <div className="spec-workbench">
          <div className="spec-editor-wrap">
            <div className="spec-toolbar">
              <span className="toolbar-label">JSON-редактор</span>
              <div className="spec-toolbar-actions">
                <span className="editor-hint">⌘/Ctrl+S — сохранить</span>
              </div>
            </div>
            <textarea
              id="spec-editor"
              className={`spec-editor${validation.valid || blankSpec ? '' : ' is-invalid'}`}
              value={text}
              onChange={(event) => { textRef.current = event.target.value; setText(event.target.value); }}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                  event.preventDefault();
                  void handleSave();
                }
              }}
              placeholder={'{\n  "version": 1,\n  "title": "…"\n}'}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              aria-label="JSON ExperimentSpec"
              aria-describedby="spec-validation"
              aria-invalid={!validation.valid && !blankSpec}
            />
            <p className="editor-footer">
              {blankSpec
                ? 'Вставьте JSON вручную или сформируйте план агентом.'
                : validation.valid
                  ? `Валидный JSON · ${Object.keys(validation.raw ?? {}).length} полей. Сохранение создаст версию v${nextPlanVersion}.`
                  : 'Редактор не блокируется статусом «Готов к запуску». Проверьте схему перед сохранением.'}
            </p>
          </div>

          <aside className="validation-pane" id="spec-validation" aria-label="Проверка спецификации">
            <p className="visually-hidden" aria-live="polite">
              {validation.jsonError && !blankSpec
                ? 'JSON не разобран'
                : validation.issues.length > 0
                  ? `Ошибок схемы: ${validation.issues.length}`
                  : validation.valid
                    ? 'Схема валидна'
                    : ''}
            </p>
            {blankSpec ? (
              <div className="validation-block">
                <strong>
                  <InfoIcon size={13} /> План не сформирован
                </strong>
                <p>
                  Нажмите «Сформировать план» или вставьте полный JSON ExperimentSpec. Редактор
                  остаётся доступным.
                </p>
              </div>
            ) : null}

            {validation.jsonError && !blankSpec ? (
              <div className="validation-block is-danger">
                <strong>
                  <AlertIcon size={13} /> JSON не разобран
                </strong>
                <code>{validation.jsonError}</code>
              </div>
            ) : null}

            {validation.issues.length > 0 ? (
              <div className="validation-block is-danger">
                <strong>
                  <AlertIcon size={13} /> Ошибки схемы: {validation.issues.length}
                </strong>
                <ul className="issue-list">
                  {validation.issues.map((issue, index) => (
                    <li key={`${index}-${issue.path}`}>
                      <code>{issue.path}</code>
                      <span>{issue.message}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {validation.raw ? (
              <div className="field-checklist">
                <p className="pane-title">Обязательные поля</p>
                <div className="field-checks">
                  {SPEC_FIELDS.map((field) => {
                    const state = specFieldState(validation, field.key);
                    return (
                      <span
                        key={field.key}
                        className={`field-check is-${state}`}
                        title={state === 'missing' ? 'Поле отсутствует' : state === 'invalid' ? 'Ошибка в поле' : 'Поле заполнено'}
                      >
                        <span>{field.label}</span>
                        {state === 'present' ? <CheckIcon size={11} /> : <span aria-hidden="true">{state === 'missing' ? '—' : '!'}</span>}
                      </span>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {missingFields.length > 0 ? (
              <div className="validation-block is-warning">
                <strong>Пробелы в плане</strong>
                <div className="tag-list">
                  {missingFields.map((item, index) => (
                    <span className="tag" key={`${index}-${item}`}>
                      {item}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            {validation.valid ? (
              <div className="validation-block is-ok">
                <strong>
                  <CheckIcon size={13} /> Схема валидна
                </strong>
                <p>
                  {run.spec
                    ? `Сохранённая версия: v${run.spec.version}.`
                    : 'Спецификация ещё не сохранена.'}
                  {' '}Следующая версия при сохранении — v{nextPlanVersion}; номер присваивает
                  приложение, а лимиты фиксируются для исполнения.
                </p>
              </div>
            ) : null}

            {!canSave && !blankSpec ? <p className="field-hint">{saveDisabledReason}</p> : null}
          </aside>
        </div>
      </div>
    </section>
  );
}
