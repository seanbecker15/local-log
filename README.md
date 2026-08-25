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

The agent does this once per project (the `listen` tool prints the same procedure with the real
URL filled in):

1. **Find the logger.** Grep for a shared logger module or class (`logger.`, `createLogger`,
   `pino(`, `winston`, `consola`, `log4js`, …) or plain `console.*`, and check what the dev
   command prints to stdout.
2. **Hook it with the easiest matching interface** from the list below. Call through to the
   original, dev-gate the hook, never let delivery throw.
3. **Verify** by emitting one test log and reading it back with `read_logs`.

### A. The process writes to stdout/stderr — no code change

Any language. NDJSON from pino/bunyan/winston keeps its level, timestamp and fields; plain text
has ANSI stripped and a level guessed; stack frames are merged into their error. Output is still
echoed to your terminal.

```sh
npm run dev 2>&1 | npx -y tiny-log-mcp pipe --source api
```

### B. A browser page — one tag

Hooks `console.*`, `window.onerror` and `unhandledrejection`, batches, and silently no-ops when
the listener is down.

```html
<script src="http://127.0.0.1:7710/client.js" data-source="web"></script>
```

### C. A logger object or class with level methods — wrap the methods

A custom `Logger` class with `debug/info/log/warn/error`, `console` itself, `loglevel`, React
Native, Electron. The server joins raw `args` the way a terminal would, so the wrapper stays tiny.

```js
const send = (source, entries) =>
  fetch("http://127.0.0.1:7710/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source, entries }),
  }).catch(() => {});
const fmt = (a) => (a instanceof Error ? (a.stack ?? String(a)) : a);

function tap(logger, source) {
  for (const level of ["trace", "debug", "log", "info", "warn", "error", "fatal"]) {
    const original = logger[level];
    if (typeof original !== "function") continue;
    logger[level] = function (...args) {
      send(source, [{ level, args: args.map(fmt) }]);
      return original.apply(this, args);
    };
  }
}

tap(console, "api"); // or tap(Logger.prototype, "api") for a class, tap(loglevel, "web")
```

### D. A logger with a transport / stream / reporter hook — one line

Records are forwarded as-is; level, message and extra fields survive.

```js
// pino
pino({ level: "trace" }, { write: (line) => send("api", [JSON.parse(line)]) });
// winston
logger.add(new winston.transports.Stream({ format: winston.format.json(), stream: { write: (line) => send("api", [JSON.parse(line)]) } }));
// bunyan
bunyan.createLogger({ name, streams: [{ level: "trace", type: "raw", stream: { write: (rec) => send("api", [rec]) } }] });
// consola
consola.addReporter({ log: (r) => send("api", [{ level: r.type, args: r.args }]) });
// tslog
logger.attachTransport((o) => send("api", [{ level: o._meta.logLevelName, args: Object.keys(o).filter((k) => k !== "_meta").map((k) => o[k]) }]));
// log4js — a custom appender
{ type: { configure: () => (e) => send("api", [{ level: e.level.levelStr, args: e.data }]) } }
// debug
debug.log = (...args) => send("api", [{ level: "debug", args }]);
// roarr
globalThis.ROARR.write = (line) => send("api", [JSON.parse(line)]);
```

### E. Another language — handler / sink shape

Prefer A (pipe stdout). Otherwise every logging library has the same one-method hook:

```python
import json, logging, urllib.request

class Tap(logging.Handler):
    def emit(self, r):
        body = json.dumps({"source": "api", "entries": [{"level": r.levelname, "message": self.format(r)}]}).encode()
        try:
            urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:7710/ingest", body, {"Content-Type": "application/json"}), timeout=1)
        except Exception:
            pass

logging.getLogger().addHandler(Tap())
```

Go: an `slog.Handler` or `io.Writer` that POSTs lines · .NET: a Serilog sink or `ILoggerProvider` ·
Java: a logback appender · Ruby: a `Logger` logdev · Rust: a `tracing` Layer.

### F. Anything that can make an HTTP request

```sh
curl -X POST http://127.0.0.1:7710/ingest -H "content-type: application/json" \
  -d '{"source":"api","entries":[{"level":"error","message":"boom","meta":{"reqId":"r1"}}]}'
curl -d "something happened" "http://127.0.0.1:7710/ingest?source=api&level=warn"
```

Accepted: a batch, a bare array, one object, or plain text. Each entry may carry `level` (any
logger's names or numbers are normalized), `message` | `msg` | `text` | `args[]`, `ts` | `time`,
`meta`, and `source`.

**A phone or another machine** — bind to all interfaces: `listen` with `host: "0.0.0.0"` (or
`TINY_LOG_HOST=0.0.0.0`). The tool prints the LAN addresses to use.

## MCP tools

| Tool         | Arguments                                                                  | Purpose                                                                                                     |
| ------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `listen`     | `port?`, `host?`                                                           | Start (or report) the listener; returns the URL, the current cursor and wiring snippets. Call it first.      |
| `read_logs`  | `after?`, `level_min?`, `include?`, `exclude?`, `source?`, `limit?`, `max_chars?` | Read buffered entries, oldest first, as compact text. Returns a cursor to pass back as `after`.       |
| `await_logs` | same as `read_logs` + `timeout_ms?`                                        | Block until a matching entry arrives (default 30 s, max 60 s). Use while the user reproduces a bug.         |
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

A typical loop: `read_logs` (note the cursor) → ask the user to reproduce → `await_logs` with
`after=<cursor>` and `level_min: "error"` → read the stack trace → fix.

## HTTP API

| Method   | Path      | Notes                                                                                        |
| -------- | --------- | -------------------------------------------------------------------------------------------- |
| `POST`   | `/ingest` | `{source?, entries: [{level?, message, ts?, meta?}]}`, a bare array, one object, or plain text. CORS: any origin. |
| `GET`    | `/logs`   | Same filter vocabulary as the tools, plus `wait=<ms>` to long-poll. Same-origin only.        |
| `DELETE` | `/logs`   | Clear the buffer.                                                                            |
| `GET`    | `/events` | Server-sent events feed used by the web UI.                                                  |
| `GET`    | `/health` | `{ok, name, version, cursor, size}`.                                                         |
| `GET`    | `/`       | Web UI. `GET /client.js` is the browser drop-in.                                             |

Only `/ingest` answers cross-origin requests, so a random web page cannot read your dev logs.

## CLI

```
tiny-log-mcp            MCP server over stdio (default); also starts the listener + web UI
tiny-log-mcp serve      listener + web UI only, for use without an agent
tiny-log-mcp pipe       stdin → /ingest, echoing to stdout   [--source name] [--url http://…] [--quiet]
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
