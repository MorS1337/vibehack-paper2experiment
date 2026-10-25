import { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, session, systemPreferences, utilityProcess } from 'electron';
import type { UtilityProcess, IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startCollabServer } from '../collab/server.js';
import { startTunnel } from '../collab/tunnel.js';
import QRCode from 'qrcode';
import type { CollabStatus } from '../shared/types.js';
import { mkdirSync } from 'node:fs';

app.setName("Methodiy AI");
// Product identity may change; the existing research and Chromium profile must not.
const userData = path.join(app.getPath("appData"), "paper2experiment");
mkdirSync(userData, { recursive: true, mode: 0o700 });
app.setPath("userData", userData);
protocol.registerSchemesAsPrivileged([
  {
    scheme: "paper2",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);
if (!app.requestSingleInstanceLock()) app.exit(0);
let window: BrowserWindow | undefined;
let worker: UtilityProcess;
let workerExited = false;
let quitting = false;
let sequence = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
let collab: Awaited<ReturnType<typeof startCollabServer>> | undefined;
let tunnel: Awaited<ReturnType<typeof startTunnel>> | undefined;
let changingCollab = false;
let collabController: AbortController | undefined;
async function collabStatus(): Promise<CollabStatus> {
  const status = collab?.status(tunnel?.alive() ? tunnel.url : undefined) ?? { running: false, links: [] };
  return { ...status, tunnel: !!tunnel?.alive(), warning: tunnel && !tunnel.alive() ? 'HTTPS-туннель отключился. Перезапустите доступ.' : undefined,
    qr: await Promise.all(status.links.map(async link => ({ control: await QRCode.toDataURL(link.control, { width: 256, margin: 2 }), view: await QRCode.toDataURL(link.view, { width: 256, margin: 2 }) }))) };
}
async function stopCollab(): Promise<void> {
  collabController?.abort(); collabController = undefined;
  tunnel?.close(); tunnel = undefined;
  const previous = collab; collab = undefined;
  await previous?.close();
}
async function startCollab(useTunnel = false): Promise<CollabStatus> {
  if (quitting) throw new Error('Приложение закрывается');
  if (changingCollab) throw new Error('Подождите завершения настройки доступа');
  changingCollab = true;
  try {
    if (collab?.status().running) return await collabStatus();
    if (collab) await stopCollab();
    const controller = new AbortController(); collabController = controller;
    collab = await startCollabServer({ rendererRoot: path.join(app.getAppPath(), 'dist', 'renderer'), port: process.env.PAPER2_COLLAB_PORT ? Number(process.env.PAPER2_COLLAB_PORT) : undefined, uploadRoot: path.join(app.getPath('temp'), 'paper2-uploads'), request, host: useTunnel ? '127.0.0.1' : '0.0.0.0' });
    if (controller.signal.aborted) { await stopCollab(); controller.signal.throwIfAborted(); }
    if (useTunnel) tunnel = await startTunnel(collab.port, app.getAppPath(), controller.signal);
    return await collabStatus();
  } catch (error) { await stopCollab(); throw error; }
  finally { changingCollab = false; }
}
function request(method: string, ...args: unknown[]): Promise<unknown> {
  if (workerExited)
    return Promise.reject(
      new Error("Ядро недоступно; перезапустите приложение"),
    );
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  worker.postMessage({ id, method, args });
  return promise;
}
function checkSender(event: IpcMainInvokeEvent): void {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    !event.senderFrame.url.startsWith("paper2://app/")
  )
    throw new Error("Недоверенный IPC sender");
}
app.on('second-instance', (_event, argv) => {
  window?.show(); window?.focus();
  if (argv.includes('--collab')) void startCollab(argv.includes('--collab-tunnel')).catch(error => dialog.showErrorBox('Collab', String(error)));
});
void app.whenReady().then(async () => {
const rendererRoot = path.join(app.getAppPath(), 'dist', 'renderer');
const icon = path.join(rendererRoot, 'methodiy-icon.png');
if (process.platform === 'darwin') app.dock?.setIcon(icon);
protocol.handle('paper2', async incoming => {
  const url = new URL(incoming.url);
  if (url.hostname !== 'app') return new Response('Forbidden', { status: 403 });
  const paper = url.pathname.match(/^\/paper\/([a-f0-9-]{36})\.pdf$/);
  if (paper) {
    try {
      const source = await request('sourcePdfPath', paper[1]);
      const response = await net.fetch(pathToFileURL(String(source)).toString());
      return new Response(response.body, { status: response.status, headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'private, max-age=0, must-revalidate', 'X-Content-Type-Options': 'nosniff' } });
    } catch { return new Response('Imported paper is unavailable or failed its integrity check', { status: 404 }); }
  }
  const file = path.resolve(rendererRoot, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  if (path.relative(rendererRoot, file).startsWith('..')) return new Response('Forbidden', { status: 403 });
  const response = await net.fetch(pathToFileURL(file).toString());
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-src 'none'");
  return new Response(response.body, { status: response.status, headers });
});
worker = utilityProcess.fork(path.join(app.getAppPath(), 'dist', 'core', 'host.js'), [process.env.PAPER2_STATE_DIR || path.join(app.getPath('userData'), 'research')], { cwd: app.getAppPath(), serviceName: 'Methodiy AI harness', stdio: 'pipe' });
worker.stdout?.on('data', chunk => process.stdout.write(chunk));
worker.stderr?.on('data', chunk => process.stderr.write(chunk));
worker.on('message', message => {
  if (message.kind === 'event') { window?.webContents.send('p2e:event', message.event); collab?.publish(message.event); return; }
  if (message.kind === 'conversation') { window?.webContents.send('p2e:conversation', message.update); collab?.publishConversation(message.update); return; }
  if (message.kind === 'fatal') { console.error('Ошибка ядра Methodiy AI:', message.error); return; }
  const call = pending.get(message.id);
  if (call) { pending.delete(message.id); if (message.error) call.reject(new Error(message.error)); else call.resolve(message.result); }
});
worker.on('exit', code => {
  workerExited = true;
  void stopCollab();
  for (const call of pending.values()) call.reject(new Error(`Ядро завершилось (${code}); перезапустите приложение. Состояние сохранено на диске`)); pending.clear();
  if (!quitting) console.error(`Ядро завершилось: ${code}. Проверьте сохранённые инстансы Vast после перезапуска.`);
});
for (const method of ['snapshot', 'create', 'importPaper', 'setBrief', 'plan', 'savePlan', 'execute', 'approve', 'cancel', 'cleanup', 'saveSettings', 'transcribe', 'cancelTranscription', 'events', 'piProviders', 'piLogin', 'piLoginState', 'piLoginRespond', 'piLoginCancel', 'sendMessage', 'conversation', 'artifactPreview']) {
  ipcMain.handle(`p2e:${method}`, (event, ...args) => { checkSender(event); return request(method, ...args); });
}
let microphonePermission: Promise<boolean> | undefined;
ipcMain.handle('p2e:requestMicrophoneAccess', async event => {
  checkSender(event);
  if (process.platform !== 'darwin') return;
  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'granted') return;
  if (status === 'not-determined') {
    // Share the OS prompt when a cancelled renderer request is retried.
    microphonePermission ??= systemPreferences.askForMediaAccess('microphone').finally(() => { microphonePermission = undefined; });
    if (await microphonePermission) return;
  }
  throw new Error('Доступ к микрофону запрещён macOS. Откройте Системные настройки → Конфиденциальность и безопасность → Микрофон, разрешите доступ Electron (npm start) или Methodiy AI и перезапустите приложение.');
});
ipcMain.handle('p2e:collab:status', event => { checkSender(event); return collabStatus(); });
ipcMain.handle('p2e:collab:start', (event, useTunnel) => { checkSender(event); if (useTunnel !== undefined && typeof useTunnel !== 'boolean') throw new Error('Некорректный режим доступа'); return startCollab(useTunnel); });
ipcMain.handle('p2e:collab:stop', async event => { checkSender(event); if (changingCollab) throw new Error('Подождите завершения настройки доступа'); await stopCollab(); });
ipcMain.handle('p2e:openFolder', async (event, id) => { checkSender(event); const folder = await request('folder', id); const error = await shell.openPath(String(folder)); if (error) throw new Error(error); });
ipcMain.handle('p2e:openAuthLink', async (event, id, url) => {
  checkSender(event);
  const link = await request('authLink', id, url);
  await shell.openExternal(String(link));
});
ipcMain.handle('p2e:openExternal', async (event, value: unknown) => {
  checkSender(event);
  if (typeof value !== 'string' || value.length > 16384) throw new Error('Invalid link');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Only HTTPS links are allowed');
  await shell.openExternal(url.href);
});
ipcMain.handle('p2e:choose', async (event, kind: string) => {
  checkSender(event);
  if (!['pdf', 'data', 'model', 'binary', 'key'].includes(kind)) throw new Error('Недопустимый тип выбора');
  const result = await dialog.showOpenDialog(window!, { properties: kind === 'data' ? ['openDirectory'] : ['openFile'], filters: kind === 'pdf' ? [{ name: 'Text PDF', extensions: ['pdf'] }] : kind === 'model' ? [{ name: 'Whisper multilingual model', extensions: ['bin'] }] : [] });
  return result.canceled ? null : result.filePaths[0];
});
session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(contents === window?.webContents && permission === 'media' && details.isMainFrame && details.requestingUrl.startsWith('paper2://app/') && 'mediaTypes' in details && details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio'));
session.defaultSession.setPermissionCheckHandler((contents, permission, origin, details) => contents === window?.webContents && permission === 'media' && origin.replace(/\/$/, '') === 'paper2://app' && details.isMainFrame && details.mediaType === 'audio');
window = new BrowserWindow({ width: 1440, height: 940, minWidth: 900, minHeight: 640, title: 'Methodiy AI', icon, titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 }, backgroundColor: '#171819', webPreferences: { preload: path.join(app.getAppPath(), 'dist', 'main', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
window.webContents.on('will-navigate', event => event.preventDefault());
window.webContents.on('will-attach-webview', event => event.preventDefault());
await window.loadURL('paper2://app/index.html');
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void stopCollab().catch(error => dialog.showErrorBox('Collab', String(error))).then(() => request('shutdown')).catch(error => dialog.showErrorBox('Проверьте ресурсы', String(error))).finally(() => { worker.kill(); app.quit(); });
});
app.on('window-all-closed', () => app.quit());
if (process.argv.includes('--collab')) void startCollab(process.argv.includes('--collab-tunnel')).catch(error => { if (!quitting) dialog.showErrorBox('Collab', String(error)); });
}).catch(error => { dialog.showErrorBox('Ошибка запуска', String(error)); app.exit(1); });
