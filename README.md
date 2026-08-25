# tiny-log-mcp

An ephemeral local log collector with an [MCP](https://modelcontextprotocol.io) server, so a
coding agent can read what your app printed — in a browser, on a phone, or in a backend
process — instead of asking you to paste console output. Zero runtime dependencies.

```
claude mcp add tiny-log -- npx -y tiny-log-mcp
```

That is the whole install. The agent calls `listen`, gets a URL and copy-paste wiring snippets,
and reads logs with filters tight enough to keep the signal high.

## How it works

`tiny-log-mcp` runs one process per agent session. It speaks MCP over stdio and, in the same
process, listens on `http://127.0.0.1:7710` for logs. Nothing is persisted, nothing runs in the
background after the session ends, and every session gets its own buffer.

```
  your app ──► POST /ingest ──► ring buffer ──► read_logs / await_logs (MCP)
  (browser, device, backend)          │
                                      └──► web UI at /  (for you)
```

Filtering happens when logs are **read**, never when they arrive, so several agents (or
sub-agents) can watch the same buffer with different filters.

## Wiring an app

Opinionated on purpose, after several rounds of dogfooding cleverer designs. **A backend or
terminal process needs no setup at all** — pipe it:

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
| `listen`     | `port?`, `host?`                                                           | Start (or report) the listener; returns the URL, the cursor, and the stream address to watch with Monitor. |
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

Output is line-oriented, consecutive duplicates collapse, long entries are cut with a hint on
how to re-read them whole:

```
2 entries, times UTC (cursor 4813). Pass after=4813 to read only newer ones.
#4812 12:04:31.220 ERROR api TypeError: Cannot read properties of undefined (reading 'id')
        at OrderService.load (src/orders.ts:88:14)
    meta: {"reqId":"r1"}
#4813 12:04:31.221 WARN  web fetch /api/orders 500
    (repeated ×36, through #4849)
```

Three ways to read, by how long the agent is waiting:

- **Now** — `read_logs`.
- **One thing, soon** — `await_logs`, with `until: "result=true"` (or whatever line ends the
  sequence) so one call returns the whole sequence instead of polling line by line.
- **While you test by hand for a while** — the listener's `/stream` WebSocket pushes each matching
  entry the moment it arrives. In Claude Code the agent attaches its **Monitor** tool to it
  (`listen` prints the exact call) and keeps working while your clicks show up as events; any
  other agent, or you, can run `tiny-log-mcp tail --include … --until …` in a shell. `until`
  closes the stream so the watch ends on its own.

A typical loop: `listen` → wire → `read_logs` to confirm → start a Monitor on the stream with a
tight filter → tell the user what to try → react to events as they land → fix.

## HTTP API

| Method   | Path      | Notes                                                                                        |
| -------- | --------- | -------------------------------------------------------------------------------------------- |
| `POST`   | `/ingest` | `{source?, entries: [{level?, message, ts?, meta?}]}`, a bare array, one object, or plain text. CORS: any origin. |
| `GET`    | `/logs`   | Same filter vocabulary as the tools, plus `wait=<ms>` (up to 10 min) to long-poll. Same-origin only. |
| `DELETE` | `/logs`   | Clear the buffer.                                                                            |
| `GET`    | `/events` | Server-sent events feed used by the web UI.                                                  |
| `GET`    | `/stream` | WebSocket: one text frame (or JSON with `format=json`) per matching entry as it arrives; same filter vocabulary plus `until`. Same-origin only. |
| `GET`    | `/health` | `{ok, name, version, cursor, size}`.                                                         |
| `GET`    | `/`       | Web UI. `GET /client.js` is the browser drop-in.                                             |

Only `/ingest` answers cross-origin requests, and `/stream` rejects browser origins other than its own, so a random web page cannot read your dev logs.

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

Pin a port per project in `.mcp.json` if you want the app's config to stay static:

```json
{ "mcpServers": { "tiny-log": { "command": "npx", "args": ["-y", "tiny-log-mcp"], "env": { "TINY_LOG_PORT": "7710" } } } }
```

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

See `AGENTS.md` for the layout and the invariants worth keeping.

## License

MIT
