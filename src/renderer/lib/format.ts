const relativeFormatter = new Intl.RelativeTimeFormat('ru', { numeric: 'auto', style: 'short' });
const dateTimeFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit'
});
const clockFormatter = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
});
const metricFormatter = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 6 });
const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 6
});
const hoursFormatter = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const bytesFormatter = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const percentFormatter = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const BYTE_UNITS = ['КБ', 'МБ', 'ГБ', 'ТБ'];

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return dateTimeFormatter.format(date);
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const seconds = (date.getTime() - Date.now()) / 1000;
  const absolute = Math.abs(seconds);
  if (absolute < 45) return 'только что';
  if (absolute < 3600) return relativeFormatter.format(Math.round(seconds / 60), 'minute');
  if (absolute < 86400) return relativeFormatter.format(Math.round(seconds / 3600), 'hour');
  if (absolute < 86400 * 30) return relativeFormatter.format(Math.round(seconds / 86400), 'day');
  return dateTimeFormatter.format(date);
}

export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return clockFormatter.format(date);
}

export function formatUSD(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return usdFormatter.format(value);
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—';
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const rest = rounded % 60;
  if (hours > 0) return minutes > 0 ? `${hours} ч ${minutes} мин` : `${hours} ч`;
  if (minutes > 0) return rest > 0 ? `${minutes} мин ${rest} с` : `${minutes} мин`;
  return `${rest} с`;
}

export function formatHours(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '—';
  const hours = seconds / 3600;
  return `${hoursFormatter.format(hours)} ч`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} Б`;
  let value = bytes / 1024;
  let unit = BYTE_UNITS[0];
  for (let index = 1; index < BYTE_UNITS.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = BYTE_UNITS[index];
  }
  return `${bytesFormatter.format(value)} ${unit}`;
}

export function formatMetric(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const absolute = Math.abs(value);
  if (absolute !== 0 && (absolute >= 10_000_000 || absolute < 0.0001)) {
    return value.toExponential(4).replace('.', ',');
  }
  return metricFormatter.format(value);
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${percentFormatter.format(value * 100)} %`;
}

export function shortHash(hash: string | null | undefined): string {
  if (!hash) return '—';
  return hash.length > 14 ? `${hash.slice(0, 12)}…` : hash;
}
