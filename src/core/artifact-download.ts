import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ExperimentRun } from '../shared/types.js';

/** Remote downloads only expose the collected inventory, with digest + containment checks. */
export async function readArtifactDownload(run: ExperimentRun, relative: string) {
  const artifact = run.artifacts.find(item => item.path === relative);
  if (!artifact) throw new Error('Артефакт не зарегистрирован');
  const parts = relative.split('/');
  if (relative.includes('\\') || relative.includes('\0') || /^[A-Za-z]:/.test(relative) || parts.some(part => !part || part === '.' || part === '..')) throw new Error('Недопустимый путь');
  const limit = 64 * 1024 * 1024;
  if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || artifact.bytes > limit) throw new Error('Лимит скачивания — 64 MiB на файл');
  const root = await realpath(run.dir);
  let file = root;
  for (const part of parts) {
    file = path.join(file, part);
    if ((await lstat(file)).isSymbolicLink()) throw new Error('Скачивание symlink запрещено');
  }
  const canonical = await realpath(file);
  if (!canonical.startsWith(root + path.sep)) throw new Error('Файл вне каталога запуска');
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== artifact.bytes || stat.size > limit) throw new Error('Размер или тип файла изменён');
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      total += chunk.length;
      if (total > limit || total > artifact.bytes) throw new Error('Размер файла изменён');
      chunks.push(chunk);
    }
    const content = Buffer.concat(chunks);
    if (total !== artifact.bytes || createHash('sha256').update(content).digest('hex') !== artifact.sha256) throw new Error('SHA-256 артефакта не совпадает');
    return { name: path.basename(relative), base64: content.toString('base64') };
  } finally { await handle.close(); }
}
