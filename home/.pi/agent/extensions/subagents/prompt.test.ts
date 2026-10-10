import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import subagentsExtension from "./index.ts";

interface RegisteredPromptTool {
  name: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
}

function registeredSpawnTool(): RegisteredPromptTool {
  const tools = new Map<string, RegisteredPromptTool>();
  const pi = {
    on() {},
    registerTool(tool: RegisteredPromptTool) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    registerMessageRenderer() {},
    registerEntryRenderer() {},
  } as unknown as ExtensionAPI;

  subagentsExtension(pi);

  const spawnTool = tools.get("subagent_spawn");
  assert.ok(spawnTool, "The extension should register subagent_spawn");
  return spawnTool;
}

// Pin the metadata consumed by Pi's host prompt builder through the public
// extension API, without importing an unexported host implementation module.
test("subagent_spawn metadata preserves harness routing", () => {
  const tool = registeredSpawnTool();

  assert.equal(
    tool.promptSnippet,
    "Spawn a background subagent on a chosen harness (pi, Claude Code, or Codex; own context, normal tools) for a self-contained task",
  );
  assert.ok(
    tool.promptGuidelines?.includes(
      "For small changes, use pi with openai-codex/gpt-6-luna and xhigh reasoning. For planning, use codex with gpt-6.1-sol and xhigh reasoning. For long-running grunt work, use codex with gpt-6.1-sol and xhigh reasoning. Keep claude as compatibility-only unless the user explicitly requests it.",
    ),
  );
});

test("subagent_spawn metadata reserves /goal for feature implementation", () => {
  const goalGuideline =
    "Use /goal only when the Codex subagent's assigned task is feature implementation. Use plain prompts for planning, research, reviews, debugging, testing, maintenance, and other non-feature tasks, including long-running grunt work, regardless of duration.";

  assert.deepEqual(
    registeredSpawnTool().promptGuidelines?.filter((line) =>
      line.includes("/goal"),
    ),
    [goalGuideline],
  );
});
