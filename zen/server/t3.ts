// Frizz's one connection to a T3 Code environment, over the MCP server T3 Connect exposes.
//
// Every board fact Frizz shows, and every verb it offers, is a T3 MCP tool call: Frizz keeps no
// thread state of its own. The tool names and shapes are T3's (`apps/server/src/mcp/toolkits/`):
//
//   t3_project_list       the project picker
//   t3_thread_list        the board
//   t3_thread_read        the pane's transcript
//   t3_thread_launch      the prompt box's new thread
//   t3_thread_send        the pane's prompt box (mode auto: start, steer or queue)
//   t3_thread_interrupt   Stop (with `stop: true`, as T3's own Stop button does)
//   t3_thread_organize    pin, snooze, done (settle), archive
//   t3_pending_request    a question the agent is waiting on, and its answer

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  ConnectionState,
  OrganizeAction,
  SendMode,
  T3PendingRequest,
  T3Project,
  T3Run,
  T3Thread,
  T3ThreadDetail,
  T3TimelineItem,
  ThreadPage,
} from "../shared/types.ts";
import { ZenOAuthProvider } from "./oauth.ts";
import type { StateFile } from "./store.ts";

export class T3Error extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

export class T3Connection {
  private client: Client | null = null;
  private connecting: Promise<ConnectionState> | null = null;
  private listCache: { key: string; at: number; value: Promise<T3Thread[]> } | null = null;
  readonly oauth: ZenOAuthProvider;
  state: ConnectionState;
  private readonly store: StateFile;

  constructor(store: StateFile, callbackUrl: string) {
    this.store = store;
    this.oauth = new ZenOAuthProvider(store, callbackUrl);
    const url = store.get().mcpUrl;
    this.state = url ? { phase: "connecting", url } : { phase: "unconfigured" };
  }

  /** Connects to `url`, or to the saved environment. Concurrent callers share one attempt. */
  connect(url?: string): Promise<ConnectionState> {
    if (url !== undefined) {
      const normalized = normalizeMcpUrl(url);
      if (normalized !== this.store.get().mcpUrl) {
        // Another environment: the old one's client and token mean nothing there.
        this.store.update({ mcpUrl: normalized, client: undefined, tokens: undefined, codeVerifier: undefined });
      }
    }
    this.connecting ??= this.open().finally(() => (this.connecting = null));
    return this.connecting;
  }

  private async open(): Promise<ConnectionState> {
    const url = this.store.get().mcpUrl;
    if (!url) return (this.state = { phase: "unconfigured" });
    await this.close();
    this.state = { phase: "connecting", url };
    const transport = new StreamableHTTPClientTransport(new URL(url), { authProvider: this.oauth });
    const client = new Client({ name: "frizz", version: "0.1.0" });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      this.client = client;
      const serverName = client.getServerVersion()?.name ?? "T3 Code";
      return (this.state = { phase: "connected", url, serverName, toolCount: tools.length });
    } catch (err) {
      await client.close().catch(() => {});
      if (err instanceof UnauthorizedError && this.oauth.pendingAuthUrl) {
        return (this.state = { phase: "needs-sign-in", url, authUrl: this.oauth.pendingAuthUrl });
      }
      return (this.state = { phase: "error", url, message: describe(err) });
    }
  }

  /** The OAuth redirect landed: trade the code for a token, then connect for real. */
  async finishAuth(code: string): Promise<ConnectionState> {
    const url = this.store.get().mcpUrl;
    if (!url) throw new T3Error("No T3 Code environment is set.", 409);
    // The SDK's own token exchange, against the same provider: it rediscovers the authorization
    // server from the MCP URL, so it does not need the transport that began the sign-in.
    const result = await auth(this.oauth, { serverUrl: url, authorizationCode: code });
    if (result !== "AUTHORIZED") throw new T3Error("T3 Code did not accept the sign-in.", 401);
    this.oauth.pendingAuthUrl = null;
    return this.connect();
  }

  async forget(): Promise<void> {
    await this.close();
    this.store.update({ mcpUrl: undefined, client: undefined, tokens: undefined, codeVerifier: undefined });
    this.state = { phase: "unconfigured" };
  }

  private async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    this.listCache = null;
    await c?.close().catch(() => {});
  }

  /** Calls one T3 tool and returns its structured result. */
  async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    if (!this.client) {
      if (this.state.phase === "connecting" || this.state.phase === "error") await this.connect();
      if (!this.client) throw new T3Error(notConnected(this.state), 503);
    }
    let result: Awaited<ReturnType<Client["callTool"]>>;
    try {
      result = await this.client.callTool({ name, arguments: stripUndefined(args) });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        // The 30-day token ran out (or was revoked): back to the sign-in step.
        await this.close();
        const url = this.store.get().mcpUrl ?? "";
        this.state = this.oauth.pendingAuthUrl
          ? { phase: "needs-sign-in", url, authUrl: this.oauth.pendingAuthUrl }
          : { phase: "error", url, message: "T3 Code no longer accepts Frizz's sign-in." };
        throw new T3Error(notConnected(this.state), 401);
      }
      throw new T3Error(`${name}: ${describe(err)}`);
    }
    const body = parseResult(result);
    if (result.isError) throw new T3Error(failureMessage(name, body), 422);
    return body as T;
  }

  // ---- the verbs Frizz offers ----

  async listProjects(): Promise<T3Project[]> {
    const out: T3Project[] = [];
    let cursor: number | null | undefined;
    for (let page = 0; page < 10; page++) {
      const r = await this.call<{ projects: T3Project[]; nextCursor: number | null }>("t3_project_list", {
        cursor: cursor ?? undefined,
        limit: 100,
      });
      out.push(...r.projects);
      cursor = r.nextCursor;
      if (cursor == null) break;
    }
    return out.filter((p) => !p.archivedAt);
  }

  /** Every top-level thread, in one project or all of them. Coalesced for a second. */
  listThreads(projectId?: string): Promise<T3Thread[]> {
    const key = projectId ?? "*";
    const c = this.listCache;
    if (c && c.key === key && Date.now() - c.at < 1000) return c.value;
    const value = this.fetchThreads(projectId);
    this.listCache = { key, at: Date.now(), value };
    value.catch(() => {
      if (this.listCache?.value === value) this.listCache = null;
    });
    return value;
  }

  private async fetchThreads(projectId?: string): Promise<T3Thread[]> {
    const out: T3Thread[] = [];
    let cursor: number | null | undefined;
    for (let page = 0; page < 5; page++) {
      const r = await this.call<{ threads: T3Thread[]; nextCursor: number | null }>("t3_thread_list", {
        projectId,
        allProjects: projectId ? undefined : true,
        cursor: cursor ?? undefined,
        limit: 100,
      });
      out.push(...r.threads);
      cursor = r.nextCursor;
      if (cursor == null) break;
    }
    return out;
  }

  async readThread(threadId: string, opts: { beforePosition?: number; limit?: number } = {}): Promise<ThreadPage> {
    const r = await this.call<{
      thread: T3ThreadDetail;
      recentRuns: T3Run[];
      items: T3TimelineItem[];
      hasMore: boolean;
      earlierPosition?: number | null;
    }>("t3_thread_read", {
      threadId,
      view: "messages",
      beforePosition: opts.beforePosition,
      limit: opts.limit ?? 60,
      runLimit: 10,
      maxCharsPerItem: 20_000,
    });
    // T3 pages newest first; a transcript reads oldest first.
    const items = [...r.items].sort((a, b) => a.position - b.position);
    const hasEarlier = r.earlierPosition !== undefined ? r.earlierPosition !== null : r.hasMore;
    const requests = r.thread.pendingRequestCount > 0 ? await this.pendingRequests(threadId) : [];
    return { thread: r.thread, runs: r.recentRuns, items, hasEarlier, requests };
  }

  async pendingRequests(threadId: string): Promise<T3PendingRequest[]> {
    const { requestIds } = await this.call<{ requestIds: string[] }>("t3_pending_request", {
      action: "list",
      threadId,
    });
    return Promise.all(
      requestIds.map((requestId) =>
        this.call<T3PendingRequest>("t3_pending_request", { action: "read", threadId, requestId }),
      ),
    );
  }

  respond(threadId: string, requestId: string, answers: Record<string, unknown>) {
    this.listCache = null;
    return this.call("t3_pending_request", { action: "respond", threadId, requestId, answers });
  }

  launch(input: { projectId?: string; title: string; message: string; scratch?: boolean }) {
    this.listCache = null;
    return this.call<{ threadId: string; link?: string; projectId: string }>("t3_thread_launch", {
      projectId: input.projectId,
      scratch: input.projectId ? undefined : input.scratch,
      title: input.title,
      message: input.message,
      clientRequestId: crypto.randomUUID(),
    });
  }

  send(threadId: string, message: string, mode: SendMode = "auto") {
    this.listCache = null;
    return this.call<{ delivery: string; runId: string }>("t3_thread_send", {
      threadId,
      message,
      mode,
      clientRequestId: crypto.randomUUID(),
    });
  }

  stop(threadId: string) {
    this.listCache = null;
    return this.call("t3_thread_interrupt", {
      threadId,
      stop: true,
      reason: "Stopped from Frizz",
      clientRequestId: crypto.randomUUID(),
    });
  }

  organize(threadId: string, action: OrganizeAction, snoozedUntil?: string) {
    this.listCache = null;
    return this.call("t3_thread_organize", { threadId, action, snoozedUntil });
  }

  rename(threadId: string, title: string) {
    this.listCache = null;
    return this.call("t3_thread_update", { threadId, action: "rename", title });
  }
}

/** Accepts what a person pastes: the copied MCP URL, or the bare environment address. */
export function normalizeMcpUrl(input: string): string {
  let raw = input.trim();
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  const u = new URL(raw);
  if (u.pathname === "/" || u.pathname === "") u.pathname = "/mcp";
  u.hash = "";
  return u.toString();
}

function parseResult(raw: unknown): unknown {
  const result = raw as { structuredContent?: unknown; content?: unknown };
  if (result.structuredContent !== undefined) return result.structuredContent;
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.find((c: { type?: string }) => c?.type === "text") as { text?: string } | undefined;
  if (!text?.text) return {};
  try {
    return JSON.parse(text.text);
  } catch {
    return { message: text.text };
  }
}

function failureMessage(tool: string, body: unknown): string {
  const b = body as { message?: unknown; error?: unknown; reason?: unknown } | null;
  const msg = [b?.message, b?.reason, b?.error].find((v) => typeof v === "string");
  return `${tool}: ${msg ?? JSON.stringify(body)}`;
}

function stripUndefined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return cause instanceof Error ? `${err.message} (${cause.message})` : err.message;
  }
  return String(err);
}

function notConnected(state: ConnectionState): string {
  switch (state.phase) {
    case "unconfigured":
      return "Frizz is not connected to T3 Code yet.";
    case "needs-sign-in":
      return "T3 Code wants you to sign in again.";
    case "error":
      return state.message;
    default:
      return "Frizz is still connecting to T3 Code.";
  }
}
