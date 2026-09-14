import assert from "node:assert/strict";
import test from "node:test";
import registerGpt56Only, {
  ALLOWED_MODEL_IDS,
  isAllowedModel,
} from "./gpt-5-6-only.ts";

type Handler = (event: any, context: any) => Promise<void> | void;
type Model = { id: string; provider: string; name?: string };

function fakePi() {
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
      return true;
    },
  };

  registerGpt56Only(pi as any);
  return { events, providerRegistrations, selectedModels };
}

function fakeContext(currentModel: Model) {
  const models: Model[] = [
    { provider: "anthropic", id: "claude-haiku-4-5" },
    { provider: "openai-codex", id: "gpt-5.4" },
    { provider: "openai-codex", id: "gpt-5.6-luna" },
    { provider: "openai-codex", id: "gpt-5.6-sol" },
    { provider: "openai-codex", id: "gpt-5.6-terra" },
  ];
  const notifications: Array<{ message: string; type: string }> = [];
  let shutdownCalls = 0;
  const context = {
    model: currentModel,
    modelRegistry: {
      getAll: () => models,
      find: (provider: string, id: string) =>
        models.find((model) => model.provider === provider && model.id === id),
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

test("allows only the three OpenAI Codex GPT-5.6 models", () => {
  for (const id of ALLOWED_MODEL_IDS) {
    assert.equal(isAllowedModel({ provider: "openai-codex", id }), true);
  }
  assert.equal(
    isAllowedModel({ provider: "anthropic", id: "claude-haiku-4-5" }),
    false,
  );
  assert.equal(
    isAllowedModel({ provider: "openai-codex", id: "gpt-5.4" }),
    false,
  );
});

test("restricts every discovered provider catalog", async () => {
  const { events, providerRegistrations } = fakePi();
  const { context } = fakeContext({
    provider: "openai-codex",
    id: "gpt-5.6-sol",
  });
  assert.deepEqual(providerRegistrations, [
    { name: "anthropic", config: { models: [] } },
  ]);
  const initialRegistrationCount = providerRegistrations.length;

  await events.get("session_start")!({}, context);

  assert.deepEqual(
    providerRegistrations
      .slice(initialRegistrationCount)
      .map(({ name, config }) => ({
        name,
        models: config.models.map((model) => model.id),
      })),
    [
      { name: "anthropic", models: [] },
      {
        name: "openai-codex",
        models: ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"],
      },
    ],
  );
});

test("replaces an out-of-policy current model before use", async () => {
  const { events, selectedModels } = fakePi();
  const { context, notifications, shutdownCalls } = fakeContext({
    provider: "anthropic",
    id: "claude-haiku-4-5",
  });

  await events.get("session_start")!({}, context);

  assert.deepEqual(selectedModels, [
    { provider: "openai-codex", id: "gpt-5.6-sol" },
  ]);
  assert.equal(shutdownCalls(), 0);
  assert.match(notifications[0]!.message, /blocked anthropic\/claude-haiku-4-5/i);
});
