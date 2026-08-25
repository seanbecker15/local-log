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
/**
 * Shared per-connection state: whether the client can show the user a dialog
 * (MCP elicitation), and the outbound-request function once the transport is up.
 * @typedef {{elicitation?: boolean, request?: import("./jsonrpc.js").Rpc["request"]}} Session
 */

export const GUIDES = [
  "logger-methods",
  "transport",
  "console",
  "stdout",
  "other-language",
  "http",
];

export const INSTRUCTIONS = `tiny-log-mcp collects logs from the app under development (browser, phone/device, backend process) into a buffer you can read or watch. Reach for it whenever you need to see what the app printed instead of asking the user to paste console output.

Setup, once per project:
1. Check your project memory and the project's agent docs (AGENTS.md/CLAUDE.md) for a saved tiny-log setup from an earlier session. If one exists, reuse it: call \`listen\` and skip straight to verifying. If it is recorded as having failed, present the remaining options to the user instead.
2. Otherwise call \`listen\` for the URL and the stream address, then \`hint\` for the facts to gather; answer them from the codebase and call hint again for the applicable options. When the client supports it, hint puts the choice directly in front of the user as a dialog and returns only what they picked — honor it. When it returns a menu instead, present the options yourself with the concrete paths you found and let the user pick — their app knowledge beats inference. No user, or one obvious fit: take the least invasive.
3. Find the app's logger (a shared logger module or class, or plain console.*) and what the dev command prints. If the code already logs what you need, capture those calls — wrapping the logger's methods captures them even when its level is off or flag-controlled — before adding any log calls of your own. If you must add some, tag them with a unique marker and remove every tagged line when done; the dev-gated hook itself is worth keeping committed, it is what makes the next session instant.
4. Hook it by what the code logs THROUGH, not where it runs — a web app with its own logger wants logger-methods (the tap runs in the page), while console/client.js covers plain console.* and uncaught errors; they compose. Prefer hooks that need no source change (stdout pipe, DevTools injection). Call through to the original, dev-gate any source change, never let delivery throw.
5. Verify with one test log and read_logs. Then save the setup — the facts you passed to hint, the approach and where the hook lives, the filters with good signal, and how smoothly it went — to the project's agent docs if the project keeps them (teammates' agents benefit), else to your own project memory.

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
 * @param {{store: Store, defaults?: BindOptions, session?: Session}} deps
 */
export function createTools({ store, defaults = {}, session = {} }) {
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
        "How to wire the app's logs to the listener. Investigate the codebase, pass what you " +
        "found (logger, logger_package, level_gated, runs_in, …), and get the applicable options " +
        "with trade-offs — present them to the user and let them pick when they differ " +
        "materially; their app knowledge beats inference. Without arguments: the questions to " +
        "answer. interface=<name> skips straight to one snippet (logger-methods, transport, " +
        "console, stdout, other-language, http, all).",
      inputSchema: {
        type: "object",
        properties: {
          language: {
            type: "string",
            description:
              'The app\'s language: "js"/"ts", or the language name if not JavaScript (python, go, …).',
          },
          runs_in: {
            type: "string",
            enum: ["browser", "node", "react-native", "electron", "other"],
            description: "Where the code you want logs from runs.",
          },
          logger: {
            type: "string",
            description:
              "The shared logger module or class the code actually calls — grep for `logger.`, " +
              "`createLogger`, `getLogger`, `class Logger` before answering, do not guess. " +
              '"console" if it logs with console.*; "none" if neither.',
          },
          logger_package: {
            type: "string",
            description:
              "The underlying logging package, if identifiable from package.json or imports: " +
              "pino, winston, bunyan, consola, tslog, log4js, loglevel, debug, roarr, or a custom/unknown name.",
          },
          level_gated: {
            type: "boolean",
            description:
              "true if the effective log level comes from config, env, or feature flags you cannot easily change locally (calls below it never reach the logger's outputs).",
          },
          emits_ndjson: {
            type: "boolean",
            description:
              "true if the dev command prints JSON log lines (pino/bunyan style) to stdout.",
          },
          interface: {
            type: "string",
            enum: [...GUIDES, "all"],
            description: "Skip the facts and fetch one interface's snippet directly.",
          },
        },
        additionalProperties: false,
      },
      async handler({ interface: name, ...facts }) {
        const current = await ensureListener();
        if (name === "all")
          return GUIDES.map((g) => wiringGuide(current.url, g).join("\n")).join("\n\n");
        if (name) return wiringGuide(current.url, name).join("\n");
        if (Object.values(facts).some((value) => value !== undefined && value !== "")) {
          const options = buildOptions(facts);
          // The http catch-all is always present; a dialog is only worth the
          // interruption when there are at least two real alternatives.
          const realOptions = options.filter((option) => option.name !== "http").length;
          if (session.elicitation && session.request && realOptions >= 2) {
            const outcome = await elicitChoice(session.request, current.url, options);
            if (outcome) return outcome;
          }
          return renderMenu(options).join("\n");
        }
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
 * @param {Session} [session]
 * @returns {Record<string, (params: any) => Promise<unknown>>}
 */
export function createHandlers(toolset, session = {}) {
  const byName = new Map(toolset.tools.map((tool) => [tool.name, tool]));
  return {
    initialize: async (params) => {
      session.elicitation = Boolean(params?.capabilities?.elicitation);
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
  /** @type {Session} */
  const session = {};
  const toolset = createTools({ store, defaults, session });
  // Bind eagerly so an app wired to a pinned port can start sending before the
  // agent calls `listen`; the tool still reports the actual port.
  try {
    await toolset.ensureListener();
  } catch (err) {
    process.stderr.write(`tiny-log-mcp: listener not started (${errorMessage(err)})\n`);
  }
  await serveStdio({
    input,
    output,
    handlers: (rpc) => {
      session.request = rpc.request;
      return createHandlers(toolset, session);
    },
  });
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
    "Answer these from the codebase (grep — don't guess), then call hint again with what you found for the applicable options to put in front of the user:",
    '  logger          the shared logger module/class the code calls (grep for logger., createLogger, getLogger, class Logger); "console" or "none" if there is not one',
    "  logger_package  the underlying package if identifiable: pino, winston, bunyan, consola, tslog, log4js, loglevel, debug, roarr, or custom",
    "  level_gated     true if the effective level comes from config/env/feature flags you can't change locally",
    "  runs_in         browser | node | react-native | electron | other",
    "  emits_ndjson    true if the dev command prints JSON log lines to stdout",
    '  language        "js"/"ts", or the language if not JavaScript',
    "",
    "For orientation — the interfaces the options draw from (interface=<name> fetches one directly). What applies depends on what the code logs THROUGH, not where it runs:",
    "  logger-methods  wrap a logger object/class's level methods (captures calls even when the logger's level is off or flag-controlled)",
    "  transport       one line on a logger's transport/stream/reporter hook (pino, winston, bunyan, consola, …)",
    "  console         client.js for a page's plain console.* + uncaught errors; composes with logger-methods when a page has both",
    "  stdout          pipe the dev command (no code change)",
    "  other-language  Python, Go, .NET, Java, Ruby, Rust → handler/sink shape",
    "  http            anything else → POST /ingest",
    "Before adding log calls of your own, check whether the code already logs what you need: logger-methods captures those calls even when the logger's level would drop them. If you must add some, tag them with a unique marker (e.g. [TL-123]), filter with include, and remove every tagged line when done.",
    "Rules: call through to the original, dev-gate any source change, never let delivery throw. Verify with one test log, then start watching. Once verified, record the setup in the project's agent docs or your project memory so the next session skips this.",
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
    case "console":
      return [
        `console — a web page logging with plain console.*: load ${url}/client.js in the page. It wraps console.* and also catches window.onerror and unhandledrejection, batches, and no-ops when the listener is down.`,
        "  It only sees console calls. If the page routes logs through its own logger object/class, wrap that too (hint interface=logger-methods) — the tap runs in the page the same way, and both post to the same listener.",
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
        "logger-methods — the app logs through a logger object or class with level methods (custom Logger class, console, loglevel). Wrap each method; the server joins raw args. Works wherever the code runs — a browser page included: paste the tap in the DevTools console after the app loads, or run it early in the entry module (dev-gated).",
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
        "  In a page, add client.js as well (hint interface=console) so uncaught errors and rejections are captured too.",
      ];
    case "transport": {
      const rows = Object.entries(TRANSPORT_LINES).map(
        ([pkg, line]) => `  ${pkg}:${" ".repeat(Math.max(1, 9 - pkg.length))}${line}`,
      );
      return [
        "transport — a logger with a transport / stream / reporter hook. One line; records are forwarded as-is (level + message + fields preserved):",
        `  ${send}`,
        ...rows,
        "  If the logger's level is set by config or flags you cannot change, set it to trace for the hook or use logger-methods instead.",
      ];
    }
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

/** One-line hook per known transport-style logger, shared by the guide and buildOptions(). */
const TRANSPORT_LINES = {
  pino: 'pino({ level: "trace" }, { write: (line) => send("api", [JSON.parse(line)]) })',
  winston:
    'logger.add(new winston.transports.Stream({ format: winston.format.json(), stream: { write: (line) => send("api", [JSON.parse(line)]) } }))',
  bunyan:
    'streams: [{ level: "trace", type: "raw", stream: { write: (rec) => send("api", [rec]) } }]',
  consola: 'consola.addReporter({ log: (r) => send("api", [{ level: r.type, args: r.args }]) })',
  tslog:
    'logger.attachTransport((o) => send("api", [{ level: o._meta.logLevelName, args: Object.keys(o).filter((k) => k !== "_meta").map((k) => o[k]) }]))',
  log4js:
    'appender { type: { configure: () => (e) => send("api", [{ level: e.level.levelStr, args: e.data }]) } }',
  debug: 'debug.log = (...args) => send("api", [{ level: "debug", args }])',
  roarr: 'globalThis.ROARR.write = (line) => send("api", [JSON.parse(line)])',
};

const JS_NAMES = new Set(["", "js", "ts", "javascript", "typescript", "node", "jsx", "tsx"]);

const OTHER_CHOICE = "Other — I'll describe the hook in chat";
const VERIFY_TAIL =
  "Then verify the pick: emit one test log, read it back with read_logs, and start watching. Once verified, save the chosen setup (facts, approach, hook location, filters) to the project's agent docs or your project memory — the next session skips this.";

/**
 * The applicable wiring options for these facts, roughly ordered by fit — a
 * filter, not a judge. When the client supports elicitation the user picks in
 * a dialog; otherwise the agent presents the rendered menu and the user picks
 * in chat. Deciding is cheap for the human and unreliable for the agent.
 *
 * @typedef {{name: string, label: string, tradeoff: string}} WiringOption
 * @param {{language?: string, runs_in?: string, logger?: string, logger_package?: string, level_gated?: boolean, emits_ndjson?: boolean}} facts
 * @returns {WiringOption[]}
 */
function buildOptions(facts) {
  const language = String(facts.language ?? "").toLowerCase();
  const runsIn = String(facts.runs_in ?? "");
  const logger = String(facts.logger ?? "").trim();
  const pkg = String(facts.logger_package ?? "").toLowerCase();
  const gated = facts.level_gated === true;
  const ndjson = facts.emits_ndjson === true;
  const inBrowser = runsIn === "browser";
  const hasLogger = logger !== "" && !["console", "none"].includes(logger.toLowerCase());
  // Options that capture downstream of a gated logger (console.*, stdout) never
  // see the calls its level check drops. That blind spot must be on the label.
  const gatedBlindSpot = hasLogger && gated ? `; will MISS ${logger}'s level-gated calls` : "";

  /** @type {WiringOption[]} */
  const options = [];
  /** @param {string} name @param {string} label @param {string} tradeoff */
  const add = (name, label, tradeoff) => options.push({ name, label, tradeoff });

  if (!JS_NAMES.has(language)) {
    add(
      "other-language",
      `a ${facts.language} handler/sink`,
      "one class wired into the logging config; keeps level and message",
    );
    if (!inBrowser)
      add(
        "stdout",
        "pipe the dev command's stdout",
        "no code change; captures only what reaches stdout",
      );
  } else {
    if (hasLogger) {
      add(
        "logger-methods",
        `wrap ${logger}'s level methods`,
        (gated
          ? "captures every call even though the level is flag/config-gated (the wrapper runs before the level check); "
          : "captures the calls the code already makes; ") +
          "one dev-gated source change, survives reloads",
      );
    } else if (runsIn === "react-native") {
      add("logger-methods", "wrap console with the tap", "React Native has no DOM for client.js");
    }
    if (pkg in TRANSPORT_LINES) {
      add(
        "transport",
        `one line on ${pkg}'s transport hook`,
        "records keep level, message and fields" +
          (gated ? "; force its level to trace to beat the gate" : ""),
      );
    }
    if (inBrowser) {
      add(
        "console",
        "inject client.js with no code change",
        `paste in the DevTools console (or via a browser tool); catches console.* and uncaught errors; lost on reload, nothing to clean up${gatedBlindSpot}`,
      );
      add(
        "console",
        "load client.js from source",
        `script tag or entry-module injection; survives reloads; dev-gated source change${gatedBlindSpot}`,
      );
    } else if (runsIn !== "react-native") {
      add(
        "stdout",
        "pipe the dev command's stdout",
        "no code change" +
          (ndjson
            ? "; the NDJSON keeps level, time and fields"
            : "; captures only what reaches stdout, plain-text levels are guessed") +
          gatedBlindSpot,
      );
    }
  }
  add("http", "POST /ingest from anything", "raw HTTP; a batch, one object, or plain text");
  return options;
}

/**
 * Today's text menu, for clients without elicitation or a dismissed dialog.
 * @param {WiringOption[]} options @returns {string[]}
 */
function renderMenu(options) {
  const rows = options.map(
    ({ name, label, tradeoff }, i) =>
      `${i + 1}. ${label} — ${tradeoff} (snippet: hint interface=${name})`,
  );
  return [
    "Applicable ways to wire this app, roughly ordered by fit. If a user is present and these differ materially (a source change versus none), present them with the concrete paths you found and let the user pick. No user, or one obvious fit: take the least invasive.",
    "",
    ...rows,
    `${options.length + 1}. Other — ask the user; they may know a hook you did not find (a logging util, a debug flag).`,
    "",
    VERIFY_TAIL,
  ];
}

/**
 * Puts the choice directly in front of the user via MCP elicitation. Returns
 * the tool result for a decided dialog, or null to fall back to the menu
 * (request failed / timed out / feature broke — never block the flow).
 *
 * @param {NonNullable<Session["request"]>} request
 * @param {string} url
 * @param {WiringOption[]} options
 * @returns {Promise<string | null>}
 */
async function elicitChoice(request, url, options) {
  const labels = [...options.map((o) => o.label), OTHER_CHOICE];
  try {
    const response = await request("elicitation/create", {
      message: [
        "How should tiny-log hook into this app's logs?",
        ...options.map((o, i) => `${i + 1}. ${o.label} — ${o.tradeoff}`),
      ].join("\n"),
      requestedSchema: {
        type: "object",
        properties: {
          choice: { type: "string", title: "Integration", enum: labels },
        },
        required: ["choice"],
      },
    });
    if (response?.action !== "accept") {
      return [
        "The user dismissed the choice dialog — present the options in chat instead and let them pick there.",
        "",
        ...renderMenu(options),
      ].join("\n");
    }
    const choice = response.content?.choice;
    if (choice === OTHER_CHOICE) {
      return "The user chose Other — ask them in chat which hook they have in mind, wire that, and verify with a test log.";
    }
    const picked = options.find((o) => o.label === choice);
    if (!picked) return null;
    return [
      `The user chose: ${picked.label} (${picked.tradeoff}).`,
      "",
      ...wiringGuide(url, picked.name),
      "",
      VERIFY_TAIL,
    ].join("\n");
  } catch {
    return null;
  }
}
