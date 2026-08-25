# local-log: agent-readable logging for local development

Working notes / handoff brief. Paste this into a fresh agent session to pick up the work.

## What this repo is

An Express 5 + socket.io server (`app.js`, port 3000) that collects logs from an app
under development and renders them at `/`. Work in progress on branch `mcp-log-tools`
adds an MCP server so a coding agent can read the buffer directly instead of asking the
human to copy and paste console output.

### Current state on `mcp-log-tools`

- `mcp.js` — stdio MCP server, thin HTTP client of `app.js`. Tools:
  - `read_logs({after, level, grep, limit})` — returns entries + a `cursor`
  - `await_logs({after, level, grep, timeout_ms})` — blocks until a match arrives
  - `clear_logs()` — resets the buffer
- `.mcp.json` committed so the server is picked up from this directory
- Entries: `{seq, ts, level, text, identity?}`. `seq` is monotonic and keeps counting
  across a clear, so a stale cursor can never re-read a recycled number.
- `GET /logs` (filter by `after`/`level`/`grep`/`limit`, plus `wait` for server-side
  long-poll), `DELETE /logs`, `POST /message`, `POST /log`
- Env: `LOG_BUFFER_SIZE` (5000), `LOG_MAX_WAIT_MS` (60000), `LOCAL_LOG_URL`
- `messages.json` flushes on a 30s interval; buffer is capped and configurable

## The two use cases

**1. Human-in-the-loop browser/device debugging.** Agent starts the log server, points
the app's logs at it, makes a change; the human interacts with the app; the agent calls
`await_logs` and reads what happened. Complementary to Chrome DevTools MCP rather than a
replacement: Chrome MCP can drive the browser (click, screenshot, inspect DOM) and this
cannot. This wins on real devices (phone, tablet, React Native, Electron, backend
processes) and when the human drives while the agent watches.

**2. Mature codebases using a logger abstraction.** No `console` to patch. Every logger
converges on the same hook — an object with one method receiving a record: pino
destination streams, `winston-transport`, bunyan streams, `consola.addReporter`,
`tslog.attachTransport`, Python `logging.Handler.emit`, Go `slog.Handler`, Serilog sinks.
Do NOT ship N integrations in this repo; ship one clean ingest contract plus a playbook
the agent reads, with transport code living in the target project, dev-gated.

## Backlog, ranked

1. **`local-log-pipe` bin** — zero code change: `npm run dev 2>&1 | npx local-log-pipe
--source api`. Parses NDJSON when possible (pino/bunyan already emit it, preserving
   level and structured fields), falls back to plain text. Biggest immediate unlock for
   mature backends; needs no contract changes.
2. **`/client.js` drop-in** — served by the log server so wiring a browser app is one
   line: `<script src="http://localhost:3000/client.js"></script>`. Must hook
   `window.onerror` and `unhandledrejection`, not just `console.*` — uncaught async
   errors are what matter and the current README snippet misses them entirely. Batch via
   the ingest endpoint; silently no-op if the server is unreachable.
3. **`POST /ingest`** — clean contract: `{source, entries: [{level, message, ts, meta}]}`.
   The existing `/log` is hostile to third-party transports (it takes an array of
   _strings containing JSON_ of `{type, item}` — double-encoded). Keep `/log` and
   `/message` for back-compat. Two things fall out: store structured `meta` and let
   `read_logs` filter on it, and normalize levels at ingest (pino numerics 10–60, Python
   `WARNING`/`CRITICAL`, syslog 0–7, `trace`/`fatal` — none map to the current five).
4. **Publish to npm with a `bin`** so any project's `.mcp.json` is `npx -y local-log-mcp`.
5. **Auto-start the server from `mcp.js`** — probe the port, spawn detached if absent,
   track it in a lockfile so repeat sessions reuse rather than orphan. Keep `app.js` a
   separate process deliberately: the buffer and web UI should survive an agent restart.
6. **Per-project isolation** — two projects on port 3000 share one buffer. `LOG_PORT` per
   project is the simple fix; tagging entries with `location.origin` plus a `source`
   filter is nearly free since `identity` already exists.
7. **Integration playbook** as an MCP prompt backed by a `SKILL.md`: detect the logger
   from the manifest, pick a strategy, write the transport, dev-gate it, then **verify by
   emitting a test log and reading it back through `read_logs`**. The agent should prove
   the integration works rather than claim it does.

## Open decisions

- Does this repo take on being a log _ingestion service_? `/ingest` becomes a contract
  other projects depend on — a real maintenance commitment worth naming before building.
- `app.js` binds `0.0.0.0` with wide-open dev CORS and no auth. Fine at home, exposed on
  a shared network. Consider defaulting to `127.0.0.1` unless device logging is on.

## Gotchas to preserve

- **Long-poll waiter bug (regression risk).** `recordEntry` must snapshot and clear the
  waiter set _before_ waking waiters. A waiter whose filter doesn't match the arriving
  entry re-registers during the wake, and a naive `waiters.clear()` afterward wipes it —
  so `await_logs level=error` sleeps through the error if any unrelated log lands first.
  `Set.forEach` also visits entries added mid-iteration, compounding it.
- **Tests are not in the repo.** The long-poll sequence (wake on match / ignore
  non-match / timeout / clear) and the MCP stdio round-trip were verified ad hoc and
  discarded. `npm test` is still the `exit 1` placeholder. Fold them in.
- Dependabot PR #98 (eslint 9→10) is open and failing for a real reason: eslint 10 removes
  `.eslintrc` support and this repo pins `ESLINT_USE_FLAT_CONFIG=false`. Needs a
  flat-config migration, not a merge.

## Suggested first task

Build #1 (`local-log-pipe`), or #3 (`/ingest` + playbook) if you'd rather lay the
foundation first. Verify any change end to end against a running server — start `app.js`,
drive real logs through it, and exercise the MCP tools over stdio.
