import type { AppAPI, ConversationUpdate, RunEvent } from "../../shared/types.js";
import { parseCollabToken } from "../../shared/collab-link.js";

const STORAGE_KEY = "paper2:collab-token";
type Connection = "connected" | "reconnecting" | "expired";
export function savedCollabToken(): string | null {
  const fragment = parseCollabToken(location.hash);
  if (fragment) {
    try { sessionStorage.setItem(STORAGE_KEY, fragment); } catch { /* Storage is optional. */ }
    history.replaceState(null, "", location.pathname + location.search);
    return fragment;
  }
  try { return parseCollabToken(sessionStorage.getItem(STORAGE_KEY) ?? ""); } catch { return null; }
}

export async function connectRemote(value: string): Promise<AppAPI> {
  const token = parseCollabToken(value);
  if (!token) throw new Error("Paste a Collab connection link from your desktop workspace.");
  const headers = { Authorization: `Bearer ${token}` };
  let state: Connection = "connected", stopped = false;
  let pump: AbortController | undefined;
  const eventListeners = new Set<(event: RunEvent) => void>();
  const conversationListeners = new Set<(update: ConversationUpdate) => void>();
  const statusListeners = new Set<(state: Connection) => void>();
  const status = (next: Connection) => { state = next; for (const listener of statusListeners) listener(next); };
  const checked = async (url: string, init: RequestInit = {}) => {
    const response = await fetch(url, { ...init, headers: { ...headers, ...init.headers }, cache: "no-store", credentials: "omit", redirect: "error" });
    if (!response.ok) {
      if (response.status === 401) status("expired");
      const data = await response.json().catch(() => null);
      throw new Error(data?.error ?? `Connection failed (${response.status})`);
    }
    return response;
  };
  const session: { access: "control" | "view" } = await (await checked("/api/session", { signal: AbortSignal.timeout(15000) })).json();
  try { sessionStorage.setItem(STORAGE_KEY, token); } catch { /* Storage is optional. */ }
  async function rpc<T>(method: string, ...args: unknown[]): Promise<T> {
    if (stopped) throw new Error("Disconnected from workspace.");
    while (args.length && args.at(-1) === undefined) args.pop();
    const response = await checked("/api/rpc", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(120000) });
    return (await response.json()).result as T;
  }
  const desktopOnly = async (): Promise<never> => { throw new Error("Manage provider sign-in on the desktop. Existing models remain available here."); };
  function startPump() {
    if (pump && !pump.signal.aborted) return;
    const controller = new AbortController(); pump = controller;
    void (async () => {
      let delay = 1000, cursor: number | undefined;
      while (!controller.signal.aborted && !stopped) {
        try {
          const response = await checked(`/api/events${cursor === undefined ? "" : `?cursor=${cursor}`}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
          const batch: { cursor: number; sync: boolean; events: RunEvent[]; conversations: ConversationUpdate[] } = await response.json();
          if (controller.signal.aborted) return;
          status("connected"); delay = 1000;
          if (cursor === undefined || batch.sync) for (const listener of eventListeners) listener({ id: "sync", runId: "", at: new Date().toISOString(), type: "status", message: "sync" });
          cursor = batch.cursor;
          for (const event of batch.events) for (const listener of eventListeners) listener(event);
          for (const update of batch.conversations) for (const listener of conversationListeners) listener(update);
        } catch {
          if (controller.signal.aborted || stopped || state === "expired") return;
          cursor = undefined; status("reconnecting");
          await new Promise<void>(resolve => {
            const done = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", done); resolve(); };
            const timer = setTimeout(done, delay);
            controller.signal.addEventListener("abort", done, { once: true });
          });
          delay = Math.min(delay * 2, 15000);
        }
      }
    })();
  }
  function stopIfUnused() { if (!eventListeners.size && !conversationListeners.size) { pump?.abort(); pump = undefined; } }
  return {
    remote: true, access: session.access,
    snapshot: () => rpc("snapshot"), create: input => rpc("create", input),
    importPaper: source => rpc("importPaper", source), setBrief: (id, input) => rpc("setBrief", id, input),
    plan: id => rpc("plan", id), savePlan: (id, spec) => rpc("savePlan", id, spec),
    execute: id => rpc("execute", id), approve: id => rpc("approve", id), cancel: id => rpc("cancel", id), cleanup: id => rpc("cleanup", id),
    sendMessage: (id, text, delivery, pendingId) => rpc("sendMessage", id, text, delivery, pendingId),
    conversation: (id, before) => rpc("conversation", id, before),
    artifactPreview: (id, file) => rpc("artifactPreview", id, file),
    events: id => rpc("events", id), saveSettings: settings => rpc("saveSettings", settings), piProviders: () => rpc("piProviders"),
    piLogin: desktopOnly, piLoginState: desktopOnly, piLoginRespond: desktopOnly, piLoginCancel: desktopOnly, openAuthLink: desktopOnly,
    openExternal: async value => {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password) throw new Error("Only HTTPS links are allowed.");
      window.open(url.href, "_blank", "noopener,noreferrer");
    },
    paperPdf: async (id, signal) => {
      const response = await checked(`/api/paper/${encodeURIComponent(id)}`, { signal: signal ?? AbortSignal.timeout(30000) });
      return new Uint8Array(await response.arrayBuffer());
    },
    downloadArtifact: async (id, file) => {
      const result = await rpc<{ name: string; base64: string }>("downloadArtifact", id, file);
      const content = Uint8Array.from(atob(result.base64), char => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([content], { type: "application/octet-stream" }));
      const link = document.createElement("a"); link.href = url; link.download = result.name;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    },
    openFolder: async () => { throw new Error("This folder is on the desktop. Use Evidence to preview or download files."); },
    requestMicrophoneAccess: async () => {
      if (session.access === "view") throw new Error("This connection is view-only.");
      // The actual browser permission prompt belongs to getUserMedia in the recorder.
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw new Error("Microphone access requires HTTPS (or localhost). Use the HTTPS Collab link.");
      }
    },
    transcribe: (audio, requestId) => {
      let binary = "";
      for (const byte of new Uint8Array(audio)) binary += String.fromCharCode(byte);
      return rpc("transcribe", btoa(binary), requestId);
    },
    cancelTranscription: requestId => rpc("cancelTranscription", requestId),
    choose: async kind => {
      if (kind !== "pdf") throw new Error("Enter a path on the desktop, or use its native file picker.");
      if (session.access === "view") throw new Error("This connection is view-only.");
      const file = await new Promise<File | null>(resolve => {
        const input = document.createElement("input"); input.type = "file"; input.accept = "application/pdf,.pdf"; input.hidden = true; document.body.append(input);
        const finish = (file: File | null) => { input.remove(); resolve(file); };
        input.onchange = () => finish(input.files?.[0] ?? null);
        input.addEventListener("cancel", () => finish(null), { once: true }); input.click();
      });
      if (!file) return null;
      if (file.size > 25 * 1024 * 1024) throw new Error("PDF upload limit is 25 MiB.");
      return (await (await checked("/api/upload", { method: "POST", headers: { "Content-Type": "application/pdf" }, body: file, signal: AbortSignal.timeout(60000) })).json()).path;
    },
    connection: listener => { statusListeners.add(listener); listener(state); return () => { statusListeners.delete(listener); }; },
    disconnect: () => { stopped = true; pump?.abort(); try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* Optional. */ } location.reload(); },
    onEvent: listener => { eventListeners.add(listener); startPump(); return () => { eventListeners.delete(listener); stopIfUnused(); }; },
    onConversation: listener => { conversationListeners.add(listener); startPump(); return () => { conversationListeners.delete(listener); stopIfUnused(); }; }
  };
}
