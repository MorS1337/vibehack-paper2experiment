import { contextBridge, ipcRenderer } from 'electron';
import type { AppAPI, RunEvent } from '../shared/types.js';

const api: AppAPI = {
  snapshot: () => ipcRenderer.invoke('p2e:snapshot'),
  create: input => ipcRenderer.invoke('p2e:create', input),
  plan: id => ipcRenderer.invoke('p2e:plan', id),
  savePlan: (id, spec) => ipcRenderer.invoke('p2e:savePlan', id, spec),
  execute: id => ipcRenderer.invoke('p2e:execute', id),
  approve: id => ipcRenderer.invoke('p2e:approve', id),
  cancel: id => ipcRenderer.invoke('p2e:cancel', id),
  cleanup: id => ipcRenderer.invoke('p2e:cleanup', id),
  saveSettings: settings => ipcRenderer.invoke('p2e:saveSettings', settings),
  choose: kind => ipcRenderer.invoke('p2e:choose', kind),
  requestMicrophoneAccess: () => ipcRenderer.invoke('p2e:requestMicrophoneAccess'),
  transcribe: (audio, requestId) => ipcRenderer.invoke('p2e:transcribe', audio, requestId),
  cancelTranscription: requestId => ipcRenderer.invoke('p2e:cancelTranscription', requestId),
  events: id => ipcRenderer.invoke('p2e:events', id),
  openFolder: id => ipcRenderer.invoke('p2e:openFolder', id),
  onEvent: listener => {
    const handler = (_event: Electron.IpcRendererEvent, event: RunEvent) => listener(event);
    ipcRenderer.on('p2e:event', handler);
    return () => ipcRenderer.removeListener('p2e:event', handler);
  }
};
contextBridge.exposeInMainWorld('paper2', api);
