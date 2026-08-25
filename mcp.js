#!/usr/bin/env node
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StdioServerTransport,
} = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");

const BASE_URL = process.env.LOCAL_LOG_URL || "http://localhost:3000";
const LEVEL = z.enum(["log", "info", "warn", "error", "debug"]);

const FILTER_SCHEMA = {
  after: z
    .number()
    .optional()
    .describe("Only return entries newer than this cursor"),
  level: LEVEL.optional().describe("Only return entries at this level"),
  grep: z
    .string()
    .optional()
    .describe("Case-insensitive regular expression matched against text"),
};

const server = new McpServer({ name: "local-log", version: "1.0.0" });

server.registerTool(
  "read_logs",
  {
    title: "Read logs",
    description:
      "Read logs the app under development sent to the local-log server " +
      "(browser console, phone, device). Returns entries plus a `cursor`; " +
      "pass that cursor back as `after` to read only what is new since.",
    inputSchema: {
      ...FILTER_SCHEMA,
      limit: z
        .number()
        .optional()
        .describe("Max entries to return, up to 1000"),
    },
  },
  (args) => call(args),
);

server.registerTool(
  "await_logs",
  {
    title: "Await logs",
    description:
      "Block until a matching log arrives, then return it. Use this after " +
      "asking the user to reproduce something instead of asking them to " +
      "paste the output. Returns timed_out: true if nothing matched in time.",
    inputSchema: {
      ...FILTER_SCHEMA,
      timeout_ms: z
        .number()
        .optional()
        .describe("How long to wait. Defaults to 30000, capped at 60000."),
    },
  },
  ({ timeout_ms: timeoutMs = 30000, ...filter }) =>
    call({ ...filter, wait: timeoutMs }, { timeoutMs: timeoutMs + 5000 }),
);

server.registerTool(
  "clear_logs",
  {
    title: "Clear logs",
    description:
      "Discard buffered logs. Call before a reproduction so the next read " +
      "contains only output from that run.",
    inputSchema: {},
  },
  () => call({}, { method: "DELETE" }),
);

/**
 * Calls the local-log HTTP API and shapes the result as a tool response.
 *
 * @param {object} query parameters to send. Undefined values are dropped.
 * @param {{method?: string, timeoutMs?: number}} [options] request options.
 * @return {Promise<object>} an MCP tool result.
 */
async function call(query, { method = "GET", timeoutMs = 10000 } = {}) {
  const params = new URLSearchParams(
    Object.entries(query)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
  const url = `${BASE_URL}/logs?${params}`;

  try {
    const response = await fetch(url, {
      method,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json();
    if (!response.ok) {
      return fail(`local-log returned ${response.status}: ${body.message}`);
    }
    return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
  } catch (err) {
    return fail(
      `Could not reach the local-log server at ${BASE_URL} (${err.message}). ` +
        `Ask the user to start it with \`npm start\`, or set LOCAL_LOG_URL.`,
    );
  }
}

/**
 * @param {string} message the failure to report to the model.
 * @return {object} an MCP tool result flagged as an error.
 */
function fail(message) {
  return { isError: true, content: [{ type: "text", text: message }] };
}

server.connect(new StdioServerTransport()).catch((err) => {
  console.error(`local-log MCP server failed to start: ${err.message}`);
  process.exit(1);
});
