import assert from "node:assert/strict";
import test from "node:test";
import registerCodexModelPolicy, { isAllowedModel } from "./gpt-5-6-only.ts";

type Handler = (event: any, context: any) => Promise<void> | void;
type Model = { id: string; provider: string; name?: string };

const defaultModels: Model[] = [
  { provider: "anthropic", id: "claude-haiku-4-5" },
  { provider: "google", id: "gemini-2.5-flash" },
  { provider: "openai-codex", id: "gpt-5.4" },
  { provider: "openai-codex", id: "gpt-5.6-luna" },
  { provider: "openai-codex", id: "gpt-5.6-sol" },
  { provider: "openai-codex", id: "gpt-6-sol" },
  { provider: "openai-codex", id: "gpt-6.1-sol" },
  { provider: "openai-codex", id: "gpt-99.unknown-codex-model" },
];

function fakePi(setModelResult = true) {
  const events = new Map<string, Handler>();
  const providerRegistrations: Array<{
    name: string;
    config: { models: Model[] };
  }> = [];
  const selectedModels: Model[] = [];
  const pi = {
    on(name: string, handler: Handler) {
      events.set(name, handler);
    },
    registerProvider(name: string, config: { models: Model[] }) {
      providerRegistrations.push({ name, config });
    },
    async setModel(model: Model) {
      selectedModels.push(model);
      return setModelResult;
    },
  };

  registerCodexModelPolicy(pi as any);
  return { events, providerRegistrations, selectedModels };
}

function fakeContext(currentModel: Model, models = defaultModels) {
  const notifications: Array<{ message: string; type: string }> = [];
  let shutdownCalls = 0;
  const context = {
    model: currentModel,
    modelRegistry: {
      getAll: () => models,
    },
    ui: {
      notify(message: string, type: string) {
        notifications.push({ message, type });
      },
    },
    shutdown() {
      shutdownCalls += 1;
    },
  };

  return {
    context,
    notifications,
    shutdownCalls: () => shutdownCalls,
  };
}

const modelSelectEvents = ["before_agent_start", "model_select", "session_start"] as const;

test("allows every Codex model ID and rejects models from other providers", () => {
  for (const id of ["gpt-5.4", "gpt-6.1-sol", "gpt-99.unknown-codex-model"]) {
    assert.equal(isAllowedModel({ provider: "openai-codex", id }), true);
  }
  assert.equal(isAllowedModel({ provider: "anthropic", id: "claude-haiku-4-5" }), false);
  assert.equal(isAllowedModel(undefined), false);
});

test("registers enforcement hooks and enforces selection before agent use", async () => {
  const expectedEvents = [
    "before_agent_start",
    "before_provider_request",
    "model_select",
    "session_start",
  ];
  assert.deepEqual([...fakePi().events.keys()].sort(), expectedEvents);

  for (const eventName of modelSelectEvents) {
    const { events, selectedModels } = fakePi();
    const disallowedModel = {
      provider: "anthropic",
      id: "claude-haiku-4-5",
    };
    const { context, notifications, shutdownCalls } = fakeContext(
      eventName === "model_select"
        ? { provider: "openai-codex", id: "gpt-99.new-codex-model" }
        : disallowedModel,
    );

    await events.get(eventName)!(
      eventName === "model_select" ? { model: disallowedModel } : {},
      context,
    );

    assert.equal(selectedModels[0]?.provider, "openai-codex", eventName);
    assert.equal(selectedModels[0]?.id, "gpt-6.1-sol", eventName);
    assert.equal(shutdownCalls(), 0, eventName);
    assert.equal(notifications[0]?.type, "warning", eventName);
  }
});

test("catalogs include every Codex model and exclude every other provider", async () => {
  const { events, providerRegistrations } = fakePi();
  const { context } = fakeContext({ provider: "openai-codex", id: "gpt-99.new" });

  assert.deepEqual(providerRegistrations, [{ name: "anthropic", config: { models: [] } }]);
  await events.get("session_start")!({}, context);

  assert.deepEqual(
    providerRegistrations.slice(1).map(({ name, config }) => ({
      name,
      modelIds: config.models.map((model) => model.id),
    })),
    [
      { name: "anthropic", modelIds: [] },
      { name: "google", modelIds: [] },
      {
        name: "openai-codex",
        modelIds: [
          "gpt-5.4",
          "gpt-5.6-luna",
          "gpt-5.6-sol",
          "gpt-6-sol",
          "gpt-6.1-sol",
          "gpt-99.unknown-codex-model",
        ],
      },
    ],
  );
});

test("prefers fallback models in policy order, then the first available Codex model", async () => {
  const cases = [
    {
      available: ["gpt-5.6-sol", "gpt-6-sol", "gpt-6.1-sol", "gpt-5.4"],
      expected: "gpt-6.1-sol",
    },
    {
      available: ["gpt-5.6-sol", "gpt-5.4", "gpt-6-sol"],
      expected: "gpt-6-sol",
    },
    {
      available: ["gpt-5.4", "gpt-5.6-sol"],
      expected: "gpt-5.6-sol",
    },
    {
      available: ["gpt-5.4", "gpt-99.unknown-codex-model"],
      expected: "gpt-5.4",
    },
  ];

  for (const { available, expected } of cases) {
    const models = available.map((id) => ({ provider: "openai-codex", id }));
    const { events, selectedModels } = fakePi();
    const { context } = fakeContext({ provider: "anthropic", id: "claude-haiku-4-5" }, models);

    await events.get("session_start")!({}, context);

    assert.equal(selectedModels[0]?.id, expected);
  }
});

test("shuts down without selecting a model when no Codex model is available", async () => {
  const { events, selectedModels } = fakePi();
  const { context, notifications, shutdownCalls } = fakeContext(
    { provider: "anthropic", id: "claude-haiku-4-5" },
    [{ provider: "anthropic", id: "claude-haiku-4-5" }],
  );

  await events.get("session_start")!({}, context);

  assert.deepEqual(selectedModels, []);
  assert.equal(shutdownCalls(), 1);
  assert.equal(notifications[0]?.type, "error");
  assert.match(notifications[0]!.message, /could not find an available openai-codex model/i);
});

test("shuts down if selecting the Codex fallback fails", async () => {
  const { events, selectedModels } = fakePi(false);
  const { context, notifications, shutdownCalls } = fakeContext({
    provider: "anthropic",
    id: "claude-haiku-4-5",
  });

  await events.get("session_start")!({}, context);

  assert.deepEqual(selectedModels, [{ provider: "openai-codex", id: "gpt-6.1-sol" }]);
  assert.equal(shutdownCalls(), 1);
  assert.equal(notifications[0]?.type, "error");
  assert.match(notifications[0]!.message, /could not select an openai-codex model/i);
});

test("aborts provider requests for a non-Codex model", () => {
  const { events, selectedModels } = fakePi();
  const { context, notifications } = fakeContext({
    provider: "anthropic",
    id: "claude-haiku-4-5",
  });
  let abortCalls = 0;

  Object.assign(context, { abort: () => abortCalls++ });
  events.get("before_provider_request")!({}, context);

  assert.equal(abortCalls, 1);
  assert.deepEqual(selectedModels, []);
  assert.equal(notifications[0]?.type, "error");
  assert.match(notifications[0]!.message, /aborted a request to anthropic\/claude-haiku-4-5/i);
});
