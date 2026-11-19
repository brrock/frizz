// The rail: the prompt box, then the board's bands top to bottom, as Frizz has always drawn them.
//
//   (pinned rows, unlabeled)
//   Rested    the queue, longest wait first, each with its rest time
//   ── rule ──
//   Active    spinning, or resting on work still in motion
//   Snoozed   dimmed, each with when it wakes
//   Done      collapsed

import { useState } from "react";
import { isSpinning, restKind, type Band, type Board } from "../../shared/board.ts";
import { age, until } from "../../shared/durations.ts";
import type { T3Project, T3Thread } from "../../shared/types.ts";
import { Mark, markFor } from "./Marks.tsx";
import { PromptBox } from "./PromptBox.tsx";

interface Props {
  board: Board | null;
  projects: T3Project[];
  projectId: string | null;
  selectedId: string | null;
  connectedTo: string;
  onSelect(id: string): void;
  onProject(id: string | null): void;
  onLaunch(message: string): Promise<void>;
  onSettings(): void;
  error: string | null;
}

export function Rail(p: Props) {
  const [doneOpen, setDoneOpen] = useState(false);
  const b = p.board;
  const projectTitle = (id: string) => p.projects.find((x) => x.id === id)?.title;
  const showProject = p.projectId === null;

  const row = (t: T3Thread, band: Band) => (
    <Row
      key={t.threadId}
      t={t}
      band={band}
      selected={t.threadId === p.selectedId}
      project={showProject ? projectTitle(t.projectId) : undefined}
      onSelect={p.onSelect}
    />
  );

  const empty = b && !b.pinned.length && !b.rested.length && !b.active.length && !b.snoozed.length;

  return (
    <aside className="rail">
      <header className="rail-head">
        <span className="wordmark">Frizz</span>
        <ProjectPicker projects={p.projects} value={p.projectId} onChange={p.onProject} />
        <button className="quiet-icon" onClick={p.onSettings} title={`Connected to ${p.connectedTo}`} aria-label="Connection">
          <span className="conn-dot" />
        </button>
      </header>

      <PromptBox
        placeholder={p.projectId ? `New thread in ${projectTitle(p.projectId) ?? "this project"}…` : "New thread…"}
        onSubmit={p.onLaunch}
        disabledReason={p.projectId ? null : p.projects.length ? "Pick a project to start a thread in." : null}
      />

      {p.error && <p className="rail-error">{p.error}</p>}

      <nav className="bands" aria-label="Threads">
        {b === null && !p.error && <p className="rail-quiet">Reading the board…</p>}
        {b && b.pinned.length > 0 && <section className="band band-pinned">{b.pinned.map((t) => row(t, "pinned"))}</section>}
        {b && b.rested.length > 0 && <section className="band band-rested" aria-label="Queue">{b.rested.map((t) => row(t, "rested"))}</section>}
        {b && (b.rested.length > 0 || b.pinned.length > 0) && b.active.length > 0 && <hr className="band-rule" />}
        {b && b.active.length > 0 && <section className="band band-active" aria-label="Active">{b.active.map((t) => row(t, "active"))}</section>}
        {b && b.snoozed.length > 0 && (
          <section className="band band-snoozed">
            <h2 className="band-label">Snoozed</h2>
            {b.snoozed.map((t) => row(t, "snoozed"))}
          </section>
        )}
        {empty && <p className="rail-quiet">Nothing in motion. Start something above.</p>}
        {b && b.done.length > 0 && (
          <section className="band band-done">
            <button className="band-label band-toggle" onClick={() => setDoneOpen((v) => !v)} aria-expanded={doneOpen}>
              Done <span className="count">{b.done.length}</span>
              <svg viewBox="0 0 10 10" width="10" height="10" className={doneOpen ? "chev open" : "chev"} aria-hidden="true">
                <path d="M3 2l3 3-3 3" />
              </svg>
            </button>
            {doneOpen && b.done.slice(0, 50).map((t) => row(t, "done"))}
          </section>
        )}
      </nav>
    </aside>
  );
}

function Row(p: { t: T3Thread; band: Band; selected: boolean; project?: string; onSelect(id: string): void }) {
  const { t, band } = p;
  const kind = restKind(t);
  const mark = markFor(band, kind, isSpinning(t));
  let meta = "";
  if (band === "rested") meta = age(t.updatedAt);
  else if (band === "snoozed") meta = t.snoozedUntil ? `in ${until(t.snoozedUntil)}` : "";
  else if (band === "done") meta = age(t.settledAt ?? t.updatedAt);
  return (
    <button
      className={`row row-${band}${p.selected ? " is-selected" : ""}`}
      onClick={() => p.onSelect(t.threadId)}
      aria-current={p.selected ? "true" : undefined}
      data-thread={t.threadId}
    >
      <Mark kind={mark} />
      <span className="row-text">
        <span className="row-title">{t.title || "Untitled"}</span>
        {p.project && <span className="row-project">{p.project}</span>}
      </span>
      {meta && <span className="row-meta">{meta}</span>}
    </button>
  );
}

function ProjectPicker(p: { projects: T3Project[]; value: string | null; onChange(id: string | null): void }) {
  return (
    <label className="project-picker">
      <span className="sr-only">Project</span>
      <select value={p.value ?? ""} onChange={(e) => p.onChange(e.target.value || null)}>
        <option value="">All projects</option>
        {p.projects.map((x) => (
          <option key={x.id} value={x.id}>
            {x.title}
          </option>
        ))}
      </select>
      <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
        <path d="M2 4l3 3 3-3" />
      </svg>
    </label>
  );
}
