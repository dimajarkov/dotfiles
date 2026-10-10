import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { getSystemMessageText } from "@earendil-works/pi-ai/utils/text";
import type { SystemMessage, TranscriptContext } from "@earendil-works/pi-ai";
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

test("Pi 1.1 emits subagent routing and /goal policy in a no-network SDK request", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-prompt-contract-"));
  let disposeSession = () => {};
  t.after(async () => {
    disposeSession();
    await rm(cwd, { recursive: true, force: true });
  });
  let emittedContext: TranscriptContext | undefined;

  const faux = fauxProvider({
    models: [{ id: "subagents-prompt-contract", name: "Prompt contract fixture" }],
  });
  faux.setResponses([
    (context: TranscriptContext) => {
      emittedContext = context;
      return fauxAssistantMessage("fixture response");
    },
  ]);
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    refreshOnCreate: false,
    modelsPath: null,
  });
  modelRuntime.registerNativeProvider(faux.provider);

  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager,
    extensionFactories: [subagentsExtension],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir: cwd,
    model: faux.getModel(),
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
  });
  disposeSession = () => session.dispose();

  await session.prompt("Capture the assembled system prompt.");

  assert.equal(faux.state.callCount, 1, "the faux provider should receive one local request");
  assert.ok(emittedContext, "the provider should receive a prompt context");
  assert.ok(session.getActiveToolNames().includes("subagent_spawn"));

  const systemMessage = emittedContext.messages.find(
    (message): message is SystemMessage => message.role === "system",
  );
  assert.ok(systemMessage, "Pi should emit a system message to the provider");
  const emittedPrompt = getSystemMessageText(systemMessage);
  assert.ok(
    emittedPrompt.includes(
      "For small changes, use pi with openai-codex/gpt-6-luna and xhigh reasoning. For planning, use codex with gpt-6.1-sol and xhigh reasoning. For long-running grunt work, use codex with gpt-6.1-sol and xhigh reasoning. Keep claude as compatibility-only unless the user explicitly requests it.",
    ),
  );
  assert.ok(
    emittedPrompt.includes(
      "Use /goal only when the Codex subagent's assigned task is feature implementation. Use plain prompts for planning, research, reviews, debugging, testing, maintenance, and other non-feature tasks, including long-running grunt work, regardless of duration.",
    ),
  );
});
