import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/tiny-log-mcp.js", import.meta.url));

let child;
let nextId = 1;
const pending = new Map();
/** Server-initiated requests seen, and queued responders for them. */
const elicitations = [];
const responders = [];

before(async () => {
  child = spawn(process.execPath, [BIN], {
    env: { ...process.env, TINY_LOG_PORT: "0" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "elicitation/create") {
      elicitations.push(message);
      const respond = responders.shift();
      assert.ok(respond, "unexpected elicitation with no queued responder");
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: respond(message) })}\n`,
      );
      return;
    }
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  // A client that declares the elicitation capability.
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "test", version: "0" },
  });
  assert.equal(init.result.serverInfo.name, "tiny-log-mcp");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
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
const hint = async (args) => {
  const { result } = await request("tools/call", { name: "hint", arguments: args });
  return result.content[0].text;
};
const GATED_WEB = { runs_in: "browser", logger: "AppLogger", level_gated: true };

test("hint elicits the choice and returns only the picked snippet", async () => {
  responders.push((message) => ({
    action: "accept",
    content: { choice: message.params.requestedSchema.properties.choice.enum[0] },
  }));
  const text = await hint(GATED_WEB);

  assert.equal(elicitations.length, 1);
  const { message, requestedSchema } = elicitations[0].params;
  assert.match(message, /wrap AppLogger's level methods/);
  assert.match(message, /will MISS AppLogger's level-gated calls/);
  const choices = requestedSchema.properties.choice.enum;
  assert.equal(choices.length, 5); // 4 options + Other
  assert.match(choices.at(-1), /^Other/);

  assert.match(text, /^The user chose: wrap AppLogger's level methods/);
  assert.match(text, /tap\(console/);
  assert.doesNotMatch(text, /Applicable ways to wire this app/);
});

test("Other hands the conversation back to the user", async () => {
  responders.push((message) => ({
    action: "accept",
    content: { choice: message.params.requestedSchema.properties.choice.enum.at(-1) },
  }));
  const text = await hint(GATED_WEB);
  assert.match(text, /chose Other — ask them in chat/);
});

test("a dismissed dialog falls back to the menu, flagged as such", async () => {
  responders.push(() => ({ action: "decline" }));
  const text = await hint(GATED_WEB);
  assert.match(text, /dismissed the choice dialog/);
  assert.match(text, /1\. wrap AppLogger's level methods/);
  assert.match(text, /Other — ask the user/);
});

test("one obvious fit never opens a dialog", async () => {
  const seen = elicitations.length;
  const text = await hint({ runs_in: "node", logger: "none" });
  assert.equal(elicitations.length, seen);
  assert.match(text, /pipe the dev command's stdout/);
});
