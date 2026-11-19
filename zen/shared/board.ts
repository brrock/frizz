// The board: which band a T3 thread sits in, and in what order.
//
// The bands and their names are Frizz's (ARCHITECTURE.md § Board nomenclature), top to bottom:
//
//   Pinned   the human's shelf; a pin outranks every other state.
//   Rested   "the queue": threads waiting on the human, in the order the pane steps through them.
//   Active   threads that are spinning, or resting on work still in motion.
//   Snoozed  parked until a time.
//   Done     settled threads.
//
// T3 Code has the same facts under other names. `settled` is Frizz's done, `snoozed` its snooze and
// `pinned` its pin. A run's `status` says whether the thread is spinning. T3's `waiting` is a run
// held on the human (a question or an approval), so it queues; that is what the queue is for.

import type { T3Thread } from "./types.ts";

export type Band = "pinned" | "rested" | "active" | "snoozed" | "done";

/** Why a rested thread is in the queue. Drives the mark on its row. */
export type RestKind = "ask" | "failed" | "report";

const SPINNING = new Set(["preparing", "queued", "starting", "running"]);
const FAILED = new Set(["failed", "interrupted", "cancelled", "rolled_back"]);

export function isSpinning(t: Pick<T3Thread, "status">): boolean {
  return SPINNING.has(t.status);
}

export function restKind(t: Pick<T3Thread, "status">): RestKind {
  if (t.status === "waiting") return "ask";
  if (FAILED.has(t.status)) return "failed";
  return "report";
}

/** A thread at rest whose background work is still running asks nothing yet, so it is Active. */
function restsOnWorkInMotion(t: T3Thread): boolean {
  return (t.pendingBackgroundTasks?.length ?? 0) > 0 || t.blockedOnThreadWait === true;
}

export function bandOf(t: T3Thread, now = Date.now()): Band {
  if (t.pinned) return "pinned";
  if (t.settled) return "done";
  if (t.snoozed && (!t.snoozedUntil || Date.parse(t.snoozedUntil) > now)) return "snoozed";
  if (isSpinning(t)) return "active";
  if (t.status !== "waiting" && !FAILED.has(t.status) && restsOnWorkInMotion(t)) return "active";
  return "rested";
}

export type Board = Record<Band, T3Thread[]>;

const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) : 0);

/**
 * Sorts every thread into its band. Sub-agent threads are left out: they belong to their parent,
 * and T3 lists them only on request anyway.
 */
export function buildBoard(threads: T3Thread[], now = Date.now()): Board {
  const board: Board = { pinned: [], rested: [], active: [], snoozed: [], done: [] };
  for (const t of threads) {
    if (t.relationshipToParent === "subagent") continue;
    board[bandOf(t, now)].push(t);
  }
  // The queue is first come, first served: the thread that has waited longest is next.
  board.rested.sort((a, b) => time(a.updatedAt) - time(b.updatedAt));
  board.active.sort((a, b) => time(b.updatedAt) - time(a.updatedAt));
  board.snoozed.sort((a, b) => time(a.snoozedUntil) - time(b.snoozedUntil));
  board.done.sort((a, b) => time(b.settledAt ?? b.updatedAt) - time(a.settledAt ?? a.updatedAt));
  board.pinned.sort((a, b) => time(a.createdAt) - time(b.createdAt));
  return board;
}

/** The thread after `currentId` in the queue, wrapping, or null when the queue is empty. */
export function nextInQueue(board: Board, currentId: string | null): string | null {
  const queue = board.rested.filter((t) => t.threadId !== currentId);
  return queue[0]?.threadId ?? null;
}
