import { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, session, utilityProcess } from 'electron';
import type { UtilityProcess, IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

protocol.registerSchemesAsPrivileged([{ scheme: 'paper2', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
if (!app.requestSingleInstanceLock()) app.exit(0);
let window: BrowserWindow | undefined;
let worker: UtilityProcess;
let workerExited = false;
let quitting = false;
let sequence = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
function request(method: string, ...args: unknown[]): Promise<unknown> {
  if (workerExited) return Promise.reject(new Error('Ядро недоступно; перезапустите приложение'));
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const id = ++sequence; pending.set(id, { resolve, reject }); worker.postMessage({ id, method, args });
  return promise;
}
function checkSender(event: IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !event.senderFrame.url.startsWith('paper2://app/')) throw new Error('Недоверенный IPC sender');
}
app.on('second-instance', () => { window?.show(); window?.focus(); });
void app.whenReady().then(async () => {
const rendererRoot = path.join(app.getAppPath(), 'dist', 'renderer');
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
worker = utilityProcess.fork(path.join(app.getAppPath(), 'dist', 'core', 'host.js'), [process.env.PAPER2_STATE_DIR || path.join(app.getPath('userData'), 'research')], { cwd: app.getAppPath(), serviceName: 'Paper2Experiment harness', stdio: 'pipe' });
worker.stdout?.on('data', chunk => process.stdout.write(chunk));
worker.stderr?.on('data', chunk => process.stderr.write(chunk));
worker.on('message', message => {
  if (message.kind === 'event') { window?.webContents.send('p2e:event', message.event); return; }
  if (message.kind === 'conversation') { window?.webContents.send('p2e:conversation', message.update); return; }
  if (message.kind === 'fatal') { console.error('Ошибка ядра Paper2Experiment:', message.error); return; }
  const call = pending.get(message.id);
  if (call) { pending.delete(message.id); if (message.error) call.reject(new Error(message.error)); else call.resolve(message.result); }
});
worker.on('exit', code => {
  workerExited = true;
  for (const call of pending.values()) call.reject(new Error(`Ядро завершилось (${code}); перезапустите приложение. Состояние сохранено на диске`)); pending.clear();
  if (!quitting) console.error(`Ядро завершилось: ${code}. Проверьте сохранённые инстансы Vast после перезапуска.`);
});
for (const method of ['snapshot', 'create', 'importPaper', 'setBrief', 'plan', 'savePlan', 'execute', 'approve', 'cancel', 'cleanup', 'saveSettings', 'transcribe', 'events', 'piProviders', 'piLogin', 'piLoginState', 'piLoginRespond', 'piLoginCancel', 'sendMessage', 'conversation', 'artifactPreview']) {
  ipcMain.handle(`p2e:${method}`, (event, ...args) => { checkSender(event); return request(method, ...args); });
}
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
session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(contents === window?.webContents && permission === 'media' && details.requestingUrl.startsWith('paper2://app/') && 'mediaTypes' in details && details.mediaTypes?.every(type => type === 'audio') === true));
session.defaultSession.setPermissionCheckHandler((contents, permission, origin) => contents === window?.webContents && permission === 'media' && origin.startsWith('paper2://app'));
window = new BrowserWindow({ width: 1440, height: 940, minWidth: 900, minHeight: 640, title: 'Paper2Experiment', backgroundColor: '#171819', webPreferences: { preload: path.join(app.getAppPath(), 'dist', 'main', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
window.webContents.on('will-navigate', event => event.preventDefault());
window.webContents.on('will-attach-webview', event => event.preventDefault());
await window.loadURL('paper2://app/index.html');
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault();
  void request('shutdown').catch(error => dialog.showErrorBox('Проверьте ресурсы', String(error))).finally(() => { quitting = true; worker.kill(); app.quit(); });
});
app.on('window-all-closed', () => app.quit());
}).catch(error => { dialog.showErrorBox('Ошибка запуска', String(error)); app.exit(1); });
