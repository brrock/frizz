// The first screen, and the one Frizz returns to whenever T3 Code is out of reach.

import { useState } from "react";
import type { ConnectionState } from "../../shared/types.ts";
import { api } from "./api.ts";
import { Enso } from "./Marks.tsx";

export function Connect({ state, onState, signinError }: { state: ConnectionState; onState(s: ConnectionState): void; signinError: string | null }) {
  const initial = new URLSearchParams(location.search).get("mcp") ?? ("url" in state ? state.url : "");
  const [url, setUrl] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(signinError);

  const connect = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    try {
      onState((await api.connect(url.trim())).state);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const signIn = state.phase === "needs-sign-in";
  const failed = state.phase === "error" ? state.message : null;

  return (
    <div className="connect">
      <div className="connect-card">
        <Enso size={72} />
        <h1 className="connect-title">{signIn ? "Sign in to T3 Code" : "Connect Frizz to T3 Code"}</h1>

        {signIn ? (
          <>
            <p className="connect-lede">
              T3 Code asks you to approve Frizz once. Approve it with your T3 Connect account and you will come straight back here.
            </p>
            <a className="primary" href={state.authUrl}>
              Continue to T3 Connect
            </a>
            <p className="connect-small">
              Connecting to <span className="mono">{state.url}</span>.{" "}
              <button className="link" onClick={() => void api.forget().then((r) => onState(r.state))}>
                Use another environment
              </button>
            </p>
          </>
        ) : (
          <>
            <p className="connect-lede">
              Frizz is a calm board over your T3 Code threads. It reads and steers them through the MCP server T3 Connect gives each environment.
            </p>
            <form onSubmit={connect} className="connect-form">
              <label htmlFor="mcp-url" className="connect-label">
                MCP URL
              </label>
              <input
                id="mcp-url"
                className="connect-input mono"
                placeholder="https://<environment-address>/mcp"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                autoFocus
                spellCheck={false}
                autoComplete="off"
              />
              <button className="primary" disabled={busy || !url.trim()}>
                {busy ? "Connecting…" : "Connect"}
              </button>
            </form>
            <p className="connect-small">
              In T3 Code, open <b>Settings → Environments</b>, then choose <b>Copy MCP URL</b> from the environment's menu. Its T3 Connect address works from anywhere.
            </p>
          </>
        )}
        {(error || failed) && <p className="connect-error">{error ?? failed}</p>}
        {state.phase === "connecting" && <p className="connect-small">Connecting…</p>}
      </div>
    </div>
  );
}
