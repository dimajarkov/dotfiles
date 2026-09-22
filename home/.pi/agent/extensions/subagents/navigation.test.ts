import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const extensionSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("subagent navigation stays command-only", () => {
  assert.match(extensionSource, /registerCommand\("subagents"/);
  assert.doesNotMatch(extensionSource, /\bregisterShortcut\s*\(/);
});
