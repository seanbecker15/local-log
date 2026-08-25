import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const README = new URL("../README.md", import.meta.url);
const CLI = new URL("../bin/tiny-log-mcp.js", import.meta.url);

test("documents additive Claude Code and Codex installation paths", async () => {
  const [readme, cli] = await Promise.all([readFile(README, "utf8"), readFile(CLI, "utf8")]);

  for (const text of [readme, cli]) {
    assert.match(text, /claude mcp add tiny-log -- npx -y tiny-log-mcp/);
    assert.match(text, /codex mcp add tiny-log -- npx -y tiny-log-mcp/);
  }
  assert.match(readme, /Claude Code \(`\.mcp\.json`\)/);
  assert.match(readme, /Codex \(`\.codex\/config\.toml` in a trusted project\)/);
  assert.match(readme, /tool_timeout_sec = 620/);
  assert.match(readme, /Claude Monitor or persistent/);
});
