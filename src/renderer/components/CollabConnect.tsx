// Connect form adapted from OMP collab-web (MIT); see docs/third-party/oh-my-pi-LICENSE.
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { AppAPI } from "../../shared/types.js";
import { connectRemote, savedCollabToken } from "../lib/remote-api.js";
import { errorMessage } from "../lib/api.js";
import { PhoneGlyph } from "./CollabPanel.js";

export function CollabConnect({ children }: { children: (api: AppAPI) => ReactNode }) {
  const [api, setApi] = useState<AppAPI | null>(null);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const connect = async (value: string) => {
    setBusy(true); setError("");
    try { setApi(await connectRemote(value)); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  useEffect(() => { const token = savedCollabToken(); if (token) void connect(token); }, []);
  if (api) return children(api);
  const submit = (event: FormEvent) => { event.preventDefault(); void connect(link); };
  return <main className="collab-connect">
    <header className="collab-connect-brand"><span className="brand-mark">p₂</span><span>paper2experiment</span><span className="collab-brand-divider">/</span><span className="muted">collab</span></header>
    <section className="collab-connect-body">
      <span className="collab-device"><PhoneGlyph /></span><span className="eyebrow">YOUR RESEARCH, CONTINUED</span>
      <h1>Join your workspace.</h1><p>Pick up the paper, conversation and evidence<br />right where you left them.</p>
      <form onSubmit={submit}>
        <label htmlFor="connection-link">Connection link</label>
        <input id="connection-link" type="text" inputMode="url" value={link} onChange={event => setLink(event.target.value)} placeholder="https://…/#p2e=…" autoComplete="off" autoCapitalize="none" spellCheck={false} required disabled={busy} />
        {error && <p className="collab-error" role="alert">{error}</p>}
        <button type="submit" className="primary-button" disabled={busy}>{busy ? "Connecting…" : "Connect to workspace"}<span aria-hidden="true">↗</span></button>
      </form>
      <div className="collab-connect-help"><span>01</span><p>Open <strong>Collab</strong> in the desktop workspace.<br />Scan its QR code or paste the connection link here.</p></div>
      <p className="collab-fineprint">Runs stay on your computer. Keep Paper2Experiment open.<br />A connection link grants access to your workspace.</p>
    </section>
    <footer className="collab-connect-footer"><span>LOCAL COMPUTE / SHARED CONTEXT</span><span>Paper → protocol → evidence</span></footer>
  </main>;
}
