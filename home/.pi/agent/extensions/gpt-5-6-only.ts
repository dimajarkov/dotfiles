import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ALLOWED_PROVIDER = "openai-codex";
// Keep newly published Codex models available without requiring another policy update.
const PREFERRED_FALLBACK_MODEL_IDS = ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol"] as const;

type ModelIdentity = {
  id: string;
  provider: string;
};

export function isAllowedModel(model: ModelIdentity | undefined): model is ModelIdentity {
  return model?.provider === ALLOWED_PROVIDER;
}

function modelLabel(model: ModelIdentity | undefined): string {
  return model ? `${model.provider}/${model.id}` : "no model";
}

function restrictProviderCatalogs(pi: ExtensionAPI, ctx: ExtensionContext) {
  const models = ctx.modelRegistry.getAll();
  const providers = new Set(models.map((model) => model.provider));

  for (const provider of providers) {
    pi.registerProvider(provider, {
      models: provider === ALLOWED_PROVIDER ? models.filter(isAllowedModel) : [],
    });
  }

  return (
    PREFERRED_FALLBACK_MODEL_IDS.map((id) =>
      models.find((model) => model.provider === ALLOWED_PROVIDER && model.id === id),
    ).find((model) => model !== undefined) ??
    models.find((model) => model.provider === ALLOWED_PROVIDER)
  );
}

export default function registerCodexModelPolicy(pi: ExtensionAPI) {
  let correctingModel = false;

  // Remove Claude from the catalog as soon as extensions load, before any
  // session or subagent can resolve the embedded Haiku default.
  pi.registerProvider("anthropic", { models: [] });

  const enforce = async (ctx: ExtensionContext, selectedModel: ModelIdentity | undefined) => {
    const fallback = restrictProviderCatalogs(pi, ctx);
    if (isAllowedModel(selectedModel) || correctingModel) return;

    if (!fallback) {
      ctx.ui.notify(
        "Codex model policy could not find an available openai-codex model. Pi is shutting down without making a model request.",
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
          `Codex model policy blocked ${modelLabel(selectedModel)}, but could not select an openai-codex model. Pi is shutting down without making a model request.`,
          "error",
        );
        ctx.shutdown();
        return;
      }
      ctx.ui.notify(
        `Codex model policy blocked ${modelLabel(selectedModel)} and selected ${modelLabel(fallback)}.`,
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
    ctx.ui.notify(`Codex model policy aborted a request to ${modelLabel(ctx.model)}.`, "error");
  });
}
