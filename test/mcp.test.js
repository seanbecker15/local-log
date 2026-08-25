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
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  assert.deepEqual((await request("ping")).result, {});
});

test("tools/list exposes the four tools with schemas", async () => {
  const { result } = await request("tools/list");
  assert.deepEqual(
    result.tools.map((t) => t.name),
    ["listen", "read_logs", "await_logs", "clear_logs"],
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
  assert.match(listen.content[0].text, /client\.js/);
  assert.match(listen.content[0].text, /pipe --source/);
  assert.match(listen.content[0].text, /1\. Find the logger/);
  assert.match(listen.content[0].text, /tap\(console/);

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
  const all = await callTool("read_logs");
  assert.match(all.content[0].text, /^2 entries/);

  const bad = await callTool("read_logs", { include: "(" });
  assert.equal(bad.isError, true);

  const timedOut = await callTool("await_logs", { after: 999, timeout_ms: 20 });
  assert.match(timedOut.content[0].text, /timeout/);

  const cleared = await callTool("clear_logs");
  assert.match(cleared.content[0].text, /Cleared 2 entries/);
});
