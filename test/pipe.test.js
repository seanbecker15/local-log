import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";
import { isContinuation, parseLine, runPipe } from "../src/pipe.js";

test("parseLine understands pino / bunyan / winston NDJSON", () => {
  const pino = parseLine(
    '{"level":50,"time":1700000000000,"pid":1,"hostname":"h","msg":"boom","reqId":"abc"}',
  );
  assert.deepEqual(pino, { level: 50, text: "boom", ts: 1700000000000, meta: { reqId: "abc" } });
  const winston = parseLine(
    '{"level":"warn","message":"careful","timestamp":"2026-01-01T00:00:00Z"}',
  );
  assert.deepEqual(winston, {
    level: "warn",
    text: "careful",
    ts: "2026-01-01T00:00:00Z",
    meta: undefined,
  });
  const noMessage = parseLine('{"event":"tick","n":1}');
  assert.equal(noMessage.text, '{"event":"tick","n":1}');
  assert.equal(noMessage.meta, undefined);
});

test("parseLine strips ANSI, guesses a level for plain text and skips blanks", () => {
  assert.deepEqual(parseLine("\x1b[31mERROR\x1b[0m something broke"), {
    level: "error",
    text: "ERROR something broke",
  });
  assert.equal(parseLine("warn: deprecated API").level, "warn");
  assert.equal(parseLine("FATAL: out of memory").level, "fatal");
  assert.equal(parseLine("debug: tick").level, "debug");
  assert.equal(parseLine("ready in 120ms").level, "info");
  assert.equal(parseLine("{not json").level, "info");
  assert.equal(parseLine("   "), null);
  assert.equal(parseLine("[1,2]").text, "[1,2]");
});

test("isContinuation detects indented lines", () => {
  assert.equal(isContinuation("    at foo (a.js:1:1)"), true);
  assert.equal(isContinuation("plain"), false);
});

test("runPipe echoes, merges stack frames and batches to /ingest", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  };
  const echoed = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      echoed.push(chunk.toString());
      cb();
    },
  });
  const input = Readable.from([
    "TypeError: bad\n",
    "    at a (x.js:1:1)\n",
    "    at b (y.js:2:2)\n",
    "\n",
    '{"level":30,"msg":"ok"}\n',
  ]);
  await runPipe({ url: "http://127.0.0.1:1/", source: "api", input, output, fetchImpl });

  assert.equal(
    echoed.join(""),
    'TypeError: bad\n    at a (x.js:1:1)\n    at b (y.js:2:2)\n\n{"level":30,"msg":"ok"}\n',
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:1/ingest");
  assert.equal(calls[0].body.source, "api");
  assert.deepEqual(
    calls[0].body.entries.map((e) => [e.level, e.text]),
    [
      ["error", "TypeError: bad\n    at a (x.js:1:1)\n    at b (y.js:2:2)"],
      [30, "ok"],
    ],
  );
});

test("runPipe keeps going and reports once when the listener is unreachable", async () => {
  const errors = [];
  const stderr = new Writable({
    write(chunk, _enc, cb) {
      errors.push(chunk.toString());
      cb();
    },
  });
  const fetchImpl = async () => {
    throw new Error("ECONNREFUSED");
  };
  const input = Readable.from(["one\n", "two\n"]);
  const output = new Writable({ write: (_c, _e, cb) => cb() });
  await runPipe({ url: "http://127.0.0.1:1", input, output, stderr, fetchImpl, quiet: true });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /cannot reach/);
});
