import assert from "node:assert/strict";
import { test } from "node:test";
import { bandOf, buildBoard, nextInQueue, restKind } from "../shared/board.ts";
import { age, formatDuration } from "../shared/durations.ts";
import type { T3Thread } from "../shared/types.ts";

const NOW = Date.parse("2026-11-19T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

function thread(over: Partial<T3Thread>): T3Thread {
  return {
    threadId: Math.random().toString(36).slice(2),
    projectId: "p",
    title: "t",
    status: "completed",
    latestRunId: null,
    model: "m",
    settled: false,
    settledAt: null,
    snoozed: false,
    snoozedUntil: null,
    parentThreadId: null,
    relationshipToParent: null,
    itemCount: 0,
    createdAt: ago(100),
    updatedAt: ago(10),
    ...over,
  };
}

test("a pin outranks every other state", () => {
  for (const s of [{ status: "running" as const }, { settled: true }, { snoozed: true }]) {
    assert.equal(bandOf(thread({ pinned: true, ...s }), NOW), "pinned");
  }
});

test("spinning statuses are Active; resting ones queue", () => {
  for (const status of ["preparing", "queued", "starting", "running"] as const) {
    assert.equal(bandOf(thread({ status }), NOW), "active", status);
  }
  for (const status of ["idle", "waiting", "completed", "failed", "interrupted", "cancelled"] as const) {
    assert.equal(bandOf(thread({ status }), NOW), "rested", status);
  }
});

test("a rest on work still in motion is Active, unless it asks or failed", () => {
  const bg = { pendingBackgroundTasks: [{ taskId: "x", kind: "monitor" as const }] };
  assert.equal(bandOf(thread({ status: "completed", ...bg }), NOW), "active");
  assert.equal(bandOf(thread({ status: "completed", blockedOnThreadWait: true }), NOW), "active");
  assert.equal(bandOf(thread({ status: "waiting", ...bg }), NOW), "rested");
  assert.equal(bandOf(thread({ status: "failed", ...bg }), NOW), "rested");
});

test("a snooze that has run out queues again", () => {
  assert.equal(bandOf(thread({ snoozed: true, snoozedUntil: ago(-30) }), NOW), "snoozed");
  assert.equal(bandOf(thread({ snoozed: true, snoozedUntil: ago(5) }), NOW), "rested");
});

test("settled is Done, before a snooze", () => {
  assert.equal(bandOf(thread({ settled: true, snoozed: true, snoozedUntil: ago(-30) }), NOW), "done");
});

test("the queue is longest wait first, and sub-agent threads stay off the board", () => {
  const a = thread({ title: "newer", updatedAt: ago(1) });
  const b = thread({ title: "older", updatedAt: ago(60) });
  const sub = thread({ title: "sub", relationshipToParent: "subagent" });
  const board = buildBoard([a, b, sub], NOW);
  assert.deepEqual(board.rested.map((t) => t.title), ["older", "newer"]);
  assert.equal(nextInQueue(board, b.threadId), a.threadId);
  assert.equal(nextInQueue(board, null), b.threadId);
});

test("rest kinds drive the row's mark", () => {
  assert.equal(restKind({ status: "waiting" }), "ask");
  assert.equal(restKind({ status: "failed" }), "failed");
  assert.equal(restKind({ status: "interrupted" }), "failed");
  assert.equal(restKind({ status: "completed" }), "report");
});

test("durations speak Frizz's one grammar", () => {
  const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H;
  assert.equal(formatDuration(450), "450ms");
  assert.equal(formatDuration(12 * S), "12s");
  assert.equal(formatDuration(40 * M), "40m");
  assert.equal(formatDuration(2 * H + 35 * M), "2h 35m");
  assert.equal(formatDuration(2 * H), "2h");
  assert.equal(formatDuration(3 * D + 4 * H), "3d 4h");
  assert.equal(formatDuration(15 * D), "2w");
  assert.equal(formatDuration(70 * D), "2mo");
  assert.equal(formatDuration(800 * D), "2y");
  assert.equal(age(ago(0.2), NOW), "now");
  // Never the spellings the grammar forbids.
  for (const ms of [5 * S, 40 * M, 2 * H + 5 * M, 3 * D]) {
    assert.doesNotMatch(formatDuration(ms), /min|hour|hr|day|\d \w/);
  }
});
