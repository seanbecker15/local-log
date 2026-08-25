#!/usr/bin/env node
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { runMcp } from "../src/mcp.js";
import { runPipe } from "../src/pipe.js";
import { DEFAULT_HOST, DEFAULT_PORT, startServer } from "../src/server.js";
import { createStore, DEFAULT_CAPACITY } from "../src/store.js";

const HELP = `tiny-log-mcp ${pkg.version} — ephemeral local log collector for coding agents

Usage: tiny-log-mcp [command] [options]

Commands:
  mcp     (default) MCP server over stdio; also starts the HTTP listener + web UI
  serve   HTTP listener + web UI only (for humans, no agent)
  pipe    read stdin, echo it, and forward it to a listener's /ingest

Options:
  --port <n>       listener port            (env TINY_LOG_PORT, default ${DEFAULT_PORT})
  --host <addr>    listener bind address    (env TINY_LOG_HOST, default ${DEFAULT_HOST}; 0.0.0.0 for devices)
  --capacity <n>   entries kept in memory   (env TINY_LOG_CAPACITY, default ${DEFAULT_CAPACITY})
  --url <url>      pipe: listener to send to (env TINY_LOG_URL, default http://${DEFAULT_HOST}:${DEFAULT_PORT})
  --source <name>  pipe: label for these logs, e.g. api
  --quiet          pipe: do not echo stdin to stdout
  -h, --help       show this help
  -v, --version    show the version

Examples:
  claude mcp add tiny-log -- npx -y tiny-log-mcp
  npm run dev 2>&1 | npx -y tiny-log-mcp pipe --source api
`;

const { values, positionals } = parseArgs({
  options: {
    port: { type: "string" },
    host: { type: "string" },
    capacity: { type: "string" },
    url: { type: "string" },
    source: { type: "string" },
    quiet: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
    version: { type: "boolean", short: "v", default: false },
  },
  allowPositionals: true,
});

if (values.help) exit(HELP);
if (values.version) exit(`${pkg.version}\n`);

const env = process.env;
const port = integer(values.port ?? env.TINY_LOG_PORT, DEFAULT_PORT, "port");
const host = values.host ?? env.TINY_LOG_HOST ?? DEFAULT_HOST;
const capacity = integer(values.capacity ?? env.TINY_LOG_CAPACITY, DEFAULT_CAPACITY, "capacity");
const command = positionals[0] ?? "mcp";

switch (command) {
  case "mcp":
    await runMcp({ store: createStore({ capacity }), defaults: { port, host } });
    break;
  case "serve": {
    const listener = await startServer(createStore({ capacity }), { port, host });
    console.log(`tiny-log-mcp listening at ${listener.url}`);
    const stop = () => listener.close().then(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    break;
  }
  case "pipe":
    await runPipe({
      url: values.url ?? env.TINY_LOG_URL ?? `http://${DEFAULT_HOST}:${port}`,
      source: values.source,
      quiet: values.quiet,
    });
    break;
  default:
    exit(`unknown command: ${command}\n\n${HELP}`, 1);
}

function integer(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) exit(`${name} must be a non-negative integer\n`, 1);
  return n;
}

function exit(text, code = 0) {
  (code === 0 ? process.stdout : process.stderr).write(text);
  process.exit(code);
}
