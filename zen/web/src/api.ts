import { useCallback, useEffect, useRef, useState } from "react";
import type { Board } from "../../shared/board.ts";
import type { ConnectionState, OrganizeAction, SendMode, T3Project, ThreadPage } from "../../shared/types.ts";

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, json.error ?? `${res.status} ${res.statusText}`);
  return json;
}

export const api = {
  connection: () => req<{ state: ConnectionState; projectId: string | null }>("GET", "/api/connection"),
  connect: (url?: string) => req<{ state: ConnectionState }>("POST", "/api/connection", url ? { url } : {}),
  forget: () => req<{ state: ConnectionState }>("DELETE", "/api/connection"),
  setProject: (projectId: string | null) => req("POST", "/api/project", { projectId }),
  projects: () => req<{ projects: T3Project[] }>("GET", "/api/projects"),
  board: (projectId: string | null) =>
    req<{ board: Board }>("GET", `/api/board${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  thread: (id: string) => req<ThreadPage>("GET", `/api/threads/${encodeURIComponent(id)}`),
  launch: (message: string, projectId: string | null) =>
    req<{ threadId: string }>("POST", "/api/threads", { message, projectId: projectId ?? undefined }),
  send: (id: string, message: string, mode: SendMode = "auto") =>
    req("POST", `/api/threads/${encodeURIComponent(id)}/send`, { message, mode }),
  stop: (id: string) => req("POST", `/api/threads/${encodeURIComponent(id)}/stop`, {}),
  organize: (id: string, action: OrganizeAction, snoozedUntil?: string) =>
    req("POST", `/api/threads/${encodeURIComponent(id)}/organize`, { action, snoozedUntil }),
  respond: (id: string, requestId: string, answers: Record<string, unknown>) =>
    req("POST", `/api/threads/${encodeURIComponent(id)}/respond`, { requestId, answers }),
};

/**
 * Polls `load` every `ms` while the tab is visible, and at once on `refresh()` or when `key`
 * changes. Keeps the last good value through a failed poll, so a blip does not blank the page.
 */
export function usePoll<T>(key: string | null, load: () => Promise<T>, ms: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    if (key === null) return;
    const mine = ++seq.current;
    try {
      const v = await loadRef.current();
      if (mine === seq.current) {
        setData(v);
        setError(null);
      }
    } catch (e) {
      if (mine === seq.current) setError(e as Error);
    }
  }, [key]);

  useEffect(() => {
    setData(null);
    setError(null);
    if (key === null) return;
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, ms);
    const onVisible = () => document.visibilityState === "visible" && void refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [key, ms, refresh]);

  return { data, error, refresh };
}
