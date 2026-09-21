import assert from "node:assert/strict";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  parseRecapResponse,
  reasoningOptions,
  summarizeRun,
} from "./src/summarizer.ts";

test("omits reasoning when configured off", () => {
  assert.deepEqual(reasoningOptions("off"), {});
  assert.deepEqual(reasoningOptions("medium"), { reasoning: "medium" });
});

test("uses the composed provider for extension-registered summary models", async () => {
  type SmokeModel = Model<"summary-smoke">;
  const model: SmokeModel = {
    id: "smoke",
    name: "Summary smoke",
    api: "summary-smoke",
    provider: "summary-smoke",
    baseUrl: "https://summary-smoke.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_000,
    maxTokens: 1_000,
  };
  let called = false;
  const provider = {
    streamSimple(
      receivedModel: SmokeModel,
      _context: Context,
      options?: SimpleStreamOptions,
    ) {
      called = true;
      assert.equal(receivedModel.baseUrl, "https://summary-smoke.invalid/v1");
      assert.equal(options?.apiKey, "summary-smoke-key");
      const stream = createAssistantMessageEventStream();
      stream.end({
        role: "assistant",
        content: [
          {
            type: "text",
            text: '{"recap":"Extension provider used.","next":"Continue."}',
          },
        ],
        api: receivedModel.api,
        provider: receivedModel.provider,
        model: receivedModel.id,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });
      return stream;
    },
  };
  const modelRegistry = {
    find: () => model,
    getApiKeyAndHeaders: async () => ({
      ok: true as const,
      apiKey: "summary-smoke-key",
      baseUrl: "https://summary-smoke.invalid/v1",
    }),
    getProvider: () => provider,
  } as unknown as ModelRegistry;

  const recap = await summarizeRun({
    modelRegistry,
    config: {
      provider: "summary-smoke",
      model: "smoke",
      reasoning: "off",
    },
    transcript: "USER\\nSay smoke",
    signal: new AbortController().signal,
  });

  assert.equal(called, true);
  assert.deepEqual(recap, {
    recap: "Extension provider used.",
    next: "Continue.",
  });
});

test("parses strict recap JSON", () => {
  assert.deepEqual(
    parseRecapResponse(
      '{"recap":"Updated config and ran focused tests.","next":"Review the diff."}',
    ),
    {
      recap: "Updated config and ran focused tests.",
      next: "Review the diff.",
    },
  );
});

test("defensively extracts fenced or surrounded JSON and normalizes Next", () => {
  assert.deepEqual(
    parseRecapResponse(
      'Result follows:\n```json\n{"recap":"- Added the extension\\n- Tests pass","next":"Next: Reload Pi."}\n```',
    ),
    {
      recap: "- Added the extension\n- Tests pass",
      next: "Reload Pi.",
    },
  );
});

test("rejects malformed or incomplete output", () => {
  assert.throws(() => parseRecapResponse("not json"), /valid recap JSON/);
  assert.throws(
    () => parseRecapResponse('{"recap":"missing next"}'),
    /valid recap JSON/,
  );
  assert.throws(
    () =>
      parseRecapResponse(
        '{"recap":"done","next":"nothing","extra":"not allowed"}',
      ),
    /valid recap JSON/,
  );
});

test("strips terminal control sequences from recap fields", () => {
  assert.deepEqual(
    parseRecapResponse(
      '{"recap":"Updated \\u001b[31mconfig\\u001b[0m.","next":"Review it.\\u0007"}',
    ),
    { recap: "Updated config.", next: "Review it." },
  );
});
