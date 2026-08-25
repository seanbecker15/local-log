import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFilter } from "../src/filter.js";
import { createStore, safeStringify } from "../src/store.js";

const all = (overrides = {}) => parseFilter(overrides);

test("add normalizes entries and assigns monotonic seq", () => {
  const store = createStore();
  const a = store.add({ text: "hello", level: "WARNING", source: "api" });
  const b = store.add({ message: { nested: true }, level: 50 });
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
  assert.equal(a.level, "warn");
  assert.equal(b.level, "error");
  assert.equal(b.text, '{"nested":true}');
  assert.equal(b.source, undefined);
  assert.match(a.ts, /^\d{4}-\d{2}-\d{2}T/);
});

test("add keeps a client timestamp when it is valid and drops empty meta", () => {
  const store = createStore();
  const ts = "2026-01-02T03:04:05.006Z";
  const entry = store.add({ text: "x", ts, meta: {} });
  assert.equal(entry.ts, ts);
  assert.equal("meta" in entry, false);
  assert.equal(store.add({ text: "x", ts: "garbage" }).ts.length, 24);
  assert.deepEqual(store.add({ text: "x", meta: { a: 1 } }).meta, { a: 1 });
});

test("buffer is bounded by capacity", () => {
  const store = createStore({ capacity: 3 });
  for (let i = 1; i <= 5; i++) store.add({ text: `m${i}` });
  assert.equal(store.size, 3);
  assert.deepEqual(
    store.query(all()).map((e) => e.text),
    ["m3", "m4", "m5"],
  );
});

test("query honours after, filter and limit, newest kept", () => {
  const store = createStore();
  store.add({ text: "one", level: "info" });
  store.add({ text: "two", level: "error" });
  store.add({ text: "three", level: "warn" });
  store.add({ text: "four", level: "error" });
  assert.deepEqual(
    store.query(all({ level_min: "warn" })).map((e) => e.text),
    ["two", "three", "four"],
  );
  assert.deepEqual(
    store.query(all({ after: 2 })).map((e) => e.text),
    ["three", "four"],
  );
  assert.deepEqual(
    store.query(all({ limit: 2 })).map((e) => e.text),
    ["three", "four"],
  );
});

test("clear empties the buffer but the cursor keeps counting", () => {
  const store = createStore();
  store.add({ text: "a" });
  store.add({ text: "b" });
  assert.deepEqual(store.clear(), { cursor: 2, cleared: 2 });
  assert.equal(store.size, 0);
  assert.equal(store.add({ text: "c" }).seq, 3);
});

test("wait resolves immediately when a match already exists", async () => {
  const store = createStore();
  store.add({ text: "ready" });
  const found = await store.wait(all(), 1000);
  assert.equal(found[0].text, "ready");
});

test("wait wakes on a matching arrival", async () => {
  const store = createStore();
  const pending = store.wait(all({ level_min: "error" }), 1000);
  store.add({ text: "boom", level: "error" });
  const found = await pending;
  assert.equal(found[0].text, "boom");
});

test("wait survives a non-matching arrival and still catches the match (regression)", async () => {
  const store = createStore();
  const pending = store.wait(all({ level_min: "error" }), 1000);
  store.add({ text: "noise", level: "info" });
  store.add({ text: "more noise", level: "debug" });
  store.add({ text: "boom", level: "error" });
  const found = await pending;
  assert.equal(found.length, 1);
  assert.equal(found[0].text, "boom");
});

test("wait times out with an empty result", async () => {
  const store = createStore();
  const started = Date.now();
  const found = await store.wait(all(), 30);
  assert.deepEqual(found, []);
  assert.ok(Date.now() - started >= 25);
});

test("multiple waiters with different filters are each satisfied", async () => {
  const store = createStore();
  const errors = store.wait(all({ level_min: "error" }), 1000);
  const api = store.wait(all({ source: "api" }), 1000);
  store.add({ text: "hello", level: "info", source: "api" });
  assert.equal((await api)[0].text, "hello");
  store.add({ text: "fail", level: "error", source: "web" });
  assert.equal((await errors)[0].text, "fail");
});

test("subscribe receives entries and clears until unsubscribed", () => {
  const store = createStore();
  const events = [];
  const stop = store.subscribe((event, payload) =>
    events.push([event, payload.text ?? payload.cursor]),
  );
  store.add({ text: "a" });
  store.clear();
  stop();
  store.add({ text: "b" });
  assert.deepEqual(events, [
    ["entry", "a"],
    ["clear", 1],
  ]);
});

test("safeStringify handles cycles, bigints and errors", () => {
  const obj = { n: 1n };
  obj.self = obj;
  assert.equal(safeStringify(obj), '{"n":"1","self":"[Circular]"}');
  assert.match(safeStringify(new Error("bad")), /"message":"bad"/);
});
