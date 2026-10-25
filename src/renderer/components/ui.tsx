import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes
} from 'react';
import type { Tone } from '../lib/tone.js';
import { AlertIcon, CheckIcon, CopyIcon, FolderIcon, InfoIcon } from './icons.js';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'md' | 'sm' | 'icon';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  disabled,
  className = '',
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`btn btn-${variant} btn-${size} ${className}`.trim()}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

interface BadgeProps {
  tone?: Tone;
  children: ReactNode;
  title?: string;
  className?: string;
}

export function Badge({ tone = 'neutral', children, title, className = '' }: BadgeProps) {
  return (
    <span className={`badge tone-${tone} ${className}`.trim()} title={title}>
      {children}
    </span>
  );
}

export function Dot({ tone = 'neutral', pulse = false }: { tone?: Tone; pulse?: boolean }) {
  return <span className={`status-dot tone-${tone}${pulse ? ' is-pulsing' : ''}`} aria-hidden="true" />;
}

interface FieldProps {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  children: ReactNode;
  className?: string;
}

export function Field({ label, htmlFor, hint, error, required, children, className = '' }: FieldProps) {
  const hintId = htmlFor ? `${htmlFor}-hint` : undefined;
  const errorId = htmlFor ? `${htmlFor}-error` : undefined;
  return (
    <div className={`field ${className}`.trim()}>
      <label className="field-label" htmlFor={htmlFor}>
        {label}
        {required ? (
          <span className="field-required" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {children}
      {error ? (
        <p className="field-error" id={errorId}>
          {error}
        </p>
      ) : hint ? (
        <p className="field-hint" id={hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
}

export function TextInput({ label, hint, error, id, required, className = '', ...rest }: TextInputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  return (
    <Field label={label} htmlFor={inputId} hint={hint} error={error} required={required} className={className}>
      <input
        id={inputId}
        className="input"
        aria-invalid={error ? true : undefined}
        aria-describedby={errorId ?? hintId}
        required={required}
        {...rest}
      />
    </Field>
  );
}

interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
}

export function TextArea({ label, hint, error, id, required, className = '', ...rest }: TextAreaProps) {
  const generatedId = useId();
  const areaId = id ?? generatedId;
  const hintId = hint ? `${areaId}-hint` : undefined;
  const errorId = error ? `${areaId}-error` : undefined;
  const area = (
    <textarea
      id={areaId}
      className={`textarea ${className}`.trim()}
      aria-invalid={error ? true : undefined}
      aria-describedby={errorId ?? hintId}
      required={required}
      {...rest}
    />
  );
  if (!label) return area;
  return (
    <Field label={label} htmlFor={areaId} hint={hint} error={error} required={required}>
      {area}
    </Field>
  );
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
}

export function Select({ label, hint, error, id, children, className = '', ...rest }: SelectProps) {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  const select = (
    <select id={selectId} className={`select ${className}`.trim()} aria-invalid={error ? true : undefined} {...rest}>
      {children}
    </select>
  );
  if (!label) return select;
  return (
    <Field label={label} htmlFor={selectId} hint={hint} error={error}>
      {select}
    </Field>
  );
}

interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
}

interface SegmentedProps<T extends string> {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false
}: SegmentedProps<T>) {
  return (
    <div className="segmented" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`segmented-option${value === option.value ? ' is-selected' : ''}`}
          aria-pressed={value === option.value}
          title={option.title}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

interface PathFieldProps {
  id: string;
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  onChoose: () => void;
  chooseLabel?: string;
  placeholder?: string;
  hint?: ReactNode;
  error?: ReactNode;
  disabled?: boolean;
  required?: boolean;
}

export function PathField({
  id,
  label,
  value,
  onChange,
  onChoose,
  chooseLabel = 'Выбрать',
  placeholder,
  hint,
  error,
  disabled,
  required
}: PathFieldProps) {
  return (
    <Field label={label} htmlFor={id} hint={hint} error={error} required={required}>
      <div className="path-row">
        <input
          id={id}
          className="input path-input"
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
          disabled={disabled}
          required={required}
          spellCheck={false}
          title={value}
        />
        <Button
          size="icon"
          variant="secondary"
          onClick={onChoose}
          disabled={disabled}
          aria-label={`${chooseLabel}: ${String(label)}`}
          title={chooseLabel}
        >
          <FolderIcon />
        </Button>
      </div>
      {value ? <p className="path-display" title={value}>{value}</p> : null}
    </Field>
  );
}

interface NoticeProps {
  tone: 'error' | 'success' | 'info';
  children: ReactNode;
  onDismiss?: () => void;
}

export function Notice({ tone, children, onDismiss }: NoticeProps) {
  return (
    <div className={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <span className="notice-icon" aria-hidden="true">
        {tone === 'success' ? <CheckIcon /> : tone === 'error' ? <AlertIcon /> : <InfoIcon />}
      </span>
      <div className="notice-body">{children}</div>
      {onDismiss ? (
        <button type="button" className="btn btn-ghost btn-icon notice-dismiss" onClick={onDismiss} aria-label="Закрыть уведомление">
          ×
        </button>
      ) : null}
    </div>
  );
}

interface EmptyStateProps {
  title: string;
  icon?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
}

export function EmptyState({ title, icon, children, actions, compact = false }: EmptyStateProps) {
  return (
    <div className={`empty-state${compact ? ' is-compact' : ''}`}>
      {icon ? <div className="empty-icon">{icon}</div> : null}
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {actions ? <div className="empty-actions">{actions}</div> : null}
    </div>
  );
}

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', 'true');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  if (!copied) throw new Error('Буфер обмена недоступен');
}

export function CopyButton({ text, label = 'Копировать', size = 'sm' }: { text: string; label?: string; size?: ButtonSize }) {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle');
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = async () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    try {
      await writeClipboard(text);
      setState('copied');
    } catch {
      setState('error');
    }
    timerRef.current = window.setTimeout(() => setState('idle'), 1800);
  };

  return (
    <Button
      size={size}
      variant="ghost"
      onClick={handleCopy}
      title={state === 'error' ? 'Не удалось скопировать' : label}
      aria-label={state === 'error' ? 'Не удалось скопировать' : label}
    >
      {state === 'copied' ? <CheckIcon /> : <CopyIcon />}
      <span>{state === 'copied' ? 'Скопировано' : state === 'error' ? 'Ошибка' : label}</span>
    </Button>
  );
}
