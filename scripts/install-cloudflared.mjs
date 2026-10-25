import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Official cloudflare/cloudflared release asset digests, pinned for reproducibility.
const version = '2026.10.3';
const assets = {
  'darwin-arm64': ['cloudflared-darwin-arm64.tgz', '1165d14b6f6360a3b8c283d7d1100024d6ec7cd9bc9e32519e96150645f3ec55'],
  'darwin-x64': ['cloudflared-darwin-amd64.tgz', '81b7b85f2376815c4f59b1aa323887b62e16ce8b67555c2e1577dc23f2a82000'],
  'linux-x64': ['cloudflared-linux-amd64', '053b80b0a23031a038fdbf3c073f59f82b8f1f152aa67971d7383ffafc0dbab0'],
  'linux-arm64': ['cloudflared-linux-arm64', '89297ebfb9e8c99c0dc013a1140601453cf3798d8306c5591651f4a3f5210be8']
};
const asset = assets[`${process.platform}-${process.arch}`];
if (!asset) throw new Error('Для этой платформы установите cloudflared самостоятельно и добавьте в PATH.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.tools');
const temporary = await mkdtemp(path.join(tmpdir(), 'paper2-cloudflared-'));
try {
  console.log(`Скачиваю официальный cloudflared ${version} (${asset[0]}) в .tools/ проекта`);
  const response = await fetch(`https://github.com/cloudflare/cloudflared/releases/download/${version}/${asset[0]}`, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`GitHub: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== asset[1]) throw new Error('SHA-256 загрузки не совпадает с официальным asset digest');
  const archive = path.join(temporary, asset[0]);
  await writeFile(archive, bytes);
  const binary = path.join(temporary, 'cloudflared');
  if (asset[0].endsWith('.tgz')) execFileSync('tar', ['-xzf', archive, '-C', temporary, 'cloudflared']);
  else await rename(archive, binary);
  await chmod(binary, 0o755);
  const executableHash = createHash('sha256').update(await readFile(binary)).digest('hex');
  await mkdir(root, { recursive: true });
  const staged = path.join(root, 'cloudflared.installing');
  await copyFile(binary, staged);
  await chmod(staged, 0o755);
  await rename(staged, path.join(root, 'cloudflared'));
  await writeFile(path.join(root, 'cloudflared.json'), JSON.stringify({ version, asset: asset[0], archiveSha256: asset[1], executableSha256: executableHash }, null, 2) + '\n');
  console.log('Готово. В приложении: «С телефона» → «Включить через HTTPS».');
} finally { await rm(temporary, { recursive: true, force: true }); }
