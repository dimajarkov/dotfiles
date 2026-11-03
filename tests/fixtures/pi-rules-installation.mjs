// Native Pi lifecycle regression: no live model, credentials, terminal UI, or package installation.
// PI_TEST_PACKAGES points to Pi's installed packages directory; PI_RULES_PACKAGE_DIR selects the candidate.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
assert.ok(
  process.env.PI_TEST_PACKAGES,
  "set PI_TEST_PACKAGES to the installed Pi packages directory",
);
const packageDir = resolve(
  process.env.PI_RULES_PACKAGE_DIR ?? join(homedir(), ".pi/agent/packages/pi-claude-rules"),
);
const manifest = JSON.parse(
  await readFile(join(packageDir, "package.json"), "utf8").catch((error) => {
    throw new Error(
      `Cannot read candidate at ${packageDir}; set PI_RULES_PACKAGE_DIR to an installed pi-claude-rules package directory.`,
      { cause: error },
    );
  }),
);
assert.equal(manifest.name, "@jordyvanvorselen/pi-claude-rules");
const config = await readFile(join(root, "home/.pi/agent/claude-rules.json"), "utf8");
assert.equal(JSON.parse(config).ruleLoading, "hybrid");
const temp = await mkdtemp(join(tmpdir(), "pi-rules-lifecycle-"));
const originalCwd = process.cwd();
const originalFetch = globalThis.fetch;
const savedEnv = Object.fromEntries(
  ["HOME", "PI_CODING_AGENT_DIR", "PI_OFFLINE"].map((key) => [key, process.env[key]]),
);
const failures = [];
const always = "# Universal fixture rule\nPreserve provenance.\nDo not invent evidence.";
const scoped =
  '# Scoped fixture rule\nUse "deliberate" changes.\nPreserve literal backslashes: C:\\workspace\\rules.';
const userRule =
  "# User discovery fixture rule\nKeep user instructions available.\nApply them only to user-scoped files.";
const compatibilityRule =
  "# Claude compatibility fixture rule\nKeep legacy discovery working.\nPreserve this complete multiline body.";
const revised = "# Reloaded fixture rule\nReview the new instructions.\nKeep both lines intact.";
const texts = (value) => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(texts);
  if (value && typeof value === "object") return Object.values(value).flatMap(texts);
  return [];
};
const count = (context, body) =>
  texts(context.messages).reduce((total, text) => total + text.split(body).length - 1, 0);
const has = (context, body, expected = 1) =>
  assert.equal(
    count(context, body),
    expected,
    `provider context must contain full multiline body ${expected} time(s): ${body}`,
  );
const toolResults = (context) =>
  context.messages.filter((message) => message.role === "toolResult");
let callId = 0;
const call = (name, args) => ({
  type: "toolCall",
  id: `fixture-${++callId}`,
  name,
  arguments: args,
});
const edit = (path) => call("edit", { path, oldText: "before", newText: "after" });

try {
  process.env.HOME = join(temp, "home");
  process.env.PI_CODING_AGENT_DIR = join(temp, "agent");
  process.env.PI_OFFLINE = "1";
  await mkdir(join(process.env.HOME, ".agents/rules"), { recursive: true });
  await writeFile(
    join(process.env.HOME, ".agents/rules/user.md"),
    `---\npaths:\n  - "user-scoped/**"\n---\n${userRule}\n`,
  );
  await mkdir(process.env.PI_CODING_AGENT_DIR);
  await writeFile(join(process.env.PI_CODING_AGENT_DIR, "claude-rules.json"), config);
  process.chdir(temp);
  globalThis.fetch = () => {
    throw new Error("fixture forbids external traffic");
  };
  const sdk = await import(
    pathToFileURL(join(process.env.PI_TEST_PACKAGES, "coding-agent/dist/index.js"))
  );
  const ai = await import(pathToFileURL(join(process.env.PI_TEST_PACKAGES, "ai/dist/index.js")));
  const runtime = await sdk.ModelRuntime.create({
    authPath: join(temp, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(temp, "models-store.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  let script = [];
  let providerFailure;
  runtime.registerProvider("rules-fixture", {
    api: "rules-fixture",
    apiKey: "local-fixture-not-a-credential",
    baseUrl: "http://fixture.invalid",
    models: [
      {
        id: "script",
        name: "Script",
        reasoning: false,
        input: ["text"],
        contextWindow: 100000,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model, context) {
      const stream = ai.createAssistantMessageEventStream();
      queueMicrotask(async () => {
        try {
          assert.ok(script.length, "unexpected provider request");
          const content = await script.shift()(context);
          const message = {
            role: "assistant",
            api: model.api,
            provider: model.provider,
            model: model.id,
            timestamp: Date.now(),
            content: content ?? [{ type: "text", text: "Fixture complete." }],
            stopReason: content?.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
            usage: {
              input: 10,
              output: 10,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 20,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          };
          stream.push({ type: "start", partial: message });
          for (const [contentIndex, block] of message.content.entries()) {
            if (block.type === "toolCall") {
              stream.push({ type: "toolcall_start", contentIndex, partial: message });
              stream.push({
                type: "toolcall_end",
                contentIndex,
                toolCall: block,
                partial: message,
              });
            } else {
              stream.push({ type: "text_start", contentIndex, partial: message });
              stream.push({
                type: "text_delta",
                contentIndex,
                delta: block.text,
                partial: message,
              });
              stream.push({
                type: "text_end",
                contentIndex,
                content: block.text,
                partial: message,
              });
            }
          }
          stream.push({ type: "done", reason: message.stopReason, message });
          stream.end();
        } catch (error) {
          providerFailure = error;
          stream.push({
            type: "error",
            reason: "error",
            error: {
              role: "assistant",
              api: model.api,
              provider: model.provider,
              model: model.id,
              timestamp: Date.now(),
              content: [],
              stopReason: "error",
              errorMessage: String(error),
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            },
          });
          stream.end();
        }
      });
      return stream;
    },
  });
  const model = runtime.getModel("rules-fixture", "script");
  assert.ok(model);

  async function run(
    session,
    steps,
    action = () => session.prompt("Perform the scripted fixture operation."),
  ) {
    script = [...steps];
    providerFailure = undefined;
    const result = await action();
    if (providerFailure) throw providerFailure;
    assert.equal(script.length, 0, "all scripted provider requests must occur");
    return result;
  }
  async function open(cwd, manager = sdk.SessionManager.create(cwd, join(temp, "sessions"))) {
    const settingsManager = sdk.SettingsManager.inMemory({
      packages: [],
      compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 1024 },
      retry: { enabled: false },
    });
    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd,
      agentDir: process.env.PI_CODING_AGENT_DIR,
      settingsManager,
      additionalExtensionPaths: [packageDir],
      noContextFiles: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    assert.equal(
      resourceLoader.getExtensions().extensions.length,
      1,
      "only the installed candidate must load",
    );
    const { session } = await sdk.createAgentSession({
      cwd,
      agentDir: process.env.PI_CODING_AGENT_DIR,
      modelRuntime: runtime,
      model,
      thinkingLevel: "off",
      resourceLoader,
      settingsManager,
      sessionManager: manager,
      tools: ["read", "edit", "write"],
    });
    await session.bindExtensions({
      onError: (error) => {
        failures.push(`extension error: ${JSON.stringify(error)}`);
      },
    });
    return session;
  }
  async function fixture(name, test, prepare = async () => {}) {
    const cwd = join(temp, name);
    await mkdir(join(cwd, ".agents/rules"), { recursive: true });
    await mkdir(join(cwd, "scoped"));
    await writeFile(
      join(cwd, ".agents/rules/always.md"),
      `---\nalwaysApply: true\n---\n${always}\n`,
    );
    await writeFile(
      join(cwd, ".agents/rules/scoped.md"),
      `---\npaths:\n  - "scoped/**"\n---\n${scoped}\n`,
    );
    await writeFile(join(cwd, "scoped/existing.txt"), "before\n");
    await writeFile(join(cwd, "unrelated.txt"), "unrelated\n");
    const sessions = [];
    const start = async (manager) => {
      const session = await open(cwd, manager);
      sessions.push(session);
      return session;
    };
    try {
      await prepare(cwd);
      await test({ cwd, session: await start(), start });
      console.log(`PASS: ${name}`);
    } catch (error) {
      failures.push(`${name}: ${error.stack ?? error}`);
      console.error(`FAIL: ${name}: ${error.message}`);
    } finally {
      for (const session of sessions) session.dispose();
    }
  }

  await fixture("unconditional-and-unrelated", async ({ session, cwd }) => {
    await run(session, [
      (context) => {
        has(context, always);
        has(context, scoped, 0);
        return [call("read", { path: "unrelated.txt" })];
      },
      (context) => {
        has(context, always);
        has(context, scoped, 0);
        assert.match(texts(toolResults(context).at(-1)).join("\n"), /unrelated/);
      },
    ]);
    assert.equal(await readFile(join(cwd, "unrelated.txt"), "utf8"), "unrelated\n");
  });
  await fixture(
    "user-agents-rules-discovery",
    async ({ session }) => {
      await run(session, [
        (context) => {
          has(context, userRule, 0);
          return [call("read", { path: "unrelated.txt" })];
        },
        (context) => {
          has(context, userRule, 0);
          return [call("read", { path: "user-scoped/existing.txt" })];
        },
        (context) => {
          has(context, userRule);
          assert.equal(toolResults(context).at(-1).isError, false);
          assert.match(
            texts(toolResults(context).at(-1).content).join("\n"),
            /user discovery target/,
          );
        },
      ]);
    },
    async (cwd) => {
      await mkdir(join(cwd, "user-scoped"));
      await writeFile(join(cwd, "user-scoped/existing.txt"), "user discovery target\n");
    },
  );
  await fixture(
    "claude-rules-compatibility",
    async ({ session }) => {
      await run(session, [
        (context) => {
          has(context, compatibilityRule, 0);
          return [call("read", { path: "compat/existing.txt" })];
        },
        (context) => {
          has(context, compatibilityRule);
          assert.equal(toolResults(context).at(-1).isError, false);
          assert.match(
            texts(toolResults(context).at(-1).content).join("\n"),
            /compatibility target/,
          );
        },
      ]);
    },
    async (cwd) => {
      await mkdir(join(cwd, ".claude/rules"), { recursive: true });
      await writeFile(
        join(cwd, ".claude/rules/compat.md"),
        `---\npaths:\n  - "compat/**"\n---\n${compatibilityRule}\n`,
      );
      await mkdir(join(cwd, "compat"));
      await writeFile(join(cwd, "compat/existing.txt"), "compatibility target\n");
    },
  );
  await fixture("missing-read-delivers-rules", async ({ session, cwd }) => {
    await run(session, [
      (context) => {
        has(context, scoped, 0);
        return [call("read", { path: "scoped/missing.txt" })];
      },
      async (context) => {
        has(context, scoped);
        assert.equal(toolResults(context).at(-1).isError, true);
        await assert.rejects(readFile(join(cwd, "scoped/missing.txt")), { code: "ENOENT" });
      },
    ]);
  });
  await fixture("read-then-edit", async ({ session, cwd }) => {
    await run(session, [
      (context) => {
        has(context, scoped, 0);
        return [call("read", { path: "scoped/existing.txt" })];
      },
      async (context) => {
        has(context, scoped);
        assert.match(texts(toolResults(context).at(-1)).join("\n"), /before/);
        assert.equal(await readFile(join(cwd, "scoped/existing.txt"), "utf8"), "before\n");
        return [edit("scoped/existing.txt")];
      },
      async (context) => {
        has(context, scoped);
        assert.equal(toolResults(context).at(-1).isError, false);
        assert.equal(await readFile(join(cwd, "scoped/existing.txt"), "utf8"), "after\n");
      },
    ]);
  });
  for (const name of ["edit", "write"])
    await fixture(`direct-blocked-${name}`, async ({ session, cwd }) => {
      const path = name === "edit" ? "scoped/existing.txt" : "scoped/fresh.txt";
      const operation = () =>
        name === "edit" ? edit(path) : call("write", { path, content: "after\n" });
      await run(session, [
        (context) => {
          has(context, scoped, 0);
          return [operation()];
        },
        async (context) => {
          has(context, scoped);
          const result = toolResults(context).at(-1);
          assert.equal(result.isError, true);
          assert.match(texts(result.content).join("\n"), /Mutation blocked/);
          if (name === "edit") assert.equal(await readFile(join(cwd, path), "utf8"), "before\n");
          else await assert.rejects(readFile(join(cwd, path)), { code: "ENOENT" });
          return [operation()];
        },
        async (context) => {
          has(context, scoped);
          assert.equal(toolResults(context).at(-1).isError, false);
          assert.equal(await readFile(join(cwd, path), "utf8"), "after\n");
        },
      ]);
    });
  await fixture("same-batch-read-edit", async ({ session, cwd }) => {
    await run(session, [
      () => [call("read", { path: "scoped/existing.txt" }), edit("scoped/existing.txt")],
      async (context) => {
        const results = toolResults(context);
        assert.equal(results.find((result) => result.toolName === "read").isError, false);
        const blocked = results.find((result) => result.toolName === "edit");
        assert.equal(blocked.isError, true);
        assert.match(texts(blocked).join("\n"), /Mutation blocked/);
        // Both read and block may carry the rule in this batch; neither permits an early mutation.
        assert.ok(count(context, scoped) >= 1);
        assert.equal(await readFile(join(cwd, "scoped/existing.txt"), "utf8"), "before\n");
        return [edit("scoped/existing.txt")];
      },
      async (context) => {
        assert.equal(toolResults(context).at(-1).isError, false);
        assert.equal(await readFile(join(cwd, "scoped/existing.txt"), "utf8"), "after\n");
      },
    ]);
  });
  await fixture("resume-retained-multiline-no-duplicate", async ({ session, start }) => {
    await run(session, [
      () => [call("read", { path: "scoped/existing.txt" })],
      (context) => {
        has(context, scoped);
      },
    ]);
    const file = session.sessionManager.getSessionFile();
    assert.ok(file, "session must be persisted for real resume");
    session.dispose();
    const resumed = await start(sdk.SessionManager.open(file));
    await run(resumed, [
      (context) => {
        has(context, scoped);
        return [call("read", { path: "scoped/existing.txt" })];
      },
      (context) => {
        has(context, scoped);
      },
    ]);
  });
  await fixture("compaction-removal-and-reinjection", async ({ session }) => {
    await run(session, [
      () => [call("read", { path: "scoped/existing.txt" })],
      (context) => {
        has(context, scoped);
      },
    ]);
    // A later turn lets native compaction drop the earlier read and its rule body.
    await run(session, [() => [{ type: "text", text: "A later turn containing no rule body." }]]);
    await run(
      session,
      [
        () => [{ type: "text", text: "Compacted fixture history; no rule bodies retained." }],
        () => [{ type: "text", text: "Latest turn summary; no rule bodies retained." }],
      ],
      () => session.compact("Summarize without quoting any rule bodies."),
    );
    await run(session, [
      (context) => {
        has(context, scoped, 0);
        has(context, always);
        return [call("read", { path: "scoped/existing.txt" })];
      },
      (context) => {
        has(context, scoped);
      },
    ]);
  });
  await fixture("slash-reload", async ({ session, cwd }) => {
    await run(session, [
      () => [call("read", { path: "scoped/existing.txt" })],
      (context) => {
        has(context, scoped);
      },
    ]);
    await writeFile(
      join(cwd, ".agents/rules/scoped.md"),
      `---\npaths:\n  - "scoped/**"\n---\n${revised}\n`,
    );
    await run(session, [], () => session.prompt("/claude-rules-reload"));
    await run(session, [
      (context) => {
        has(context, revised, 0);
        return [call("read", { path: "scoped/existing.txt" })];
      },
      (context) => {
        has(context, revised);
      },
    ]);
  });
  console.log(`Candidate: ${manifest.name}@${manifest.version} (${packageDir})`);
  if (failures.length) {
    console.error(failures.join("\n\n"));
    process.exitCode = 1;
  } else console.log("PASS: all native Pi rules lifecycle checks");
} finally {
  process.chdir(originalCwd);
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(temp, { recursive: true, force: true });
}
