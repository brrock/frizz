# Frizz for T3 Code

A calm board over your [T3 Code](https://github.com/pingdotgg/t3code) threads. Frizz no longer
runs agents itself: T3 Code does. Frizz connects to the MCP server that **T3 Connect** gives each
T3 Code environment and becomes its control plane: one queue of what is waiting on you, one pane
to read and answer it, and the keys to move through it fast.

It keeps Frizz's board and its words: the prompt box at the top of the rail, then the queue,
**Active**, **Snoozed** and **Done**, and the one-thread pane that steps through the queue.

## Run it

```sh
cd zen
pnpm install
pnpm build
pnpm start            # http://localhost:4777
```

Open it, paste your environment's MCP URL, and approve Frizz once on the T3 Connect sign-in page.
To find the URL in T3 Code, open **Settings → Environments** and choose **Copy MCP URL** from the
environment's menu. It looks like `https://<environment-address>/mcp`. The T3 Connect address works
from anywhere; `localhost` works when Frizz runs on the same machine as T3 Code.

The sign-in lasts 30 days, which is how long T3 Code's access lasts. After that, Frizz shows the
sign-in step again. It keeps the credential in `~/.frizz-zen/state.json` (mode 0600; override the
folder with `FRIZZ_ZEN_HOME`), and serves on `127.0.0.1` only.

### Try it without T3 Code

```sh
pnpm demo
```

This starts a stand-in T3 Code environment, with the same MCP tools and the same OAuth sign-in, plus a
Frizz pointed at it. A prompt containing "ask" ends on a question, and one containing "fail" fails.

## How the board reads T3

Frizz keeps no thread state. Every band is computed from `t3_thread_list` (`shared/board.ts`):

| Band | T3 threads |
| --- | --- |
| Pinned | `pinned` |
| Rested (the queue) | at rest and not settled or snoozed: a question (`waiting`), a failure, or a finished run. Longest wait first. |
| Active | `preparing`, `queued`, `starting`, `running`, or at rest on background work still in motion |
| Snoozed | `snoozed` until a time that has not passed |
| Done | `settled` |

Every action is a T3 tool call (`server/t3.ts`):

| In Frizz | T3 tool |
| --- | --- |
| Prompt box (new thread) | `t3_thread_launch` |
| Reply / steer | `t3_thread_send`, `mode: "auto"` |
| Stop | `t3_thread_interrupt`, `stop: true` |
| Done, Snooze, Pin | `t3_thread_organize` (`settle`, `snooze`, `pin`) |
| Answering a question | `t3_pending_request` (`list`, `read`, `respond`) |

## Keys

<kbd>J</kbd> / <kbd>K</kbd> move through the board, <kbd>E</kbd> marks done and opens the next
in the queue, <kbd>R</kbd> replies, <kbd>/</kbd> starts a thread, <kbd>⌘⏎</kbd> sends, and
<kbd>⇧⌘⏎</kbd> sends and opens the next.

## Develop

```sh
pnpm dev         # API on :4777, page with hot reload on :5173 (open :5173)
pnpm test        # the board rules, and the server against the stand-in, sign-in included
pnpm typecheck
```

`server/` is the loopback server and its MCP client, `web/` is the page (React and plain CSS),
`shared/` holds what both read, and `mock/` is the stand-in T3 Code.
