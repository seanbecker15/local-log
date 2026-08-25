import pkg from "../package.json" with { type: "json" };
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
/** @typedef {{name: string, description: string, inputSchema: object, handler: (args: Record<string, any>) => Promise<string>}} Tool */

export const GUIDES = [
  "stdout",
  "browser",
  "logger-methods",
  "transport",
  "other-language",
  "http",
];

export const INSTRUCTIONS = `tiny-log-mcp collects logs from the app under development (browser, phone/device, backend process) into a buffer you can read or watch. Reach for it whenever you need to see what the app printed instead of asking the user to paste console output.

Setup, once per project:
1. Call \`listen\` for the URL and the stream address. \`hint\` lists the ways to wire the app; \`hint interface=<name>\` gives one snippet.
2. Find the app's logger (a shared logger module or class, or plain console.*) and what the dev command prints. If the code already logs what you need, capture those calls — wrapping the logger's methods (hint interface=logger-methods) captures them even when its level is off or flag-controlled — before adding any log calls of your own. If you must add some, tag them with a unique marker and remove every tagged line when done.
3. Hook it with the least invasive interface that fits (piping stdout or injecting client.js from the DevTools console needs no source change). Call through to the original, dev-gate any source change, never let delivery throw.
4. Verify with one test log and read_logs.

Reading — pick by how long you are waiting:
- read_logs: what is there now. Pass the last cursor as \`after\`; filter tightly (level_min, source, include, exclude).
- await_logs: one thing you expect soon. \`until=<regex>\` returns everything through a terminal line in one call.
- Monitor on the ws stream URL from \`listen\` (or \`tiny-log-mcp tail\` in a shell) when the user is going to test by hand for a while: each matching entry is pushed to you as it happens while you keep working. Tell the user what to try, then leave them room to explore. Filter to the lines you would act on and include the failure signatures, not just the happy path.
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
      async handler({ port, host }) {
        const current = await ensureListener({ port, host });
        return describeListener(current, store.cursor);
      },
    },
    {
      name: "hint",
      description:
        "How to wire the app's logs to the listener. Without arguments: the list of interfaces " +
        "and how to choose. With interface=<name>: the copy-paste snippet for that one — stdout " +
        "(pipe a process), browser (client.js), logger-methods (wrap a logger object/class), " +
        "transport (pino/winston/…), other-language (Python/Go/…), http (raw POST), or all.",
      inputSchema: {
        type: "object",
        properties: {
          interface: { type: "string", enum: [...GUIDES, "all"] },
        },
        additionalProperties: false,
      },
      async handler({ interface: name }) {
        const current = await ensureListener();
        if (name === "all")
          return GUIDES.map((g) => wiringGuide(current.url, g).join("\n")).join("\n\n");
        if (name) return wiringGuide(current.url, name).join("\n");
        return wiringIndex().join("\n");
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
    "Wiring: call hint (or hint interface=<name>) for how to connect the app's logs.",
    "Read now: read_logs.  Wait for one thing: await_logs (until=<regex> returns everything through a terminal line).",
    "Watch while the user drives (minutes, hands-free): each matching entry is pushed to you as it happens —",
    `  Monitor({ ws: { url: "${ws}?after=${cursor}&include=<regex>&exclude=<regex>&level_min=<level>&until=<regex>" }, description: "<what you are watching for>", persistent: true })`,
    `  shell: tiny-log-mcp tail --url ${url} --include <regex> [--until <regex>]`,
    "  Filter to the lines you'd act on, and include the failure signatures, not only the happy path. Drop params you don't need; until closes the stream so the watch ends by itself; stop early with TaskStop.",
    `Web UI for the human: ${url}/`,
  );
  return lines.join("\n");
}

/** The short form: what exists, and how to ask for one snippet. */
function wiringIndex() {
  return [
    "Find the app's logger, then pick the least invasive interface and call hint interface=<name> for its snippet:",
    "  stdout          the process prints to stdout/stderr → pipe the dev command (no code change)",
    "  browser         a web page → inject client.js from the DevTools console or a browser tool (no code change), or one tag",
    "  logger-methods  a logger object/class with level methods → wrap them (captures calls even when the logger's level is off or flag-controlled)",
    "  transport       a logger with a transport/stream/reporter hook (pino, winston, bunyan, consola, …) → one line",
    "  other-language  Python, Go, .NET, Java, Ruby, Rust → handler/sink shape, or use stdout",
    "  http            anything else → POST /ingest",
    "Before adding log calls of your own, check whether the code already logs what you need: logger-methods captures those calls even when the logger's level would drop them. If you must add some, tag them with a unique marker (e.g. [TL-123]), filter with include, and remove every tagged line when done.",
    "Rules: call through to the original, dev-gate any source change, never let delivery throw. Verify with one test log, then start watching.",
  ];
}

/**
 * One interface's snippet, with the real URL filled in.
 * @param {string} url
 * @param {string} name
 * @returns {string[]}
 */
function wiringGuide(url, name) {
  const ingest = `${url}/ingest`;
  const send = `const send = (source, entries) => fetch("${ingest}", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source, entries }) }).catch(() => {});`;
  const inject = `(s => { s.src = "${url}/client.js"; s.dataset.source = "web"; document.head.append(s); })(document.createElement("script"))`;
  switch (name) {
    case "stdout":
      return [
        "stdout — the process prints to stdout/stderr (any language). No code change:",
        `  <dev command> 2>&1 | npx -y tiny-log-mcp pipe --source api --url ${url}`,
        "  pino/bunyan/winston NDJSON keeps level, time and fields; plain text gets ANSI stripped and a level guessed; stack frames are merged.",
      ];
    case "browser":
      return [
        `browser — load ${url}/client.js in the page. It hooks console.*, window.onerror and unhandledrejection, batches, and no-ops when the listener is down.`,
        "  The page keeps its own origin: the client POSTs cross-origin to the listener. Never proxy or re-host the page for this.",
        "  No code change (lost on reload — re-run after each load). Paste into the DevTools console, or run it with a browser-automation tool if you have one:",
        `    ${inject}`,
        `  Bookmarklet for the user:  javascript:${inject}`,
        "  In source (survives reloads; dev-gate it, remove when done). Put one tag where the app's HTML lives:",
        `    <script src="${url}/client.js" data-source="web"></script>`,
        '    Vite: index.html at the project root · Next.js: app/layout.tsx via <Script strategy="beforeInteractive"> or pages/_document · CRA/webpack: public/index.html',
        "  If the template is not in the repo (copied from a package, generated by a plugin), do not hunt for it — inject from the entry module instead:",
        `    if (process.env.NODE_ENV !== "production") { ${inject}; }`,
      ];
    case "logger-methods":
      return [
        "logger-methods — a logger object or class with level methods (custom Logger class, console, loglevel, React Native, Electron). Wrap each method; the server joins raw args.",
        "  This captures every call the app makes, including ones the logger would drop because its level is off or set by config/feature flags you cannot change: the wrapper runs before the logger's own level check. Prefer it over adding console.log calls when the code already logs what you need.",
        `  ${send}`,
        "  const fmt = (a) => (a instanceof Error ? (a.stack ?? String(a)) : a);",
        "  function tap(logger, source) {",
        '    for (const level of ["trace", "debug", "log", "info", "warn", "error", "fatal"]) {',
        "      const original = logger[level];",
        '      if (typeof original !== "function") continue;',
        "      logger[level] = function (...args) {",
        "        send(source, [{ level, args: args.map(fmt) }]);",
        "        return original.apply(this, args);",
        "      };",
        "    }",
        "  }",
        '  tap(console, "api");   // or tap(Logger.prototype, "web") for a class (once, before instances are created), tap(loglevel, "web")',
      ];
    case "transport":
      return [
        "transport — a logger with a transport / stream / reporter hook. One line; records are forwarded as-is (level + message + fields preserved):",
        `  ${send}`,
        '  pino:     pino({ level: "trace" }, { write: (line) => send("api", [JSON.parse(line)]) })',
        '  winston:  logger.add(new winston.transports.Stream({ format: winston.format.json(), stream: { write: (line) => send("api", [JSON.parse(line)]) } }))',
        '  bunyan:   streams: [{ level: "trace", type: "raw", stream: { write: (rec) => send("api", [rec]) } }]',
        '  consola:  consola.addReporter({ log: (r) => send("api", [{ level: r.type, args: r.args }]) })',
        '  tslog:    logger.attachTransport((o) => send("api", [{ level: o._meta.logLevelName, args: Object.keys(o).filter((k) => k !== "_meta").map((k) => o[k]) }]))',
        '  log4js:   appender { type: { configure: () => (e) => send("api", [{ level: e.level.levelStr, args: e.data }]) } }',
        '  debug:    debug.log = (...args) => send("api", [{ level: "debug", args }])',
        '  roarr:    globalThis.ROARR.write = (line) => send("api", [JSON.parse(line)])',
        "  If the logger's level is set by config or flags you cannot change, set it to trace for the hook or use logger-methods instead.",
      ];
    case "other-language":
      return [
        "other-language — prefer stdout (pipe the process); otherwise implement the one-method handler/sink shape and POST:",
        "  Python:   class Tap(logging.Handler):",
        `                def emit(self, r): post({"source": "api", "entries": [{"level": r.levelname, "message": self.format(r)}]})   # urllib/requests to ${ingest}, swallow errors`,
        "            logging.getLogger().addHandler(Tap())",
        "  Go: slog.Handler or an io.Writer that POSTs lines.  .NET: Serilog sink / ILoggerProvider.  Java: logback appender.  Ruby: Logger logdev.  Rust: tracing Layer.",
      ];
    case "http":
      return [
        "http — anything that can make an HTTP request:",
        `  POST ${ingest}  {"source":"api","entries":[{"level":"error","message":"…","ts":"2026-01-01T00:00:00Z","meta":{"reqId":"r1"}}]}`,
        `  curl -d "plain text" "${ingest}?source=api&level=warn"`,
        "  Accepted: a batch, a bare array, one object, or plain text. Each entry: level (any logger's names or numbers are normalized), message | msg | text | args[], ts | time, meta, source.",
      ];
    default:
      return [`Unknown guide "${name}". One of: ${GUIDES.join(", ")}, all.`];
  }
}
