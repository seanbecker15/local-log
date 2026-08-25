# tiny-log-mcp

[![CI](https://github.com/seanbecker15/tiny-log-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/seanbecker15/tiny-log-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/tiny-log-mcp.svg)](https://www.npmjs.com/package/tiny-log-mcp)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](https://nodejs.org/)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An ephemeral local log collector with an [MCP](https://modelcontextprotocol.io) server, so a
coding agent can read what your app printed — in a browser, on a phone, or in a backend
process — instead of asking you to paste console output. Zero runtime dependencies.

## Requirements

- Node.js 22 or newer.
- A local MCP client. Claude Code and local Codex clients have first-class setup below.
- npm access the first time `npx` downloads the package, unless it is already installed.

## Install

Choose your client:

```sh
# Claude Code
claude mcp add tiny-log -- npx -y tiny-log-mcp

# Codex CLI, desktop app, and IDE extension
codex mcp add tiny-log -- npx -y tiny-log-mcp
```

Restart the client if it was already open. The client starts the server as a local process when
needed and stops it when the MCP session closes.

## Quick start

1. Ask the agent: **“Use tiny-log to inspect my app logs.”** It calls `listen` and reports the
   actual listener URL.
2. For a backend or terminal process, pipe the development command:

   ```sh
   npm run dev 2>&1 | npx -y tiny-log-mcp pipe --source api
   ```

   For a web app, the agent calls `hint`, inspects the existing logging setup, and returns the
   appropriate snippet.
3. Reproduce the problem. The agent reads immediately with `read_logs`, waits for a particular
   result with `await_logs`, or starts a longer Claude Monitor / persistent `tail` watch.

What the agent gets back is compact and cursor-based:

```text
2 entries, times UTC (cursor 4813). Pass after=4813 to read only newer ones.
#4812 12:04:31.220 ERROR api TypeError: Cannot read properties of undefined (reading 'id')
        at OrderService.load (src/orders.ts:88:14)
    meta: {"reqId":"r1"}
#4813 12:04:31.221 WARN  web fetch /api/orders 500
    (repeated ×36, through #4849)
```

## Compatibility

| Client | Setup | Longer watch |
| ------ | ----- | ------------ |
| Claude Code | `claude mcp add tiny-log -- npx -y tiny-log-mcp` | Native Monitor on the WebSocket stream |
| Codex CLI, desktop, and IDE extension | `codex mcp add tiny-log -- npx -y tiny-log-mcp` | `tiny-log-mcp tail` in a persistent terminal session |
| Other local stdio MCP clients | Configure `npx -y tiny-log-mcp` as a stdio server | `tail` or the `/stream` WebSocket |
| Remote or cloud agents | Requires a network path from the agent to the listener | Not turnkey; the default listener is local-only |

## How it works

`tiny-log-mcp` runs one process per agent session. It speaks MCP over stdio and, in the same
process, listens on `http://127.0.0.1:7710` for logs. Nothing is persisted, nothing runs in the
background after the session ends, and every session gets its own buffer.

```
  your app ──► POST /ingest ──► ring buffer ──► read_logs / await_logs (MCP)
  (browser, device, backend)          │                       │
                                      └──► logs UI at /        └──► activity UI at /activity
```

Filtering happens when logs are **read**, never when they arrive, so several agents (or
sub-agents) can watch the same buffer with different filters.

## Web UI

The URL returned by `listen` opens a live, filterable log viewer. Its floating monitor indicator
opens `/activity`, which separates active WebSocket streams, in-flight `await_logs` calls, and UI
viewers. The activity transcript shows the exact formatted text returned by `read_logs` and
`await_logs`, plus each frame delivered to a Claude Monitor or `tail` stream.

“Active monitors” counts concurrent waits and streams, not unique agents: MCP and WebSocket
clients do not provide a stable agent identity. The transcript is bounded, exists only in memory,
and can be cleared independently of the application log buffer.

## Wiring an app

**A backend or terminal process needs no setup at all** — pipe it:

```sh
npm run dev 2>&1 | npx -y tiny-log-mcp pipe --source api
```

The guided wiring targets **web apps** (recipes for more ecosystems are welcome contributions;
anything can always `POST /ingest`):

1. **If the app has a log implementation** (a wrapper around logging), use it: insert logs through
   it at levels you'd be comfortable shipping — prefixes are fine, dev-gate anything temporary.
2. **If that implementation is level-gated** (config/env/feature flags), adjust the level locally,
   dev-gated. Don't fight the gate.
3. **If there is no log implementation**, log with `console.*`.
4. **Call `hint` with the log implementation** — `hint({logs: "wrapper" | "native" | "none"})` —
   and get the exact recipe: make the logs flow (the rules above with snippets filled in), then
   deliver them. Delivery matches the implementation: a **wrapper** forwards from the wrapper
   itself (one dev-gated `fetch` where it emits — you're already editing it to adjust the level);
   **native**/**none** inject `client.js` (DevTools one-liner with no code change, or a dev-gated
   tag in source), which forwards `console.*` and uncaught errors.

**A phone or another machine** — bind to all interfaces: `listen` with `host: "0.0.0.0"` (or
`TINY_LOG_HOST=0.0.0.0`). The tool prints the LAN addresses to use.

**Across sessions** — the instructions tell the agent to check project memory and the project's
agent docs (`AGENTS.md`/`CLAUDE.md`) for a recorded setup before doing any of this, and to record
the setup (logs, hook location, filters) there once verified. Logs inserted at shippable levels
are simply kept; only tagged temporary ones get removed.

## MCP tools

| Tool         | Arguments                                                                  | Purpose                                                                                                     |
| ------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `listen`     | `port?`, `host?`                                                           | Start (or report) the listener; returns the Web UI/activity URLs, cursor, Claude Monitor call, and persistent-shell command. |
| `hint`       | `logs?`                                                                    | The wiring recipe for a web app: `wrapper` \| `native` \| `none`. Bare: asks which. Terminal processes skip hint and pipe stdout. |
| `read_logs`  | `after?`, `level_min?`, `include?`, `exclude?`, `source?`, `limit?`, `max_chars?` | Read buffered entries, oldest first, as compact text. Returns a cursor to pass back as `after`.       |
| `await_logs` | same as `read_logs` + `until?`, `settle_ms?`, `timeout_ms?`               | Block until matching entries arrive (default 60 s, max 10 min). `until` returns everything through a terminal line; `settle_ms` gathers a burst. |
| `clear_logs` | —                                                                          | Discard the buffer. The cursor keeps counting, so prefer `after` when other agents may be reading.          |

Filter vocabulary, shared by every read and by the HTTP API:

- `after` — cursor from a previous read; only newer entries are returned.
- `level_min` — `trace` `debug` `info` `warn` `error` `fatal`. Levels from any logger (pino
  numerics, Python `WARNING`/`CRITICAL`, syslog, `log`, …) are normalized onto these at ingest.
- `include` / `exclude` — case-insensitive regexes on the text. `exclude: "hmr|vite|GET /health"`
  is the single biggest noise reducer in a busy app.
- `source` — regex on the reporting source (`api`, `web|ios`).
- `limit` (default 100, max 1000), `max_chars` per entry (default 800, `0` = unlimited).

Output is line-oriented, consecutive duplicates collapse, and long entries are cut with a hint
on how to re-read them whole.

Three ways to read, by how long the agent is waiting:

- **Now** — `read_logs`.
- **One thing, soon** — `await_logs`, with `until: "result=true"` (or whatever line ends the
  sequence) so one call returns the whole sequence instead of polling line by line.
- **While you test by hand for a while** — the listener's `/stream` WebSocket pushes each matching
  entry the moment it arrives. In Claude Code the agent attaches its **Monitor** tool to it
  (`listen` prints the exact call) and keeps working while your clicks show up as events. In Codex,
  the agent runs `tiny-log-mcp tail --include … --until …` in a persistent terminal session and
  resumes that session as events arrive; the same command works for any other agent or a human.
  `until` closes either watch so it ends by itself.

A typical loop: `listen` → wire → `read_logs` to confirm → start a Claude Monitor or persistent
`tail` session with a tight filter → tell the user what to try → react to events as they land → fix.

## HTTP API

| Method   | Path      | Notes                                                                                        |
| -------- | --------- | -------------------------------------------------------------------------------------------- |
| `POST`   | `/ingest` | `{source?, entries: [{level?, message, ts?, meta?}]}`, a bare array, one object, or plain text. CORS: any origin. |
| `GET`    | `/logs`   | Same filter vocabulary as the tools, plus `wait=<ms>` (up to 10 min) to long-poll. Same-origin only. |
| `DELETE` | `/logs`   | Clear the buffer.                                                                            |
| `GET`    | `/events` | Server-sent events feed used by the web UI.                                                  |
| `GET`    | `/activity` | Activity UI; `DELETE` clears its in-memory delivery transcript.                           |
| `GET`    | `/activity-events` | Server-sent presence and exact agent-delivery payloads.                             |
| `GET`    | `/activity-state` | Current presence counts and recent deliveries as JSON.                                  |
| `GET`    | `/stream` | WebSocket: one text frame (or JSON with `format=json`) per matching entry as it arrives; same filter vocabulary plus `until`. Same-origin only. |
| `GET`    | `/health` | `{ok, name, version, cursor, size}`.                                                         |
| `GET`    | `/`       | Web UI. `GET /client.js` is the browser drop-in.                                             |

## CLI

```
tiny-log-mcp            MCP server over stdio (default); also starts the listener + web UI
tiny-log-mcp serve      listener + web UI only, for use without an agent
tiny-log-mcp pipe       stdin → /ingest, echoing to stdout   [--source name] [--url http://…] [--quiet]
tiny-log-mcp tail       print matching entries as they arrive  [--include re] [--exclude re] [--level-min l] [--source re] [--after n] [--until re] [--json]
```

| Option / env                        | Default          |
| ----------------------------------- | ---------------- |
| `--port` / `TINY_LOG_PORT`          | `7710` (falls back to a free port if busy; `listen` reports it) |
| `--host` / `TINY_LOG_HOST`          | `127.0.0.1`      |
| `--capacity` / `TINY_LOG_CAPACITY`  | `10000` entries  |
| `--url` / `TINY_LOG_URL` (pipe)     | `http://127.0.0.1:7710` |

Pin a port per project if you want the app's config to stay static.

Claude Code (`.mcp.json`):

```json
{ "mcpServers": { "tiny-log": { "command": "npx", "args": ["-y", "tiny-log-mcp"], "env": { "TINY_LOG_PORT": "7710" } } } }
```

Codex (`.codex/config.toml` in a trusted project):

```toml
[mcp_servers.tiny-log]
command = "npx"
args = ["-y", "tiny-log-mcp"]
# Codex defaults MCP calls to 60 seconds. This covers await_logs' 10-minute maximum.
tool_timeout_sec = 620

[mcp_servers.tiny-log.env]
TINY_LOG_PORT = "7710"
```

Codex CLI, desktop, and IDE clients on the same host share this configuration. The longer tool
timeout is Codex-only configuration; it does not change tiny-log's behavior in Claude Code.

## Security and privacy

- The listener binds to `127.0.0.1` by default, keeps logs only in memory, and shuts down with the
  MCP session. Nothing is persisted by tiny-log.
- The activity transcript also lives only in memory, but it repeats the exact subset of logs sent
  to agents. Treat `/activity` with the same care as the main log viewer.
- There is no authentication or TLS. Do not expose the listener to the public internet.
- Only `/ingest` grants cross-origin browser access. Browser read APIs do not grant cross-origin
  access, and `/stream` rejects foreign browser origins. This is a browser boundary, not
  authentication against non-browser clients.
- Binding to `0.0.0.0` makes the listener reachable from the local network. Anyone who can reach
  that port may be able to submit or read logs, so use it only on a network you trust.
- Application logs can contain credentials, tokens, personal data, or request bodies. Avoid
  emitting secrets; read-time filters reduce what an agent sees but do not keep entries out of the
  in-memory buffer.

## Troubleshooting

**The MCP server does not start** — check `node --version`; tiny-log requires Node.js 22 or newer.
Run the client’s MCP status command (`/mcp`, where supported) to confirm that the server loaded.

**Nothing arrives** — call `listen` and use the URL it reports. Emit one unmistakable test line,
then call `read_logs` without filters. For a pipe, pass the reported address with `--url` if it is
not `http://127.0.0.1:7710`.

**Port 7710 is occupied** — the listener falls back to a free port. Use the URL returned by
`listen`, or pin a different unused port in the MCP configuration and in any static app wiring.

**Codex cancels a long `await_logs` call** — Codex defaults MCP tool calls to 60 seconds. Use the
`.codex/config.toml` example above, which sets `tool_timeout_sec = 620` for tiny-log's ten-minute
maximum. This setting does not affect Claude Code.

**Browser logs do not arrive** — inspect the browser console for Content Security Policy or
mixed-content errors. In a restricted app, forward to `/ingest` from the existing logger or allow
the local listener in development rather than weakening production policy.

**Another agent cannot see the same entries** — each MCP process has its own in-memory buffer.
Sessions share logs only when their app wiring or `pipe` commands point at the same listener URL.

## Contributing

Issues and pull requests are welcome, especially wiring recipes for more ecosystems, additional
logger normalization, and high-signal filtering improvements. Before opening a PR:

```sh
pnpm lint
pnpm typecheck
pnpm test
```

Keep runtime dependencies at zero unless a change has a strong reason to add one. Tool-surface
changes must update the README table and `test/mcp.test.js`; prompt changes should be deliberate
and preserve the established Claude Monitor workflow. See [`AGENTS.md`](AGENTS.md) for the code
layout and behavioral invariants.

## Development

Node ≥ 22 and pnpm 11, both pinned in `mise.toml` (`mise install`). Lifecycle scripts are
disabled for this repo and its dependencies (`pnpm-workspace.yaml`), and there are no runtime
dependencies to begin with. Types are JSDoc, checked by `tsc` — no build step.

```sh
pnpm install
pnpm test        # node --test
pnpm typecheck   # tsc over the JSDoc types, no build
pnpm lint        # biome
pnpm start       # listener + UI at http://127.0.0.1:7710
```

## License

MIT
