import { errorMessage } from "./util.js";

/**
 * Follows a listener's `/stream` and prints one line (or JSON object) per
 * matching entry as it arrives. Exits when the stream closes — which `until`
 * causes after its match — so it works as a bounded Monitor command.
 *
 * @param {object} options
 * @param {string} options.url listener base URL, e.g. http://127.0.0.1:7710
 * @param {Record<string, string | undefined>} [options.query] filter params: after, level_min, include, exclude, source, until, format, max_chars
 * @param {NodeJS.WritableStream} [options.output]
 * @param {NodeJS.WritableStream} [options.stderr]
 * @returns {Promise<number>} the WebSocket close code (1000 = clean)
 */
export function runTail({ url, query = {}, output = process.stdout, stderr = process.stderr }) {
  const target = new URL("/stream", url);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") target.searchParams.set(key, value);
  }
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target);
    ws.addEventListener("message", (event) => {
      output.write(`${String(event.data)}\n`);
    });
    ws.addEventListener("error", () => {
      reject(new Error(`cannot connect to ${target.origin} — is the listener running?`));
    });
    ws.addEventListener("close", (event) => {
      if (event.code !== 1000 && event.code !== 1005) {
        stderr.write(
          `tiny-log-mcp: stream closed (${event.code}${event.reason ? ` ${event.reason}` : ""})\n`,
        );
      }
      resolve(event.code);
    });
  });
}

/** @param {unknown} err */
export function tailFailure(err) {
  return `tiny-log-mcp tail: ${errorMessage(err)}\n`;
}
