import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildSystemPrompt } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import subagentsExtension from "./index.ts";

interface RegisteredPromptTool {
  name: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
}

function buildEmittedPrompt(): string {
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
  assert.ok(spawnTool.promptSnippet, "subagent_spawn should contribute an available-tool snippet");
  assert.ok(spawnTool.promptGuidelines, "subagent_spawn should contribute prompt guidelines");

  return buildSystemPrompt({
    cwd: "/workspace",
    selectedTools: [spawnTool.name],
    toolSnippets: { [spawnTool.name]: spawnTool.promptSnippet },
    promptGuidelines: spawnTool.promptGuidelines,
  });
}

function emittedGuidelines(prompt: string): string[] {
  const section = prompt.split("\nGuidelines:\n")[1]?.split("\n\nPi documentation:")[0];
  assert.ok(section, "The runtime-built prompt should contain its Guidelines section");
  return section
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));
}

// These tests pin generated model-facing text, not a model's interpretation of it.
test("the emitted Pi system prompt preserves subagent routing", () => {
  const prompt = buildEmittedPrompt();
  const guidelines = emittedGuidelines(prompt);

  assert.ok(
    prompt.includes(
      "- subagent_spawn: Spawn a background subagent on a chosen harness (pi, Claude Code, or Codex; own context, normal tools) for a self-contained task",
    ),
    "The registered tool snippet should reach the emitted prompt",
  );
  assert.ok(
    guidelines.includes(
      "For small changes, use pi with openai-codex/gpt-6-luna and xhigh reasoning. For planning, use codex with gpt-6.1-sol and xhigh reasoning. For long-running grunt work, use codex with gpt-6.1-sol and xhigh reasoning. Keep claude as compatibility-only unless the user explicitly requests it.",
    ),
  );
});

test("the emitted prompt reserves /goal for feature implementation at any duration", () => {
  const goalGuideline =
    "Use /goal only when the Codex subagent's assigned task is feature implementation. Use plain prompts for planning, research, reviews, debugging, testing, maintenance, and other non-feature tasks, including long-running grunt work, regardless of duration.";
  const goalGuidelines = emittedGuidelines(buildEmittedPrompt()).filter((line) =>
    line.includes("/goal"),
  );

  assert.deepEqual(goalGuidelines, [goalGuideline]);
});
