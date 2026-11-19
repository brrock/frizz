// Frizz's server: one loopback HTTP server that serves the page and turns its requests into T3
// MCP calls. It owns no thread state; T3 Code does.
//
// It binds 127.0.0.1 only. Its token can start agents, so it also refuses a cross-site write: a
// write must be JSON (which a cross-origin page cannot send without a preflight this server never
// answers) and, when the browser names an Origin, it must be this server's own.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { buildBoard } from "../shared/board.ts";
import type { OrganizeAction, SendMode } from "../shared/types.ts";
import { StateFile } from "./store.ts";
import { T3Connection, T3Error } from "./t3.ts";

export interface ServerOptions {
  port?: number;
  host?: string;
  /** Where state.json lives. */
  home?: string;
  /** The built page. Absent: API only (the Vite dev server serves the page). */
  staticDir?: string;
  /** The origin T3 sends the OAuth redirect back to; defaults to http://localhost:<port>. */
  publicOrigin?: string;
}

export interface RunningServer {
  url: string;
  port: number;
  t3: T3Connection;
  close(): Promise<void>;
}

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const host = opts.host ?? "127.0.0.1";
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, host, resolve));
  const port = (server.address() as { port: number }).port;
  const origin = opts.publicOrigin ?? `http://localhost:${port}`;
  const store = new StateFile(opts.home);
  const t3 = new T3Connection(store, `${origin}/oauth/callback`);
  if (store.get().mcpUrl) void t3.connect();

  server.on("request", (req, res) => {
    handle(req, res, { t3, store, staticDir: opts.staticDir, port }).catch((err) => {
      const status = err instanceof T3Error ? err.status : err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  return {
    url: `http://${host}:${port}`,
    port,
    t3,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Ctx {
  t3: T3Connection;
  store: StateFile;
  staticDir?: string;
  port: number;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, ctx: Ctx) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;
  const { t3, store } = ctx;

  if (req.method !== "GET" && req.method !== "HEAD") guardWrite(req, ctx.port);

  // ---- connection ----
  if (p === "/api/connection" && req.method === "GET") {
    return sendJson(res, 200, { state: t3.state, projectId: store.get().projectId ?? null });
  }
  if (p === "/api/connection" && req.method === "POST") {
    const body = await readJson<{ url?: string; retry?: boolean }>(req);
    if (body.url) return sendJson(res, 200, { state: await t3.connect(body.url) });
    return sendJson(res, 200, { state: await t3.connect() });
  }
  if (p === "/api/connection" && req.method === "DELETE") {
    await t3.forget();
    return sendJson(res, 200, { state: t3.state });
  }
  if (p === "/oauth/callback" && req.method === "GET") {
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (error || !code) {
      const why = url.searchParams.get("error_description") ?? error ?? "T3 Code sent no code back.";
      return redirect(res, `/?signin_error=${encodeURIComponent(why)}`);
    }
    try {
      await t3.finishAuth(code);
      return redirect(res, "/");
    } catch (err) {
      return redirect(res, `/?signin_error=${encodeURIComponent(err instanceof Error ? err.message : String(err))}`);
    }
  }

  // ---- preferences ----
  if (p === "/api/project" && req.method === "POST") {
    const { projectId } = await readJson<{ projectId?: string | null }>(req);
    store.update({ projectId: projectId ?? undefined });
    return sendJson(res, 200, { projectId: projectId ?? null });
  }

  // ---- reads ----
  if (p === "/api/projects" && req.method === "GET") {
    return sendJson(res, 200, { projects: await t3.listProjects() });
  }
  if (p === "/api/board" && req.method === "GET") {
    const projectId = url.searchParams.get("projectId") ?? undefined;
    const threads = await t3.listThreads(projectId);
    return sendJson(res, 200, { board: buildBoard(threads), at: new Date().toISOString() });
  }

  const m = p.match(/^\/api\/threads\/([^/]+)(?:\/([a-z-]+))?$/);
  if (m) {
    const id = decodeURIComponent(m[1]!);
    const verb = m[2];
    if (!verb && req.method === "GET") {
      const before = url.searchParams.get("before");
      return sendJson(res, 200, await t3.readThread(id, { beforePosition: before ? Number(before) : undefined }));
    }
    if (req.method === "POST") {
      const body = await readJson<Record<string, unknown>>(req);
      switch (verb) {
        case "send": {
          const message = requireText(body.message, "message");
          return sendJson(res, 200, await t3.send(id, message, (body.mode as SendMode) ?? "auto"));
        }
        case "stop":
          return sendJson(res, 200, await t3.stop(id));
        case "organize": {
          const action = body.action as OrganizeAction;
          if (!ORGANIZE.has(action)) throw new HttpError(400, `Unknown action ${String(action)}.`);
          return sendJson(res, 200, await t3.organize(id, action, body.snoozedUntil as string | undefined));
        }
        case "rename":
          return sendJson(res, 200, await t3.rename(id, requireText(body.title, "title")));
        case "respond":
          return sendJson(
            res,
            200,
            await t3.respond(id, requireText(body.requestId, "requestId"), (body.answers ?? {}) as Record<string, unknown>),
          );
      }
    }
  }
  if (p === "/api/threads" && req.method === "POST") {
    const body = await readJson<{ projectId?: string; message?: string; title?: string }>(req);
    const message = requireText(body.message, "message");
    const title = body.title?.trim() || titleFrom(message);
    return sendJson(res, 200, await t3.launch({ projectId: body.projectId, title, message, scratch: !body.projectId }));
  }

  if (p.startsWith("/api/")) throw new HttpError(404, `No route for ${req.method} ${p}.`);
  return serveStatic(res, p, ctx.staticDir);
}

const ORGANIZE = new Set<OrganizeAction>([
  "pin",
  "unpin",
  "snooze",
  "unsnooze",
  "settle",
  "unsettle",
  "archive",
  "mark_unread",
]);

/** A thread's title from its first prompt: the first line, cut at a word near 60 characters. */
export function titleFrom(message: string): string {
  const line = message.trim().split("\n")[0]!.replace(/\s+/g, " ");
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  const space = cut.lastIndexOf(" ");
  return `${(space > 30 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function guardWrite(req: http.IncomingMessage, port: number) {
  if (req.url?.startsWith("/oauth/")) return;
  const type = req.headers["content-type"] ?? "";
  if (!type.startsWith("application/json") && req.method !== "DELETE") {
    throw new HttpError(415, "Writes must be JSON.");
  }
  const origin = req.headers.origin;
  if (origin) {
    const o = new URL(origin);
    const loopback = o.hostname === "localhost" || o.hostname === "127.0.0.1" || o.hostname === "[::1]";
    // The Vite dev server proxies from its own port; any loopback origin is this machine's.
    if (!loopback) throw new HttpError(403, "Cross-site write refused.");
    void port;
  }
}

function requireText(v: unknown, name: string): string {
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `${name} is required.`);
  return v;
}

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, "Body too large.");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new HttpError(400, "Body is not JSON.");
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function redirect(res: http.ServerResponse, to: string) {
  res.writeHead(302, { location: to });
  res.end();
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

function serveStatic(res: http.ServerResponse, p: string, dir?: string) {
  if (!dir) {
    res.writeHead(404).end("Frizz's page is served by the dev server.");
    return;
  }
  const root = path.resolve(dir);
  let file = path.resolve(root, `.${decodeURIComponent(p)}`);
  if (!file.startsWith(root)) return res.writeHead(403).end();
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, "index.html");
  if (!fs.existsSync(file)) return res.writeHead(404).end("Build the page first: pnpm build");
  const immutable = file.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, {
    "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  fs.createReadStream(file).pipe(res);
}
