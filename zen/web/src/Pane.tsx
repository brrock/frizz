// The one-thread pane: the thread's header, its transcript, the question it is waiting on, and
// its prompt box. Everything it does is a T3 verb (see server/t3.ts).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { isSpinning } from "../../shared/board.ts";
import { age, formatDuration } from "../../shared/durations.ts";
import type { T3PendingRequest, T3TimelineItem, ThreadPage } from "../../shared/types.ts";
import { api } from "./api.ts";
import { renderMarkdown } from "./markdown.ts";
import { Enso } from "./Marks.tsx";
import { PromptBox, type PromptBoxHandle } from "./PromptBox.tsx";

interface Props {
  threadId: string;
  page: ThreadPage | null;
  error: string | null;
  projectTitle?: string;
  hasNext: boolean;
  onChanged(): void;
  onNext(): void;
  onBack?(): void;
  composerRef: React.RefObject<PromptBoxHandle | null>;
}

export function Pane(p: Props) {
  const page = p.page;
  if (!page) {
    return (
      <main className="pane pane-loading">
        {p.onBack && <BackButton onBack={p.onBack} />}
        <p className="quiet">{p.error ?? "Opening the thread…"}</p>
      </main>
    );
  }
  const t = page.thread;
  const spinning = isSpinning(t);

  const act = async (fn: () => Promise<unknown>, thenNext = false) => {
    await fn();
    p.onChanged();
    if (thenNext) p.onNext();
  };

  return (
    <main className="pane">
      <header className="pane-head">
        {p.onBack && <BackButton onBack={p.onBack} />}
        <div className="pane-title-block">
          <h1 className="pane-title">{t.title || "Untitled"}</h1>
          <p className="pane-facts">
            {[p.projectTitle, t.model, t.branch, statusWords(page)].filter(Boolean).join("  ·  ")}
            {t.pullRequests?.map((pr) => (
              <a key={pr.url} className="fact-link" href={pr.url} target="_blank" rel="noreferrer">
                PR{pr.number ? ` #${pr.number}` : ""}
              </a>
            ))}
          </p>
        </div>
        <div className="pane-actions">
          <button className="quiet-btn" onClick={() => void act(() => api.organize(t.threadId, t.pinned ? "unpin" : "pin"))}>
            {t.pinned ? "Unpin" : "Pin"}
          </button>
          <SnoozeMenu
            snoozed={t.snoozed}
            onPick={(at) => void act(() => (at ? api.organize(t.threadId, "snooze", at) : api.organize(t.threadId, "unsnooze")), !!at)}
          />
          {t.settled ? (
            <button className="quiet-btn" onClick={() => void act(() => api.organize(t.threadId, "unsettle"))}>
              Reopen
            </button>
          ) : (
            <button className="quiet-btn" onClick={() => void act(() => api.organize(t.threadId, "settle"), true)} title="Mark as done (E)">
              Done
            </button>
          )}
          {t.link && (
            <a className="quiet-btn" href={t.link} target="_blank" rel="noreferrer" title="Open this thread in T3 Code">
              Open in T3 ↗
            </a>
          )}
        </div>
      </header>

      <Transcript page={page} />

      <footer className="pane-foot">
        {page.requests.map((r) => (
          <QuestionCard key={r.requestId} request={r} onAnswer={(answers) => act(() => api.respond(t.threadId, r.requestId, answers))} />
        ))}
        <PromptBox
          ref={p.composerRef}
          draftKey={t.threadId}
          placeholder={spinning ? "Steer this thread…" : "Reply…"}
          onSubmit={(text, { andNext }) => act(() => api.send(t.threadId, text), andNext && p.hasNext)}
          actions={
            spinning ? (
              <button className="quiet-btn stop" onClick={() => void act(() => api.stop(t.threadId))}>
                Stop
              </button>
            ) : null
          }
        />
      </footer>
    </main>
  );
}

function statusWords(page: ThreadPage): string {
  const t = page.thread;
  if (isSpinning(t)) {
    const run = page.runs.find((r) => r.runId === t.activeRunId) ?? page.runs[0];
    const since = run?.startedAt ?? run?.requestedAt;
    return since ? `working ${formatDuration(Date.now() - Date.parse(since))}` : "working";
  }
  if (t.status === "waiting") return "waiting on you";
  if (t.status === "failed") return "failed";
  if (t.status === "interrupted") return "stopped";
  if (t.snoozed) return "snoozed";
  if (t.settled) return "done";
  return `last active ${age(t.updatedAt)}${age(t.updatedAt) === "now" ? "" : " ago"}`;
}

function BackButton({ onBack }: { onBack(): void }) {
  return (
    <button className="back" onClick={onBack} aria-label="Back to threads">
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
        <path d="M7.5 2.5L4 6l3.5 3.5" />
      </svg>
    </button>
  );
}

// ---------------------------------------------------------------- transcript

function Transcript({ page }: { page: ThreadPage }) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinnedToEnd = useRef(true);
  const id = page.thread.threadId;
  const last = page.items.at(-1)?.itemId;

  // Open at the end; then follow new items only while the reader is already at the end.
  useLayoutEffect(() => {
    pinnedToEnd.current = true;
  }, [id]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinnedToEnd.current) el.scrollTop = el.scrollHeight;
  }, [id, last, page.items.length]);

  const spinning = isSpinning(page.thread);

  return (
    <div
      className="transcript"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinnedToEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
    >
      <div className="transcript-col">
        {page.hasEarlier && (
          <p className="earlier">
            Earlier messages are in T3 Code.{" "}
            {page.thread.link && (
              <a href={page.thread.link} target="_blank" rel="noreferrer">
                Read the whole thread ↗
              </a>
            )}
          </p>
        )}
        {page.items.length === 0 && !spinning && (
          <div className="pane-empty-inline">
            <p className="quiet">Nothing has been said in this thread yet.</p>
          </div>
        )}
        {groupSteps(page.items).map((g) =>
          g.kind === "message" ? <Message key={g.item.itemId} item={g.item} /> : <Steps key={g.items[0]!.itemId} items={g.items} />,
        )}
        {spinning && <Working since={page.runs[0]?.startedAt ?? page.thread.updatedAt} />}
      </div>
    </div>
  );
}

type Group = { kind: "message"; item: T3TimelineItem } | { kind: "steps"; items: T3TimelineItem[] };

const MESSAGE_TYPES = new Set(["user_message", "assistant_message", "error", "proposed_plan"]);

/** Consecutive tool, reasoning and notice items fold into one quiet line between messages. */
function groupSteps(items: T3TimelineItem[]): Group[] {
  const out: Group[] = [];
  for (const item of items) {
    if (MESSAGE_TYPES.has(item.type)) out.push({ kind: "message", item });
    else {
      const prev = out.at(-1);
      if (prev?.kind === "steps") prev.items.push(item);
      else out.push({ kind: "steps", items: [item] });
    }
  }
  return out;
}

function Message({ item }: { item: T3TimelineItem }) {
  const text = item.text ?? "";
  if (item.type === "user_message") {
    return (
      <div className="msg msg-user">
        <div className="msg-body">{text}</div>
      </div>
    );
  }
  if (item.type === "error") {
    return (
      <div className="msg msg-error" role="note">
        <span className="msg-error-label">Stopped</span> {text}
      </div>
    );
  }
  return (
    <div className="msg msg-agent">
      <div className="prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
      {item.textTruncated && <p className="quiet small">This message is longer in T3 Code.</p>}
    </div>
  );
}

const STEP_NAMES: Record<string, string> = {
  command_execution: "command",
  file_change: "edit",
  file_search: "search",
  reasoning: "thought",
  todo_list: "plan",
  notification: "notice",
  web_search: "search",
  mcp_tool_call: "tool call",
};

function Steps({ items }: { items: T3TimelineItem[] }) {
  const [open, setOpen] = useState(false);
  const counts = new Map<string, number>();
  for (const i of items) {
    const n = STEP_NAMES[i.type] ?? i.type.replace(/_/g, " ");
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  const summary = [...counts].map(([n, c]) => (c > 1 ? `${c} ${n}s` : `${c} ${n}`)).join(", ");
  return (
    <div className={`steps${open ? " is-open" : ""}`}>
      <button className="steps-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="steps-line" aria-hidden="true" />
        <span className="steps-summary">{summary}</span>
      </button>
      {open && (
        <ol className="steps-list">
          {items.map((i) => (
            <li key={i.itemId} className="step">
              <span className="step-kind">{i.title ?? STEP_NAMES[i.type] ?? i.type}</span>
              {i.text && <pre className="step-text">{i.text}</pre>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Working({ since }: { since: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="working" aria-live="polite">
      <span className="breath" aria-hidden="true" />
      <span>Working</span>
      <span className="working-time">{formatDuration(Date.now() - Date.parse(since))}</span>
    </div>
  );
}

// ---------------------------------------------------------------- the question card

function QuestionCard({ request, onAnswer }: { request: T3PendingRequest; onAnswer(a: Record<string, unknown>): Promise<void> }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qs = request.questions;
  const complete = qs.every((q) => (picked[q.id]?.length ?? 0) > 0);

  const send = async (next: Record<string, string[]>) => {
    setBusy(true);
    setError(null);
    try {
      const answers = Object.fromEntries(
        qs.map((q) => [q.id, q.multiSelect ? (next[q.id] ?? []) : (next[q.id]?.[0] ?? "")]),
      );
      await onAnswer(answers);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const pick = (qid: string, value: string, multi: boolean) => {
    const cur = picked[qid] ?? [];
    const nextFor = multi ? (cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]) : [value];
    const next = { ...picked, [qid]: nextFor };
    setPicked(next);
    // One single-choice question answers itself on the click, as T3's own card does.
    if (qs.length === 1 && !multi) void send(next);
  };

  return (
    <section className="question" aria-label="The agent is asking">
      {qs.map((q) => (
        <div key={q.id} className="q">
          <p className="q-header">{q.header}</p>
          <p className="q-text">{q.question}</p>
          <div className="q-options">
            {q.options.map((o) => {
              const value = o.value ?? o.label;
              const on = picked[q.id]?.includes(value);
              return (
                <button
                  key={value}
                  className={`q-option${on ? " is-on" : ""}`}
                  disabled={busy}
                  onClick={() => pick(q.id, value, !!q.multiSelect)}
                >
                  <span className="q-label">{o.label}</span>
                  {o.description && <span className="q-desc">{o.description}</span>}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {(qs.length > 1 || qs.some((q) => q.multiSelect)) && (
        <div className="q-foot">
          <button className="send" disabled={!complete || busy} onClick={() => void send(picked)}>
            {busy ? "Answering…" : "Answer"}
          </button>
        </div>
      )}
      {error && <p className="q-error">{error}</p>}
    </section>
  );
}

// ---------------------------------------------------------------- snooze

function SnoozeMenu({ snoozed, onPick }: { snoozed: boolean; onPick(at: string | null): void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  if (snoozed) {
    return (
      <button className="quiet-btn" onClick={() => onPick(null)}>
        Wake
      </button>
    );
  }
  const choices: [string, () => Date][] = [
    ["For 1h", () => new Date(Date.now() + 3600_000)],
    ["For 3h", () => new Date(Date.now() + 3 * 3600_000)],
    ["Until tomorrow", () => atNine(1)],
    ["Until next week", () => atNine(((8 - new Date().getDay()) % 7) || 7)],
  ];
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="quiet-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        Snooze
      </button>
      {open && (
        <div className="menu" role="menu">
          {choices.map(([label, at]) => (
            <button
              key={label}
              role="menuitem"
              className="menu-item"
              onClick={() => {
                setOpen(false);
                onPick(at().toISOString());
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function atNine(daysAhead: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setHours(9, 0, 0, 0);
  return d;
}

export function EmptyPane({ queued }: { queued: number }) {
  return (
    <main className="pane pane-empty">
      <Enso />
      <p className="empty-line">{queued ? `${queued} waiting on you.` : "Nothing is waiting on you."}</p>
      <p className="empty-hint">
        {queued ? (
          <>
            Press <kbd>J</kbd> to open the first.
          </>
        ) : (
          <>
            Press <kbd>/</kbd> to start a thread.
          </>
        )}
      </p>
    </main>
  );
}
