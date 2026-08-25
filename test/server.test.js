import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer } from "../src/server.js";
import { createStore } from "../src/store.js";

let store;
let listener;
const json = (path, init) =>
  fetch(`${listener.url}${path}`, init).then(async (res) => ({
    status: res.status,
    headers: res.headers,
    body: await res.json(),
  }));
const post = (path, payload, headers = { "content-type": "application/json" }) =>
  json(path, {
    method: "POST",
    headers,
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });

before(async () => {
  store = createStore();
  listener = await startServer(store, { port: 0 });
});
after(() => listener.close());

test("startServer binds a free port when asked for 0", () => {
  assert.ok(listener.port > 0);
  assert.equal(listener.url, `http://127.0.0.1:${listener.port}`);
});

test("POST /ingest accepts a batch, a bare array, a single object and plain text", async () => {
  store.clear();
  let res = await post("/ingest", {
    source: "api",
    entries: [
      { level: 50, msg: "pino style", time: 1700000000000, meta: { a: 1 } },
      "just a string",
    ],
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { accepted: 2, cursor: store.cursor });

  res = await post("/ingest", [{ level: "warn", message: "bare array", source: "web" }]);
  assert.equal(res.body.accepted, 1);

  res = await post("/ingest", { level: "info", text: "single" });
  assert.equal(res.body.accepted, 1);

  res = await post("/ingest?source=curl&level=warn", "plain text body", {
    "content-type": "text/plain",
  });
  assert.equal(res.body.accepted, 1);

  const all = store.query({ after: 0, limit: 100 });
  assert.deepEqual(
    all.map((e) => [e.level, e.source, e.text]),
    [
      ["error", "api", "pino style"],
      ["info", "api", "just a string"],
      ["warn", "web", "bare array"],
      ["info", undefined, "single"],
      ["warn", "curl", "plain text body"],
    ],
  );
  assert.equal(all[0].ts, "2023-11-14T22:13:20.000Z");
  assert.deepEqual(all[0].meta, { a: 1 });
});

test("POST /ingest joins console-style args when no message is given", async () => {
  store.clear();
  const res = await post("/ingest", {
    source: "api",
    entries: [
      { level: "warn", args: ["user", { id: 7 }, 42, null, { stack: "Error: boom\n    at x" }] },
    ],
  });
  assert.equal(res.body.accepted, 1);
  const [entry] = store.query({ after: 0, limit: 1 });
  assert.equal(entry.text, 'user {"id":7} 42 null Error: boom\n    at x');
  assert.equal(entry.level, "warn");
});

test("POST /ingest rejects malformed JSON", async () => {
  const res = await post("/ingest", "{not json");
  assert.equal(res.status, 400);
  assert.match(res.body.error, /invalid body/);
  assert.equal((await post("/ingest", '"a string"')).status, 400);
});

test("only /ingest answers cross-origin", async () => {
  const preflight = await fetch(`${listener.url}/ingest`, { method: "OPTIONS" });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  const read = await fetch(`${listener.url}/logs`);
  assert.equal(read.headers.get("access-control-allow-origin"), null);
});

test("GET /logs filters and returns a cursor; bad filters are 400", async () => {
  store.clear();
  await post("/ingest", {
    source: "api",
    entries: [
      { level: "info", message: "hello" },
      { level: "error", message: "boom" },
    ],
  });
  const res = await json("/logs?level_min=warn");
  assert.equal(res.body.count, 1);
  assert.equal(res.body.entries[0].text, "boom");
  assert.equal(res.body.cursor, store.cursor);
  assert.equal(res.body.timed_out, false);
  assert.equal((await json("/logs?level_min=loud")).status, 400);
  assert.equal((await json("/logs?include=(")).status, 400);
});

test("GET /logs?wait long-polls until a matching entry lands", async () => {
  store.clear();
  const cursor = store.cursor;
  const pending = json(`/logs?after=${cursor}&level_min=error&wait=5000`);
  await post("/ingest", { entries: [{ level: "info", message: "noise" }] });
  await post("/ingest", { entries: [{ level: "error", message: "signal" }] });
  const res = await pending;
  assert.equal(res.body.count, 1);
  assert.equal(res.body.entries[0].text, "signal");
});

test("GET /logs?wait times out cleanly", async () => {
  const res = await json(`/logs?after=${store.cursor}&wait=30`);
  assert.deepEqual(res.body, { cursor: store.cursor, count: 0, timed_out: true, entries: [] });
});

test("DELETE /logs clears and /health reports", async () => {
  await post("/ingest", { entries: [{ message: "x" }] });
  const cleared = await json("/logs", { method: "DELETE" });
  assert.equal(cleared.body.cleared >= 1, true);
  const health = await json("/health");
  assert.equal(health.body.ok, true);
  assert.equal(health.body.name, "tiny-log-mcp");
  assert.equal(health.body.size, 0);
});

test("serves the UI assets, the browser client and 404s elsewhere", async () => {
  const ui = await fetch(`${listener.url}/`);
  assert.equal(ui.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(await ui.text(), /id="presence"/);
  const app = await fetch(`${listener.url}/index.js`);
  assert.equal(app.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.match(await app.text(), /Coalesce an SSE replay or live burst/);
  const styles = await fetch(`${listener.url}/index.css`);
  assert.equal(styles.headers.get("content-type"), "text/css; charset=utf-8");
  assert.match(await styles.text(), /content: attr\(data-empty\)/);
  const activity = await fetch(`${listener.url}/activity`);
  assert.equal(activity.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(await activity.text(), /Delivered to agents/);
  const activityApp = await fetch(`${listener.url}/activity.js`);
  assert.equal(activityApp.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.match(await activityApp.text(), /activity-events/);
  const client = await fetch(`${listener.url}/client.js`);
  assert.equal(client.status, 200);
  assert.match(await client.text(), /unhandledrejection/);
  assert.equal((await fetch(`${listener.url}/nope`)).status, 404);
});

test("activity feed replays exact deliveries and can be cleared", async () => {
  listener.activity.clear();
  listener.activity.deliver({
    channel: "mcp",
    client: "mcp-read",
    tool: "read_logs",
    args: { include: "signal" },
    text: "exact payload",
    error: false,
  });

  const res = await fetch(`${listener.url}/activity-events`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let received = "";
  while (!received.includes("exact payload")) {
    const { value } = await reader.read();
    received += decoder.decode(value);
  }
  assert.match(received, /event: presence/);
  assert.match(received, /"viewers":1/);
  assert.match(received, /event: delivery/);
  await reader.cancel();

  const state = await json("/activity-state");
  assert.equal(state.body.deliveries[0].text, "exact payload");
  const cleared = await json("/activity", { method: "DELETE" });
  assert.deepEqual(cleared.body, { cleared: 1 });
});

test("GET /events connects immediately when the buffer is empty", async () => {
  store.clear();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000);
  try {
    const res = await fetch(`${listener.url}/events`, { signal: controller.signal });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let received = "";
    while (!received.includes("event: presence")) {
      const { value } = await reader.read();
      received += decoder.decode(value);
    }
    assert.match(received, /: connected/);
    assert.match(received, /"monitors":0/);
    await reader.cancel();
  } finally {
    clearTimeout(timeout);
  }
});

test("GET /events streams existing and new entries", async () => {
  store.clear();
  store.add({ text: "replayed" });
  const res = await fetch(`${listener.url}/events`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let received = "";
  const readUntil = async (needle) => {
    while (!received.includes(needle)) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value);
    }
  };
  await readUntil("replayed");
  store.add({ text: "fresh" });
  await readUntil("fresh");
  store.clear();
  await readUntil("event: clear");
  await reader.cancel();
});

test("falls back to another port when the requested one is busy", async () => {
  const second = await startServer(createStore(), { port: listener.port });
  assert.notEqual(second.port, listener.port);
  await second.close();
});
