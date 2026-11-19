import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Board } from "../../shared/board.ts";
import type { ConnectionState, T3Project, T3Thread } from "../../shared/types.ts";
import { ApiError, api, usePoll } from "./api.ts";
import { Connect } from "./Connect.tsx";
import { EmptyPane, Pane } from "./Pane.tsx";
import type { PromptBoxHandle } from "./PromptBox.tsx";
import { Rail } from "./Rail.tsx";

export function App() {
  const [conn, setConn] = useState<ConnectionState | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const signinError = useMemo(() => new URLSearchParams(location.search).get("signin_error"), []);

  const loadConn = useCallback(async () => {
    const r = await api.connection();
    setConn(r.state);
    setProjectId(r.projectId);
    return r.state;
  }, []);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      const s = await loadConn().catch(() => null);
      if (!stop && s?.phase === "connecting") setTimeout(tick, 500);
    };
    void tick();
    if (signinError) history.replaceState(null, "", location.pathname + location.hash);
    return () => {
      stop = true;
    };
  }, [loadConn, signinError]);

  if (!conn) return <div className="boot" />;
  if (conn.phase !== "connected") {
    return (
      <Connect
        state={conn}
        signinError={signinError}
        onState={(s) => {
          setConn(s);
          if (s.phase === "connecting") void loadConn();
        }}
      />
    );
  }
  return (
    <Board
      key={conn.url}
      connectedTo={conn.url}
      projectId={projectId}
      onProject={(id) => {
        setProjectId(id);
        void api.setProject(id);
      }}
      onDisconnected={() => void loadConn()}
    />
  );
}

function selectedFromHash(): string | null {
  const m = location.hash.match(/^#\/t\/(.+)$/);
  return m ? decodeURIComponent(m[1]!) : null;
}

function Board(p: { connectedTo: string; projectId: string | null; onProject(id: string | null): void; onDisconnected(): void }) {
  const [selectedId, setSelectedId] = useState<string | null>(selectedFromHash);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const composer = useRef<PromptBoxHandle>(null);
  const railPrompt = useRef<HTMLElement | null>(null);

  const projects = usePoll<T3Project[]>("projects", async () => (await api.projects()).projects, 60_000);
  const board = usePoll<Board>(`board:${p.projectId ?? "*"}`, async () => (await api.board(p.projectId)).board, 2500);
  const thread = usePoll(selectedId, () => api.thread(selectedId!), 2000);

  // A 401 means T3 wants a sign-in again; hand back to the connection screen.
  useEffect(() => {
    const e = board.error ?? thread.error;
    if (e instanceof ApiError && (e.status === 401 || e.status === 503)) p.onDisconnected();
  }, [board.error, thread.error, p]);

  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    const hash = id ? `#/t/${encodeURIComponent(id)}` : "";
    if (location.hash !== hash) history.pushState(null, "", hash || location.pathname);
  }, []);

  useEffect(() => {
    const onPop = () => setSelectedId(selectedFromHash());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const b = board.data;
  const order: T3Thread[] = useMemo(() => (b ? [...b.pinned, ...b.rested, ...b.active, ...b.snoozed] : []), [b]);
  const nextQueued = useMemo(() => b?.rested.find((t) => t.threadId !== selectedId)?.threadId ?? null, [b, selectedId]);

  const refreshAll = useCallback(() => {
    void board.refresh();
    void thread.refresh();
  }, [board, thread]);

  // Keyboard: J/K walk the board, E marks done, / starts a thread, ⌫ / Esc leave the pane on a phone.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("textarea, input, select, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
      const i = order.findIndex((t) => t.threadId === selectedId);
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        const next = e.key === "j" ? order[i + 1] ?? order[0] : order[i - 1] ?? order.at(-1);
        if (next) select(next.threadId);
      } else if (e.key === "e" && selectedId) {
        e.preventDefault();
        void api.organize(selectedId, "settle").then(() => {
          refreshAll();
          select(nextQueued);
        });
      } else if (e.key === "/") {
        e.preventDefault();
        (railPrompt.current ?? document.querySelector<HTMLTextAreaElement>(".rail .prompt textarea"))?.focus();
      } else if (e.key === "r" && selectedId) {
        e.preventDefault();
        composer.current?.focus();
      } else if (e.key === "Escape" && selectedId && window.matchMedia("(max-width: 760px)").matches) {
        select(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [order, selectedId, select, nextQueued, refreshAll]);

  const projectTitle = (id: string) => projects.data?.find((x) => x.id === id)?.title;
  const pageProject = thread.data ? projectTitle(thread.data.thread.projectId) : undefined;

  return (
    <div className={`app${selectedId ? " has-thread" : ""}`}>
      <Rail
        board={b}
        projects={projects.data ?? []}
        projectId={p.projectId}
        selectedId={selectedId}
        connectedTo={p.connectedTo}
        onSelect={select}
        onProject={(id) => {
          p.onProject(id);
          select(null);
        }}
        onLaunch={async (message) => {
          const r = await api.launch(message, p.projectId);
          await board.refresh();
          select(r.threadId);
        }}
        onSettings={() => setSettingsOpen(true)}
        error={board.error && !b ? board.error.message : null}
      />
      {selectedId ? (
        <Pane
          key={selectedId}
          threadId={selectedId}
          page={thread.data}
          error={thread.error?.message ?? null}
          projectTitle={pageProject}
          hasNext={!!nextQueued}
          composerRef={composer}
          onChanged={refreshAll}
          onNext={() => select(nextQueued)}
          onBack={() => select(null)}
        />
      ) : (
        <EmptyPane queued={b?.rested.length ?? 0} />
      )}
      {settingsOpen && (
        <ConnectionSheet
          url={p.connectedTo}
          onClose={() => setSettingsOpen(false)}
          onForget={async () => {
            await api.forget();
            p.onDisconnected();
          }}
        />
      )}
    </div>
  );
}

function ConnectionSheet(p: { url: string; onClose(): void; onForget(): Promise<void> }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && p.onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [p]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Connection">
        <h2 className="sheet-title">Connection</h2>
        <p className="sheet-row">
          <span className="conn-dot" /> Connected to T3 Code
        </p>
        <p className="mono small sheet-url">{p.url}</p>
        <div className="sheet-actions">
          <button className="quiet-btn" onClick={() => void p.onForget()}>
            Disconnect
          </button>
          <button className="send" onClick={p.onClose}>
            Close
          </button>
        </div>
        <p className="sheet-keys">
          <kbd>J</kbd> <kbd>K</kbd> move · <kbd>E</kbd> done · <kbd>R</kbd> reply · <kbd>/</kbd> new thread · <kbd>⌘</kbd>
          <kbd>⏎</kbd> send · <kbd>⇧</kbd>
          <kbd>⌘</kbd>
          <kbd>⏎</kbd> send and open the next
        </p>
      </div>
    </div>
  );
}
