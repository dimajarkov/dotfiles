import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function barrier() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

// The only substituted collaborator is the external model provider.
export async function fixture(packages, options = {}) {
  const sdk = await import(pathToFileURL(join(packages, "coding-agent/dist/index.js")));
  const { createAssistantMessageEventStream } = await import(
    pathToFileURL(join(packages, "ai/dist/index.js"))
  );
  const directory = options.cwd ?? mkdtempSync(join(tmpdir(), "pi-user-request-"));
  const agentDir = options.agentDir ?? directory;
  mkdirSync(agentDir, { recursive: true });
  const settingsManager = sdk.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    ...options.settings,
  });
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-store.json"),
    allowModelNetwork: false,
  });
  const events = [],
    preparations = [],
    inputs = [],
    calls = [],
    errors = [];
  let api, context;
  const loader = new sdk.DefaultResourceLoader({
    cwd: directory,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        api = pi;
        pi.on("session_start", (_event, ctx) => {
          context = ctx;
        });
        pi.on("input", (event) => {
          inputs.push(structuredClone(event));
        });
        for (const name of ["user_request_start", "user_request_end"])
          pi.on(name, async (event, ctx) => {
            events.push(structuredClone(event));
            await options.lifecycle?.(event, ctx);
          });
        for (const name of ["user_request_prepare", "user_request_prepare_end"])
          pi.on(name, async (event, ctx) => {
            preparations.push(structuredClone(event));
            await options.preparation?.(event, ctx);
          });
        options.factory?.(pi);
        pi.registerProvider("request-fixture", {
          api: "request-fixture-api",
          baseUrl: "http://invalid.local",
          apiKey: "offline-test",
          models: [
            {
              id: "fixture",
              name: "Offline fixture",
              reasoning: false,
              input: ["text"],
              contextWindow: 1000000,
              maxTokens: 1024,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
          streamSimple(model, providerContext, streamOptions) {
            const index = calls.length;
            calls.push(structuredClone(providerContext));
            const stream = createAssistantMessageEventStream();
            void (async () => {
              let response;
              try {
                response = await options.respond?.(index, providerContext, streamOptions);
              } catch (error) {
                response = { stopReason: "error", errorMessage: String(error) };
              }
              const output = {
                role: "assistant",
                api: model.api,
                provider: model.provider,
                model: model.id,
                content: [{ type: "text", text: "CONCLUSION" }],
                stopReason: "stop",
                timestamp: Date.now(),
                usage: {
                  input: 0,
                  output: 0,
                  totalTokens: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                ...response,
              };
              stream.push({ type: "start", partial: output });
              stream.push(
                output.stopReason === "error" || output.stopReason === "aborted"
                  ? { type: "error", reason: output.stopReason, error: output }
                  : { type: "done", reason: output.stopReason, message: output },
              );
              stream.end();
            })();
            return stream;
          },
        });
      },
    ],
  });
  await loader.reload();
  const { session } = await sdk.createAgentSession({
    cwd: directory,
    agentDir,
    modelRuntime,
    settingsManager,
    resourceLoader: loader,
    sessionManager: sdk.SessionManager.create(directory, join(agentDir, "sessions")),
    noTools: "builtin",
    thinkingLevel: "off",
  });
  await session.setModel(modelRuntime.getModel("request-fixture", "fixture"));
  await session.bindExtensions({
    mode: options.mode ?? "json",
    onError: (error) => errors.push(error),
    ...(options.onNotification
      ? {
          uiContext: {
            ...session.extensionRunner.getUIContext(),
            notify: options.onNotification,
          },
        }
      : {}),
  });
  return {
    sdk,
    session,
    api,
    events,
    preparations,
    inputs,
    calls,
    errors,
    directory,
    get context() {
      return context;
    },
    async close() {
      await session.waitForIdle();
      session.dispose();
      if (!options.cwd) rmSync(directory, { recursive: true, force: true });
    },
  };
}
