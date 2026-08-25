import pkg from "../package.json" with { type: "json" };
import { FilterError, MAX_LIMIT, parseFilter } from "./filter.js";
import { DEFAULT_MAX_CHARS, formatEntries, formatHeader } from "./format.js";
import { INVALID_PARAMS, RpcError, serveStdio } from "./jsonrpc.js";
import { LEVELS } from "./levels.js";
import { DEFAULT_HOST, DEFAULT_PORT, lanAddresses, MAX_WAIT_MS, startServer } from "./server.js";
import { errorMessage } from "./util.js";

const DEFAULT_TIMEOUT_MS = 30_000;

/** @typedef {import("./store.js").Store} Store */
/** @typedef {import("./server.js").Listener} Listener */
/** @typedef {{port?: number, host?: string}} BindOptions */
/** @typedef {{name: string, description: string, inputSchema: object, handler: (args: Record<string, any>) => Promise<string>}} Tool */

export const INSTRUCTIONS = `tiny-log-mcp collects logs from the app under development (browser, phone/device, backend process) into a buffer you can read. Reach for it whenever you need to see what the app printed instead of asking the user to paste console output.

Setup, once per project:
1. Call \`listen\` to get the URL.
2. Find the app's logger: grep for a shared logger module or class (\`logger.\`, \`createLogger\`, \`pino(\`, \`winston\`, \`consola\`, \`log4js\`, …) or plain \`console.*\`, and check what the dev command prints to stdout.
3. Hook it with the easiest matching interface — \`listen\` prints a snippet for each: (A) it writes to stdout → pipe the dev command, no code change; (B) browser page → one <script> tag; (C) a logger object/class with level methods → wrap each method; (D) a logger with a transport/stream/reporter hook → one line; (E) another language → handler/sink shape; (F) anything → POST /ingest. Call through to the original, dev-gate the hook, never let delivery throw.
4. Verify: emit one test log and read it back with \`read_logs\`.

Reading: take the cursor from \`read_logs\`, ask the user to reproduce, then \`await_logs\` with \`after=<cursor>\` and a tight filter (level_min, source, include, exclude — e.g. exclude="hmr|vite|GET /health"). Prefer \`after\` cursors over \`clear_logs\` when other agents may share the buffer.`;

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
    listener = await startServer(store, want);
    return listener;
  }

  /** @type {Tool[]} */
  const tools = [
    {
      name: "listen",
      description:
        "Start (or report) the local log listener and get the URL plus copy-paste snippets for " +
        "wiring a browser, a Node logger, or any process's stdout to it. Call this first. " +
        "Use host 0.0.0.0 to accept logs from a phone or another machine on the LAN.",
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
      async handler(args) {
        const current = await ensureListener(args);
        return describeListener(current, store.cursor);
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
      async handler(args) {
        const filter = toFilter(args);
        const entries = store.query(filter);
        return render(entries, store.cursor, args.max_chars, false);
      },
    },
    {
      name: "await_logs",
      description:
        "Block until a log matching the filter arrives, then return it. Use after asking the " +
        "user to reproduce something. Pass the cursor from the last read as `after` so only " +
        "new entries count. Returns a timeout note if nothing matched in time.",
      inputSchema: {
        type: "object",
        properties: {
          ...FILTER_PROPERTIES,
          ...OUTPUT_PROPERTIES,
          timeout_ms: {
            type: "integer",
            minimum: 0,
            maximum: MAX_WAIT_MS,
            description: `How long to wait. Default ${DEFAULT_TIMEOUT_MS}, max ${MAX_WAIT_MS}.`,
          },
        },
        additionalProperties: false,
      },
      async handler(args) {
        const filter = toFilter(args);
        const timeout = Math.min(args.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_WAIT_MS);
        const entries = await store.wait(filter, timeout);
        return render(entries, store.cursor, args.max_chars, true);
      },
    },
    {
      name: "clear_logs",
      description:
        "Discard all buffered logs (the cursor keeps counting). Prefer `after` cursors when " +
        "other agents may be reading; use this to reset before an isolated reproduction.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async handler() {
        const { cleared, cursor } = store.clear();
        return `Cleared ${cleared} entries. Cursor is ${cursor}.`;
      },
    },
  ];

  return {
    tools,
    ensureListener,
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
  return {
    initialize: async (params) => ({
      protocolVersion: params.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: pkg.name, version: pkg.version },
      instructions: INSTRUCTIONS,
    }),
    "notifications/initialized": async () => {},
    ping: async () => ({}),
    "tools/list": async () => ({
      tools: toolset.tools.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    }),
    "tools/call": async ({ name, arguments: args = {} }) => {
      const tool = byName.get(name);
      if (!tool) throw new RpcError(INVALID_PARAMS, `unknown tool: ${name}`);
      try {
        const text = await tool.handler(args ?? {});
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return { content: [{ type: "text", text: errorMessage(err) }], isError: true };
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

/**
 * @param {import("./store.js").Entry[]} entries
 * @param {number} cursor
 * @param {number | undefined} maxChars
 * @param {boolean} waited
 */
function render(entries, cursor, maxChars, waited) {
  const header = formatHeader({
    count: entries.length,
    cursor,
    timedOut: waited && entries.length === 0,
  });
  if (entries.length === 0) return header;
  return `${header}\n${formatEntries(entries, { maxChars })}`;
}

/** @param {Listener} listener @param {number} cursor @returns {string} */
function describeListener({ url, host, port }, cursor) {
  const lines = [
    `tiny-log-mcp is listening at ${url} (cursor ${cursor}; pass after=${cursor} to read only what arrives from now).`,
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
  lines.push("", ...wiringGuide(url), "", `Web UI for the human: ${url}/`);
  return lines.join("\n");
}

/**
 * The integration procedure with one snippet per logger interface. Lives in
 * the listen output (paid once per session), not in the always-loaded
 * instructions.
 */
/** @param {string} url @returns {string[]} */
function wiringGuide(url) {
  const ingest = `${url}/ingest`;
  const post = `fetch("${ingest}", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source, entries }) }).catch(() => {})`;
  return [
    "How to hook the app up:",
    "1. Find the logger: grep for a shared logger module or class (logger., createLogger, pino(, winston, bunyan, consola, tslog, log4js, loglevel, debug(), roarr) or plain console.*, and check what the dev command prints to stdout.",
    "2. Pick the easiest matching interface below. Call through to the original, dev-gate the hook (NODE_ENV / import.meta.env.DEV), never let delivery throw.",
    "3. Verify: emit one test log and read it back with read_logs.",
    "",
    "A. The process writes to stdout/stderr (any language) — no code change:",
    `   <dev command> 2>&1 | npx -y tiny-log-mcp pipe --source api --url ${url}`,
    "   pino/bunyan/winston NDJSON keeps level, time and fields; plain text gets ANSI stripped and a level guessed; stack frames are merged.",
    "",
    "B. A browser page — one tag; hooks console.*, window.onerror and unhandledrejection, batches, no-ops when the listener is down:",
    `   <script src="${url}/client.js" data-source="web"></script>`,
    "",
    "C. A logger object or class with level methods (custom Logger class, console, loglevel, React Native, Electron) — wrap each method; the server joins raw args:",
    `   const send = (source, entries) => ${post};`,
    "   const fmt = (a) => (a instanceof Error ? (a.stack ?? String(a)) : a);",
    "   function tap(logger, source) {",
    '     for (const level of ["trace", "debug", "log", "info", "warn", "error", "fatal"]) {',
    "       const original = logger[level];",
    '       if (typeof original !== "function") continue;',
    "       logger[level] = function (...args) {",
    "         send(source, [{ level, args: args.map(fmt) }]);",
    "         return original.apply(this, args);",
    "       };",
    "     }",
    "   }",
    '   tap(console, "api");            // or tap(Logger.prototype, "api") for a class, tap(loglevel, "web")',
    "",
    "D. A logger with a transport / stream / reporter hook — one line; records are forwarded as-is (level + message + fields preserved):",
    `   const send = (source, entries) => ${post};`,
    '   pino:     pino({ level: "trace" }, { write: (line) => send("api", [JSON.parse(line)]) })',
    '   winston:  logger.add(new winston.transports.Stream({ format: winston.format.json(), stream: { write: (line) => send("api", [JSON.parse(line)]) } }))',
    '   bunyan:   streams: [{ level: "trace", type: "raw", stream: { write: (rec) => send("api", [rec]) } }]',
    '   consola:  consola.addReporter({ log: (r) => send("api", [{ level: r.type, args: r.args }]) })',
    '   tslog:    logger.attachTransport((o) => send("api", [{ level: o._meta.logLevelName, args: Object.keys(o).filter((k) => k !== "_meta").map((k) => o[k]) }]))',
    '   log4js:   appender { type: { configure: () => (e) => send("api", [{ level: e.level.levelStr, args: e.data }]) } }',
    '   debug:    debug.log = (...args) => send("api", [{ level: "debug", args }])',
    '   roarr:    globalThis.ROARR.write = (line) => send("api", [JSON.parse(line)])',
    "",
    "E. Another language — prefer A (pipe stdout); otherwise implement the handler/sink shape and POST:",
    "   Python:   class Tap(logging.Handler):",
    '                 def emit(self, r): post({"source": "api", "entries": [{"level": r.levelname, "message": self.format(r)}]})   # urllib/requests, swallow errors',
    "             logging.getLogger().addHandler(Tap())",
    "   Go: slog.Handler or an io.Writer that POSTs lines.  .NET: Serilog sink / ILogger provider.  Java: logback appender.  Ruby: Logger logdev.  Rust: tracing Layer.",
    "",
    "F. Anything that can make an HTTP request:",
    `   POST ${ingest}  {"source":"api","entries":[{"level":"error","message":"…","ts":"2026-01-01T00:00:00Z","meta":{"reqId":"r1"}}]}`,
    `   curl -d "plain text" "${ingest}?source=api&level=warn"`,
    "   Accepted: a batch, a bare array, one object, or plain text. Each entry: level (any logger's names or numbers are normalized), message | msg | text | args[], ts | time, meta, source.",
  ];
}
