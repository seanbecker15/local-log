# tiny-log-mcp — notes for coding agents

Ephemeral local log collector + MCP server. Zero runtime dependencies, Node ≥ 22, ESM.

## Commands

- `pnpm install` — pnpm 11 via mise (`mise.toml`). Lifecycle scripts are disabled repo-wide; never re-enable them.
- `pnpm test` — `node --test`, covers the store, filters, formatter, HTTP API, pipe and an MCP stdio round-trip.
- `pnpm typecheck` — `tsc` over the JSDoc types in `src/` and `bin/` (no build; TypeScript + @types/node are dev-only). Keep it at zero errors.
- `pnpm lint` / `pnpm format` — Biome (lint + format). CI runs lint, typecheck and tests on Node 22/24/26.
- `pnpm start` — HTTP listener + web UI at http://127.0.0.1:7710 (`pnpm dev` restarts on change).

## Layout

- `bin/tiny-log-mcp.js` — CLI: `mcp` (default), `serve`, `pipe`, `tail`.
- `src/store.js` — ring buffer, cursor, filtered query, long-poll `wait`, subscribers.
- `src/filter.js` — the one filter vocabulary (`after`, `level_min`, `include`, `exclude`, `source`, `limit`) shared by HTTP and MCP.
- `src/server.js` — `node:http` routes: `/ingest`, `/logs`, `/events` (SSE), `/stream` (WebSocket, for Monitor/`tail`), `/health`, static UI + `/client.js`.
- `src/ws.js` — minimal server-side WebSocket (handshake, text frames out, close/ping in); `src/tail.js` — `/stream` client for the CLI.
- `src/mcp.js` — tools (`listen`, `hint`, `read_logs`, `await_logs`, `clear_logs`), the always-loaded `INSTRUCTIONS`, and the per-interface wiring guide; `src/jsonrpc.js` — stdio JSON-RPC framing.
- `src/pipe.js` — stdin → `/ingest` (NDJSON-aware, ANSI-stripped, stack frames merged).
- `public/` — web UI and the browser drop-in client. No build step.

## Rules

- No runtime dependencies. Reach for Node built-ins first; a new dependency needs a reason in the PR.
- Types live in JSDoc (`Entry`, `Filter`, `Store`, `Listener`, …). Annotate new functions; `pnpm typecheck` must stay clean.
- Filtering is read-time only. Never drop entries at ingest — several agents may read the same buffer with different filters.
- Keep `seq` monotonic across `clear()`; keep the waiter snapshot-then-clear order in `store.add` (see the regression test).
- Only `/ingest` is cross-origin. Reads stay same-origin (`/stream` checks `Origin` on upgrade) so a web page cannot exfiltrate dev logs.
- Prompt text (`INSTRUCTIONS`, tool descriptions, `hint`) is product surface: change it deliberately, from observed agent behaviour, and don't overfit it to one incident.
- Every change to the tool surface needs a matching update in `test/mcp.test.js` and the README table.
