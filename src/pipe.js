import { createInterface } from "node:readline";
import { errorMessage } from "./util.js";

/** @typedef {{level: unknown, text: string, ts?: unknown, meta?: Record<string, unknown>}} PipeEntry */

const FLUSH_MS = 250;
const FLUSH_SIZE = 500;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const CONSUMED_KEYS = new Set([
  "level",
  "severity",
  "msg",
  "message",
  "text",
  "time",
  "ts",
  "timestamp",
  "@timestamp",
  "pid",
  "hostname",
  "v",
]);

/**
 * Turns one line of process output into an ingest entry. NDJSON records
 * (pino, bunyan, winston) keep their level, timestamp and extra fields; plain
 * text gets ANSI stripped and a level guessed from keywords.
 *
 * @param {string} raw
 * @returns {PipeEntry | null} null for blank lines.
 */
export function parseLine(raw) {
  const line = raw.replace(ANSI, "").replace(/\r$/, "");
  if (line.trim() === "") return null;
  if (line.trimStart().startsWith("{")) {
    try {
      const record = JSON.parse(line);
      if (record && typeof record === "object" && !Array.isArray(record)) return fromRecord(record);
    } catch {
      // not JSON after all; fall through to plain text
    }
  }
  return { level: guessLevel(line), text: line };
}

/** Continuation lines (indented, e.g. stack frames) belong to the previous entry. */
/** @param {string} text */
export function isContinuation(text) {
  return /^\s+\S/.test(text);
}

/** @param {Record<string, unknown>} record @returns {PipeEntry} */
function fromRecord(record) {
  const text = record.msg ?? record.message ?? record.text;
  /** @type {Record<string, unknown>} */
  const meta = {};
  for (const [key, value] of Object.entries(record)) {
    if (!CONSUMED_KEYS.has(key)) meta[key] = value;
  }
  return {
    level: record.level ?? record.severity,
    text: typeof text === "string" ? text : JSON.stringify(record),
    ts: record.time ?? record.ts ?? record.timestamp ?? record["@timestamp"],
    meta: Object.keys(meta).length > 0 && typeof text === "string" ? meta : undefined,
  };
}

/** @param {string} text @returns {string} */
function guessLevel(text) {
  if (/\b(fatal|panic)\b/i.test(text)) return "fatal";
  if (/(\berr\b|error|exception|unhandled|uncaught|failed|traceback)/i.test(text)) return "error";
  if (/\b(warn|warning|deprecat\w*)\b/i.test(text)) return "warn";
  if (/\b(debug|trace|verbose)\b/i.test(text)) return "debug";
  return "info";
}

/**
 * Reads lines from `input`, echoes them to `output` (unless quiet) and forwards
 * them in batches to a listener's `/ingest`. Never throws on delivery failure:
 * the app's own output must keep flowing even when nobody is listening.
 *
 * @param {object} options
 * @param {string} options.url listener base URL
 * @param {string} [options.source] label for these logs
 * @param {boolean} [options.quiet] do not echo input to output
 * @param {NodeJS.ReadableStream} [options.input]
 * @param {NodeJS.WritableStream} [options.output]
 * @param {NodeJS.WritableStream} [options.stderr]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<void>} resolves once input ends and the last batch is sent.
 */
export async function runPipe({
  url,
  source,
  quiet = false,
  input = process.stdin,
  output = process.stdout,
  stderr = process.stderr,
  fetchImpl = fetch,
}) {
  const endpoint = `${url.replace(/\/$/, "")}/ingest`;
  /** @type {PipeEntry[]} */
  let batch = [];
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  let unreachable = false;
  let inFlight = Promise.resolve();

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (batch.length === 0) return inFlight;
    const entries = batch;
    batch = [];
    inFlight = inFlight.then(async () => {
      try {
        const res = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ source, entries }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (unreachable) {
          unreachable = false;
          stderr.write(`tiny-log-mcp: reconnected to ${endpoint}\n`);
        }
      } catch (err) {
        if (!unreachable) {
          unreachable = true;
          stderr.write(
            `tiny-log-mcp: cannot reach ${endpoint} (${errorMessage(err)}); will keep trying\n`,
          );
        }
      }
    });
    return inFlight;
  };

  const push = (entry) => {
    batch.push(entry);
    if (batch.length >= FLUSH_SIZE) flush();
    else if (!timer) timer = setTimeout(flush, FLUSH_MS);
  };

  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const raw of lines) {
    if (!quiet) output.write(`${raw}\n`);
    const entry = parseLine(raw);
    if (!entry) continue;
    const previous = batch.at(-1);
    if (previous && !previous.meta && isContinuation(entry.text) && !entry.meta) {
      previous.text += `\n${entry.text}`;
    } else {
      push(entry);
    }
  }
  await flush();
}
