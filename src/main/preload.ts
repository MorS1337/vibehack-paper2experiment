import { contextBridge, ipcRenderer } from "electron";
import type { AppAPI, ConversationUpdate, RunEvent } from "../shared/types.js";

const api: AppAPI = {
  collab: {
    status: () => ipcRenderer.invoke('p2e:collab:status'),
    start: tunnel => ipcRenderer.invoke('p2e:collab:start', tunnel),
    stop: () => ipcRenderer.invoke('p2e:collab:stop')
  },
  snapshot: () => ipcRenderer.invoke('p2e:snapshot'),
  create: input => ipcRenderer.invoke('p2e:create', input),
  importPaper: source => ipcRenderer.invoke('p2e:importPaper', source),
  setBrief: (id, input) => ipcRenderer.invoke('p2e:setBrief', id, input),
  plan: id => ipcRenderer.invoke('p2e:plan', id),
  savePlan: (id, spec) => ipcRenderer.invoke('p2e:savePlan', id, spec),
  execute: id => ipcRenderer.invoke('p2e:execute', id),
  approve: id => ipcRenderer.invoke('p2e:approve', id),
  cancel: id => ipcRenderer.invoke('p2e:cancel', id),
  cleanup: id => ipcRenderer.invoke('p2e:cleanup', id),
  sendMessage: (id, text, delivery, pendingId) => ipcRenderer.invoke('p2e:sendMessage', id, text, delivery, pendingId),
  conversation: (id, before) => ipcRenderer.invoke('p2e:conversation', id, before),
  artifactPreview: (id, file) => ipcRenderer.invoke('p2e:artifactPreview', id, file),
  onConversation: listener => {
    const handler = (_event: Electron.IpcRendererEvent, update: ConversationUpdate) => listener(update);
    ipcRenderer.on('p2e:conversation', handler);
    return () => ipcRenderer.removeListener('p2e:conversation', handler);
  },
  openExternal: (url) => ipcRenderer.invoke("p2e:openExternal", url),
  saveSettings: (settings) => ipcRenderer.invoke("p2e:saveSettings", settings),
  piProviders: () => ipcRenderer.invoke("p2e:piProviders"),
  piLogin: (provider, method) =>
    ipcRenderer.invoke("p2e:piLogin", provider, method),
  piLoginState: (id) => ipcRenderer.invoke("p2e:piLoginState", id),
  piLoginRespond: (id, promptId, value) =>
    ipcRenderer.invoke("p2e:piLoginRespond", id, promptId, value),
  piLoginCancel: (id) => ipcRenderer.invoke("p2e:piLoginCancel", id),
  openAuthLink: (id, url) => ipcRenderer.invoke("p2e:openAuthLink", id, url),
  choose: (kind) => ipcRenderer.invoke("p2e:choose", kind),
  transcribe: (audio, requestId) =>
    ipcRenderer.invoke("p2e:transcribe", audio, requestId),
  cancelTranscription: (requestId) =>
    ipcRenderer.invoke("p2e:cancelTranscription", requestId),
  requestMicrophoneAccess: () =>
    ipcRenderer.invoke("p2e:requestMicrophoneAccess"),
  events: (id) => ipcRenderer.invoke("p2e:events", id),
  openFolder: (id) => ipcRenderer.invoke("p2e:openFolder", id),
  onEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, event: RunEvent) =>
      listener(event);
    ipcRenderer.on("p2e:event", handler);
    return () => ipcRenderer.removeListener("p2e:event", handler);
  },

};
contextBridge.exposeInMainWorld("paper2", api);
