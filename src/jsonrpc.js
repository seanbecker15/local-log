import { createInterface } from "node:readline";
import { errorMessage } from "./util.js";

/** A JSON-RPC error with a protocol error code. */
export class RpcError extends Error {
  /** @param {number} code @param {string} message @param {unknown} [data] */
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

/**
 * Serves newline-delimited JSON-RPC 2.0 over a pair of streams — the MCP stdio
 * transport. `handlers` maps method names to `async (params) => result`.
 * Notifications (no `id`) run their handler, if any, and get no reply.
 *
 * @param {object} options
 * @param {NodeJS.ReadableStream} [options.input]
 * @param {NodeJS.WritableStream} [options.output]
 * @param {Record<string, (params: any) => Promise<unknown>>} options.handlers
 * @returns {Promise<void>} resolves when the input stream ends.
 */
export function serveStdio({ input = process.stdin, output = process.stdout, handlers }) {
  /** @param {unknown} message */
  const write = (message) => output.write(`${JSON.stringify(message)}\n`);

  /** @param {any} message */
  const dispatch = async (message) => {
    if (Array.isArray(message)) {
      return write(errorResponse(null, INVALID_REQUEST, "batch requests are not supported"));
    }
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") {
      return write(errorResponse(message?.id ?? null, INVALID_REQUEST, "invalid request"));
    }
    const { id, method, params } = message;
    const isNotification = id === undefined;
    const handler = handlers[method];
    if (!handler) {
      if (isNotification) return;
      return write(errorResponse(id, METHOD_NOT_FOUND, `method not found: ${method}`));
    }
    try {
      const result = await handler(params ?? {});
      if (!isNotification) write({ jsonrpc: "2.0", id, result: result ?? {} });
    } catch (err) {
      if (isNotification) return;
      const code = err instanceof RpcError ? err.code : INTERNAL_ERROR;
      const data = err instanceof RpcError ? err.data : undefined;
      write(errorResponse(id, code, errorMessage(err), data));
    }
  };

  return new Promise((resolve) => {
    const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    lines.on("line", (line) => {
      if (line.trim() === "") return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return write(errorResponse(null, PARSE_ERROR, "parse error"));
      }
      dispatch(message);
    });
    lines.on("close", resolve);
  });
}

/** @param {unknown} id @param {number} code @param {string} message @param {unknown} [data] */
function errorResponse(id, code, message, data) {
  /** @type {{code: number, message: string, data?: unknown}} */
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}
