// A stand-in T3 Code environment: the same MCP tools, the same OAuth, an in-memory world.
//
// It exists so Frizz can be driven end to end without a real T3 Code: the tests start it, and
// `pnpm demo` points a Frizz at it. The tool names and result shapes follow T3's contracts
// (`packages/contracts/src/orchestratorMcp.ts`); the sign-in follows T3's (`auth/McpOAuth.ts`):
// protected-resource metadata, dynamic registration, PKCE, public client, no refresh token.
// Unlike T3 it approves every sign-in at once, with no approval page.
//
// Its "agents" are scripted: a send starts a run, and a moment later the run completes with a
// reply. A prompt containing "ask" ends waiting on a question instead, and one containing "fail"
// fails, so every band of the board can be reached.

import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { T3PendingRequest, T3Project, T3ThreadDetail, T3TimelineItem, ThreadStatus } from "../shared/types.ts";

export interface MockOptions {
  port?: number;
  /** Require OAuth, as a real environment does. Default true. */
  auth?: boolean;
  /** How long a scripted run takes. */
  runMs?: number;
  /** Seed a lived-in board. Default true. */
  seed?: boolean;
}

export interface RunningMock {
  url: string;
  mcpUrl: string;
  world: World;
  /** How many tokens the mock has issued (one per completed sign-in). */
  issued(): number;
  /** Revoke every token, as a 30-day expiry would. */
  expireTokens(): void;
  close(): Promise<void>;
}

// ---------------------------------------------------------------- the world

interface MockThread extends T3ThreadDetail {
  items: T3TimelineItem[];
  requests: T3PendingRequest[];
  timer?: NodeJS.Timeout;
}

export class World {
  projects: T3Project[] = [];
  threads = new Map<string, MockThread>();
  private position = 0;

  private readonly runMs: number;

  constructor(runMs: number) {
    this.runMs = runMs;
  }

  addProject(title: string, root: string): T3Project {
    const p: T3Project = { id: `proj_${slug(title)}`, title, workspaceRoot: root, updatedAt: iso(0) };
    this.projects.push(p);
    return p;
  }

  addThread(projectId: string, title: string, over: Partial<MockThread> = {}, agoMin = 5): MockThread {
    const id = `thr_${randomUUID().slice(0, 8)}`;
    const t: MockThread = {
      threadId: id,
      projectId,
      title,
      link: `https://t3.example/threads/${id}`,
      status: "idle",
      latestRunId: null,
      activeRunId: null,
      model: "claude-opus-5-5",
      providerInstanceId: "claude",
      runtimeMode: "full-access",
      interactionMode: "default",
      settled: false,
      settledAt: null,
      snoozed: false,
      snoozedUntil: null,
      pinned: false,
      pendingBackgroundTasks: [],
      parentThreadId: null,
      relationshipToParent: null,
      itemCount: 0,
      createdAt: iso(agoMin + 30),
      updatedAt: iso(agoMin),
      branch: `t3/${slug(title)}`,
      worktreePath: null,
      pendingRequestCount: 0,
      archived: false,
      runCount: 0,
      items: [],
      requests: [],
      ...over,
    };
    this.threads.set(id, t);
    return t;
  }

  say(t: MockThread, type: string, text: string, agoMin = 0, title: string | null = null) {
    t.items.push({
      position: this.position++,
      itemId: `itm_${randomUUID().slice(0, 8)}`,
      runId: t.latestRunId,
      type,
      status: "completed",
      title,
      text,
      textTruncated: false,
      updatedAt: iso(agoMin),
    });
    t.itemCount = t.items.length;
  }

  /** A run: the prompt lands, the agent works, and it ends as the prompt's words decide. */
  run(t: MockThread, prompt: string) {
    clearTimeout(t.timer);
    t.latestRunId = t.activeRunId = `run_${randomUUID().slice(0, 8)}`;
    t.runCount++;
    t.status = "running";
    t.settled = false;
    t.settledAt = null;
    t.updatedAt = iso(0);
    this.say(t, "user_message", prompt);
    t.timer = setTimeout(() => {
      this.say(t, "command_execution", "$ pnpm test\n✓ 42 passed", 0, "Run tests");
      t.activeRunId = null;
      t.updatedAt = iso(0);
      if (/\bfail/i.test(prompt)) {
        t.status = "failed";
        this.say(t, "error", "The provider stopped: rate limit reached.");
      } else if (/\bask\b/i.test(prompt)) {
        t.status = "waiting";
        t.pendingRequestCount = 1;
        t.requests = [
          {
            requestId: `req_${randomUUID().slice(0, 8)}`,
            questions: [
              {
                id: "q1",
                header: "Approach",
                question: "Which way should I take this?",
                options: [
                  { label: "Small and safe", description: "Touch only the failing module." },
                  { label: "Clean it up", description: "Refactor the module and its callers." },
                ],
              },
            ],
          },
        ];
      } else {
        t.status = "completed";
        this.say(t, "assistant_message", `Done. I looked at **${t.title}** and made the change.\n\n- Updated the handler\n- Added a test`);
      }
    }, this.runMs);
  }
}

function seed(w: World) {
  const web = w.addProject("Atlas web", "/Users/me/code/atlas-web");
  const api = w.addProject("Atlas API", "/Users/me/code/atlas-api");

  const ask = w.addThread(web.id, "Fix the flaky checkout test", { status: "waiting", pendingRequestCount: 1 }, 42);
  w.say(ask, "user_message", "The checkout e2e test fails one run in five. Find out why and fix it.", 60);
  w.say(ask, "reasoning", "Looking at the retry logic around the payment iframe.", 55);
  w.say(ask, "command_execution", "$ pnpm e2e checkout --repeat 20\n4 of 20 failed", 50, "Repeat the test");
  w.say(
    ask,
    "assistant_message",
    "The test races the payment iframe's load event. I can either wait on the iframe explicitly, or rework the fixture so the iframe is ready before the test starts.",
    43,
  );
  ask.requests = [
    {
      requestId: "req_seed",
      questions: [
        {
          id: "q1",
          header: "Fix",
          question: "Which fix do you want?",
          options: [
            { label: "Wait on the iframe", description: "One line in the test. Keeps the fixture as it is." },
            { label: "Rework the fixture", description: "Slower to land, but every payment test gets faster." },
          ],
        },
      ],
    },
  ];

  const report = w.addThread(api.id, "Add rate limits to the public API", { status: "completed" }, 18);
  w.say(report, "user_message", "Add per-key rate limits to every public route. 100 requests a minute.", 70);
  w.say(report, "file_change", "src/middleware/rateLimit.ts\n+64 -0", 30, "rateLimit.ts");
  w.say(report, "command_execution", "$ pnpm test\n✓ 318 passed", 20, "Run tests");
  w.say(
    report,
    "assistant_message",
    "Rate limits are on every public route.\n\n- **100 requests a minute** per API key, with a `Retry-After` header on a 429\n- Limits live in Redis, so they hold across instances\n- 6 new tests cover the window edges\n\nThe PR is ready for review.",
    18,
  );
  report.pullRequests = [{ url: "https://github.com/example/atlas-api/pull/214", number: 214, state: "open" }];

  const failed = w.addThread(web.id, "Upgrade the router to v8", { status: "failed" }, 9);
  w.say(failed, "user_message", "Upgrade react-router to v8 and fix whatever breaks.", 40);
  w.say(failed, "error", "The provider stopped: usage limit reached. It resets in 2h.", 9);

  const running = w.addThread(api.id, "Write the migration for invoice totals", { status: "running" }, 1);
  w.say(running, "user_message", "Backfill invoice totals into the new column, in batches.", 4);
  w.say(running, "reasoning", "Reading the invoices schema.", 2);

  const running2 = w.addThread(web.id, "Make the settings page load faster", { status: "running" }, 0);
  w.say(running2, "user_message", "Settings takes 3s to load. Get it under 500ms.", 12);

  const bg = w.addThread(
    api.id,
    "Watch CI on the auth refactor",
    {
      status: "completed",
      pendingBackgroundTasks: [{ taskId: "t1", kind: "monitor", description: "CI on #209" }],
    },
    6,
  );
  w.say(bg, "user_message", "Keep an eye on CI for the auth refactor and fix anything red.", 30);

  const snoozed = w.addThread(
    web.id,
    "Revisit the onboarding copy",
    { status: "completed", snoozed: true, snoozedUntil: new Date(Date.now() + 3 * 3600_000).toISOString() },
    120,
  );
  w.say(snoozed, "assistant_message", "Drafted three versions of the onboarding copy.", 120);

  const pinned = w.addThread(api.id, "Q4 performance budget", { status: "completed", pinned: true }, 300);
  w.say(pinned, "assistant_message", "Tracking: p95 under 200ms on every read route.", 300);

  for (const [title, ago] of [
    ["Rename the billing tables", 1500],
    ["Fix the dark mode contrast in charts", 3000],
    ["Document the webhook retries", 9000],
  ] as const) {
    const d = w.addThread(web.id, title, { status: "completed", settled: true, settledAt: iso(ago) }, ago);
    w.say(d, "assistant_message", "Done.", ago);
  }
}

// ---------------------------------------------------------------- the tools

type Args = Record<string, unknown>;

function tools(w: World): Record<string, (a: Args) => unknown> {
  const get = (id: unknown) => {
    const t = w.threads.get(String(id));
    if (!t) throw new ToolFailure(`No thread ${String(id)}.`);
    return t;
  };
  const listItem = (t: MockThread) => {
    const { items: _i, requests: _r, timer: _t, ...rest } = t;
    return rest;
  };
  return {
    t3_project_list: () => ({ projects: w.projects, nextCursor: null }),
    t3_thread_list: (a) => {
      let all = [...w.threads.values()].filter((t) => !t.archived);
      if (!a.allProjects) {
        if (!a.projectId) throw new ToolFailure("Pass projectId or allProjects outside a thread.");
        all = all.filter((t) => t.projectId === a.projectId);
      }
      all.sort((x, y) => Date.parse(y.updatedAt) - Date.parse(x.updatedAt));
      return { projectId: a.projectId ?? null, currentThreadId: null, threads: all.map(listItem), nextCursor: null, total: all.length };
    },
    t3_thread_read: (a) => {
      const t = get(a.threadId);
      const limit = Number(a.limit ?? 50);
      const before = a.beforePosition === undefined ? Infinity : Number(a.beforePosition);
      const older = t.items.filter((i) => i.position < before);
      const page = older.slice(-limit);
      const earlier = older.length > page.length ? page[0]!.position : null;
      return {
        thread: listItem(t),
        recentRuns: [],
        items: [...page].reverse(),
        nextPosition: null,
        hasMore: earlier !== null,
        earlierPosition: earlier,
      };
    },
    t3_thread_launch: (a) => {
      const projectId = a.projectId ? String(a.projectId) : (w.projects[0]?.id ?? "scratch");
      const t = w.addThread(projectId, String(a.title), {}, 0);
      if (a.message) w.run(t, String(a.message));
      return { threadId: t.threadId, link: t.link, projectId, modelSelection: { instanceId: "claude", model: t.model }, runId: t.latestRunId, status: t.status === "idle" ? null : t.status };
    },
    t3_thread_send: (a) => {
      const t = get(a.threadId);
      const delivery = t.status === "running" ? "steered" : "started";
      t.requests = [];
      t.pendingRequestCount = 0;
      w.run(t, String(a.message));
      return { threadId: t.threadId, messageId: `msg_${randomUUID().slice(0, 8)}`, runId: t.latestRunId, status: "running", delivery };
    },
    t3_thread_interrupt: (a) => {
      const t = get(a.threadId);
      if (t.status !== "running") return { threadId: t.threadId, runId: null, status: "no_active_run" };
      clearTimeout(t.timer);
      t.status = "interrupted";
      t.activeRunId = null;
      t.updatedAt = iso(0);
      return { threadId: t.threadId, runId: t.latestRunId, status: "interrupt_requested" };
    },
    t3_thread_organize: (a) => {
      const t = get(a.threadId);
      const now = iso(0);
      switch (a.action) {
        case "pin": t.pinned = true; break;
        case "unpin": t.pinned = false; break;
        case "settle": t.settled = true; t.settledAt = now; break;
        case "unsettle": t.settled = false; t.settledAt = null; break;
        case "snooze":
          if (!a.snoozedUntil) throw new ToolFailure("snooze needs snoozedUntil.");
          t.snoozed = true; t.snoozedUntil = String(a.snoozedUntil); break;
        case "unsnooze": t.snoozed = false; t.snoozedUntil = null; break;
        case "archive": t.archived = true; break;
        case "unarchive": t.archived = false; break;
        case "mark_unread": break;
        default: throw new ToolFailure(`Unknown action ${String(a.action)}.`);
      }
      return { sequence: w.threads.size };
    },
    t3_thread_update: (a) => {
      const t = get(a.threadId);
      if (a.action === "rename") t.title = String(a.title);
      return { threadId: t.threadId, title: t.title };
    },
    t3_pending_request: (a) => {
      const t = get(a.threadId);
      if (a.action === "list") return { requestIds: t.requests.map((r) => r.requestId) };
      const r = t.requests.find((x) => x.requestId === a.requestId);
      if (!r) throw new ToolFailure(`No pending request ${String(a.requestId)}.`);
      if (a.action === "read") return r;
      const answer = Object.values((a.answers ?? {}) as Record<string, unknown>).join(", ");
      t.requests = t.requests.filter((x) => x !== r);
      t.pendingRequestCount = t.requests.length;
      w.run(t, `Answered: ${answer}`);
      return { sequence: 1 };
    },
  };
}

class ToolFailure extends Error {}

function mcpServer(w: World): Server {
  const handlers = tools(w);
  const server = new Server({ name: "T3 Code (mock)", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.keys(handlers).map((name) => ({ name, inputSchema: { type: "object" as const } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const fn = handlers[req.params.name];
    if (!fn) return { isError: true, content: [{ type: "text", text: `Unknown tool ${req.params.name}` }] };
    try {
      const out = fn((req.params.arguments ?? {}) as Args) as Record<string, unknown>;
      return { structuredContent: out, content: [{ type: "text", text: JSON.stringify(out) }] };
    } catch (err) {
      const failure = { _tag: "OrchestratorMcpFailure", message: (err as Error).message };
      return { isError: true, structuredContent: failure, content: [{ type: "text", text: JSON.stringify(failure) }] };
    }
  });
  return server;
}

// ---------------------------------------------------------------- the sign-in

class MockAuth implements OAuthServerProvider {
  private clients = new Map<string, OAuthClientInformationFull>();
  private codes = new Map<string, { client: string; params: AuthorizationParams }>();
  tokens = new Map<string, AuthInfo>();
  issued = 0;

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (id) => this.clients.get(id),
      registerClient: (c) => {
        const full = { ...c, client_id: `client_${randomUUID().slice(0, 8)}`, client_id_issued_at: Math.floor(Date.now() / 1000) };
        this.clients.set(full.client_id, full);
        return full;
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: express.Response) {
    const code = randomUUID();
    this.codes.set(code, { client: client.client_id, params });
    const to = new URL(params.redirectUri);
    to.searchParams.set("code", code);
    if (params.state) to.searchParams.set("state", params.state);
    res.redirect(to.toString());
  }

  async challengeForAuthorizationCode(_c: OAuthClientInformationFull, code: string) {
    const c = this.codes.get(code);
    if (!c) throw new Error("Unknown code.");
    return c.params.codeChallenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<OAuthTokens> {
    const c = this.codes.get(code);
    if (!c || c.client !== client.client_id) throw new Error("Bad code.");
    this.codes.delete(code);
    const token = randomUUID();
    const ttl = 30 * 24 * 3600;
    this.tokens.set(token, { token, clientId: client.client_id, scopes: [], expiresAt: Math.floor(Date.now() / 1000) + ttl });
    this.issued++;
    return { access_token: token, token_type: "bearer", expires_in: ttl };
  }

  async exchangeRefreshToken(): Promise<OAuthTokens> {
    throw new Error("T3 Code issues no refresh tokens.");
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const info = this.tokens.get(token);
    if (!info) throw new InvalidTokenError("Unknown or expired token.");
    return info;
  }
}

// ---------------------------------------------------------------- the server

export async function startMock(opts: MockOptions = {}): Promise<RunningMock> {
  const world = new World(opts.runMs ?? 1500);
  if (opts.seed !== false) seed(world);
  const app = express();
  app.set("trust proxy", false);
  const http: HttpServer = await new Promise((resolve) => {
    const s = app.listen(opts.port ?? 0, "127.0.0.1", () => resolve(s));
  });
  const port = (http.address() as { port: number }).port;
  const base = `http://localhost:${port}`;
  const mcpUrl = new URL(`${base}/mcp`);
  const auth = new MockAuth();

  const guards: express.RequestHandler[] = [];
  if (opts.auth !== false) {
    app.use(mcpAuthRouter({ provider: auth, issuerUrl: new URL(base), resourceServerUrl: mcpUrl, resourceName: "T3 Code (mock)" }));
    guards.push(requireBearerAuth({ verifier: auth, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) }));
  }
  app.all("/mcp", express.json(), ...guards, async (req, res) => {
    // Stateless: one server and transport per request, as T3's HTTP endpoint behaves for a client.
    const server = mcpServer(world);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void transport.close().then(() => server.close()));
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return {
    url: base,
    mcpUrl: mcpUrl.toString(),
    world,
    issued: () => auth.issued,
    expireTokens: () => auth.tokens.clear(),
    close: () =>
      new Promise((resolve) => {
        for (const t of world.threads.values()) clearTimeout(t.timer);
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}

function iso(minutesAgo: number) {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export type { ThreadStatus };
