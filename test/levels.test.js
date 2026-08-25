import assert from "node:assert/strict";
import { test } from "node:test";
import { LEVELS, levelRank, normalizeLevel } from "../src/levels.js";

test("normalizeLevel maps names from common loggers", () => {
  const cases = {
    ERROR: "error",
    Warning: "warn",
    log: "info",
    CRITICAL: "fatal",
    verbose: "trace",
    silly: "trace",
    notice: "info",
    http: "debug",
    emerg: "fatal",
    "": "info",
    nonsense: "info",
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(normalizeLevel(input), expected, `"${input}"`);
  }
});

test("normalizeLevel maps pino/bunyan numerics and syslog severities", () => {
  assert.equal(normalizeLevel(10), "trace");
  assert.equal(normalizeLevel(20), "debug");
  assert.equal(normalizeLevel(30), "info");
  assert.equal(normalizeLevel(40), "warn");
  assert.equal(normalizeLevel(50), "error");
  assert.equal(normalizeLevel(60), "fatal");
  assert.equal(normalizeLevel(35), "info");
  assert.equal(normalizeLevel("50"), "error");
  assert.equal(normalizeLevel(0), "fatal");
  assert.equal(normalizeLevel(3), "error");
  assert.equal(normalizeLevel(4), "warn");
  assert.equal(normalizeLevel(6), "info");
  assert.equal(normalizeLevel(7), "debug");
});

test("normalizeLevel tolerates junk", () => {
  assert.equal(normalizeLevel(undefined), "info");
  assert.equal(normalizeLevel(null), "info");
  assert.equal(normalizeLevel({}), "info");
  assert.equal(normalizeLevel(Number.NaN), "info");
});

test("levelRank orders LEVELS", () => {
  const ranks = LEVELS.map(levelRank);
  assert.deepEqual(ranks, [0, 1, 2, 3, 4, 5]);
  assert.equal(levelRank("bogus"), levelRank("info"));
});
