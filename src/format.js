export const DEFAULT_MAX_CHARS = 800;

/**
 * Renders entries as compact, line-oriented text for an agent to read:
 *
 *   #4812 12:04:31.220 ERROR api   TypeError: Cannot read properties of undefined
 *       at OrderService.load (src/orders.ts:88:14)
 *       meta: {"orderId":42}
 *   #4813 12:04:31.221 WARN  web   fetch /api/orders 500
 *       (repeated ×36, through #4849)
 *
 * Consecutive identical entries collapse into one line with a repeat count.
 * Long entries are cut at `maxChars` with a hint on how to re-read them whole.
 *
 * @param {import('./store.js').Entry[]} entries
 * @param {{maxChars?: number}} [options] `maxChars: 0` disables truncation.
 * @returns {string}
 */
export function formatEntries(entries, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  const lines = [];
  let i = 0;
  while (i < entries.length) {
    const entry = entries[i];
    let j = i + 1;
    while (j < entries.length && sameMessage(entries[j], entry)) j++;
    lines.push(formatEntry(entry, maxChars));
    if (j - i > 1) {
      lines.push(`    (repeated ×${j - i - 1}, through #${entries[j - 1].seq})`);
    }
    i = j;
  }
  return lines.join("\n");
}

/** One-line summary placed above the entries so the agent knows what to do next. */
export function formatHeader({ count, cursor, timedOut = false }) {
  if (timedOut) {
    return `No matching logs arrived before the timeout (cursor ${cursor}).`;
  }
  if (count === 0) {
    return `No matching logs (cursor ${cursor}). Pass after=${cursor} later to read only what is new.`;
  }
  const noun = count === 1 ? "entry" : "entries";
  return `${count} ${noun}, times UTC (cursor ${cursor}). Pass after=${cursor} to read only newer ones.`;
}

/** @param {import('./store.js').Entry} entry @param {number} maxChars @returns {string} */
function formatEntry(entry, maxChars) {
  const time = entry.ts.slice(11, 23);
  const level = entry.level.toUpperCase().padEnd(5);
  const source = entry.source ? `${entry.source} ` : "";
  let body = entry.text;
  if (entry.meta) body += `\nmeta: ${JSON.stringify(entry.meta)}`;

  let suffix = "";
  if (maxChars > 0 && body.length > maxChars) {
    const dropped = body.length - maxChars;
    body = body.slice(0, maxChars);
    suffix = `… [+${dropped} chars; re-read with after=${entry.seq - 1} limit=1 max_chars=0]`;
  }

  const [first, ...rest] = body.split("\n");
  const head = `#${entry.seq} ${time} ${level} ${source}${first}`;
  const tail = rest.map((line) => `    ${line}`);
  if (suffix) {
    if (tail.length > 0) tail[tail.length - 1] += suffix;
    else return head + suffix;
  }
  return [head, ...tail].join("\n");
}

/** @param {import('./store.js').Entry} a @param {import('./store.js').Entry} b @returns {boolean} */
function sameMessage(a, b) {
  return (
    a.level === b.level &&
    a.source === b.source &&
    a.text === b.text &&
    JSON.stringify(a.meta) === JSON.stringify(b.meta)
  );
}
