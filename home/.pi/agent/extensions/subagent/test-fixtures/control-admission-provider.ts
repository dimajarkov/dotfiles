import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";

export default function controlAdmissionProvider(pi: ExtensionAPI) {
  const barrierPath = process.env.CONTROL_TEST_BARRIER!;
  const releasePath = process.env.CONTROL_TEST_RELEASE!;
  const callsPath = process.env.CONTROL_TEST_CALLS!;
  const activeSteer = process.env.CONTROL_TEST_ACTIVE === "1";
  const continuation = process.env.CONTROL_TEST_CONTINUE === "1";
  pi.on("message_start", (event) => {
    if (continuation && event.message.role === "custom") {
      writeFileSync(`${barrierPath}.consumption`, JSON.stringify(event.message));
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (activeSteer || existsSync(barrierPath)) return;
    writeFileSync(
      barrierPath,
      JSON.stringify({ sessionPath: ctx.sessionManager.getSessionFile() }),
    );
    while (!existsSync(releasePath)) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  });

  pi.registerProvider("control-admission-test", {
    api: "control-admission-test-api",
    baseUrl: "http://invalid.local",
    apiKey: "offline-test",
    models: [
      {
        id: "fixture",
        name: "Control admission fixture",
        reasoning: false,
        input: ["text"],
        contextWindow: 1_000_000,
        maxTokens: 1_024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model, context) {
      const calls = existsSync(callsPath)
        ? Number.parseInt(readFileSync(callsPath, "utf8"), 10)
        : 0;
      writeFileSync(callsPath, String(calls + 1));
      if (continuation) {
        const settlementPath = `${process.env.HERDR_SUBAGENT_COMPLETION_MARKER}.settlement`;
        writeFileSync(
          `${callsPath}.${calls + 1}.json`,
          JSON.stringify({
            context,
            settlement: existsSync(settlementPath)
              ? JSON.parse(readFileSync(settlementPath, "utf8"))
              : null,
          }),
        );
      }
      const text = activeSteer
        ? calls === 0
          ? "INITIAL_ACTIVE_RESPONSE"
          : "ACTIVE_FOLLOW_UP_CONCLUSION"
        : "EXACT_PERSISTED_CONCLUSION";
      const output: AssistantMessage = {
        role: "assistant",
        api: model.api,
        model: model.id,
        provider: model.provider,
        content: [{ type: "text", text }],
        timestamp: Date.now(),
        stopReason: "stop",
        usage: {
          input: 0,
          output: 0,
          totalTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const stream = createAssistantMessageEventStream();
      void (async () => {
        if (activeSteer && calls === 0) {
          writeFileSync(barrierPath, JSON.stringify({ active: true }));
          while (!existsSync(releasePath)) {
            await new Promise<void>((resolve) => setTimeout(resolve, 5));
          }
        }
        if (continuation && calls === 1) {
          writeFileSync(`${barrierPath}.second`, JSON.stringify({ active: true }));
          while (!existsSync(`${releasePath}.second`)) {
            await new Promise<void>((resolve) => setTimeout(resolve, 5));
          }
        }
        stream.push({ type: "start", partial: output });
        stream.push({ type: "text_start", contentIndex: 0, partial: output });
        stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
        stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
        stream.push({ type: "done", reason: "stop", message: output });
        stream.end();
      })();
      return stream;
    },
  });
}
