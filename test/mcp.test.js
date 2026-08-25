import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/tiny-log-mcp.js", import.meta.url));

let child;
let nextId = 1;
const pending = new Map();

before(async () => {
  child = spawn(process.execPath, [BIN], {
    env: { ...process.env, TINY_LOG_PORT: "0" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
});
after(async () => {
  child.stdin.end();
  await new Promise((resolve) => child.once("exit", resolve));
});

function request(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve) => pending.set(id, resolve));
}
const callTool = async (name, args = {}) => {
  const { result } = await request("tools/call", { name, arguments: args });
  return result;
};

test("initialize advertises tools and instructions", async () => {
  const { result } = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  assert.equal(result.protocolVersion, "2025-06-18");
  assert.deepEqual(result.capabilities, { tools: {} });
  assert.equal(result.serverInfo.name, "tiny-log-mcp");
  assert.match(result.instructions, /await_logs/);
  assert.match(result.instructions, /project memory/);
  assert.match(result.instructions, /let the user pick/);
  assert.match(result.instructions, /keeping committed/);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  assert.deepEqual((await request("ping")).result, {});
});

test("tools/list exposes the four tools with schemas", async () => {
  const { result } = await request("tools/list");
  assert.deepEqual(
    result.tools.map((t) => t.name),
    ["listen", "hint", "read_logs", "await_logs", "clear_logs"],
  );
  for (const tool of result.tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.ok(tool.description.length > 20);
  }
});

test("unknown methods and tools are reported as errors", async () => {
  const { error } = await request("nope");
  assert.equal(error.code, -32601);
  const { error: toolError } = await request("tools/call", { name: "nope", arguments: {} });
  assert.equal(toolError.code, -32602);
});

test("end to end: listen → ingest over HTTP → read_logs / await_logs / clear_logs", async () => {
  const listen = await callTool("listen");
  const url = listen.content[0].text.match(/listening at (http:\/\/[^\s]+)/)[1];
  // listen is operational: URL, cursor, stream address; wiring lives in hint.
  assert.match(
    listen.content[0].text,
    /Monitor\(\{ ws: \{ url: "ws:\/\/127\.0\.0\.1:\d+\/stream\?after=0/,
  );
  assert.match(listen.content[0].text, /tiny-log-mcp tail --url/);
  assert.doesNotMatch(listen.content[0].text, /tap\(console/);
  assert.ok(listen.content[0].text.split("\n").length < 14);

  const index = await callTool("hint");
  assert.match(index.content[0].text, /grep — don't guess/);
  assert.match(index.content[0].text, /level_gated/);
  assert.match(index.content[0].text, /logs THROUGH, not where it runs/);
  assert.ok(
    index.content[0].text.indexOf("logger-methods") < index.content[0].text.indexOf("console "),
    "logger question comes before the page-specific entry",
  );

  const consoleGuide = await callTool("hint", { interface: "console" });
  assert.match(consoleGuide.content[0].text, /client\.js/);
  assert.match(consoleGuide.content[0].text, /DevTools console/);
  assert.doesNotMatch(consoleGuide.content[0].text, /pino:/);
  const methods = await callTool("hint", { interface: "logger-methods" });
  assert.match(methods.content[0].text, /tap\(console/);
  assert.match(methods.content[0].text, /level is off/);
  assert.match(methods.content[0].text, /browser page included/);
  const everything = await callTool("hint", { interface: "all" });
  assert.match(everything.content[0].text, /pipe --source/);
  assert.match(everything.content[0].text, /roarr/);
  assert.match(everything.content[0].text, /logging\.Handler/);

  // Facts → options menu: a web app with its own flag-gated logger.
  const gatedWeb = await callTool("hint", {
    runs_in: "browser",
    logger: "AppLogger",
    level_gated: true,
  });
  const menu = gatedWeb.content[0].text;
  assert.match(menu, /let the user pick/);
  assert.match(menu, /^1\. wrap AppLogger's level methods/m);
  assert.match(menu, /flag\/config-gated/);
  assert.match(menu, /inject client\.js with no code change/);
  assert.match(menu, /load client\.js from source/);
  assert.match(menu, /Other — ask the user/);
  assert.match(menu, /agent docs or your project memory/);
  assert.doesNotMatch(menu, /pipe the dev command/);

  // A pino backend: stdout keeps fields, transport offered, nothing browser-shaped.
  const pinoNode = await callTool("hint", {
    runs_in: "node",
    logger: "src/logger.ts",
    logger_package: "pino",
    emits_ndjson: true,
  });
  assert.match(pinoNode.content[0].text, /pino's transport hook/);
  assert.match(pinoNode.content[0].text, /NDJSON keeps level, time and fields/);
  assert.doesNotMatch(pinoNode.content[0].text, /client\.js/);

  // Non-JS gets the sink shape plus the pipe.
  const py = await callTool("hint", { language: "python" });
  assert.match(py.content[0].text, /python handler\/sink/);
  assert.match(py.content[0].text, /pipe the dev command/);

  const health = await fetch(`${url}/health`).then((r) => r.json());
  assert.equal(health.ok, true);

  const empty = await callTool("read_logs");
  assert.match(empty.content[0].text, /No matching logs/);

  const waiting = callTool("await_logs", { level_min: "error", timeout_ms: 5000 });
  await fetch(`${url}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: "api",
      entries: [
        { level: "info", message: "GET /health 200" },
        {
          level: "error",
          message: "TypeError: boom\n    at handler (api.js:10:5)",
          meta: { reqId: "r1" },
        },
      ],
    }),
  });
  const awaited = await waiting;
  assert.match(awaited.content[0].text, /^1 entry/);
  assert.match(awaited.content[0].text, /ERROR api TypeError: boom\n {8}at handler/);
  assert.match(awaited.content[0].text, /meta: \{"reqId":"r1"\}/);

  const filtered = await callTool("read_logs", { exclude: "health" });
  assert.doesNotMatch(filtered.content[0].text, /GET \/health/);
  const allLogs = await callTool("read_logs");
  assert.match(allLogs.content[0].text, /^2 entries/);

  const bad = await callTool("read_logs", { include: "(" });
  assert.equal(bad.isError, true);

  const timedOut = await callTool("await_logs", { after: 999, timeout_ms: 20 });
  assert.match(timedOut.content[0].text, /timeout/);

  // until: one call returns everything through the terminal line.
  const untilCall = callTool("await_logs", {
    include: "TL-1",
    until: "result=true",
    timeout_ms: 5000,
  });
  await new Promise((r) => setTimeout(r, 50));
  await fetch(`${url}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: "web",
      entries: [
        { message: "[TL-1] step 1" },
        { message: "noise" },
        { message: "[TL-1] step 2" },
        { message: "[TL-1] result=true" },
      ],
    }),
  });
  const untilResult = await untilCall;
  assert.match(untilResult.content[0].text, /^3 entries through the until match/);
  assert.match(untilResult.content[0].text, /step 1[\s\S]*step 2[\s\S]*result=true/);
  assert.doesNotMatch(untilResult.content[0].text, /noise/);

  const untilTimeout = await callTool("await_logs", {
    include: "TL-1",
    until: "never",
    timeout_ms: 30,
  });
  assert.match(untilTimeout.content[0].text, /Timed out before until="never" matched; 3 entries/);

  // settle_ms: a burst after the first match comes back in one call.
  const settled = callTool("await_logs", { include: "burst", settle_ms: 300, timeout_ms: 5000 });
  await new Promise((r) => setTimeout(r, 50));
  await fetch(`${url}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entries: [{ message: "burst 1" }] }),
  });
  await new Promise((r) => setTimeout(r, 100));
  await fetch(`${url}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entries: [{ message: "burst 2" }] }),
  });
  const settledResult = await settled;
  assert.match(settledResult.content[0].text, /^2 entries/);

  const cleared = await callTool("clear_logs");
  assert.match(cleared.content[0].text, /Cleared 8 entries/);
});
