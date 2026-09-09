// Offline model boundary for e2e-scopes.mjs. Loaded only by isolated test configurations.
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";

interface Plan {
  scopeFixture: true;
  calls: Array<{ name: string; arguments: Record<string, unknown>; expectError?: boolean }>;
  result: string;
}

export default function scopeProvider(pi: ExtensionAPI) {
  const gates = join(process.env.PI_CODING_AGENT_DIR!, "gates");
  mkdirSync(gates, { recursive: true });
  pi.registerTool({
    name: "scope_gate", label: "Scope test gate", description: "Wait at a deterministic offline E2E gate",
    parameters: Type.Object({ key: Type.String({ pattern: "^[a-z0-9-]+$" }), participant: Type.String({ pattern: "^[a-z0-9-]+$" }), blocked: Type.Optional(Type.Boolean()) }),
    async execute(_id, { key, participant, blocked }, signal, _update, ctx) {
      const path = join(gates, `${key}.${participant}.json`);
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({
        childId: process.env.HERDR_SUBAGENT_AGENT_ID,
        rootId: process.env.HERDR_SUBAGENT_ROOT_ID,
        workScope: process.env.HERDR_SUBAGENT_WORK_SCOPE,
        generation: process.env.HERDR_SUBAGENT_GENERATION,
        model: `${ctx.model?.provider}/${ctx.model?.id}`, thinking: ctx.thinkingLevel,
        tools: pi.getActiveTools(), session: ctx.sessionManager.getSessionFile(),
      }));
      renameSync(temporary, path);
      const deadline = Date.now() + 180_000;
      if (blocked) pi.events.emit("herdr:blocked", { active: true, reason: "Offline E2E gate" });
      try {
        while (!existsSync(join(gates, `${key}.release`))) {
          if (signal?.aborted) throw new Error("Scope gate aborted");
          if (Date.now() >= deadline) throw new Error(`Scope gate timed out: ${key}`);
          await new Promise((done) => setTimeout(done, 25));
        }
        return { content: [{ type: "text", text: `Released ${key}` }], details: undefined };
      } finally {
        if (blocked) pi.events.emit("herdr:blocked", { active: false });
      }
    },
  });
  pi.registerProvider("scope-test", {
    api: "scope-test-api", baseUrl: "http://invalid.local", apiKey: "offline-test",
    models: ["root", "worker", "scout", "researcher", "planner", "reviewer"].map((id) => ({
      id, name: `Offline ${id}`, reasoning: true, input: ["text"], contextWindow: 1_000_000,
      maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const output: AssistantMessage = {
        role: "assistant", api: model.api, model: model.id, provider: model.provider,
        content: [{ type: "text", text: "COMPLETION_OBSERVED" }], timestamp: Date.now(), stopReason: "stop",
        usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const userIndex = context.messages.findLastIndex((message) => message.role === "user");
      const user = context.messages[userIndex];
      let plan: Plan | undefined;
      if (user?.role === "user") {
        const text = typeof user.content === "string" ? user.content : user.content.filter((part) => part.type === "text").map((part) => part.text).join("");
        try {
          const value = JSON.parse(text);
          if (value.scopeFixture === true && Array.isArray(value.calls)) plan = value;
        } catch { /* Normal completion follow-ups are intentionally not commands. */ }
      }
      if (plan) {
        const results = context.messages.slice(userIndex + 1).filter((message) => message.role === "toolResult");
        const unexpectedError = results.some((result, index) => Boolean(result.isError) !== Boolean(plan!.calls[index]?.expectError));
        const next = plan.calls[results.length];
        if (unexpectedError) output.content = [{ type: "text", text: "FIXTURE_UNEXPECTED_TOOL_OUTCOME" }];
        else if (next) {
          output.content = [{ type: "toolCall", id: crypto.randomUUID(), name: next.name, arguments: next.arguments }];
          output.stopReason = "toolUse";
        } else output.content = [{ type: "text", text: plan.result }];
      }
      stream.push({ type: "start", partial: output });
      const part = output.content[0];
      if (part.type === "toolCall") {
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: part, partial: output });
      } else if (part.type === "text") {
        stream.push({ type: "text_start", contentIndex: 0, partial: output });
        stream.push({ type: "text_delta", contentIndex: 0, delta: part.text, partial: output });
        stream.push({ type: "text_end", contentIndex: 0, content: part.text, partial: output });
      }
      stream.push({ type: "done", reason: output.stopReason === "toolUse" ? "toolUse" : "stop", message: output });
      stream.end();
      return stream;
    },
  });
}
