import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { after, before, test } from "node:test";
import { startServer } from "../src/server.js";
import { createStore } from "../src/store.js";
import { runTail } from "../src/tail.js";

let store;
let listener;
before(async () => {
  store = createStore();
  listener = await startServer(store, { port: 0 });
});
after(() => listener.close());

const wsUrl = (query) =>
  `${listener.url.replace(/^http/, "ws")}/stream?${new URLSearchParams(query)}`;

/** Opens a socket and collects frames until it closes or `count` frames arrived. */
function collect(query, count, { origin } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(query), origin ? { headers: { origin } } : undefined);
    const frames = [];
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    ws.addEventListener("open", () => {
      if (count === 0) finish({ frames, ws, opened: true });
    });
    ws.addEventListener("message", (event) => {
      frames.push(String(event.data));
      if (frames.length >= count) finish({ frames, ws, opened: true });
    });
    ws.addEventListener("close", (event) =>
      finish({ frames, ws, code: event.code, reason: event.reason, opened: false }),
    );
    ws.addEventListener("error", () => finish({ frames, ws, error: true, opened: false }));
    setTimeout(() => reject(new Error("timed out")), 5000).unref();
  });
}

test("/stream pushes one frame per matching entry as it arrives", async () => {
  const pending = collect({ include: "sig", level_min: "info" }, 2);
  await new Promise((r) => setTimeout(r, 50));
  store.add({ text: "noise" });
  store.add({ text: "signal 1", level: "warn", source: "web" });
  store.add({ text: "debug sig", level: "debug" });
  store.add({ text: "signal 2", level: "error" });
  const { frames, ws } = await pending;
  assert.equal(frames.length, 2);
  assert.match(frames[0], /^#\d+ \d\d:\d\d:\d\d\.\d{3} WARN {2}web signal 1$/);
  assert.match(frames[1], /ERROR signal 2$/);
  ws.close();
});

test("/stream replays from `after` and closes itself on `until`", async () => {
  store.clear();
  const first = store.add({ text: "step 1" });
  store.add({ text: "step 2" });
  const result = await (async () => {
    const pending = collect({ after: String(first.seq - 1), until: "done", format: "json" }, 99);
    await new Promise((r) => setTimeout(r, 50));
    store.add({ text: "all done" });
    return pending;
  })();
  assert.equal(result.opened, false);
  assert.equal(result.code, 1000);
  assert.equal(result.reason, "until matched");
  assert.deepEqual(
    result.frames.map((f) => JSON.parse(f).text),
    ["step 1", "step 2", "all done"],
  );
});

test("/stream refuses cross-origin browsers and bad filters, allows same-origin", async () => {
  const foreign = await collect({}, 0, { origin: "http://evil.example" });
  assert.equal(foreign.opened, false);
  const same = await collect({}, 0, { origin: listener.url });
  assert.equal(same.opened, true);
  same.ws.close();
  const bad = await collect({ include: "(" }, 0);
  assert.equal(bad.opened, false);
  const notFound = await new Promise((resolve) => {
    const ws = new WebSocket(`${listener.url.replace(/^http/, "ws")}/nope`);
    ws.addEventListener("open", () => resolve("opened"));
    ws.addEventListener("error", () => resolve("refused"));
  });
  assert.equal(notFound, "refused");
});

test("runTail prints frames and resolves when until closes the stream", async () => {
  store.clear();
  const lines = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const pending = runTail({
    url: listener.url,
    query: { include: "TL", until: "finished" },
    output,
  });
  await new Promise((r) => setTimeout(r, 50));
  store.add({ text: "[TL] one" });
  store.add({ text: "other" });
  store.add({ text: "[TL] finished" });
  const code = await pending;
  assert.equal(code, 1000);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\[TL\] one\n$/);
  assert.match(lines[1], /\[TL\] finished\n$/);
});

test("runTail rejects when nothing is listening", async () => {
  await assert.rejects(
    runTail({ url: "http://127.0.0.1:1", output: new Writable({ write: (_c, _e, cb) => cb() }) }),
    /cannot connect/,
  );
});
