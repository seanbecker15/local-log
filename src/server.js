import { readFile } from "node:fs/promises";
import http from "node:http";
import { networkInterfaces } from "node:os";
import pkg from "../package.json" with { type: "json" };
import { createActivity } from "./activity.js";
import { FilterError, MAX_LIMIT, matches, parseFilter, toRegExp } from "./filter.js";
import { DEFAULT_MAX_CHARS, formatEntries } from "./format.js";
import { safeStringify } from "./store.js";
import { errorMessage } from "./util.js";
import { acceptWebSocket } from "./ws.js";

/** @typedef {import("./store.js").Store} Store */
/** @typedef {import("./activity.js").Activity} Activity */
/** @typedef {{server: http.Server, host: string, port: number, url: string, activity: Activity, close: () => Promise<void>}} Listener */

export const DEFAULT_PORT = 7710;
export const DEFAULT_HOST = "127.0.0.1";
export const MAX_WAIT_MS = 600_000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const SSE_REPLAY = MAX_LIMIT;
const PUBLIC_DIR = new URL("../public/", import.meta.url);

const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/activity": ["activity.html", "text/html; charset=utf-8"],
  "/activity.js": ["activity.js", "text/javascript; charset=utf-8"],
  "/index.css": ["index.css", "text/css; charset=utf-8"],
  "/index.js": ["index.js", "text/javascript; charset=utf-8"],
  "/client.js": ["client.js", "text/javascript; charset=utf-8"],
};

/**
 * HTTP API over a store:
 *
 *   POST   /ingest   {source?, entries: [{level?, message, ts?, meta?}]}  (CORS: any origin)
 *   GET    /logs     ?after&level_min&include&exclude&source&limit&wait     (same-origin only)
 *   DELETE /logs
 *   GET    /events   server-sent events feed for the web UI
 *   GET    /stream   WebSocket: one text frame per matching entry as it arrives     (same-origin only)
 *                    ?after&level_min&include&exclude&source&until&format=json&max_chars
 *   GET    /health
 *   GET    /         web UI;  GET /client.js  browser drop-in
 *
 * Only `/ingest` answers cross-origin requests: the app under development
 * writes from any origin, but reading the buffer from a web page is limited to
 * the UI itself so a stray site cannot read your dev logs.
 *
 * @param {Store} store
 * @param {{maxWaitMs?: number, activity?: Activity}} [options]
 * @returns {http.Server}
 */
export function createServer(store, { maxWaitMs = MAX_WAIT_MS, activity = createActivity() } = {}) {
  const server = http.createServer((req, res) => {
    handle(store, activity, req, res, maxWaitMs).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: errorMessage(err) });
      else res.end();
    });
  });
  server.on("upgrade", (req, socket, head) => stream(store, activity, req, socket, head));
  return server;
}

/**
 * Binds a server. If the port is busy, falls back to a free one — the MCP
 * `listen` tool reports the port actually in use, so the agent always knows.
 *
 * @param {Store} store
 * @param {{port?: number, host?: string, maxWaitMs?: number, activity?: Activity}} [options]
 * @returns {Promise<Listener>}
 */
export async function startServer(
  store,
  { port = DEFAULT_PORT, host = DEFAULT_HOST, maxWaitMs, activity = createActivity() } = {},
) {
  const server = createServer(store, { maxWaitMs, activity });
  try {
    await listen(server, port, host);
  } catch (err) {
    if (
      !(err instanceof Error) ||
      /** @type {NodeJS.ErrnoException} */ (err).code !== "EADDRINUSE"
    ) {
      throw err;
    }
    await listen(server, 0, host);
  }
  const address = server.address();
  const actualPort = address && typeof address === "object" ? address.port : port;
  return {
    server,
    host,
    port: actualPort,
    url: `http://${urlHost(host)}:${actualPort}`,
    activity,
    close() {
      server.closeAllConnections();
      return /** @type {Promise<void>} */ (new Promise((resolve) => server.close(() => resolve())));
    },
  };
}

/** LAN addresses a phone or another machine could reach when bound to 0.0.0.0. */
export function lanAddresses() {
  return Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .filter((iface) => iface.family === "IPv4" && !iface.internal)
    .map((iface) => iface.address);
}

/**
 * @param {Store} store
 * @param {Activity} activity
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {number} maxWaitMs
 */
async function handle(store, activity, req, res, maxWaitMs) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const { pathname } = url;

  if (pathname === "/ingest") {
    allowAnyOrigin(res);
    if (req.method === "OPTIONS") return end(res, 204);
    if (req.method === "POST") return ingest(store, req, res, url);
    return sendJson(res, 405, { error: "method not allowed" });
  }

  if (pathname === "/logs" && req.method === "GET") return readLogs(store, res, url, maxWaitMs);
  if (pathname === "/logs" && req.method === "DELETE") return sendJson(res, 200, store.clear());
  if (pathname === "/events" && req.method === "GET") return events(store, activity, req, res);
  if (pathname === "/activity-events" && req.method === "GET") {
    return activityEvents(activity, req, res);
  }
  if (pathname === "/activity-state" && req.method === "GET") {
    return sendJson(res, 200, { presence: activity.snapshot(), deliveries: activity.recent() });
  }
  if (pathname === "/activity" && req.method === "DELETE") {
    return sendJson(res, 200, activity.clear());
  }
  if (pathname === "/health" && req.method === "GET") {
    return sendJson(res, 200, {
      ok: true,
      name: pkg.name,
      version: pkg.version,
      cursor: store.cursor,
      size: store.size,
    });
  }
  if (STATIC[pathname] && req.method === "GET") {
    const [file, type] = STATIC[pathname];
    const body = await readFile(new URL(file, PUBLIC_DIR));
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    return res.end(body);
  }
  sendJson(res, 404, { error: "not found" });
}

/**
 * @param {Store} store
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {URL} url
 */
async function ingest(store, req, res, url) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return sendJson(res, 413, { error: errorMessage(err) });
  }
  const isJson = (req.headers["content-type"] ?? "").includes("json");
  const querySource = url.searchParams.get("source") ?? undefined;

  let batch;
  if (isJson) {
    try {
      batch = toBatch(JSON.parse(body));
    } catch (err) {
      return sendJson(res, 400, { error: `invalid body: ${errorMessage(err)}` });
    }
  } else {
    // Plain text: `curl -d "something happened" host/ingest?source=api&level=warn`
    batch = {
      source: querySource,
      entries: [{ text: body, level: url.searchParams.get("level") ?? undefined }],
    };
  }

  const source = batch.source ?? querySource;
  let accepted = 0;
  for (const item of batch.entries) {
    if (typeof item !== "string" && (!item || typeof item !== "object")) continue;
    const entry = /** @type {Record<string, unknown>} */ (
      typeof item === "string" ? { text: item } : item
    );
    store.add({
      level: entry.level,
      text: entry.message ?? entry.msg ?? entry.text ?? joinArgs(entry.args),
      source: entry.source ?? source,
      ts: entry.ts ?? entry.time ?? entry.timestamp,
      meta: entry.meta,
    });
    accepted++;
  }
  sendJson(res, 200, { accepted, cursor: store.cursor });
}

/**
 * Console-style call arguments, joined the way a terminal would show them:
 * strings as-is, error-like objects by their stack, everything else as JSON.
 * Lets a logger wrapper forward `args` without formatting on the client.
 */
/** @param {unknown} args @returns {string | undefined} */
function joinArgs(args) {
  if (!Array.isArray(args)) return undefined;
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg && typeof arg === "object" && typeof arg.stack === "string") return arg.stack;
      return safeStringify(arg);
    })
    .join(" ");
}

/** @param {any} parsed @returns {{source?: unknown, entries: unknown[]}} */
function toBatch(parsed) {
  if (Array.isArray(parsed)) return { entries: parsed };
  if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed.entries)) return { source: parsed.source, entries: parsed.entries };
    return { source: parsed.source, entries: [parsed] };
  }
  throw new Error("expected {source, entries: [...]}");
}

/**
 * @param {Store} store
 * @param {http.ServerResponse} res
 * @param {URL} url
 * @param {number} maxWaitMs
 */
async function readLogs(store, res, url, maxWaitMs) {
  let filter;
  try {
    filter = parseFilter(Object.fromEntries(url.searchParams));
  } catch (err) {
    if (err instanceof FilterError) return sendJson(res, 400, { error: err.message });
    throw err;
  }
  const wait = Math.min(Number(url.searchParams.get("wait")) || 0, maxWaitMs);
  let entries = store.query(filter);
  if (entries.length === 0 && wait > 0) entries = await store.wait(filter, wait);
  sendJson(res, 200, {
    cursor: store.cursor,
    count: entries.length,
    timed_out: entries.length === 0 && wait > 0,
    entries,
  });
}

/**
 * @param {Store} store
 * @param {Activity} activity
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
function events(store, activity, req, res) {
  const viewer = activity.open("viewer");
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  // Send a comment immediately so headers reach EventSource even when the
  // buffer is empty. Otherwise the UI stays "connecting" until the first log
  // or the 25-second heartbeat.
  res.write(": connected\n\n");
  /** @param {"entry" | "clear" | "presence"} event @param {any} data */
  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send("presence", activity.snapshot());
  for (const entry of store.query(parseFilter({ limit: SSE_REPLAY }))) send("entry", entry);
  const unsubscribeStore = store.subscribe(send);
  const unsubscribeActivity = activity.subscribe((event, data) => {
    if (event === "presence") send(event, data);
  });
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
  heartbeat.unref();
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribeStore();
    unsubscribeActivity();
    viewer.close();
  });
}

/**
 * Same-origin activity feed for the observer UI. Replays the bounded delivery
 * transcript, then emits presence and exact payloads as they change.
 * @param {Activity} activity
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
function activityEvents(activity, req, res) {
  const viewer = activity.open("viewer");
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  /** @param {string} event @param {unknown} data */
  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send("presence", activity.snapshot());
  for (const delivery of activity.recent()) send("delivery", delivery);
  const unsubscribe = activity.subscribe(send);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
  heartbeat.unref();
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    viewer.close();
  });
}

/**
 * WebSocket event stream: every entry that passes the filter is sent as one
 * text frame the moment it arrives. Starts from `after` when given, otherwise
 * from now. `until=<regex>` closes the stream after the matching entry, so a
 * watcher ends on its own. Built for Claude Code's Monitor tool and the
 * `tail` command; same-origin only, like every other read.
 *
 * @param {Store} store
 * @param {Activity} activity
 * @param {http.IncomingMessage} req
 * @param {import("node:stream").Duplex} socket
 * @param {Buffer} head
 */
function stream(store, activity, req, socket, head) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const refuse = (/** @type {string} */ status, /** @type {string} */ body = "") => {
    socket.write(
      `HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${body}`,
    );
    socket.destroy();
  };
  if (url.pathname !== "/stream") return refuse("404 Not Found");
  // Browsers send Origin on WebSocket upgrades; a page from anywhere else must
  // not read the buffer. Non-browser clients (Monitor, tail, curl) send none.
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) return refuse("403 Forbidden");

  const params = Object.fromEntries(url.searchParams);
  let filter;
  let until;
  try {
    filter = parseFilter(params);
    until = toRegExp(params.until, "until");
  } catch (err) {
    if (err instanceof FilterError) return refuse("400 Bad Request", err.message);
    throw err;
  }
  const asJson = params.format === "json";
  const maxChars =
    params.max_chars === undefined ? DEFAULT_MAX_CHARS : Number(params.max_chars) || 0;
  const after = params.after === undefined ? store.cursor : filter.after;

  const ws = acceptWebSocket(req, socket, head);
  if (!ws) return;
  const watcher = activity.open("stream");
  ws.onClose(watcher.close);
  /** @param {import("./store.js").Entry} entry */
  const emit = (entry) => {
    if (ws.closed) return;
    const text = asJson ? JSON.stringify(entry) : formatEntries([entry], { maxChars });
    ws.send(text);
    activity.deliver({
      channel: "stream",
      client: watcher.id,
      tool: "monitor",
      args: params,
      text,
      error: false,
    });
    if (until?.test(entry.text)) ws.close(1000, "until matched");
  };
  for (const entry of store.query({ ...filter, after, limit: MAX_LIMIT })) emit(entry);
  const unsubscribe = store.subscribe((event, payload) => {
    if (event === "entry" && payload.seq > after && matches(payload, filter)) emit(payload);
  });
  ws.onClose(unsubscribe);
}

/** @param {http.IncomingMessage} req @returns {Promise<string>} */
function readBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** @param {http.Server} server @param {number} port @param {string} host @returns {Promise<void>} */
function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    /** @param {Error} err */
    const onError = (err) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/** @param {string} host @returns {string} */
function urlHost(host) {
  return host === "0.0.0.0" || host === "::" ? "localhost" : host;
}

/** @param {http.ServerResponse} res */
function allowAnyOrigin(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

/** @param {http.ServerResponse} res @param {number} status @param {unknown} payload */
function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

/** @param {http.ServerResponse} res @param {number} status */
function end(res, status) {
  res.writeHead(status);
  res.end();
}
