# tiny-log-mcp technical reference

Complete tool, transport, CLI and configuration details for
[`tiny-log-mcp`](../README.md). Start with the README if you have not completed a first successful
log read yet.

## Contents

- [Client configuration](#client-configuration)
- [MCP tools](#mcp-tools)
- [Filters and output](#filters-and-output)
- [Reading strategies](#reading-strategies)
- [Wiring and networking](#wiring-and-networking)
- [HTTP API](#http-api)
- [CLI and environment](#cli-and-environment)
- [Security boundaries](#security-boundaries)
- [Advanced troubleshooting](#advanced-troubleshooting)
- [Development](#development)

## Client configuration

Requirements:

- Node.js 22 or newer.
- pnpm 11 for repository development; end users can run the package through `npx`.
- A local stdio MCP client. Remote agents need their own network path to the listener.

Claude Code (`.mcp.json`):

```json
{
  "mcpServers": {
    "tiny-log": {
      "command": "npx",
      "args": ["-y", "tiny-log-mcp"],
      "env": { "TINY_LOG_PORT": "7710" }
    }
  }
}
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

Codex CLI, desktop and IDE clients on the same host share this configuration. The longer tool
timeout is Codex-only configuration and does not change tiny-log's behavior in Claude Code.

## MCP tools

Every tool uses a JSON object input and returns text. Unknown fields are rejected.

### `listen`

Starts the HTTP listener or reports the compatible listener that is already running. The response
contains the actual URL and cursor, Web UI and activity links, a Claude Monitor call and a
persistent-shell `tail` command.

| Argument | Type | Behavior |
| --- | --- | --- |
| `port` | integer `0..65535` | Preferred port. Defaults to `7710`; a busy port falls back to a free one. `0` requests a free port. |
| `host` | string | Interface to bind. Omit for the recommended local-only default, `127.0.0.1`. Change only for explicit same-network device testing. |

### `hint`

Returns a web-app wiring recipe. Terminal processes skip this tool and pipe stdout instead.

| Argument | Values | Meaning |
| --- | --- | --- |
| `logs` | `wrapper` | A shared logger module, function or class exists, even if it wraps `console` or is level-gated. |
| `logs` | `native` | The app logs directly with `console.*`; no wrapper exists. |
| `logs` | `none` | The app barely logs and needs useful `console.*` instrumentation first. |

Call `hint` without `logs` to get the definitions. Inspect the codebase before choosing; do not
guess based on one call site.

### `read_logs`

Reads matching buffered entries immediately, oldest first. The returned cursor should be passed
back as `after` on the next read.

Arguments: every [shared filter](#shared-filters), plus `limit` and `max_chars`.

### `await_logs`

Waits for matching entries. It accepts every `read_logs` argument plus:

| Argument | Type | Behavior |
| --- | --- | --- |
| `until` | case-insensitive regex | Keep collecting through the first matching terminal line. Returns everything collected if the timeout arrives first. |
| `settle_ms` | integer `0..30000` | Without `until`, continue collecting briefly after the first match so a burst returns together. Default `500`. |
| `timeout_ms` | integer `0..600000` | Maximum wait. Default `60000`; maximum 10 minutes. |

### `clear_logs`

Discards the shared log buffer. The cursor remains monotonic. Prefer an `after` cursor when another
agent may be reading the same buffer.

## Filters and output

### Shared filters

The MCP tools, `/logs`, `/stream` and `tail` use one filter vocabulary:

| Field | Behavior |
| --- | --- |
| `after` | Include only entries whose monotonic `seq` is greater than this cursor. Default `0` for reads; `/stream` starts from now when omitted. |
| `level_min` | Minimum normalized severity: `trace`, `debug`, `info`, `warn`, `error` or `fatal`. |
| `include` | Case-insensitive regex the entry text must match. |
| `exclude` | Case-insensitive regex that removes matching entry text. A common noise filter is `hmr|vite|GET /health`. |
| `source` | Case-insensitive regex against the reporting source, such as `api` or `web|ios`. |
| `limit` | Newest matching entries to keep, returned oldest first. Default `100`; maximum `1000`. |

Filtering is read-time only. No entry is discarded at ingest because different readers may need
different views of the same buffer.

### Output controls and format

`max_chars` truncates each entry's text. The default is `800`; `0` disables truncation. A truncated
entry includes a hint for rereading it whole.

Text output is line-oriented:

```text
2 entries, times UTC (cursor 4813). Pass after=4813 to read only newer ones.
#4812 12:04:31.220 ERROR api TypeError: boom
        at handler (src/api.ts:18:9)
    meta: {"requestId":"req_7af2"}
#4813 12:04:31.245 INFO  web operation.failed
```

Continuation lines are indented, structured metadata follows the message and consecutive
identical entries collapse into a repeat marker. Logger levels are normalized at ingest, including
Pino/Bunyan numerics, Python `WARNING`/`CRITICAL`, syslog severities and common aliases.

## Reading strategies

- **Current evidence** — call `read_logs` and pass the returned cursor as `after` next time.
- **One expected outcome** — call `await_logs`. Add `until` when a specific line ends the sequence
  so one response contains the whole reproduction.
- **A human-driven session** — use `/stream`. Claude Code attaches its Monitor tool; Codex and
  other clients run `tiny-log-mcp tail` in a persistent terminal. `until` closes either watch.

Use tight filters that include failure signatures as well as happy-path completion lines. Tell the
user what to try, then leave the monitor running while they explore.

## Wiring and networking

### Backend and terminal processes

Pipe stdout and stderr. `pipe` echoes by default, understands common NDJSON log shapes, strips ANSI
codes and merges stack frames with their leading error.

```sh
npm run dev 2>&1 | npx -y tiny-log-mcp pipe --source api
```

Pass `--url` when `listen` reported a non-default port.

### Web app with a logger wrapper

Use the wrapper rather than intercepting it externally:

1. Insert useful logs through the existing wrapper at levels suitable for the project. Prefix and
   development-gate temporary diagnostics.
2. If local configuration suppresses the needed level, adjust that configuration locally rather
   than bypassing the wrapper.
3. Call `hint({logs: "wrapper"})`. It locates delivery at the common emission method, before
   reporter/console/no-op branches, and keeps delivery failure non-throwing.
4. Forward uncaught browser errors and unhandled rejections when they are relevant.
5. Emit one unmistakable test line and confirm it with `read_logs`.

Do not monkey-patch prototypes or intercept `console` around an existing wrapper. Error objects
need their `.stack` mapped explicitly because `JSON.stringify` drops their normal fields.

### Web app using `console.*`

Call `hint({logs: "native"})`. The returned `client.js` injection forwards `console.*`, uncaught
errors and unhandled rejections. It can be injected temporarily from DevTools or added to the
development app shell. Delivery failures are ignored so logging never breaks the app.

If the app barely logs, call `hint({logs: "none"})`, add useful logs first, then use the same
browser drop-in.

### Reusing the setup

After one verified read, record the logging implementation, hook location, listener configuration
and useful filters in project memory or `AGENTS.md`/`CLAUDE.md`. Later sessions should check for and
reuse that setup before editing the app again.

### Another device on the same network

Keep the default loopback binding for normal development. When the user explicitly asks to test a
phone or another device on the same trusted network, opt into a LAN-reachable interface:

```text
listen({host: "0.0.0.0"})
```

or set `TINY_LOG_HOST=0.0.0.0`. The `listen` response includes usable LAN addresses. Anyone who can
reach that port may be able to submit or read logs, so return to loopback after the device test.

## HTTP API

Only `/ingest` sends cross-origin browser headers. Reads are same-origin in browsers; `/stream`
also rejects a foreign `Origin` during WebSocket upgrade.

| Method | Path | Behavior |
| --- | --- | --- |
| `POST` | `/ingest` | Accept `{source?, entries: [...]}`, a bare entry array, one entry object or plain text. JSON entries may contain `level`, `message`/`text`, `source`, `ts` and `meta`. |
| `OPTIONS` | `/ingest` | Cross-origin preflight for browser writers. |
| `GET` | `/logs` | Return `{cursor, count, timed_out, entries}` using the shared filters. `wait=<ms>` long-polls up to 10 minutes. |
| `DELETE` | `/logs` | Clear the log buffer while preserving the cursor. |
| `GET` | `/events` | SSE log and presence feed used by the main Web UI. |
| `GET` | `/stream` | WebSocket frames for Monitor/`tail`; accepts shared filters plus `until`, `format=json` and `max_chars`. |
| `GET` | `/activity` | Agent activity page. |
| `DELETE` | `/activity` | Clear the activity transcript independently of logs. |
| `GET` | `/activity-events` | SSE presence and exact delivery events used by the activity page. |
| `GET` | `/activity-state` | Current presence counts and recent deliveries as JSON. |
| `GET` | `/health` | Return `{ok, name, version, cursor, size}`. |
| `GET` | `/` | Main log viewer. |
| `GET` | `/client.js` | Browser console/error forwarding drop-in. |

The ingest body limit is 5 MiB. The log ring defaults to 10,000 entries. The Web UI replays at most
1,000 existing entries over SSE and keeps its newest 5,000 rendered entries.

## CLI and environment

```text
tiny-log-mcp            MCP server over stdio; eagerly starts the listener and Web UI
tiny-log-mcp serve      listener and Web UI only
tiny-log-mcp pipe       stdin → /ingest, echoing to stdout
tiny-log-mcp tail       print matching /stream frames until stopped or `until` matches
```

| Command options / environment | Default | Notes |
| --- | --- | --- |
| `--port`, `TINY_LOG_PORT` | `7710` | Listener port; falls back to a free port when busy. |
| `--host`, `TINY_LOG_HOST` | `127.0.0.1` | Listener interface. Keep the local-only default except for explicit device tests. |
| `--capacity`, `TINY_LOG_CAPACITY` | `10000` | In-memory log entries. |
| `--url`, `TINY_LOG_URL` | `http://127.0.0.1:7710` | Listener URL used by `pipe` and `tail`. |
| `pipe --source <name>` | — | Reporting source assigned to piped lines. |
| `pipe --quiet` | false | Do not echo stdin back to stdout. |
| `tail --after <cursor>` | current cursor | Replay only entries after this cursor. |
| `tail --level-min <level>` | `trace` | Minimum normalized severity. |
| `tail --include/--exclude/--source <regex>` | — | Shared text/source filters. |
| `tail --until <regex>` | — | Close after delivering the terminal match. |
| `tail --json` | false | Emit entry JSON rather than formatted text. |

Pin a port per project when app wiring must remain static. Always trust the URL returned by
`listen`, because a collision can move the listener to a free port.

## Security boundaries

- The listener is unauthenticated HTTP. Loopback is the security default, not merely a convenience.
- No logs or activity are persisted by tiny-log. Both disappear with the process.
- The activity transcript repeats the exact subset sent to agents and deserves the same care as
  the main log buffer.
- Cross-origin browser access is write-only through `/ingest`. This browser boundary is not
  authentication against non-browser local processes.
- LAN binding broadens access to the network. Never expose the listener to the public internet.
- Filters do not redact the stored buffer. Avoid logging credentials, tokens, personal data and
  sensitive request bodies at the source.

## Advanced troubleshooting

### The server does not load in the MCP client

Check `node --version`, then use the client's MCP status command (`/mcp`, where supported). Restart
the client after adding configuration if it was already running.

### Nothing reaches the buffer

Call `listen` and use its reported URL. Emit one unmistakable test line, then call `read_logs`
without filters. For `pipe`, pass `--url` if the listener did not bind to the default address.

### Port 7710 is occupied

The listener falls back to a free port. Use the reported URL, or pin another unused port in both MCP
configuration and static app wiring.

### Codex cancels a long `await_logs`

Codex defaults MCP calls to 60 seconds. Set `tool_timeout_sec = 620` for tiny-log as shown in
[client configuration](#client-configuration). This does not affect Claude Code.

### Browser logs do not arrive

Inspect the browser console for Content Security Policy or mixed-content errors. In a restricted
app, forward from the existing logger or allow the local listener only in development rather than
weakening production policy.

### Another session cannot see the same entries

Each MCP process owns its own in-memory buffer. Sessions share logs only when their app wiring or
`pipe` commands point to the same listener URL.

### The UI appears stuck on connecting

Confirm that the page and listener use the same reported port and restart any listener process that
predates the current package version. The SSE endpoint sends an immediate connection comment even
when the buffer is empty.

## Development

Node 22+ and pnpm 11 are pinned in `mise.toml` (`mise install`). Lifecycle scripts are disabled
repo-wide. There is no build step: source is ESM JavaScript with JSDoc types and the Web UI is
served directly from `public/`.

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm start
```

CI runs lint, typecheck and tests on Node 22, 24 and 26. See [`AGENTS.md`](../AGENTS.md) for code
layout, behavioral invariants and release automation.
