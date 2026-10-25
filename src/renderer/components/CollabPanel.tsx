import { useEffect, useRef, useState } from "react";
import type { AppAPI, CollabStatus } from "../../shared/types.js";
import { errorMessage } from "../lib/api.js";

export function PhoneGlyph() {
  return <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><rect x="5.5" y="2" width="9" height="16" rx="1.5" /><path d="M8 4h4M9 15.5h2" /></svg>;
}

export function CollabPanel({ api, onClose }: { api: NonNullable<AppAPI["collab"]>; onClose: () => void }) {
  const [status, setStatus] = useState<CollabStatus | null>(null);
  const [access, setAccess] = useState<"control" | "view">("control");
  const [network, setNetwork] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    let live = true;
    dialog.current?.showModal();
    void api.status().then(value => { if (live) setStatus(value); }).catch(cause => { if (live) setError(errorMessage(cause)); }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; clearTimeout(copyTimer.current); };
  }, [api]);
  const work = async (action: () => Promise<CollabStatus | void>) => {
    setBusy(true); setError(""); setCopied(false);
    try { setStatus(await action() ?? { running: false, links: [] }); setNetwork(0); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  const selected = Math.min(network, Math.max(0, (status?.links.length ?? 1) - 1));
  const link = status?.links[selected]?.[access];
  const copy = async () => {
    if (!link) return;
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(link);
      else {
        const field = document.createElement("textarea"); field.value = link;
        field.style.position = "fixed"; field.style.opacity = "0";
        dialog.current!.append(field); field.select();
        const ok = document.execCommand("copy"); field.remove();
        if (!ok) throw new Error("Select and copy the link below.");
      }
      setCopied(true); clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch { setError("Could not copy. Select the link and copy it manually."); }
  };
  return <dialog ref={dialog} className="collab-dialog" aria-labelledby="collab-title" onCancel={onClose} onClose={onClose}>
    <header className="collab-heading"><span className="eyebrow">METHODIY AI / COLLAB</span><button className="collab-close" onClick={onClose} aria-label="Close sharing">×</button></header>
    <div className="collab-intro"><span className="collab-device"><PhoneGlyph /></span><h1 id="collab-title">Continue on another device.</h1><p>The same paper, conversation and evidence.<br />Your computer keeps the experiment running.</p></div>
    {error && <p className="collab-error" role="alert">{error}</p>}
    {busy && !status ? <p className="collab-loading" role="status">Checking workspace access…</p> : status?.running ? <>
      <div className="collab-live"><span className="session-dot is-complete" /><span>{status.tunnel ? "HTTPS tunnel" : "Local network"}</span><span className="collab-expiry">Until {status.expiresAt ? new Date(status.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "app closes"}</span></div>
      <div className="collab-tabs" role="group" aria-label="Link permissions">
        <button aria-pressed={access === "control"} onClick={() => { setAccess("control"); setCopied(false); }}>Control</button>
        <button aria-pressed={access === "view"} onClick={() => { setAccess("view"); setCopied(false); }}>View only</button>
      </div>
      <p className="collab-access-note">{access === "control" ? "Create, discuss and run experiments. Share only with someone you trust." : "Read the paper, live conversation and results. Experiment controls are disabled."}</p>
      {status.links.length > 1 && <label className="collab-network">Network<select value={selected} onChange={event => { setNetwork(Number(event.target.value)); setCopied(false); }}>{status.links.map((item, index) => <option key={item.origin} value={index}>{item.origin}</option>)}</select></label>}
      {link ? <div className="collab-share">
        <div className="collab-qr">{status.qr?.[selected] ? <img src={status.qr[selected][access]} alt={`${access === "control" ? "Control" : "View-only"} connection QR code`} width={184} height={184} /> : <PhoneGlyph />}</div>
        <div className="collab-share-copy"><span className="eyebrow">SCAN TO CONNECT</span><p>{status.tunnel ? "Open from any network." : "Connect both devices to the same Wi-Fi."}</p><button className="collab-copy" onClick={() => void copy()} aria-live="polite">{copied ? "✓ Link copied" : "Copy connection link ↗"}</button><label className="sr-only" htmlFor="collab-link">Connection link</label><textarea id="collab-link" className="collab-url" readOnly value={link} rows={3} onFocus={event => event.currentTarget.select()} /></div>
      </div> : <p className="collab-access-note">No network address found. Connect to Wi-Fi, or restart sharing with an HTTPS tunnel.</p>}
      {status.warning && <p className="collab-error" role="alert">{status.warning}</p>}
      <footer className="collab-footer"><p>Stopping sharing disconnects devices<br />and revokes both links.</p><button className="collab-stop" disabled={busy} onClick={() => void work(() => api.stop())}>{busy ? "Stopping…" : "Stop sharing"}</button></footer>
    </> : <div className="collab-options">
      <button className="collab-option" disabled={busy} onClick={() => void work(() => api.start(false))}><span className="collab-option-mark">01</span><span><strong>Same Wi-Fi</strong><small>A direct link within your trusted network.</small></span><span>↗</span></button>
      <button className="collab-option" disabled={busy} onClick={() => void work(() => api.start(true))}><span className="collab-option-mark">02</span><span><strong>HTTPS tunnel</strong><small>Connect from another network via Cloudflare.</small></span><span>↗</span></button>
      {busy && <p className="collab-loading" role="status">Opening a connection…</p>}
    </div>}
    <p className="collab-fineprint">{status?.tunnel ? "Cloudflare can see traffic through this tunnel. Keep your connection link private." : "Local access uses HTTP. Use HTTPS for microphone access and connections outside your trusted network."}</p>
  </dialog>;
}
