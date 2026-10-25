import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { readFile, realpath, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { collabLink } from '../shared/collab-link.js';
import type { CollabStatus, ConversationUpdate, RunEvent } from '../shared/types.js';

const READ_METHODS = new Set(['snapshot', 'events', 'conversation', 'artifactPreview', 'downloadArtifact', 'piProviders']);
const WRITE_METHODS = new Set(['create', 'plan', 'savePlan', 'execute', 'approve', 'cancel', 'cleanup', 'saveSettings', 'transcribe', 'importPaper', 'setBrief', 'sendMessage', 'cancelTranscription']);
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const MAX_BODY = 4 * 1024 * 1024;
const MAX_PDF = 25 * 1024 * 1024;

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
async function body(request: IncomingMessage, limit: number): Promise<Buffer> {
  if (Number(request.headers['content-length'] ?? 0) > limit) throw new HttpError(413, 'Файл или запрос превышает лимит');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Файл или запрос превышает лимит');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}
function equal(actual: string, expected: string): boolean {
  const bytes = Buffer.from(actual);
  const secret = Buffer.from(expected);
  return bytes.length === secret.length && timingSafeEqual(bytes, secret);
}

export interface CollabServerOptions {
  rendererRoot: string;
  uploadRoot: string;
  request(method: string, ...args: unknown[]): Promise<unknown>;
  host?: string;
  port?: number;
  lifetimeMs?: number;
}

/** One desktop harness owns all work. This server only adapts its existing RPC. */
export async function startCollabServer(options: CollabServerOptions) {
  const control = randomBytes(32).toString('base64url');
  const view = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + (options.lifetimeMs ?? 12 * 60 * 60 * 1000);
  const polls = new Set<() => void>();
  let sequence = 0;
  const history: { sequence: number; event?: RunEvent; conversation?: ConversationUpdate; bytes: number }[] = [];
  let historyBytes = 0;
  const publish = (event?: RunEvent, conversation?: ConversationUpdate) => {
    const bytes = Buffer.byteLength(JSON.stringify({ event, conversation }));
    history.push({ sequence: ++sequence, event, conversation, bytes }); historyBytes += bytes;
    while (history.length > 500 || historyBytes > 8 * 1024 * 1024) historyBytes -= history.shift()!.bytes;
    for (const flush of [...polls]) flush();
  };
  const rendererRoot = await realpath(options.rendererRoot);
  let closed = false;
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (!url.pathname.startsWith('/api/')) {
        if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'Метод не поддерживается');
        const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
        const candidate = path.resolve(rendererRoot, '.' + relative);
        if (!candidate.startsWith(rendererRoot + path.sep)) throw new HttpError(403, 'Недопустимый путь');
        let file: string;
        try { file = await realpath(candidate); } catch { throw new HttpError(404, 'Файл не найден'); }
        if (!file.startsWith(rendererRoot + path.sep) || !MIME[path.extname(file)]) throw new HttpError(403, 'Файл недоступен');
        const content = await readFile(file);
        response.writeHead(200, { 'Content-Type': MIME[path.extname(file)] });
        response.end(request.method === 'HEAD' ? undefined : content);
        return;
      }
      // No CORS. A link's token travels only in Authorization, never URLs/logs.
      const origin = request.headers.origin;
      if (origin && new URL(origin).host !== request.headers.host) throw new HttpError(403, 'Недоверенный origin');
      if (closed || Date.now() >= expiresAt) throw new HttpError(401, 'Ссылка истекла. Создайте новую на компьютере.');
      const token = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const access = equal(token, control) ? 'control' : equal(token, view) ? 'view' : null;
      if (!access) throw new HttpError(401, 'Ссылка недействительна. Откройте ссылку или QR с компьютера.');
      if (url.pathname === '/api/session' && request.method === 'GET') {
        json(response, 200, { access, expiresAt: new Date(expiresAt).toISOString() }); return;
      }
      if (url.pathname.startsWith('/api/paper/') && request.method === 'GET') {
        const id = url.pathname.slice('/api/paper/'.length);
        if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id)) throw new HttpError(400, 'Invalid paper ID');
        // The harness verifies this path against the imported source and its SHA-256.
        const file = await options.request('sourcePdfPath', id);
        const content = await readFile(String(file));
        if (content.length > 40 * 1024 * 1024) throw new HttpError(413, 'Paper exceeds 40 MiB');
        response.writeHead(200, { 'Content-Type': 'application/pdf' }); response.end(content); return;
      }
      if (url.pathname === '/api/events' && request.method === 'GET') {
        if (polls.size >= 16) throw new HttpError(429, 'Слишком много подключений');
        const cursorText = url.searchParams.get('cursor');
        if (cursorText !== null && !/^\d{1,15}$/.test(cursorText)) throw new HttpError(400, 'Некорректный курсор');
        const cursor = cursorText === null ? null : Number(cursorText);
        let timer: NodeJS.Timeout | undefined;
        const flush = () => {
          if (timer) clearTimeout(timer);
          polls.delete(flush);
          if (closed || Date.now() >= expiresAt) { json(response, 401, { error: 'Ссылка отозвана или истекла' }); return; }
          const items = history.filter(item => cursor !== null && item.sequence > cursor);
          const sync = cursor === null || cursor > sequence || cursor < (history[0]?.sequence ?? sequence) - 1 || items.some(item => !item.event && !item.conversation);
          json(response, 200, { cursor: sequence, sync, events: items.flatMap(item => item.event ? [item.event] : []), conversations: items.flatMap(item => item.conversation ? [item.conversation] : []) });
        };
        if (cursor === null || cursor !== sequence) flush();
        else {
          polls.add(flush);
          timer = setTimeout(flush, Math.max(1, Math.min(20_000, expiresAt - Date.now())));
          response.on('close', () => { if (timer) clearTimeout(timer); polls.delete(flush); });
        }
        return;
      }
      if (url.pathname === '/api/upload' && request.method === 'POST') {
        if (access !== 'control') throw new HttpError(403, 'Эта ссылка разрешает только просмотр');
        const content = await body(request, MAX_PDF);
        if (content.subarray(0, 5).toString() !== '%PDF-') throw new HttpError(400, 'Нужен PDF-файл');
        await mkdir(options.uploadRoot, { recursive: true, mode: 0o700 });
        const file = path.join(options.uploadRoot, `${randomBytes(16).toString('hex')}.pdf`);
        await writeFile(file, content, { mode: 0o600, flag: 'wx' });
        json(response, 200, { path: file }); return;
      }
      if (url.pathname !== '/api/rpc' || request.method !== 'POST') throw new HttpError(404, 'Неизвестная операция');
      if (!request.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Нужен application/json');
      let data: { method?: unknown; args?: unknown };
      try { data = JSON.parse((await body(request, MAX_BODY)).toString()); }
      catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'Некорректный JSON'); }
      if (!data || typeof data.method !== 'string' || !Array.isArray(data.args) || data.args.length > 4) throw new HttpError(400, 'Некорректный RPC');
      if (!READ_METHODS.has(data.method) && !WRITE_METHODS.has(data.method)) throw new HttpError(404, 'Неизвестная операция');
      if (WRITE_METHODS.has(data.method) && access !== 'control') throw new HttpError(403, 'Эта ссылка разрешает только просмотр');
      if (data.method === 'transcribe') {
        if (typeof data.args[0] !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.args[0]) || data.args[0].length > 2_666_668) throw new HttpError(400, 'Недопустимая запись');
        const bytes = Buffer.from(data.args[0], 'base64');
        data.args[0] = Uint8Array.from(bytes).buffer;
      }
      const result = await options.request(data.method, ...data.args);
      if (WRITE_METHODS.has(data.method)) publish();
      json(response, 200, { result });
    } catch (error) {
      if (!response.headersSent) json(response, error instanceof HttpError ? error.status : 400, { error: error instanceof Error ? error.message : 'Ошибка запроса' });
      else response.end();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4317, options.host ?? '0.0.0.0', () => { server.off('error', reject); resolve(); });
  });
  const port = (server.address() as { port: number }).port;
  return {
    port,
    status(publicOrigin?: string): CollabStatus {
      if (closed || Date.now() >= expiresAt) return { running: false, links: [] };
      const interfaces = Object.entries(networkInterfaces());
      const physical = interfaces.filter(([name]) => /^(en\d|eth\d|wlan\d|wl\w|Wi-Fi|Ethernet)/i.test(name));
      const origins = publicOrigin ? [publicOrigin] : [...new Set((physical.length ? physical : interfaces).flatMap(([, items]) => (items ?? []).filter(item => item.family === 'IPv4' && !item.internal).map(item => `http://${item.address}:${port}`)))];
      return { running: true, port, expiresAt: new Date(expiresAt).toISOString(), links: origins.map(origin => ({ origin, control: collabLink(origin, control), view: collabLink(origin, view) })) };
    },
    publish(event: RunEvent): void {
      publish(event);
    },
    publishConversation(update: ConversationUpdate): void { publish(undefined, update); },
    async close(): Promise<void> {
      closed = true;
      for (const flush of [...polls]) flush();
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    }
  };
}
