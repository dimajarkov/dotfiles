// Deterministic provider for e2e-active-cancellation.mjs. Never loaded by normal Pi sessions.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type SimpleStreamOptions,
  type ToolCall,
} from "@earendil-works/pi-ai";

export default function activeCancellationProvider(pi: ExtensionAPI) {
  const directory = process.env.PI_CODING_AGENT_DIR!;
  const barrierPath = `${directory}/active-provider-barrier.json`;
  const abortedPath = `${directory}/active-provider-aborted.json`;
  const child = Boolean(process.env.HERDR_SUBAGENT_AGENT_ID);
  const callsPath = `${directory}/${child ? "active-provider-child-calls" : "active-provider-parent-calls"}`;

  pi.registerProvider("active-cancel-test", {
    api: "active-cancel-test-api",
    baseUrl: "http://invalid.local",
    apiKey: "offline-test",
    models: [
      {
        id: "fixture",
        name: "Active cancellation fixture",
        reasoning: false,
        input: ["text"],
        contextWindow: 1_000_000,
        maxTokens: 1_024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model, context, options?: SimpleStreamOptions) {
      const calls = existsSync(callsPath)
        ? Number.parseInt(readFileSync(callsPath, "utf8"), 10)
        : 0;
      writeFileSync(callsPath, String(calls + 1));
      const text = child ? "ACTIVE_CHILD_RESPONSE" : "PARENT_RESPONSE";
      const output: AssistantMessage = {
        role: "assistant",
        api: model.api,
        model: model.id,
        provider: model.provider,
        content: [],
        timestamp: Date.now(),
        stopReason: "stop",
        usage: {
          input: 0,
          output: 0,
          total: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const last = context.messages.at(-1);
      const textOf = (content: unknown): string =>
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .filter((part) => part && typeof part === "object" && part.type === "text")
                .map((part) => (part as { text: string }).text)
                .join("")
            : "";
      const tool = (name: string, args: Record<string, unknown>) => {
        const call: ToolCall = {
          type: "toolCall",
          id: crypto.randomUUID(),
          name,
          arguments: args,
        };
        output.content = [call];
        output.stopReason = "toolUse";
      };

      if (child && calls === 0) {
        // Keep the provider blocked until child-owned cancellation aborts it.
        // Admission must not wait for this response to finish or start another turn.
        writeFileSync(barrierPath, JSON.stringify({ active: true }));
      } else if (
        !child &&
        last?.role === "user" &&
        textOf(last.content) === "START_ACTIVE_CANCEL"
      ) {
        tool("subagent", {
          action: "spawn",
          agent: "probe",
          name: "probe",
          workScope: "active-cancel-test",
          task: "ACTIVE_CANCEL_CHILD",
        });
      } else if (
        !child &&
        last?.role === "toolResult" &&
        last.toolName === "subagent" &&
        last.content.some((block) => block.type === "text" && block.text.startsWith("Spawned"))
      ) {
        output.content = [{ type: "text", text: "PARENT_CHILD_STARTED" }];
      } else if (
        !child &&
        last?.role === "user" &&
        textOf(last.content) === "CANCEL_ACTIVE_CHILD"
      ) {
        tool("subagent", { action: "cancel", name: "probe" });
      } else if (
        !child &&
        last?.role === "toolResult" &&
        last.toolName === "subagent" &&
        last.content.some((block) => block.type === "text" && block.text.startsWith("Cancelled"))
      ) {
        output.content = [{ type: "text", text: "PARENT_CANCEL_DONE" }];
      } else {
        output.content = [{ type: "text", text }];
      }

      const stream = createAssistantMessageEventStream();
      void (async () => {
        if (child && calls === 0) {
          while (!options?.signal?.aborted) {
            await new Promise<void>((resolve) => setTimeout(resolve, 5));
          }
          writeFileSync(
            abortedPath,
            JSON.stringify({
              aborted: true,
              receipt: existsSync(`${process.env.HERDR_SUBAGENT_COMPLETION_MARKER}.control`)
                ? JSON.parse(
                    readFileSync(`${process.env.HERDR_SUBAGENT_COMPLETION_MARKER}.control`, "utf8"),
                  )
                : null,
            }),
          );
          output.stopReason = "aborted";
          output.errorMessage = "Request was aborted";
          stream.push({ type: "error", reason: "aborted", error: output });
          stream.end();
          return;
        }
        stream.push({ type: "start", partial: output });
        const content = output.content[0];
        if (content.type === "toolCall") {
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
          stream.push({
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: content,
            partial: output,
          });
        } else if (content.type === "text") {
          stream.push({ type: "text_start", contentIndex: 0, partial: output });
          stream.push({
            type: "text_delta",
            contentIndex: 0,
            delta: content.text,
            partial: output,
          });
          stream.push({
            type: "text_end",
            contentIndex: 0,
            content: content.text,
            partial: output,
          });
        }
        stream.push({
          type: "done",
          reason: output.stopReason === "toolUse" ? "toolUse" : "stop",
          message: output,
        });
        stream.end();
      })();
      return stream;
    },
  });
}
