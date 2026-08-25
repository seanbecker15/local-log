import assert from "node:assert/strict";
import test from "node:test";
import { createActivity } from "../src/activity.js";

test("activity tracks connections and keeps a bounded delivery transcript", () => {
  const activity = createActivity({ capacity: 2 });
  const events = [];
  activity.subscribe((event, payload) => events.push([event, payload]));

  const stream = activity.open("stream");
  const wait = activity.open("wait");
  const viewer = activity.open("viewer");
  assert.deepEqual(activity.snapshot(), { monitors: 2, streams: 1, waits: 1, viewers: 1 });

  activity.deliver({
    channel: "mcp",
    client: wait.id,
    tool: "await_logs",
    args: { include: "signal" },
    text: "first",
    error: false,
  });
  activity.deliver({
    channel: "stream",
    client: stream.id,
    tool: "monitor",
    args: {},
    text: "second",
    error: false,
  });
  activity.deliver({
    channel: "mcp",
    client: "mcp-read",
    tool: "read_logs",
    args: {},
    text: "third",
    error: false,
  });
  assert.deepEqual(
    activity.recent().map((delivery) => delivery.text),
    ["second", "third"],
  );

  stream.close();
  stream.close();
  wait.close();
  viewer.close();
  assert.deepEqual(activity.snapshot(), { monitors: 0, streams: 0, waits: 0, viewers: 0 });
  assert.deepEqual(activity.clear(), { cleared: 2 });
  assert.equal(activity.recent().length, 0);
  assert.equal(
    events.some(([event]) => event === "delivery"),
    true,
  );
  assert.equal(events.at(-1)[0], "clear");
});
