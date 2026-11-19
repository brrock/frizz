// The slice of T3 Code's MCP contract Frizz reads.
//
// Copied by hand from pingdotgg/t3code `packages/contracts/src/orchestratorMcp.ts` (HEAD 26b872b4,
// 2026-11-18), keeping only the fields Frizz draws. Every field T3 marks "absent from linked
// environments that predate it" is optional here too, so an older environment still renders.

export type RunStatus =
  | "preparing"
  | "queued"
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "interrupted"
  | "failed"
  | "cancelled"
  | "rolled_back";

/** A thread with no run yet reads `idle`. */
export type ThreadStatus = "idle" | RunStatus;

export interface BackgroundTask {
  taskId: string;
  kind: "subagent" | "command" | "monitor" | "background_task";
  description?: string;
  awaited?: true;
  childThreadId?: string;
}

export interface PullRequestRef {
  url: string;
  number?: number;
  state?: string | null;
}

/** `t3_thread_list` → `threads[]`. */
export interface T3Thread {
  threadId: string;
  projectId: string;
  title: string;
  link?: string;
  status: ThreadStatus;
  latestRunId: string | null;
  model: string;
  providerInstanceId?: string;
  runtimeMode?: string;
  interactionMode?: string;
  pullRequests?: PullRequestRef[];
  settled: boolean;
  settledAt: string | null;
  snoozed: boolean;
  snoozedUntil: string | null;
  pinned?: boolean;
  blockedOnThreadWait?: boolean;
  pendingBackgroundTasks?: BackgroundTask[];
  parentThreadId: string | null;
  relationshipToParent: "fork" | "subagent" | null;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

/** `t3_thread_read` → `thread`: the list item plus what only a read carries. */
export interface T3ThreadDetail extends T3Thread {
  activeRunId: string | null;
  branch: string | null;
  worktreePath: string | null;
  pendingRequestCount: number;
  archived: boolean;
  runCount: number;
}

/** `t3_thread_read` → `items[]`. Newest first on the wire. */
export interface T3TimelineItem {
  position: number;
  itemId: string;
  runId: string | null;
  /** "user_message", "assistant_message", tool and reasoning kinds, … — T3 leaves it open. */
  type: string;
  status: string;
  title: string | null;
  text: string | null;
  textTruncated: boolean;
  updatedAt: string;
}

export interface T3Run {
  runId: string;
  ordinal: number;
  status: RunStatus;
  model: string;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

/** `t3_project_list` → `projects[]`. */
export interface T3Project {
  id: string;
  title: string;
  workspaceRoot: string;
  pinnedAt?: string | null;
  archivedAt?: string | null;
  updatedAt: string;
}

/** `t3_pending_request` read → one question card. */
export interface T3Question {
  id: string;
  header: string;
  question: string;
  options: { label: string; description: string; value?: string }[];
  multiSelect?: boolean;
  allowCustomAnswer?: boolean;
}

export interface T3PendingRequest {
  requestId: string;
  questions: T3Question[];
}

// ---- Frizz's own API, between its server and its page ----

export type ConnectionState =
  | { phase: "unconfigured" }
  | { phase: "connecting"; url: string }
  /** T3 Connect wants a sign-in: open `authUrl`, approve, and T3 sends the browser back here. */
  | { phase: "needs-sign-in"; url: string; authUrl: string }
  | { phase: "connected"; url: string; serverName: string; toolCount: number }
  | { phase: "error"; url: string; message: string };

export interface ThreadPage {
  thread: T3ThreadDetail;
  runs: T3Run[];
  /** Oldest first, ready to draw. */
  items: T3TimelineItem[];
  /** Older items exist above this page. */
  hasEarlier: boolean;
  requests: T3PendingRequest[];
}

export type OrganizeAction =
  | "pin"
  | "unpin"
  | "snooze"
  | "unsnooze"
  | "settle"
  | "unsettle"
  | "archive"
  | "mark_unread";

export type SendMode = "auto" | "queue" | "steer" | "restart";
