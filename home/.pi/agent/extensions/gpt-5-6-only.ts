import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const ALLOWED_PROVIDER = "openai-codex";
const FALLBACK_MODEL_ID = "gpt-5.6-sol";

export const ALLOWED_MODEL_IDS = [
  "gpt-5.6-luna",
  FALLBACK_MODEL_ID,
  "gpt-5.6-terra",
] as const;

const allowedModelIds = new Set<string>(ALLOWED_MODEL_IDS);

type ModelIdentity = {
  id: string;
  provider: string;
};

export function isAllowedModel(
  model: ModelIdentity | undefined,
): model is ModelIdentity {
  return (
    model?.provider === ALLOWED_PROVIDER && allowedModelIds.has(model.id)
  );
}

function modelLabel(model: ModelIdentity | undefined): string {
  return model ? `${model.provider}/${model.id}` : "no model";
}

function restrictProviderCatalogs(pi: ExtensionAPI, ctx: ExtensionContext) {
  const models = ctx.modelRegistry.getAll();
  const providers = new Set(models.map((model) => model.provider));

  for (const provider of providers) {
    pi.registerProvider(provider, {
      models:
        provider === ALLOWED_PROVIDER
          ? models.filter(isAllowedModel)
          : [],
    });
  }

  return models.find(
    (model) =>
      model.provider === ALLOWED_PROVIDER && model.id === FALLBACK_MODEL_ID,
  );
}

export default function registerGpt56Only(pi: ExtensionAPI) {
  let correctingModel = false;

  // Remove Claude from the catalog as soon as extensions load, before any
  // session or subagent can resolve the embedded Haiku default.
  pi.registerProvider("anthropic", { models: [] });

  const enforce = async (
    ctx: ExtensionContext,
    selectedModel: ModelIdentity | undefined,
  ) => {
    const fallback = restrictProviderCatalogs(pi, ctx);
    if (isAllowedModel(selectedModel) || correctingModel) return;

    if (!fallback) {
      ctx.ui.notify(
        "GPT-5.6 policy could not find openai-codex/gpt-5.6-sol. Pi is shutting down without making a model request.",
        "error",
      );
      ctx.shutdown();
      return;
    }

    correctingModel = true;
    try {
      const changed = await pi.setModel(fallback);
      if (!changed) {
        ctx.ui.notify(
          `GPT-5.6 policy blocked ${modelLabel(selectedModel)}, but could not select openai-codex/${FALLBACK_MODEL_ID}. Pi is shutting down without making a model request.`,
          "error",
        );
        ctx.shutdown();
        return;
      }
      ctx.ui.notify(
        `GPT-5.6 policy blocked ${modelLabel(selectedModel)} and selected openai-codex/${FALLBACK_MODEL_ID}.`,
        "warning",
      );
    } finally {
      correctingModel = false;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    await enforce(ctx, ctx.model);
  });

  pi.on("model_select", async (event, ctx) => {
    await enforce(ctx, event.model);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    await enforce(ctx, ctx.model);
  });

  pi.on("before_provider_request", (_event, ctx) => {
    if (isAllowedModel(ctx.model)) return;
    ctx.abort();
    ctx.ui.notify(
      `GPT-5.6 policy aborted a request to ${modelLabel(ctx.model)}.`,
      "error",
    );
  });
}
