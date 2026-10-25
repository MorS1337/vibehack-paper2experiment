import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { runProcess, runProcessToFile } from './process.js';

export interface ExportRecord {
  path: string;
  sha256: string;
}

const EXPORT_MEMBER = /^(?:artifacts/(?:[A-Za-z0-9._-]+/)*[A-Za-z0-9._-]+|stdout\.log|stderr\.log)$/;
const INVENTORY_FILE = '.p2e-artifacts.sha256';

/** Rejects anything that could escape project/ during member extraction. */
export function validateExportPath(member: string): string {
  const segments = member.split('/');
  if (!EXPORT_MEMBER.test(member) || segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Недопустимый путь экспорта: ${member}`);
  }
  return member;
}

function unescapeHashName(value: string): string {
  return value.replace(/\\(.)/g, (_, character: string) => {
    if (character === 'n') return '\n';
    if (character === 'r') return '\r';
    if (character === '\\') return '\\';
    return `\\${character}`;
  });
}

/**
 * Parses GNU sha256sum output. Escaped names (leading backslash) are decoded only
 * to reject unsafe/control paths rather than silently omitting remote outputs.
 */
export function parseExportInventory(text: string): ExportRecord[] {
  const records: ExportRecord[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line) continue;
    const escaped = line.startsWith('\\');
    const body = escaped ? line.slice(1) : line;
    const match = /^([0-9a-f]{64}) [ *](.*)$/.exec(body);
    if (!match) throw new Error(`Некорректная строка инвентаризации экспорта: ${line.slice(0, 240)}`);
    const member = validateExportPath(escaped ? unescapeHashName(match[2]) : match[2]);
    if (seen.has(member)) throw new Error(`Повторяющийся путь в инвентаризации: ${member}`);
    seen.add(member);
    records.push({ path: member, sha256: match[1] });
  }
  return records;
}

export async function readTarMemberText(archive: string, member: string, timeoutMs = 30_000): Promise<string> {
  if (member.startsWith('-')) throw new Error(`Недопустимый member архива: ${member}`);
  const result = await runProcess('tar', ['-xOzf', archive, member], { timeoutMs, env: undefined, captureLimit: 8 * 1024 * 1024 });
  if (result.exitCode !== 0) throw new Error(`Не удалось прочитать ${member} из архива экспорта: ${result.stderr.slice(-1000)}`);
  return result.stdout;
}

export async function extractVerifiedTarMember(archive: string, member: string, destination: string, expectedSha256: string, maxBytes: number): Promise<number> {
  validateExportPath(member);
  const result = await runProcessToFile('tar', ['-xOzf', archive, member], destination, {
    timeoutMs: 120_000,
    maxBytes
  });
  if (result.sha256 !== expectedSha256) {
    throw new Error(`SHA256 не совпал для ${member}: ожидался ${expectedSha256}, получен ${result.sha256}`);
  }
  return result.bytes;
}

export async function hashFile(file: string, maxBytes = 512 * 1024 * 1024): Promise<{ sha256: string; bytes: number }> {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (info.size > maxBytes) throw new Error(`Файл экспорта превышает лимит: ${file}`);
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    for (;;) {
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;
      if (bytes > maxBytes) throw new Error(`Файл экспорта превышает лимит: ${file}`);
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    return { sha256: hash.digest('hex'), bytes };
  } finally {
    await handle.close();
  }
}

export const EXPORT_INVENTORY_FILE = INVENTORY_FILE;
