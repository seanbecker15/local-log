import { matches } from "./filter.js";
import { normalizeLevel } from "./levels.js";

export const DEFAULT_CAPACITY = 10000;

/**
 * @typedef {object} Entry
 * @property {number} seq monotonic, never reused (survives clear)
 * @property {string} ts ISO-8601
 * @property {string} level one of LEVELS
 * @property {string} [source] the reporting app or process
 * @property {string} text
 * @property {Record<string, unknown>} [meta] structured fields from the logger
 */

/**
 * @typedef {object} EntryInput raw fields as sent by any client; everything is optional and untrusted
 * @property {unknown} [level]
 * @property {unknown} [text]
 * @property {unknown} [message]
 * @property {unknown} [source]
 * @property {unknown} [ts]
 * @property {unknown} [meta]
 */

/** @typedef {ReturnType<typeof createStore>} Store */
/** @typedef {(event: "entry" | "clear", payload: any) => void} Subscriber */

/**
 * In-memory ring buffer of log entries with a monotonic cursor, filtered
 * queries, one-shot long-poll waiters and streaming subscribers.
 *
 * Entries are `{seq, ts, level, source, text, meta?}`. `seq` keeps counting
 * across `clear()` so a stale cursor can never re-read a recycled number.
 */
export function createStore({ capacity = DEFAULT_CAPACITY } = {}) {
  /** @type {Entry[]} */
  let entries = [];
  let seq = 0;
  /** One-shot callbacks from in-flight `wait()` calls. @type {Set<() => void>} */
  const waiters = new Set();
  /** Persistent listeners, e.g. the SSE feed. @type {Set<Subscriber>} */
  const subscribers = new Set();

  /**
   * Normalizes and appends a record. Non-string messages are JSON encoded.
   * @param {EntryInput} [input]
   * @returns {Entry} the stored entry.
   */
  function add({ level, text, message, source, ts, meta } = {}) {
    const raw = text ?? message ?? "";
    /** @type {Entry} */
    const entry = {
      seq: ++seq,
      ts: toIsoTimestamp(ts),
      level: normalizeLevel(level),
      source: typeof source === "string" && source !== "" ? source : undefined,
      text: typeof raw === "string" ? raw : safeStringify(raw),
    };
    if (meta && typeof meta === "object" && Object.keys(meta).length > 0) {
      entry.meta = /** @type {Record<string, unknown>} */ (meta);
    }

    entries.push(entry);
    if (entries.length > capacity) {
      entries.splice(0, entries.length - capacity);
    }

    for (const notify of subscribers) notify("entry", entry);
    // Snapshot and clear BEFORE waking. A waiter whose filter this entry does
    // not match re-registers itself during the wake and must survive into the
    // next round; clearing afterwards would silently drop it.
    const pending = Array.from(waiters);
    waiters.clear();
    for (const wake of pending) wake();
    return entry;
  }

  /**
   * Newest `limit` entries after the cursor that pass the filter, oldest first.
   * Walks backwards so a huge buffer with a narrow filter stays cheap.
   * @param {import('./filter.js').Filter} filter
   * @returns {Entry[]}
   */
  function query(filter) {
    /** @type {Entry[]} */
    const out = [];
    for (let i = entries.length - 1; i >= 0 && out.length < filter.limit; i--) {
      const entry = entries[i];
      if (entry.seq <= filter.after) break;
      if (matches(entry, filter)) out.push(entry);
    }
    return out.reverse();
  }

  /**
   * Resolves with matches as soon as any exist, or with `[]` once `timeoutMs`
   * elapses. Re-checks on every arrival because an arrival may not match.
   * @param {import('./filter.js').Filter} filter
   * @param {number} timeoutMs
   * @returns {Promise<Entry[]>}
   */
  function wait(filter, timeoutMs) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const attempt = () => {
        const found = query(filter);
        if (found.length > 0) return resolve(found);
        const remaining = deadline - Date.now();
        if (remaining <= 0) return resolve([]);
        const timer = setTimeout(() => {
          waiters.delete(wake);
          resolve([]);
        }, remaining);
        const wake = () => {
          clearTimeout(timer);
          attempt();
        };
        waiters.add(wake);
      };
      attempt();
    });
  }

  /** Discards buffered entries. The cursor is preserved. */
  function clear() {
    const cleared = entries.length;
    entries = [];
    for (const notify of subscribers) notify("clear", { cursor: seq });
    return { cursor: seq, cleared };
  }

  /** @param {Subscriber} notify @returns {() => void} unsubscribe */
  function subscribe(notify) {
    subscribers.add(notify);
    return () => subscribers.delete(notify);
  }

  return {
    add,
    query,
    wait,
    clear,
    subscribe,
    get cursor() {
      return seq;
    },
    get size() {
      return entries.length;
    },
  };
}

/** @param {unknown} ts @returns {string} */
function toIsoTimestamp(ts) {
  if (ts !== undefined && ts !== null && ts !== "") {
    const date = new Date(/** @type {string | number | Date} */ (ts));
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}

/** JSON.stringify that survives cycles, bigints and errors. @param {unknown} value @returns {string} */
export function safeStringify(value) {
  const seen = new WeakSet();
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint") return item.toString();
    if (item instanceof Error) return { name: item.name, message: item.message, stack: item.stack };
    if (item && typeof item === "object") {
      if (seen.has(item)) return "[Circular]";
      seen.add(item);
    }
    return item;
  });
}
