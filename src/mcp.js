import pkg from "../package.json" with { type: "json" };
import { createActivity } from "./activity.js";
import { FilterError, MAX_LIMIT, parseFilter, toRegExp } from "./filter.js";
import { DEFAULT_MAX_CHARS, formatEntries, formatHeader } from "./format.js";
import { INVALID_PARAMS, RpcError, serveStdio } from "./jsonrpc.js";
import { LEVELS } from "./levels.js";
import { DEFAULT_HOST, DEFAULT_PORT, lanAddresses, MAX_WAIT_MS, startServer } from "./server.js";
import { errorMessage } from "./util.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_SETTLE_MS = 500;
const MAX_SETTLE_MS = 30_000;

/** @typedef {import("./store.js").Store} Store */
/** @typedef {import("./store.js").Entry} Entry */
/** @typedef {import("./server.js").Listener} Listener */
/** @typedef {{port?: number, host?: string}} BindOptions */
/** @typedef {{title?: string, readOnlyHint?: boolean, destructiveHint?: boolean, idempotentHint?: boolean, openWorldHint?: boolean}} ToolAnnotations */
/** @typedef {{name: string, description: string, inputSchema: object, annotations: ToolAnnotations, handler: (args: Record<string, any>) => Promise<string>}} Tool */

export const LOG_IMPLEMENTATIONS = ["wrapper", "native", "none"];

export const INSTRUCTIONS = `tiny-log-mcp collects logs from the app under development into a buffer you can read or watch. Reach for it whenever you need to see what the app printed instead of asking the user to paste console output.

Whenever you call \`listen\`, surface its Web UI URL prominently to the user. Do this even when you are also starting a Monitor or terminal watch: the UI lets the human inspect the shared logs and see exactly what monitoring agents receive.

A backend or terminal process needs no setup: run it as \`<dev command> 2>&1 | npx -y tiny-log-mcp pipe --source api\`. The guided wiring below is for web apps (other ecosystems: POST /ingest — contributions welcome).

Wiring a web app, once per project — first check project memory and the project's agent docs (AGENTS.md/CLAUDE.md) for a saved tiny-log setup and reuse it. Otherwise:
1. If the app has a log implementation (a wrapper around logging), use it: insert logs through it at levels the user would be comfortable shipping — prefixes are fine, dev-gate anything temporary.
2. If that implementation is level-gated (config/env/feature flags), adjust the level locally, dev-gated. Don't fight the gate.
3. If there is no log implementation, log with console.*.
4. Call \`listen\`, then \`hint\` with logs=wrapper|native|none for the exact wiring recipe. Verify with one test log and read_logs, then save the setup (logs, hook location, filters) to the project's agent docs or your project memory — the next session skips all of this.

Reading — pick by how long you are waiting:
- read_logs: what is there now. Pass the last cursor as \`after\`; filter tightly (level_min, source, include, exclude).
- await_logs: one thing you expect soon. \`until=<regex>\` returns everything through a terminal line in one call.
- Long watch while the user tests by hand: Claude Code attaches Monitor to the ws stream URL from \`listen\`; Codex and other clients run \`tiny-log-mcp tail\` in a persistent shell. Each matching entry is pushed as it happens while you keep working. Tell the user what to try, then leave them room to explore. Filter to the lines you would act on and include the failure signatures, not just the happy path.
Prefer \`after\` cursors over clear_logs when other agents share the buffer.`;

const FILTER_PROPERTIES = {
  after: {
    type: "integer",
    minimum: 0,
    description: "Only entries with seq greater than this cursor (returned by every read).",
  },
  level_min: {
    type: "string",
    enum: LEVELS,
    description: "Minimum severity to include. Levels from any logger are normalized onto these.",
  },
  include: {
    type: "string",
    description: "Case-insensitive regex the text must match.",
  },
  exclude: {
    type: "string",
    description: 'Case-insensitive regex that drops matching entries, e.g. "hmr|vite|GET /health".',
  },
  source: {
    type: "string",
    description: 'Case-insensitive regex on the reporting source, e.g. "api" or "web|ios".',
  },
};

const OUTPUT_PROPERTIES = {
  limit: {
    type: "integer",
    minimum: 1,
    maximum: MAX_LIMIT,
    description: `Max entries to return (newest kept). Default 100, max ${MAX_LIMIT}.`,
  },
  max_chars: {
    type: "integer",
    minimum: 0,
    description: `Truncate each entry's text to this many chars. Default ${DEFAULT_MAX_CHARS}; 0 = no truncation.`,
  },
};

/**
 * Builds the MCP tool set over a store and its HTTP listener.
 *
 * @param {{store: Store, defaults?: BindOptions}} deps
 */
export function createTools({ store, defaults = {} }) {
  /** @type {Listener | null} */
  let listener = null;
  const activity = createActivity();

  /** @param {BindOptions} [options] @returns {Promise<Listener>} */
  async function ensureListener({ port, host } = {}) {
    const want = {
      port: port ?? listener?.port ?? defaults.port ?? DEFAULT_PORT,
      host: host ?? listener?.host ?? defaults.host ?? DEFAULT_HOST,
    };
    if (listener && listener.host === want.host && (port === undefined || listener.port === port)) {
      return listener;
    }
    if (listener) await listener.close();
    listener = await startServer(store, { ...want, activity });
    return listener;
  }

  /** @type {Tool[]} */
  const tools = [
    {
      name: "listen",
      description:
        "Start (or report) the local log listener: returns its URL, the current cursor, and the " +
        "stream address to watch with Monitor. Call this first. Use host 0.0.0.0 to accept logs " +
        "from a phone or another machine. For how to wire the app, call hint.",
      inputSchema: {
        type: "object",
        properties: {
          port: {
            type: "integer",
            minimum: 0,
            maximum: 65535,
            description: `Port to bind. Default ${DEFAULT_PORT}; falls back to a free port if busy.`,
          },
          host: {
            type: "string",
            description: `Interface to bind. Default ${DEFAULT_HOST} (this machine only).`,
          },
        },
        additionalProperties: false,
      },
      annotations: {
        title: "Start log listener",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      async handler({ port, host }) {
        const current = await ensureListener({ port, host });
        return describeListener(current, store.cursor);
      },
    },
    {
      name: "hint",
      description:
        "The wiring recipe for a web app: pass logs (wrapper: the app has its own logger " +
        "module/class | native: it logs straight with console.* | none: it barely logs) and get " +
        "the exact steps and snippets. Remember: use an existing wrapper at shippable levels; if " +
        "it is level-gated, adjust the level locally (dev-gated) rather than fighting the gate. " +
        "Backend/terminal processes need no hint — pipe their stdout.",
      inputSchema: {
        type: "object",
        properties: {
          logs: {
            type: "string",
            enum: LOG_IMPLEMENTATIONS,
            description:
              "wrapper: a shared logger module/class exists; native: plain console.*; none: the code barely logs.",
          },
        },
        additionalProperties: false,
      },
      annotations: {
        title: "Get log wiring recipe",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      async handler({ logs }) {
        const current = await ensureListener();
        if (!logs || !LOG_IMPLEMENTATIONS.includes(logs)) {
          const ask = [
            "Tell me the web app's log implementation and I'll return the exact recipe. Grep the codebase before answering (`logger.`, `createLogger`, `getLogger`, `class Logger`) — do not guess:",
            "  logs=wrapper  a shared logger module/class exists (even if it wraps console or its level is flag-controlled — that still counts as wrapper)",
            "  logs=native   the code logs straight with console.*, no wrapper anywhere",
            "  logs=none     the code barely logs at all",
            `Not a web app? A backend/terminal process needs no recipe: <dev command> 2>&1 | npx -y tiny-log-mcp pipe --source api --url ${current.url}. Anything else can POST ${current.url}/ingest.`,
          ];
          if (logs) ask.unshift(`"${logs}" is not a log implementation.`);
          return ask.join("\n");
        }
        return recipe(current.url, logs).join("\n");
      },
    },
    {
      name: "read_logs",
      description:
        "Read buffered logs, oldest first, as compact text. Returns a cursor; pass it back as " +
        "`after` to read only what arrived since. Filter aggressively for signal.",
      inputSchema: {
        type: "object",
        properties: { ...FILTER_PROPERTIES, ...OUTPUT_PROPERTIES },
        additionalProperties: false,
      },
      annotations: {
        title: "Read buffered logs",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      async handler(args) {
        const filter = toFilter(args);
        const entries = store.query(filter);
        return render({ entries, cursor: store.cursor, maxChars: args.max_chars });
      },
    },
    {
      name: "await_logs",
      description:
        "Block until matching logs arrive, then return them. Use while the user reproduces " +
        "something. Pass the last cursor as `after`. Give `until` a regex for the line that ends " +
        "what you are waiting for and you get everything up to it in one call; `settle_ms` keeps " +
        "collecting briefly after the first match so a burst comes back together. Waits up to " +
        `${MAX_WAIT_MS / 60_000} minutes — use long waits when a human is driving.`,
      inputSchema: {
        type: "object",
        properties: {
          ...FILTER_PROPERTIES,
          ...OUTPUT_PROPERTIES,
          until: {
            type: "string",
            description:
              "Case-insensitive regex. Keep collecting until an entry matches it (or the timeout), " +
              "then return everything collected.",
          },
          settle_ms: {
            type: "integer",
            minimum: 0,
            maximum: MAX_SETTLE_MS,
            description: `After the first match, keep collecting for this long. Default ${DEFAULT_SETTLE_MS}; ignored with until.`,
          },
          timeout_ms: {
            type: "integer",
            minimum: 0,
            maximum: MAX_WAIT_MS,
            description: `How long to wait. Default ${DEFAULT_TIMEOUT_MS}, max ${MAX_WAIT_MS}.`,
          },
        },
        additionalProperties: false,
      },
      annotations: {
        title: "Wait for matching logs",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      async handler(args) {
        const filter = toFilter(args);
        const until = toUntil(args.until);
        const timeout = Math.min(args.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_WAIT_MS);
        const settle = Math.min(args.settle_ms ?? DEFAULT_SETTLE_MS, MAX_SETTLE_MS);

        const ready = until
          ? (/** @type {Entry[]} */ found) => found.some((entry) => until.test(entry.text))
          : undefined;
        let { entries, satisfied } = await store.waitFor(filter, timeout, ready);
        if (satisfied && !until && settle > 0) {
          await sleep(settle);
          entries = store.query(filter);
        }
        return render({
          entries,
          cursor: store.cursor,
          maxChars: args.max_chars,
          waited: true,
          satisfied,
          until: args.until,
        });
      },
    },
    {
      name: "clear_logs",
      description:
        "Discard all buffered logs (the cursor keeps counting). Prefer `after` cursors when " +
        "other agents may be reading; use this to reset before an isolated reproduction.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: {
        title: "Clear buffered logs",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      async handler() {
        const { cleared, cursor } = store.clear();
        return `Cleared ${cleared} entries. Cursor is ${cursor}.`;
      },
    },
  ];

  return {
    tools,
    ensureListener,
    activity,
    get listener() {
      return listener;
    },
    async close() {
      if (listener) await listener.close();
      listener = null;
    },
  };
}

/**
 * JSON-RPC method handlers implementing the MCP tools-only surface.
 * @param {ReturnType<typeof createTools>} toolset
 * @returns {Record<string, (params: any) => Promise<unknown>>}
 */
export function createHandlers(toolset) {
  const byName = new Map(toolset.tools.map((tool) => [tool.name, tool]));
  let clientName = "MCP client";
  return {
    initialize: async (params) => {
      clientName = params.clientInfo?.name || clientName;
      return {
        protocolVersion: params.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: pkg.name, version: pkg.version },
        instructions: INSTRUCTIONS,
      };
    },
    "notifications/initialized": async () => {},
    ping: async () => ({}),
    "tools/list": async () => ({
      tools: toolset.tools.map(({ name, description, inputSchema, annotations }) => ({
        name,
        description,
        inputSchema,
        annotations,
      })),
    }),
    "tools/call": async ({ name, arguments: args = {} }) => {
      const tool = byName.get(name);
      if (!tool) throw new RpcError(INVALID_PARAMS, `unknown tool: ${name}`);
      const waiting = name === "await_logs" ? toolset.activity.open("wait") : null;
      try {
        const text = await tool.handler(args ?? {});
        if (name === "read_logs" || name === "await_logs") {
          toolset.activity.deliver({
            channel: "mcp",
            client: waiting ? `${clientName} · ${waiting.id}` : clientName,
            tool: name,
            args: args ?? {},
            text,
            error: false,
          });
        }
        return { content: [{ type: "text", text }] };
      } catch (err) {
        const text = errorMessage(err);
        if (name === "read_logs" || name === "await_logs") {
          toolset.activity.deliver({
            channel: "mcp",
            client: waiting ? `${clientName} · ${waiting.id}` : clientName,
            tool: name,
            args: args ?? {},
            text,
            error: true,
          });
        }
        return { content: [{ type: "text", text }], isError: true };
      } finally {
        waiting?.close();
      }
    },
  };
}

/**
 * Runs the MCP server over stdio until stdin closes.
 * @param {{store: Store, defaults?: BindOptions, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream}} options
 */
export async function runMcp({ store, defaults, input, output }) {
  const toolset = createTools({ store, defaults });
  // Bind eagerly so an app wired to a pinned port can start sending before the
  // agent calls `listen`; the tool still reports the actual port.
  try {
    await toolset.ensureListener();
  } catch (err) {
    process.stderr.write(`tiny-log-mcp: listener not started (${errorMessage(err)})\n`);
  }
  await serveStdio({ input, output, handlers: createHandlers(toolset) });
  await toolset.close();
}

/** @param {Record<string, unknown>} args @returns {import("./filter.js").Filter} */
function toFilter(args) {
  try {
    return parseFilter(args);
  } catch (err) {
    if (err instanceof FilterError) throw new Error(err.message);
    throw err;
  }
}

/** @param {unknown} value @returns {RegExp | null} */
function toUntil(value) {
  try {
    return toRegExp(value, "until");
  } catch (err) {
    if (err instanceof FilterError) throw new Error(err.message);
    throw err;
  }
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {object} options
 * @param {Entry[]} options.entries
 * @param {number} options.cursor
 * @param {number | undefined} [options.maxChars]
 * @param {boolean} [options.waited]
 * @param {boolean} [options.satisfied]
 * @param {string} [options.until]
 */
function render({ entries, cursor, maxChars, waited = false, satisfied = true, until }) {
  let header;
  if (until) {
    const noun = entries.length === 1 ? "entry" : "entries";
    header = satisfied
      ? `${entries.length} ${noun} through the until match, times UTC (cursor ${cursor}). Pass after=${cursor} to read only newer ones.`
      : `Timed out before until=${JSON.stringify(until)} matched; ${entries.length} ${noun} collected so far (cursor ${cursor}).`;
  } else {
    header = formatHeader({ count: entries.length, cursor, timedOut: waited && !satisfied });
  }
  if (entries.length === 0) return header;
  return `${header}\n${formatEntries(entries, { maxChars })}`;
}

/**
 * @param {Listener} listener
 * @param {number} cursor
 * @returns {string}
 */
function describeListener({ url, host, port }, cursor) {
  const ws = `${url.replace(/^http/, "ws")}/stream`;
  const lines = [
    `tiny-log-mcp is listening at ${url} (cursor ${cursor}; pass after=${cursor} to read only what arrives from now).`,
    `Web UI — surface this link to the user now: ${url}/  Agent activity: ${url}/activity`,
  ];
  if (host === "0.0.0.0" || host === "::") {
    const lan = lanAddresses();
    if (lan.length > 0) {
      lines.push(
        `Reachable from other devices at: ${lan.map((ip) => `http://${ip}:${port}`).join("  ")}`,
      );
    }
  } else {
    lines.push(
      'Bound to this machine only. Call listen with host="0.0.0.0" to accept logs from a phone or another machine.',
    );
  }
  lines.push(
    "",
    "Wiring a web app: call hint — it asks which log implementation the app has and returns the recipe. A terminal process just pipes: <dev command> 2>&1 | npx -y tiny-log-mcp pipe --source api.",
    "Read now: read_logs.  Wait for one thing: await_logs (until=<regex> returns everything through a terminal line).",
    "Watch while the user drives (minutes, hands-free): each matching entry is pushed to you as it happens —",
    `  Claude Code: Monitor({ ws: { url: "${ws}?after=${cursor}&include=<regex>&exclude=<regex>&level_min=<level>&until=<regex>" }, description: "<what you are watching for>", persistent: true })`,
    `  Codex/other clients, persistent shell: tiny-log-mcp tail --url ${url} --include <regex> [--until <regex>]`,
    "  Filter to actionable lines and include failure signatures. Drop params you don't need; until ends either watch. In Claude, stop Monitor early with TaskStop; otherwise stop the terminal process.",
  );
  return lines.join("\n");
}

/**
 * The wiring recipe for a web app with the given log implementation: make the
 * logs flow, get them to the listener, verify. Opinionated on purpose — the
 * rules live in the instructions; this fills in the snippets. Delivery matches
 * the implementation: a wrapper forwards from the wrapper; client.js is
 * reserved for apps logging with plain console.*. Web-only for now; recipes
 * for more ecosystems are welcome contributions.
 *
 * @param {string} url
 * @param {string} logs
 * @returns {string[]}
 */
function recipe(url, logs) {
  const lines = ["Wire it in two steps, then verify."];

  if (logs === "wrapper") {
    lines.push(
      "",
      "1. Make the logs flow through the wrapper:",
      "   Insert logs at levels the user would be comfortable shipping; prefix and dev-gate anything temporary.",
      "   If the level is gated by config/env/feature flags, adjust the level locally (dev-gated). Don't fight the gate.",
      "",
      "2. Forward from the wrapper: open the source file where the wrapper class/function lives. Find the method all levels funnel through. At the top of the method body, before any branching (reporter, console, no-op — it does not matter), add this dev-gated forward:",
      `     if (process.env.NODE_ENV === "development") {`,
      `       fetch("${url}/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "app", entries: [{ level, args }] }) }).catch(() => {});`,
      "     }",
      "   Adapt the variable names to the method's signature; map Error values to their .stack (JSON.stringify drops Error fields). The dev-gate makes the edit a production no-op. Delivery must never throw.",
      "   Do not patch from outside the file: no monkey-patching prototypes, no console interception, no importing the wrapper into the app entry point.",
      '   To also capture uncaught errors and unhandled rejections, forward window "error" and "unhandledrejection" events the same way.',
    );
  } else if (logs === "native") {
    lines.push(
      "",
      "1. Make the logs flow: log with console.* as usual; add what you need at levels the user would keep.",
      "",
      ...clientJsStep(url),
    );
  } else {
    lines.push(
      "",
      "1. Make the logs flow: the code barely logs — add logs with console.* at levels the user would be comfortable shipping; prefix temporary ones and dev-gate them.",
      "",
      ...clientJsStep(url),
    );
  }

  lines.push(
    "",
    "3. Verify: emit one test log and read it back with read_logs. Save the setup (logs, hook location, filters) to the project's agent docs or your project memory.",
  );
  return lines;
}

/** client.js delivery, for apps logging with plain console.*. @param {string} url @returns {string[]} */
function clientJsStep(url) {
  return [
    "2. Get them to tiny-log — inject client.js; it forwards console.* and uncaught errors:",
    `   no code change (paste in DevTools, lost on reload): (s => { s.src = "${url}/client.js"; s.dataset.source = "web"; document.head.append(s); })(document.createElement("script"))`,
    `   in source (dev-gated, survives reloads): <script src="${url}/client.js" data-source="web"></script> — Vite: index.html · Next: app/layout · CRA: public/index.html; template not in the repo? run the injection line from the entry module instead.`,
  ];
}
