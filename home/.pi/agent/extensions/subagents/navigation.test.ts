import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import test from "node:test";
import subagents from "./index.ts";

test("subagent dashboard registers a command without taking a shortcut", () => {
  const commands: string[] = [];
  const shortcuts: string[] = [];
  const pi = {
    on() {},
    registerCommand(name: string) {
      commands.push(name);
    },
    registerEntryRenderer() {},
    registerMessageRenderer() {},
    registerShortcut(name: string) {
      shortcuts.push(name);
    },
    registerTool() {},
    sendMessage() {},
  } as unknown as ExtensionAPI;

  subagents(pi);

  assert.ok(commands.includes("subagents"));
  assert.deepEqual(shortcuts, []);
});
