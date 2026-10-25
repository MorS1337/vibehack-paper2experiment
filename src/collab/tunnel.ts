import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** cloudflared is optional and stays a child of this app; no account/service setup. */
export async function startTunnel(port: number, projectRoot = process.cwd(), signal?: AbortSignal) {
  signal?.throwIfAborted();
  const local = path.join(projectRoot, '.tools', 'cloudflared');
  const binary = process.env.PAPER2_CLOUDFLARED || (existsSync(local) ? local : 'cloudflared');
  const child = spawn(binary, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], { stdio: ['ignore', 'ignore', 'pipe'], signal });
  let stopping = false;
  let tail = '';
  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => { reject(new Error('Cloudflare не выдал ссылку за 30 секунд')); }, 30_000);
    const finish = (error?: Error, link?: string) => { clearTimeout(timeout); if (error) reject(error); else resolve(link!); };
    child.once('error', () => finish(new Error(signal?.aborted ? 'Настройка HTTPS отменена' : 'Не найден cloudflared. Выполните npm run collab:setup в проекте. Для Wi-Fi туннель не нужен.')));
    child.once('exit', () => finish(new Error('HTTPS-туннель завершился до подключения')));
    child.stderr!.on('data', chunk => {
      tail = (tail + String(chunk)).slice(-8000);
      const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/.exec(tail);
      if (match) finish(undefined, match[0]);
    });
  }).catch(error => { stopping = true; child.kill(); throw error; });
  return { url, alive: () => !stopping && child.exitCode === null && child.signalCode === null, close: () => { stopping = true; child.kill(); } };
}
