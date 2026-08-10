import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Composio } from "@composio/core";
import { PiProvider, type PiComposioSessionLike } from "@composio/experimental";
import { COMPOSIO_KEYCHAIN_SERVICE, resolveComposioApiKey } from "./auth.js";
import { loadComposioConfig, type ComposioExtensionConfig } from "./config.js";
import { ComposioOutputStore } from "./output.js";

type ActiveSession = PiComposioSessionLike & { sessionId: string };

interface PersistedSession {
  sessionId: string;
  userId: string;
  configFingerprint: string;
}

const SESSION_ENTRY_TYPE = "composio-session";
const COMPOSIO_TOOL_NAMES = new Set([
  "composio_search_tools",
  "composio_manage_connections",
  "composio_execute_tool",
  "composio_remote_workbench",
  "composio_remote_bash",
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function configFingerprint(config: ComposioExtensionConfig): string {
  return JSON.stringify({
    userId: config.userId,
    toolkits: config.toolkits ?? null,
    sandbox: config.sandbox,
    callbackUrl: config.callbackUrl ?? null,
  });
}

function restoredSession(ctx: ExtensionContext, config: ComposioExtensionConfig): PersistedSession | undefined {
  const expectedFingerprint = configFingerprint(config);
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if (entry.type !== "custom" || entry.customType !== SESSION_ENTRY_TYPE) continue;
    const data = entry.data as Partial<PersistedSession> | undefined;
    if (
      data?.userId === config.userId &&
      data.configFingerprint === expectedFingerprint &&
      typeof data.sessionId === "string"
    ) {
      return data as PersistedSession;
    }
  }
  return undefined;
}

export default function composioExtension(pi: ExtensionAPI): void {
  const outputStore = new ComposioOutputStore();
  let activeSession: ActiveSession | undefined;
  let activeConfig: ComposioExtensionConfig | undefined;
  let initializationError: string | undefined;
  let initialization: Promise<void> | undefined;

  async function initialize(ctx: ExtensionContext): Promise<void> {
    activeSession = undefined;
    activeConfig = undefined;
    initializationError = undefined;

    const apiKey = resolveComposioApiKey();
    if (!apiKey) return;

    ctx.ui.setStatus("composio", "Composio: connecting");
    try {
      const config = loadComposioConfig();
      const provider = new PiProvider({
        catchErrors: false,
        formatResult: (value) => outputStore.format(value),
      });
      const composio = new Composio({
        apiKey,
        provider,
        disableVersionCheck: true,
      });
      const persisted = restoredSession(ctx, config);
      const session = persisted
        ? await composio.use(persisted.sessionId)
        : await composio.create(config.userId, {
            ...(config.toolkits ? { toolkits: config.toolkits } : {}),
            manageConnections: {
              enable: true,
              ...(config.callbackUrl ? { callbackUrl: config.callbackUrl } : {}),
            },
            sandbox: { enable: config.sandbox },
          });

      if (!persisted) {
        pi.appendEntry(SESSION_ENTRY_TYPE, {
          sessionId: session.sessionId,
          userId: config.userId,
          configFingerprint: configFingerprint(config),
        } satisfies PersistedSession);
      }

      const tools = provider.createSessionTools(session, {
        callbackUrl: config.callbackUrl,
        includeWorkbenchTools: config.sandbox,
        transformResult: ({ value }) => outputStore.transform(value),
      });
      for (const tool of tools) {
        pi.registerTool({
          ...tool,
          promptGuidelines: tool.promptGuidelines?.map(
            (guideline) => `${tool.name}: ${guideline}`,
          ),
        });
      }

      activeSession = session;
      activeConfig = config;
      ctx.ui.setStatus("composio", "Composio: ready");
    } catch (error) {
      initializationError = errorMessage(error);
      ctx.ui.setStatus("composio", "Composio: error");
      ctx.ui.notify(`Composio failed to initialize: ${initializationError}`, "error");
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    initialization = initialize(ctx);
    await initialization;
  });

  pi.on("session_shutdown", (_event, ctx) => {
    outputStore.cleanup();
    ctx.ui.setStatus("composio", undefined);
  });

  pi.registerCommand("composio", {
    description: "Show Composio integration status",
    handler: async (_args, ctx) => {
      await initialization;
      if (activeSession && activeConfig) {
        const activeTools = pi.getActiveTools().filter((name) => COMPOSIO_TOOL_NAMES.has(name));
        ctx.ui.notify(
          `Composio ready for ${activeConfig.userId}. Session ${activeSession.sessionId}. ${activeTools.length} tools active.`,
          "info",
        );
        return;
      }

      if (initializationError) {
        ctx.ui.notify(`Composio error: ${initializationError}`, "error");
        return;
      }

      ctx.ui.notify(
        `Composio is not configured. Set COMPOSIO_API_KEY, create ~/.config/pi-composio/api-key, or add it to macOS Keychain service ${COMPOSIO_KEYCHAIN_SERVICE}, then restart pi.`,
        "warning",
      );
    },
  });
}
