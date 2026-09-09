// Deterministic, offline model boundary for e2e-lifecycle.mjs. Never loaded by normal Pi sessions.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export default function lifecycleProvider(pi: ExtensionAPI) {
  const directory = process.env.PI_CODING_AGENT_DIR!;
  pi.registerTool({
    name: "lifecycle_barrier", label: "Lifecycle barrier", description: "Wait for the test scout to complete without ending the parent turn",
    parameters: Type.Object({ action: Type.String() }),
    async execute(_id, { action }, signal, _update, ctx) {
      const registry = join(directory, "herdr-subagents");
      const deadline = Date.now() + 20_000;
      while (!signal?.aborted && Date.now() < deadline) {
        const child = readdirSync(registry, { recursive: true }).filter((file): file is string => typeof file === "string" && file.endsWith(".json"))
          .map((file) => JSON.parse(readFileSync(join(registry, file), "utf8")))
          .find((record) => record.semanticName === "probe");
        if (child?.state === "completed") {
          writeFileSync(join(directory, "barrier.json"), JSON.stringify({ action, child, session: ctx.sessionManager.getSessionFile() }));
          if (action === "crash") process.exit(0); // Test-owned process, after completion was durably queued.
          return { content: [{ type: "text", text: action }], details: undefined };
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Timed out waiting for test child completion");
    },
  });
  pi.registerProvider("lifecycle-test", {
    api: "lifecycle-test-api", baseUrl: "http://invalid.local", apiKey: "offline-test",
    models: [{ id: "fixture", name: "Offline lifecycle fixture", reasoning: false, input: ["text"],
      contextWindow: 1_000_000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const last = context.messages.at(-1);
      const text = (content: unknown): string => typeof content === "string" ? content :
        Array.isArray(content) ? content.filter((part) => part.type === "text").map((part) => part.text).join("") : "";
      const output: AssistantMessage = {
        role: "assistant", api: model.api, model: model.id, provider: model.provider,
        content: [], timestamp: Date.now(), stopReason: "stop",
        usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const tool = (name: string, args: Record<string, unknown>) => {
        const call: ToolCall = { type: "toolCall", id: crypto.randomUUID(), name, arguments: args };
        output.content = [call];
        output.stopReason = "toolUse";
      };
      if (process.env.HERDR_SUBAGENT_AGENT_ID) {
        output.content = [{ type: "text", text: `SCOUT_RESULT_${process.env.HERDR_SUBAGENT_GENERATION}` }];
      } else if (last?.role === "user" && ["message", "cancel", "crash"].includes(text(last.content))) {
        tool("subagent", { action: "spawn", agent: "scout", name: "probe", workScope: "lifecycle-test", task: text(last.content) });
      } else if (last?.role === "toolResult" && last.toolName === "subagent" && last.content.some((block) => block.type === "text" && block.text.startsWith("Spawned"))) {
        const action = context.messages.find((message) => message.role === "user");
        tool("lifecycle_barrier", { action: text(action?.content) });
      } else if (last?.role === "toolResult" && last.toolName === "lifecycle_barrier") {
        const action = last.content.find((block) => block.type === "text");
        tool("subagent", { action: action?.text, name: "probe", message: "Continue" });
      } else {
        output.content = [{ type: "text", text: "PARENT_USABLE" }];
      }
      stream.push({ type: "start", partial: output });
      const content = output.content[0];
      if (content.type === "toolCall") {
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: content, partial: output });
      } else if (content.type === "text") {
        stream.push({ type: "text_start", contentIndex: 0, partial: output });
        stream.push({ type: "text_delta", contentIndex: 0, delta: content.text, partial: output });
        stream.push({ type: "text_end", contentIndex: 0, content: content.text, partial: output });
      }
      stream.push({ type: "done", reason: output.stopReason === "toolUse" ? "toolUse" : "stop", message: output });
      stream.end();
      return stream;
    },
  });
}
