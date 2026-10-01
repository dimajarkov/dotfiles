import assert from "node:assert/strict";
import test from "node:test";
import { type Context, type Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { parseRecapResponse, summarizeRun } from "./src/summarizer.ts";

test("uses ModelRegistry.complete for extension-registered summary models", async () => {
  type SmokeModel = Model<"openai-codex-responses">;
  const model: SmokeModel = {
    id: "smoke",
    name: "Summary smoke",
    api: "openai-codex-responses",
    provider: "summary-smoke",
    baseUrl: "https://summary-smoke.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_000,
    maxTokens: 1_000,
  };
  let called = false;
  const modelRegistry = {
    find: () => model,
    async complete(
      receivedModel: SmokeModel,
      context: Context,
      options?: {
        maxRetries?: number;
        timeoutMs?: number;
        reasoningEffort?: string;
        apiKey?: string;
      },
    ) {
      called = true;
      assert.equal(receivedModel.baseUrl, "https://summary-smoke.invalid/v1");
      assert.equal(context.systemPrompt?.includes("recap"), true);
      assert.equal(context.systemPrompt?.includes('"title"'), true);
      assert.equal(options?.maxRetries, 1);
      assert.equal(options?.timeoutMs, 40_000);
      assert.equal(options?.reasoningEffort, "medium");
      assert.equal(options?.apiKey, undefined);
      return {
        role: "assistant" as const,
        content: [
          {
            type: "text" as const,
            text: '{"title":"Use extension summary provider","recap":"Extension provider used.","next":"Continue."}',
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
        stopReason: "stop" as const,
        timestamp: Date.now(),
      };
    },
  } as unknown as ModelRegistry;

  const recap = await summarizeRun({
    modelRegistry,
    config: {
      provider: "summary-smoke",
      model: "smoke",
      reasoning: "medium",
    },
    transcript: "USER\\nSay smoke",
    signal: new AbortController().signal,
  });

  assert.equal(called, true);
  assert.deepEqual(recap, {
    title: "Use extension summary provider",
    recap: "Extension provider used.",
    next: "Continue.",
  });
});

test("parses strict recap JSON with a semantic title", () => {
  assert.deepEqual(
    parseRecapResponse(
      '{"title":"Add semantic recap titles","recap":"Updated config and ran focused tests.","next":"Review the diff."}',
    ),
    {
      title: "Add semantic recap titles",
      recap: "Updated config and ran focused tests.",
      next: "Review the diff.",
    },
  );
});

test("normalizes generated titles into short plain-text headings", () => {
  assert.equal(
    parseRecapResponse(
      '{"title":"**Add semantic titles to completed Pi agent recaps everywhere now.**","recap":"Updated the recap card.","next":"Reload Pi."}',
    ).title,
    "Add semantic titles to completed Pi agent recaps",
  );
});

test("defensively extracts fenced or surrounded JSON and normalizes Next", () => {
  assert.deepEqual(
    parseRecapResponse(
      'Result follows:\n```json\n{"title":"Build recap extension","recap":"- Added the extension\\n- Tests pass","next":"Next: Reload Pi."}\n```',
    ),
    {
      title: "Build recap extension",
      recap: "- Added the extension\n- Tests pass",
      next: "Reload Pi.",
    },
  );
});

test("rejects malformed or incomplete output", () => {
  assert.throws(() => parseRecapResponse("not json"), /valid recap JSON/);
  assert.throws(
    () => parseRecapResponse('{"recap":"missing title","next":"nothing remains"}'),
    /valid recap JSON/,
  );
  assert.throws(
    () =>
      parseRecapResponse(
        '{"title":"Do the work","recap":"done","next":"nothing","extra":"not allowed"}',
      ),
    /valid recap JSON/,
  );
  assert.throws(
    () => parseRecapResponse('{"title":"Run recap","recap":"done","next":"nothing"}'),
    /valid recap JSON/,
  );
});

test("strips terminal control sequences from recap fields", () => {
  assert.deepEqual(
    parseRecapResponse(
      '{"title":"Update \\u001b[34mconfig\\u001b[0m","recap":"Updated \\u001b[31mconfig\\u001b[0m.","next":"Review it.\\u0007"}',
    ),
    {
      title: "Update config",
      recap: "Updated config.",
      next: "Review it.",
    },
  );
});
