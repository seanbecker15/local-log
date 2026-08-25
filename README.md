# tiny-log-mcp

[![CI](https://github.com/seanbecker15/tiny-log-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/seanbecker15/tiny-log-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/tiny-log-mcp.svg)](https://www.npmjs.com/package/tiny-log-mcp)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](https://nodejs.org/)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Give coding agents a live, filtered view of your app's logs. Browser, backend and test output goes
into one local, in-memory buffer—no pasting console output, no log files, no runtime dependencies.

[Technical reference](docs/reference.md)

## Install

Requires Node.js 22 or newer.

```sh
# Claude Code
claude mcp add tiny-log -- npx -y tiny-log-mcp

# Codex CLI, desktop app and IDE extension
codex mcp add tiny-log -- npx -y tiny-log-mcp
```

Restart the client if it was already open. It will start and stop tiny-log with the MCP session.

## Use it

Ask the agent:

```text
Use tiny-log to inspect my app logs.
```

The agent starts the listener, gives you its local URL and helps connect the app. Terminal output
can go straight in:

```sh
npm run dev 2>&1 | npx -y tiny-log-mcp pipe --source api
```

For a web app, the agent inspects the existing logger and uses `hint` to choose the smallest
development-only hook. Then reproduce the problem and let the logs do the talking.

```text
listen → connect → reproduce → inspect → fix → repeat
```

Use `read_logs` for what has already happened, `await_logs` for the next matching event, and
Monitor or `tiny-log-mcp tail` for a longer watch. Reads return a cursor; pass it back as `after`
to skip entries the agent has already seen.

Example output:

```text
2 entries, times UTC (cursor 4813). Pass after=4813 to read only newer ones.
#4812 12:04:31.220 ERROR api TypeError: Cannot read properties of undefined (reading 'id')
        at Service.load (src/service.ts:88:14)
    meta: {"reqId":"r1"}
#4813 12:04:31.221 WARN  web fetch /api/items 500
    (repeated ×36, through #4849)
```

## How it works

One process speaks MCP over stdio and listens locally for application logs:

```text
your app ──► POST /ingest ──► ring buffer ──► read_logs / await_logs
                                      │
                                      └──► Monitor / tail
```

Nothing is persisted and nothing remains running after the MCP session ends. Filtering happens
when logs are read, so several agents can use different filters without discarding each other's
entries.

## Client support

| Client | Longer watch |
| --- | --- |
| Claude Code | Native Monitor on `/stream` |
| Codex CLI, desktop and IDE | `tiny-log-mcp tail` in a persistent terminal |
| Other local stdio MCP clients | `tail` or the `/stream` WebSocket |
| Remote or cloud agents | Requires a network path; the default listener is local-only |

## Connecting an app

- **Backend or terminal process:** pipe stdout and stderr through `tiny-log-mcp pipe`.
- **Web app with a logger wrapper:** forward from the wrapper's common emission point in
  development.
- **Web app using `console.*`:** use the browser drop-in returned by `hint`; it also captures
  uncaught errors and unhandled rejections.
- **Phone or another local device:** opt into a LAN-reachable listener only for the test, on a
  network you trust. Return to loopback afterwards.

Once it works, record the setup in project memory or `AGENTS.md`/`CLAUDE.md` so the next agent
doesn't have to rediscover it. Exact recipes and networking options are in the [wiring
reference](docs/reference.md#wiring-and-networking).

## MCP tools

| Tool | What it does |
| --- | --- |
| `listen` | Starts or reports the listener and returns the local URLs and watch commands. |
| `hint` | Returns a wiring recipe for the app's logging setup. |
| `read_logs` | Reads matching buffered entries now. |
| `await_logs` | Waits for matching entries or collects through a terminal match. |
| `clear_logs` | Clears the shared buffer without resetting its cursor. |

Arguments, filters and output rules live in the [MCP reference](docs/reference.md#mcp-tools).

## Keep it local

tiny-log binds to `127.0.0.1` by default and stores logs only in memory. It has no authentication
or TLS, so do not expose it to the public internet. A LAN binding allows reachable devices to read
and write logs; use it only for an explicit same-network test.

Application logs may contain tokens, personal data or request bodies. Filters limit what an agent
reads, not what enters the buffer, so avoid logging secrets in the first place.

## If something's weird

- **The MCP server does not start:** confirm Node.js 22+ and check the client's MCP status.
- **Nothing arrives:** use the URL from `listen`, emit one unmistakable test line, then call
  `read_logs` without filters.
- **Port 7710 is occupied:** tiny-log chooses a free port; trust the reported URL.
- **Browser logs do not arrive:** check Content Security Policy and mixed-content errors. Prefer
  forwarding from the existing logger over weakening production policy.

More edge cases are covered in [advanced troubleshooting](docs/reference.md#advanced-troubleshooting).

## Hack on it

Issues and pull requests are welcome. Keep runtime dependencies at zero unless a change has a
strong reason to add one.

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
```

Tool-surface changes must update the table above, the technical reference and `test/mcp.test.js`.
Prompt changes should preserve the established Claude Monitor workflow. See
[`AGENTS.md`](AGENTS.md) for code layout, invariants and release behavior.

## License

MIT
