import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
if (!process.env.PI_TEST_PACKAGES)
  throw new Error("Set PI_TEST_PACKAGES to the deployment package packages directory");
const installed = pathToFileURL(resolve(process.env.PI_TEST_PACKAGES)).href;
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
  await import(`${installed}/coding-agent/dist/index.js`);
const { createAssistantMessageEventStream } = await import(`${installed}/ai/dist/index.js`);
const {
  registerChildCompletionProtocol,
  childControlPrompt,
  childControlRequestFromPrompt,
  childControlReceiptPath,
  childControlReceiptAt,
  completionSettlementAt,
} = await import("./completion-protocol.ts");
for (const fault of ["native-rejection", "receipt-publication", "cancel-receipt"]) {
  const directory = mkdtempSync(join(tmpdir(), `subagent-native-${fault}-`));
  console.log(`Evidence: ${directory}`);
  const registry = join(directory, "registry");
  mkdirSync(registry);
  const marker = join(registry, "child-1.generation-1.complete");
  writeFileSync(
    join(registry, "child-1.json"),
    JSON.stringify({
      id: "child-1",
      rootId: "root-1",
      parentId: "parent-1",
      generation: 1,
      state: "working",
    }),
  );
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  let started;
  const providerStarted = new Promise((resolve) => (started = resolve));
  let release;
  const providerRelease = new Promise((resolve) => (release = resolve));
  let calls = 0;
  const modelRuntime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: join(directory, "models.json"),
    modelsStorePath: join(directory, "models-store.json"),
    allowModelNetwork: false,
  });
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        pi.registerProvider("wrapper-probe", {
          api: "wrapper-probe-api",
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
          streamSimple(model) {
            calls += 1;
            const stream = createAssistantMessageEventStream();
            const output = {
              role: "assistant",
              api: model.api,
              provider: model.provider,
              model: model.id,
              content: [{ type: "text", text: "PRIOR_CONCLUSION" }],
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
            };
            void (async () => {
              started();
              await providerRelease;
              stream.push({ type: "start", partial: output });
              stream.push({ type: "done", reason: "stop", message: output });
              stream.end();
            })();
            return stream;
          },
        });
        registerChildCompletionProtocol(pi, {
          HERDR_SUBAGENT_AGENT_ID: "child-1",
          HERDR_SUBAGENT_GENERATION: "1",
          HERDR_SUBAGENT_REGISTRY: registry,
          HERDR_SUBAGENT_COMPLETION_MARKER: marker,
        });
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    modelRuntime,
    settingsManager,
    resourceLoader: loader,
    sessionManager: SessionManager.create(directory, join(directory, "sessions")),
    noTools: "all",
    thinkingLevel: "off",
  });
  await session.setModel(modelRuntime.getModel("wrapper-probe", "fixture"));
  const errors = [];
  let aborts = 0;
  await session.bindExtensions({
    onError: (error) => errors.push(error),
    abortHandler: () => {
      aborts++;
      void session.abort();
    },
  });
  const initial = session.prompt("INITIAL");
  await Promise.race([
    providerStarted,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("provider startup deadline")), 5000).unref(),
    ),
  ]);
  let nativeCalls = 0;
  const steer = session.agent.steer.bind(session.agent);
  session.agent.steer = (message) => {
    nativeCalls += 1;
    if (fault === "native-rejection") throw new Error("Injected real queue rejection");
    steer(message);
    rmSync(childControlReceiptPath(marker));
    mkdirSync(childControlReceiptPath(marker));
  };
  if (fault === "cancel-receipt") mkdirSync(childControlReceiptPath(marker));
  try {
    const control = childControlPrompt({
      version: 1,
      childId: "child-1",
      generation: 1,
      nonce: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      action: fault === "cancel-receipt" ? "cancel" : "message",
      receiptPath: childControlReceiptPath(marker),
      ...(fault === "cancel-receipt" ? {} : { message: "MUST_NOT_BE_ACKNOWLEDGED" }),
    });
    assert.ok(
      childControlRequestFromPrompt(control),
      "fault injection must use a valid private control envelope",
    );
    await session.prompt(control, { streamingBehavior: "steer" });
    await new Promise((resolve) => setImmediate(resolve));
    const receipt = childControlReceiptAt(marker);
    const evidence = {
      fault,
      nativeCalls,
      calls,
      receipt,
      settlement: completionSettlementAt(marker),
      errors,
    };
    writeFileSync(join(directory, "evidence.json"), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
    assert.equal(nativeCalls, fault === "cancel-receipt" ? 0 : 1);
    assert.equal(calls, 1, "no provider release before failed-admission observation");
    assert.equal(aborts, 0, "failed receipt publication must not interrupt the busy provider");
    assert.equal(
      receipt,
      undefined,
      "real public wrapper must not acknowledge a rejected native queue",
    );
    assert.equal(
      completionSettlementAt(marker)?.pendingControls ?? 0,
      fault === "receipt-publication" ? 1 : 0,
      "native rejection withdraws its reservation; publication failure retains an unauthorized settlement guard",
    );
    assert.equal(session.agent.hasQueuedMessages(), fault === "receipt-publication");
    assert.deepEqual(
      errors,
      [],
      "rejection is observed synchronously, not hidden by a void runtime wrapper",
    );
    session.agent.steer = steer;
    release();
    await initial;
    assert.equal(calls, 1, "unauthorized control never starts another provider call");
    assert.equal(aborts, fault === "receipt-publication" ? 1 : 0);
    if (fault === "receipt-publication") assert.equal(existsSync(marker), false);
    console.log(
      `PASS actual SDK ${fault}: no accepted receipt or unauthorized provider call; settlement remains truthful`,
    );
  } finally {
    session.agent.steer = steer;
    release();
    await initial;
    session.dispose();
  }
}
