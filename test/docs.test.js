import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const README = new URL("../README.md", import.meta.url);
const REFERENCE = new URL("../docs/reference.md", import.meta.url);
const CLI = new URL("../bin/tiny-log-mcp.js", import.meta.url);

test("documents additive Claude Code and Codex installation paths", async () => {
  const [readme, reference, cli] = await Promise.all([
    readFile(README, "utf8"),
    readFile(REFERENCE, "utf8"),
    readFile(CLI, "utf8"),
  ]);

  for (const text of [readme, cli]) {
    assert.match(text, /claude mcp add tiny-log -- npx -y tiny-log-mcp/);
    assert.match(text, /codex mcp add tiny-log -- npx -y tiny-log-mcp/);
  }
  assert.match(readme, /\[Technical reference\]\(docs\/reference\.md\)/);
  assert.match(reference, /Claude Code \(`\.mcp\.json`\)/);
  assert.match(reference, /Codex \(`\.codex\/config\.toml` in a trusted project\)/);
  assert.match(reference, /tool_timeout_sec = 620/);
  assert.match(reference, /Claude Code attaches its Monitor tool/);
  assert.match(reference, /Codex and\s+other clients run `tiny-log-mcp tail`/);
});
