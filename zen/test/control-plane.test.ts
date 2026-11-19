// Frizz's server against a T3 Code stand-in that speaks the same MCP tools and the same OAuth.
// Real HTTP on both sides, the real MCP SDK client and server, the real sign-in redirects.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { startServer, type RunningServer } from "../server/app.ts";
import { startMock, type RunningMock } from "../mock/t3-mock.ts";
import type { Board } from "../shared/board.ts";
import type { ConnectionState, ThreadPage } from "../shared/types.ts";

let mock: RunningMock;
let zen: RunningServer;
let home: string;

async function api<T>(method: string, p: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(zen.url + p, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as T };
}

/** Follows the sign-in as a browser would: T3's authorize page, then Frizz's callback. */
async function signIn(authUrl: string) {
  const a = await fetch(authUrl, { redirect: "manual" });
  assert.equal(a.status, 302, "the mock approves at once and redirects");
  const callback = new URL(a.headers.get("location")!);
  assert.equal(callback.pathname, "/oauth/callback");
  const c = await fetch(`${zen.url}${callback.pathname}${callback.search}`, { redirect: "manual" });
  assert.equal(c.status, 302);
  assert.equal(c.headers.get("location"), "/", `callback failed: ${c.headers.get("location")}`);
}

async function until<T>(fn: () => Promise<T | undefined>, what: string, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    // A socket pooled from before a restart fails once; the next attempt opens a fresh one.
    const v = await fn().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const board = async () => (await api<{ board: Board }>("GET", "/api/board")).json.board;
const bandOf = async (id: string) => {
  const b = await board();
  return (Object.keys(b) as (keyof Board)[]).find((k) => b[k].some((t) => t.threadId === id));
};

describe("Frizz as a T3 Code control plane", () => {
  before(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "frizz-zen-"));
    mock = await startMock({ runMs: 150 });
    zen = await startServer({ home });
  });
  after(async () => {
    await zen.close();
    await mock.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("starts unconfigured, and refuses board reads until connected", async () => {
    const { json } = await api<{ state: ConnectionState }>("GET", "/api/connection");
    assert.equal(json.state.phase, "unconfigured");
    const b = await api<{ error: string }>("GET", "/api/board");
    assert.equal(b.status, 503);
  });

  test("a bare address is read as its /mcp URL, and T3 asks for a sign-in", async () => {
    const bare = mock.url.replace("http://", "http://") + "/";
    const { json } = await api<{ state: ConnectionState }>("POST", "/api/connection", { url: bare });
    assert.equal(json.state.phase, "needs-sign-in", JSON.stringify(json.state));
    if (json.state.phase !== "needs-sign-in") return;
    assert.equal(json.state.url, mock.mcpUrl);
    const auth = new URL(json.state.authUrl);
    assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
    assert.match(auth.searchParams.get("redirect_uri")!, /^http:\/\/localhost:\d+\/oauth\/callback$/);
  });

  test("signing in connects, and the credential is saved 0600", async () => {
    const { json } = await api<{ state: ConnectionState }>("GET", "/api/connection");
    assert.equal(json.state.phase, "needs-sign-in");
    if (json.state.phase !== "needs-sign-in") return;
    await signIn(json.state.authUrl);
    const after = await api<{ state: ConnectionState }>("GET", "/api/connection");
    assert.equal(after.json.state.phase, "connected", JSON.stringify(after.json.state));
    assert.equal(mock.issued(), 1);
    const file = path.join(home, "state.json");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(JSON.parse(fs.readFileSync(file, "utf8")).tokens.access_token);
  });

  test("the board sorts T3's threads into Frizz's bands", async () => {
    const b = await board();
    const titles = (k: keyof Board) => b[k].map((t) => t.title);
    assert.deepEqual(titles("pinned"), ["Q4 performance budget"]);
    // The queue: longest wait first. An ask, a report and a failure all wait on the human.
    assert.deepEqual(titles("rested"), [
      "Fix the flaky checkout test",
      "Add rate limits to the public API",
      "Upgrade the router to v8",
    ]);
    // Spinning, plus a thread resting on a CI watch that has not asked for anything yet.
    assert.deepEqual(new Set(titles("active")), new Set([
      "Write the migration for invoice totals",
      "Make the settings page load faster",
      "Watch CI on the auth refactor",
    ]));
    assert.deepEqual(titles("snoozed"), ["Revisit the onboarding copy"]);
    assert.equal(b.done.length, 3);
  });

  test("the board narrows to one project", async () => {
    const { json } = await api<{ projects: { id: string; title: string }[] }>("GET", "/api/projects");
    const api_ = json.projects.find((p) => p.title === "Atlas API")!;
    const b = (await api<{ board: Board }>("GET", `/api/board?projectId=${api_.id}`)).json.board;
    const all = Object.values(b).flat();
    assert.ok(all.length > 0);
    assert.ok(all.every((t) => t.projectId === api_.id));
  });

  test("reading a thread gives its transcript oldest first, and its open question", async () => {
    const id = (await board()).rested[0]!.threadId;
    const { json } = await api<ThreadPage>("GET", `/api/threads/${id}`);
    assert.equal(json.items[0]!.type, "user_message");
    assert.equal(json.items.at(-1)!.type, "assistant_message");
    assert.equal(json.requests.length, 1);
    assert.equal(json.requests[0]!.questions[0]!.options.length, 2);
  });

  test("answering the question sends the thread back to work, then into the queue with a reply", async () => {
    const id = (await board()).rested[0]!.threadId;
    const page = (await api<ThreadPage>("GET", `/api/threads/${id}`)).json;
    const req = page.requests[0]!;
    const r = await api("POST", `/api/threads/${id}/respond`, { requestId: req.requestId, answers: { q1: "Wait on the iframe" } });
    assert.equal(r.status, 200);
    assert.equal(await bandOf(id), "active");
    await until(async () => ((await bandOf(id)) === "rested" ? true : undefined), "the run to finish");
    const done = (await api<ThreadPage>("GET", `/api/threads/${id}`)).json;
    assert.equal(done.requests.length, 0);
    assert.equal(done.items.at(-1)!.type, "assistant_message");
  });

  test("a new thread from the prompt box launches in T3, titled from its first line", async () => {
    const { json: projects } = await api<{ projects: { id: string }[] }>("GET", "/api/projects");
    const r = await api<{ threadId: string }>("POST", "/api/threads", {
      projectId: projects.projects[0]!.id,
      message: "Tidy the README\n\nShorter intro, and a quick start that actually runs.",
    });
    assert.equal(r.status, 200);
    const t = mock.world.threads.get(r.json.threadId)!;
    assert.equal(t.title, "Tidy the README");
    assert.equal(await bandOf(r.json.threadId), "active");
  });

  test("Stop interrupts a running thread", async () => {
    const id = (await board()).active.find((t) => t.status === "running")!.threadId;
    const r = await api<{ status: string }>("POST", `/api/threads/${id}/stop`, {});
    assert.equal(r.json.status, "interrupt_requested");
    assert.equal(mock.world.threads.get(id)!.status, "interrupted");
    assert.equal(await bandOf(id), "rested");
  });

  test("Done, snooze and pin move a thread between bands, through T3", async () => {
    const id = (await board()).rested[0]!.threadId;
    await api("POST", `/api/threads/${id}/organize`, { action: "settle" });
    assert.equal(await bandOf(id), "done");
    await api("POST", `/api/threads/${id}/organize`, { action: "unsettle" });
    const later = new Date(Date.now() + 3600_000).toISOString();
    await api("POST", `/api/threads/${id}/organize`, { action: "snooze", snoozedUntil: later });
    assert.equal(await bandOf(id), "snoozed");
    await api("POST", `/api/threads/${id}/organize`, { action: "pin" });
    assert.equal(await bandOf(id), "pinned");
    const bad = await api<{ error: string }>("POST", `/api/threads/${id}/organize`, { action: "explode" });
    assert.equal(bad.status, 400);
  });

  test("a T3 failure reaches the page as its own message", async () => {
    const r = await api<{ error: string }>("POST", "/api/threads/thr_nope/send", { message: "hi" });
    assert.equal(r.status, 422);
    assert.match(r.json.error, /No thread thr_nope/);
  });

  test("a cross-site write is refused", async () => {
    const res = await fetch(`${zen.url}/api/threads/x/stop`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: "{}",
    });
    assert.equal(res.status, 403);
    const form = await fetch(`${zen.url}/api/threads/x/stop`, { method: "POST", body: "a=b", headers: { "content-type": "application/x-www-form-urlencoded" } });
    assert.equal(form.status, 415);
  });

  test("an expired token sends Frizz back to the sign-in step, and signing in again recovers", async () => {
    mock.expireTokens();
    const r = await api<{ error: string }>("GET", "/api/board");
    assert.equal(r.status, 401);
    const { json } = await api<{ state: ConnectionState }>("GET", "/api/connection");
    assert.equal(json.state.phase, "needs-sign-in", JSON.stringify(json.state));
    if (json.state.phase !== "needs-sign-in") return;
    await signIn(json.state.authUrl);
    assert.equal((await api<{ state: ConnectionState }>("GET", "/api/connection")).json.state.phase, "connected");
    assert.equal((await api("GET", "/api/board")).status, 200);
  });

  test("a restarted Frizz reconnects with the saved credential, no sign-in", async () => {
    const issued = mock.issued();
    await zen.close();
    zen = await startServer({ home, port: zen.port });
    const state = await until(async () => {
      const s = (await api<{ state: ConnectionState }>("GET", "/api/connection")).json.state;
      return s.phase === "connecting" ? undefined : s;
    }, "the reconnect");
    assert.equal(state.phase, "connected", JSON.stringify(state));
    assert.equal(mock.issued(), issued);
  });

  test("forgetting the environment drops its credential", async () => {
    await api("DELETE", "/api/connection");
    const saved = JSON.parse(fs.readFileSync(path.join(home, "state.json"), "utf8"));
    assert.equal(saved.tokens, undefined);
    assert.equal(saved.mcpUrl, undefined);
  });
});
