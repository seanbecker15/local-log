import assert from "node:assert/strict";
import { test } from "node:test";
import { formatEntries, formatHeader } from "../src/format.js";

const entry = (seq, text, extra = {}) => ({
  seq,
  ts: "2026-08-24T12:04:31.220Z",
  level: "error",
  source: "api",
  text,
  ...extra,
});

test("formats one entry per line with seq, time, level and source", () => {
  const out = formatEntries([
    entry(1, "boom"),
    entry(2, "next", { level: "info", source: undefined }),
  ]);
  assert.equal(out, "#1 12:04:31.220 ERROR api boom\n#2 12:04:31.220 INFO  next");
});

test("indents continuation lines and appends meta", () => {
  const out = formatEntries([
    entry(7, "TypeError: x\n    at foo (a.js:1:2)", { meta: { id: 42 } }),
  ]);
  assert.equal(
    out,
    '#7 12:04:31.220 ERROR api TypeError: x\n        at foo (a.js:1:2)\n    meta: {"id":42}',
  );
});

test("collapses consecutive identical entries", () => {
  const out = formatEntries([
    entry(1, "same"),
    entry(2, "same"),
    entry(3, "same"),
    entry(4, "other"),
  ]);
  assert.equal(
    out,
    "#1 12:04:31.220 ERROR api same\n    (repeated ×2, through #3)\n#4 12:04:31.220 ERROR api other",
  );
});

test("truncates long text with a re-read hint; max_chars 0 disables", () => {
  const long = "x".repeat(50);
  const out = formatEntries([entry(9, long)], { maxChars: 10 });
  assert.equal(
    out,
    `#9 12:04:31.220 ERROR api ${"x".repeat(10)}… [+40 chars; re-read with after=8 limit=1 max_chars=0]`,
  );
  assert.equal(formatEntries([entry(9, long)], { maxChars: 0 }).endsWith(long), true);
});

test("header explains the cursor and timeouts", () => {
  assert.match(formatHeader({ count: 0, cursor: 5 }), /No matching logs \(cursor 5\)/);
  assert.match(formatHeader({ count: 1, cursor: 5 }), /^1 entry, times UTC \(cursor 5\)/);
  assert.match(formatHeader({ count: 3, cursor: 5 }), /^3 entries/);
  assert.match(formatHeader({ count: 0, cursor: 5, timedOut: true }), /before the timeout/);
});
