import assert from "node:assert/strict";
import { test } from "node:test";
import { FilterError, matches, parseFilter } from "../src/filter.js";

test("parseFilter defaults", () => {
  assert.deepEqual(parseFilter(), {
    after: 0,
    levelMin: null,
    include: null,
    exclude: null,
    source: null,
    limit: 100,
  });
});

test("parseFilter accepts strings (HTTP) and numbers (MCP)", () => {
  const fromHttp = parseFilter({ after: "12", limit: "5", level_min: "warn", include: "foo" });
  const fromMcp = parseFilter({ after: 12, limit: 5, level_min: "warn", include: "foo" });
  assert.equal(fromHttp.after, 12);
  assert.equal(fromMcp.after, 12);
  assert.equal(fromHttp.limit, 5);
  assert.equal(fromHttp.include.flags, "i");
  assert.equal(fromHttp.include.source, fromMcp.include.source);
});

test("parseFilter caps limit and rejects bad input", () => {
  assert.equal(parseFilter({ limit: 99999 }).limit, 1000);
  assert.equal(parseFilter({ limit: 0 }).limit, 100);
  assert.throws(() => parseFilter({ level_min: "loud" }), FilterError);
  assert.throws(() => parseFilter({ include: "(" }), FilterError);
  assert.throws(() => parseFilter({ after: -1 }), FilterError);
  assert.throws(() => parseFilter({ after: "abc" }), FilterError);
});

test("matches applies level threshold, source, include and exclude", () => {
  const entry = { level: "warn", source: "api", text: "GET /health 200" };
  assert.equal(matches(entry, parseFilter({ level_min: "warn" })), true);
  assert.equal(matches(entry, parseFilter({ level_min: "error" })), false);
  assert.equal(matches(entry, parseFilter({ source: "API" })), true);
  assert.equal(matches(entry, parseFilter({ source: "web" })), false);
  assert.equal(matches(entry, parseFilter({ include: "health" })), true);
  assert.equal(matches(entry, parseFilter({ exclude: "health" })), false);
  assert.equal(matches({ ...entry, source: undefined }, parseFilter({ source: "api" })), false);
});
