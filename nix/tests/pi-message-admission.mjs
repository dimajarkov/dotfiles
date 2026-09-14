import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const packages = resolve(process.env.PI_TEST_PACKAGES ?? process.argv[2]);
const sdk = await import(pathToFileURL(join(packages, "coding-agent/dist/index.js")));
const { createAssistantMessageEventStream } = await import(
  pathToFileURL(join(packages, "ai/dist/index.js"))
);

function barrier() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pi-native-admission-"));
  const settingsManager = sdk.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: join(directory, "models.json"),
    modelsStorePath: join(directory, "models-store.json"),
    allowModelNetwork: false,
  });
  const calls = [];
  const started = barrier();
  const provider = barrier();
  const consumed = barrier();
  const consumption = barrier();
  const errors = [];
  let api;
  let gateConsumption = false;
  const loader = new sdk.DefaultResourceLoader({
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
        api = pi;
        pi.on("message_start", async (event) => {
          if (event.message.role === "custom" && gateConsumption) {
            consumed.release();
            await consumption.promise;
          }
        });
        pi.registerProvider("native-admission", {
          api: "native-admission-api",
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
          streamSimple(model, context) {
            calls.push(structuredClone(context));
            const stream = createAssistantMessageEventStream();
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
            };
            void (async () => {
              started.release();
              await provider.promise;
              stream.push({ type: "start", partial: output });
              stream.push({ type: "done", reason: "stop", message: output });
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
    agentDir: directory,
    modelRuntime,
    settingsManager,
    resourceLoader: loader,
    sessionManager: sdk.SessionManager.create(directory, join(directory, "sessions")),
    noTools: "all",
    thinkingLevel: "off",
  });
  await session.setModel(modelRuntime.getModel("native-admission", "fixture"));
  await session.bindExtensions({ onError: (error) => errors.push(error) });
  return {
    session,
    api,
    calls,
    started,
    provider,
    consumed,
    consumption,
    errors,
    gate() {
      gateConsumption = true;
    },
    async close() {
      provider.release();
      consumption.release();
      await session.agent.waitForIdle();
      session.dispose();
    },
  };
}

const message = { customType: "admission-test", content: "EXACT_CONTROL", display: false };

for (const mode of ["steer", "followUp"]) {
  test(
    `public ${mode} rejection throws before acknowledgment or another provider call`,
    { timeout: 10000 },
    async () => {
      const f = await fixture();
      const run = f.session.prompt("INITIAL");
      await f.started.promise;
      const native = f.session.agent[mode];
      let rejections = 0;
      f.session.agent[mode] = () => {
        rejections++;
        throw new Error("Injected native rejection");
      };
      try {
        assert.equal(
          typeof f.api.enqueueMessage,
          "function",
          "packaged runtime must expose native admission",
        );
        assert.throws(
          () => f.api.enqueueMessage(message, { deliverAs: mode }),
          /Injected native rejection/,
        );
        assert.equal(rejections, 1);
        assert.equal(f.session.agent.hasQueuedMessages(), false);
        assert.equal(f.calls.length, 1);
        assert.deepEqual(
          f.errors,
          [],
          "rejection reaches caller, not a hidden runtime error callback",
        );
      } finally {
        f.session.agent[mode] = native;
        await f.close();
        await run;
      }
    },
  );

  test(
    `busy ${mode} acknowledgment precedes release and awaited consumption precedes next provider`,
    { timeout: 10000 },
    async () => {
      const f = await fixture();
      f.gate();
      const run = f.session.prompt("INITIAL");
      await f.started.promise;
      try {
        const before = Date.now();
        assert.deepEqual(f.api.enqueueMessage(message, { deliverAs: mode }), { status: "queued" });
        assert.ok(Date.now() - before < 5000);
        assert.equal(f.session.agent.hasQueuedMessages(), true);
        assert.equal(f.calls.length, 1);
        f.provider.release();
        await f.consumed.promise;
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(f.calls.length, 1, "message_start must finish before another provider starts");
        f.consumption.release();
        await run;
        assert.equal(f.calls.length, 2);
        assert.match(JSON.stringify(f.calls[1]), /EXACT_CONTROL/);
        assert.deepEqual(f.errors, []);
      } finally {
        await f.close();
        await run;
      }
    },
  );

  test(
    `idle ${mode} starts with the queued message, not an empty provider turn`,
    { timeout: 10000 },
    async () => {
      const f = await fixture();
      f.gate();
      try {
        assert.deepEqual(f.api.enqueueMessage(message, { deliverAs: mode }), { status: "queued" });
        await f.consumed.promise;
        assert.equal(f.calls.length, 0);
        f.consumption.release();
        await f.started.promise;
        assert.equal(f.calls.length, 1);
        assert.match(JSON.stringify(f.calls[0]), /EXACT_CONTROL/);
        assert.deepEqual(f.errors, []);
      } finally {
        await f.close();
      }
    },
  );
}

for (const mode of ["steer", "followUp"]) {
  test(
    `admission from agent_end continues the same session: ${mode}`,
    { timeout: 10000 },
    async () => {
      const f = await fixture();
      let admissions = 0;
      f.api.on("agent_end", () => {
        if (admissions++ === 0)
          assert.deepEqual(f.api.enqueueMessage(message, { deliverAs: mode }), {
            status: "queued",
          });
      });
      f.provider.release();
      try {
        await f.session.prompt("INITIAL");
        assert.equal(f.calls.length, 2);
        assert.match(JSON.stringify(f.calls[1]), /EXACT_CONTROL/);
        assert.equal(f.session.isIdle, true);
        assert.equal(f.session.agent.hasQueuedMessages(), false);
        assert.deepEqual(f.errors, []);
      } finally {
        await f.close();
      }
    },
  );
}

test(
  "idle compaction and branch-summary states reject before native insertion",
  { timeout: 10000 },
  async () => {
    const f = await fixture();
    try {
      for (const controller of [
        "_autoCompactionAbortController",
        "_compactionAbortController",
        "_branchSummaryAbortController",
      ]) {
        // Inject the actual session's three compaction-state discriminants.
        f.session[controller] = new AbortController();
        try {
          assert.equal(f.session.isCompacting, true);
          for (const mode of ["steer", "followUp"])
            assert.throws(
              () => f.api.enqueueMessage(message, { deliverAs: mode }),
              /idle compaction/,
            );
          assert.equal(f.calls.length, 0);
          assert.equal(f.session.agent.hasQueuedMessages(), false);
          assert.deepEqual(f.errors, []);
        } finally {
          f.session[controller] = undefined;
        }
      }
    } finally {
      await f.close();
    }
  },
);

test(
  "a later run failure is reported separately from successful native insertion",
  { timeout: 10000 },
  async () => {
    const f = await fixture();
    const prompt = f.session.agent.prompt;
    f.session.agent.prompt = async () => {
      throw new Error("Injected run startup failure");
    };
    try {
      assert.deepEqual(f.api.enqueueMessage(message), { status: "queued" });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        f.session.agent.hasQueuedMessages(),
        true,
        "the admitted message really entered the native queue",
      );
      assert.equal(f.calls.length, 0);
      assert.deepEqual(f.errors, [
        {
          extensionPath: "<runtime>",
          event: "enqueue_message_run",
          error: "Injected run startup failure",
        },
      ]);
    } finally {
      f.session.agent.prompt = prompt;
      await f.close();
    }
  },
);

test("idle native rejection cannot start a run", { timeout: 10000 }, async () => {
  const f = await fixture();
  const native = f.session.agent.steer;
  f.session.agent.steer = () => {
    throw new Error("Idle native rejection");
  };
  try {
    assert.throws(() => f.api.enqueueMessage(message), /Idle native rejection/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.calls.length, 0);
    assert.equal(f.session.isIdle, true);
    assert.equal(f.session.agent.hasQueuedMessages(), false);
  } finally {
    f.session.agent.steer = native;
    await f.close();
  }
});
