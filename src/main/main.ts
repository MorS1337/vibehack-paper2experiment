import { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, session, systemPreferences, utilityProcess } from 'electron';
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
protocol.handle('paper2', async request => {
  const url = new URL(request.url);
  if (url.hostname !== 'app') return new Response('Forbidden', { status: 403 });
  const file = path.resolve(rendererRoot, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  if (path.relative(rendererRoot, file).startsWith('..')) return new Response('Forbidden', { status: 403 });
  const response = await net.fetch(pathToFileURL(file).toString());
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'");
  return new Response(response.body, { status: response.status, headers });
});
worker = utilityProcess.fork(path.join(app.getAppPath(), 'dist', 'core', 'host.js'), [process.env.PAPER2_STATE_DIR || path.join(app.getPath('userData'), 'research')], { cwd: app.getAppPath(), serviceName: 'Paper2Experiment harness', stdio: 'pipe' });
worker.stdout?.on('data', chunk => process.stdout.write(chunk));
worker.stderr?.on('data', chunk => process.stderr.write(chunk));
worker.on('message', message => {
  if (message.kind === 'event') { window?.webContents.send('p2e:event', message.event); return; }
  if (message.kind === 'fatal') { console.error('Ошибка ядра Paper2Experiment:', message.error); return; }
  const call = pending.get(message.id);
  if (call) { pending.delete(message.id); if (message.error) call.reject(new Error(message.error)); else call.resolve(message.result); }
});
worker.on('exit', code => {
  workerExited = true;
  for (const call of pending.values()) call.reject(new Error(`Ядро завершилось (${code}); перезапустите приложение. Состояние сохранено на диске`)); pending.clear();
  if (!quitting) console.error(`Ядро завершилось: ${code}. Проверьте сохранённые инстансы Vast после перезапуска.`);
});
for (const method of ['snapshot', 'create', 'plan', 'savePlan', 'execute', 'approve', 'cancel', 'cleanup', 'saveSettings', 'transcribe', 'cancelTranscription', 'events']) {
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
  throw new Error('Доступ к микрофону запрещён macOS. Откройте Системные настройки → Конфиденциальность и безопасность → Микрофон, разрешите доступ Electron (npm start) или Paper2Experiment и перезапустите приложение.');
});
ipcMain.handle('p2e:openFolder', async (event, id) => { checkSender(event); const folder = await request('folder', id); const error = await shell.openPath(String(folder)); if (error) throw new Error(error); });
ipcMain.handle('p2e:choose', async (event, kind: string) => {
  checkSender(event);
  if (!['pdf', 'data', 'model', 'binary', 'key'].includes(kind)) throw new Error('Недопустимый тип выбора');
  const result = await dialog.showOpenDialog(window!, { properties: kind === 'data' ? ['openDirectory'] : ['openFile'], filters: kind === 'pdf' ? [{ name: 'Text PDF', extensions: ['pdf'] }] : kind === 'model' ? [{ name: 'Whisper multilingual model', extensions: ['bin'] }] : [] });
  return result.canceled ? null : result.filePaths[0];
});
session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(contents === window?.webContents && permission === 'media' && details.isMainFrame && details.requestingUrl.startsWith('paper2://app/') && 'mediaTypes' in details && details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio'));
session.defaultSession.setPermissionCheckHandler((contents, permission, origin, details) => contents === window?.webContents && permission === 'media' && origin.replace(/\/$/, '') === 'paper2://app' && details.isMainFrame && details.mediaType === 'audio');
window = new BrowserWindow({ width: 1480, height: 960, minWidth: 1080, minHeight: 700, title: 'Paper2Experiment', backgroundColor: '#f5f4ef', webPreferences: { preload: path.join(app.getAppPath(), 'dist', 'main', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
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
