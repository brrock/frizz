// The small marks that say what a row is doing. One shape per state, all drawn on the same 14px
// box with their ink centred in it, so a column of rows reads as one even line.

import type { Band, RestKind } from "../../shared/board.ts";

export type MarkKind = RestKind | "spinning" | "resting-on-work" | "snoozed" | "done" | "pinned";

export function markFor(band: Band, kind: RestKind, spinning: boolean): MarkKind {
  if (band === "active") return spinning ? "spinning" : "resting-on-work";
  if (band === "snoozed") return "snoozed";
  if (band === "done") return "done";
  if (band === "pinned") return spinning ? "spinning" : "pinned";
  return kind;
}

const LABEL: Record<MarkKind, string> = {
  ask: "Asking you something",
  failed: "Stopped with an error",
  report: "Finished, waiting on you",
  spinning: "Working",
  "resting-on-work": "Waiting on background work",
  snoozed: "Snoozed",
  done: "Done",
  pinned: "Pinned",
};

export function Mark({ kind }: { kind: MarkKind }) {
  return (
    <svg className={`mark mark-${kind}`} viewBox="0 0 14 14" width="14" height="14" role="img" aria-label={LABEL[kind]}>
      {kind === "spinning" && (
        <>
          <circle cx="7" cy="7" r="4.6" className="mark-track" />
          <path d="M7 2.4a4.6 4.6 0 0 1 4.6 4.6" className="mark-arc" />
        </>
      )}
      {kind === "resting-on-work" && <circle cx="7" cy="7" r="4.6" className="mark-track mark-dashed" />}
      {kind === "ask" && <circle cx="7" cy="7" r="3.6" className="mark-fill-accent" />}
      {kind === "failed" && (
        <>
          <circle cx="7" cy="7" r="4.4" className="mark-ring-accent" />
          <path d="M7 4.6v3" className="mark-ring-accent" />
          <circle cx="7" cy="9.5" r="0.8" className="mark-fill-accent" />
        </>
      )}
      {kind === "report" && <circle cx="7" cy="7" r="3" className="mark-fill-ink" />}
      {kind === "snoozed" && <path d="M4 7h6" className="mark-line" />}
      {kind === "done" && <path d="M3.8 7.3l2.2 2.2 4.2-4.6" className="mark-line" />}
      {kind === "pinned" && (
        <>
          <path d="M4.6 2.6h4.8M5.4 2.6v3.2L3.8 8h6.4L8.6 5.8V2.6" className="mark-pin" />
          <path d="M7 8v3.6" className="mark-pin" />
        </>
      )}
    </svg>
  );
}

/** The large mark for an empty pane: an ensō, drawn in one stroke with one break. */
export function Enso({ size = 96 }: { size?: number }) {
  return (
    <svg className="enso" viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <path d="M50 18A24 24 0 1 0 54 36" />
      <circle cx="54" cy="36" r="2.6" />
    </svg>
  );
}
