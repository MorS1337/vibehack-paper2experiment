import type { RunStatus } from '../../shared/types.js';
import { STATUS_META } from '../lib/status.js';
import { Badge, Dot } from './ui.js';

export function StatusBadge({ status, subtle = false }: { status: RunStatus; subtle?: boolean }) {
  const meta = STATUS_META[status];
  return (
    <Badge tone={meta.tone} className={`status-badge${subtle ? ' is-subtle' : ''}`}>
      <Dot tone={meta.tone} pulse={meta.tone === 'active'} />
      {meta.label}
    </Badge>
  );
}
