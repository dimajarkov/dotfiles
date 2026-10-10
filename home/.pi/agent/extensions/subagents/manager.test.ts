/**
 * End-to-end smoke tests: manager behavior through a real ManagedRuntime,
 * exactly as the tool handlers drive it. The registry is test-only: scripted
 * stub sessions registered under the claude/codex names (the production
 * backends launch real processes and have their own live test files), plus
 * the real pi backend for its cheap registry precondition.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect, Layer, ManagedRuntime, Scope, Stream } from "effect";
import {
  BackendRegistry,
  type ScopedSubagentBackend,
  type SubagentBackend,
  type SubagentSession,
} from "./src/backend.ts";
import { piBackend } from "./src/backends/pi.ts";
import { makeStubBackend } from "./src/backends/stub.ts";
import {
  SpawnError,
  type BackendName,
  type ParentContext,
  type SpawnTask,
  type SubagentMeta,
} from "./src/domain.ts";
import {
  SubagentManager,
  SubagentManagerLive,
  type SubagentManagerShape,
} from "./src/manager.ts";
import { adaptScopedBackend } from "./src/lifecycle.ts";
import { runTool } from "./src/runtime.ts";
import { compatibilityTerminalAttachment } from "./src/ui/terminal-attachment.ts";

const TestRegistryLive = Layer.sync(BackendRegistry, () => {
  const backends: ScopedSubagentBackend[] = [
    piBackend,
    makeStubBackend({
      backend: "claude",
      defaultModelLabel: "claude/sonnet",
      contextWindow: 200_000,
      toolName: "Bash",
      cadenceMs: 40,
    }),
    makeStubBackend({
      backend: "codex",
      defaultModelLabel: "codex/gpt-5-codex",
      contextWindow: 272_000,
      toolName: "shell",
      cadenceMs: 30,
    }),
  ];
  const managedBackends = backends.map(adaptScopedBackend);
  return new Map<BackendName, SubagentBackend>(
    managedBackends.map((backend) => [backend.name, backend]),
  );
});

const createTestRuntime = () =>
  ManagedRuntime.make(
    SubagentManagerLive.pipe(Layer.provide(TestRegistryLive)),
  );

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: false,
};

function task(prompt: string): SpawnTask {
  return { prompt, title: "test", cwd: process.cwd(), parent };
}

async function withManager(
  run: (
    manager: SubagentManagerShape,
    runtime: ReturnType<typeof createTestRuntime>,
  ) => Promise<void>,
) {
  const runtime = createTestRuntime();
  try {
    const manager = await runtime.runPromise(SubagentManager);
    await run(manager, runtime);
  } finally {
    await runtime.dispose();
  }
}

test("runtime shutdown waits for an in-flight scoped child acquisition", async () => {
  let announceStarted!: () => void;
  let releaseAcquisition!: () => void;
  const started = new Promise<void>((resolve) => {
    announceStarted = resolve;
  });
  const acquisitionGate = new Promise<void>((resolve) => {
    releaseAcquisition = resolve;
  });
  let scopeReleases = 0;
  const delayedBackend: ScopedSubagentBackend = {
    name: "claude",
    capabilities: {
      steering: true,
      modelSelection: true,
      reasoningEffort: true,
    },
    available: Effect.succeed(true),
    spawn: () =>
      Effect.gen(function* () {
        announceStarted();
        yield* Effect.promise(() => acquisitionGate);
        const childScope = yield* Scope.Scope;
        yield* Scope.addFinalizer(
          childScope,
          Effect.sync(() => {
            scopeReleases++;
          }),
        );
        return {
          meta: Effect.succeed({ backend: "claude" }),
          events: Stream.empty,
          send: () => Effect.void,
          interrupt: Effect.void,
        } satisfies SubagentSession;
      }),
  };
  const Registry = Layer.sync(
    BackendRegistry,
    () => {
      const backend = adaptScopedBackend(delayedBackend);
      return new Map([[backend.name, backend]]);
    },
  );
  const runtime = ManagedRuntime.make(
    SubagentManagerLive.pipe(Layer.provide(Registry)),
  );

  try {
    const manager = await runtime.runPromise(SubagentManager);
    const spawning = runTool(runtime, manager.spawn("claude", task("delayed")));
    await started;

    let shutdownReturned = false;
    const shuttingDown = runTool(runtime, manager.disposeAll).then(() => {
      shutdownReturned = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const returnedBeforeAcquisitionFinished = shutdownReturned;

    releaseAcquisition();
    await shuttingDown;
    await assert.rejects(spawning);

    assert.equal(
      returnedBeforeAcquisitionFinished,
      false,
      "shutdown must join pending ownership acquisition before returning",
    );
    assert.equal(scopeReleases, 1, "the compatibility scope must close once");
  } finally {
    releaseAcquisition();
    await runtime.dispose();
  }
});

test("shutdown stops a managed child whose metadata acquisition is pending", async () => {
  let announceMetaStarted!: () => void;
  let releaseMeta!: (meta: SubagentMeta) => void;
  const metaStarted = new Promise<void>((resolve) => {
    announceMetaStarted = resolve;
  });
  const metaGate = new Promise<SubagentMeta>((resolve) => {
    releaseMeta = resolve;
  });
  let stops = 0;
  const backend: SubagentBackend = {
    name: "claude",
    capabilities: {
      steering: true,
      modelSelection: true,
      reasoningEffort: true,
    },
    available: Effect.succeed(true),
    spawn: () =>
      Effect.succeed({
        conversation: {
          id: "metadata-pending-conversation",
          meta: Effect.promise(() => {
            announceMetaStarted();
            return metaGate;
          }),
        },
        execution: {
          send: () => Effect.void,
          interrupt: Effect.void,
          stop: Effect.sync(() => {
            stops++;
          }),
        },
        management: { events: Stream.empty },
      }),
  };
  const Registry = Layer.sync(
    BackendRegistry,
    () => new Map<BackendName, SubagentBackend>([[backend.name, backend]]),
  );
  const runtime = ManagedRuntime.make(
    SubagentManagerLive.pipe(Layer.provide(Registry)),
  );

  try {
    const manager = await runtime.runPromise(SubagentManager);
    const spawning = runTool(
      runtime,
      manager.spawn("claude", task("metadata pending")),
    );
    await metaStarted;

    let shutdownReturned = false;
    const shutdown = runTool(runtime, manager.disposeAll).then(() => {
      shutdownReturned = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(shutdownReturned, false);

    releaseMeta({ backend: "claude" });
    await shutdown;
    await assert.rejects(spawning, /shut down while spawning/);
    assert.equal(stops, 1);
  } finally {
    releaseMeta({ backend: "claude" });
    await runtime.dispose();
  }
});

test("scoped adapter releases partial resources after a failed spawn", async () => {
  let releases = 0;
  const backend: ScopedSubagentBackend = {
    name: "claude",
    capabilities: {
      steering: true,
      modelSelection: true,
      reasoningEffort: true,
    },
    available: Effect.succeed(true),
    spawn: () =>
      Effect.gen(function* () {
        const scope = yield* Scope.Scope;
        yield* Scope.addFinalizer(scope, Effect.sync(() => releases++));
        return yield* new SpawnError({ message: "mock acquisition failed" });
      }),
  };
  const managedBackend = adaptScopedBackend(backend);
  const Registry = Layer.sync(
    BackendRegistry,
    () =>
      new Map<BackendName, SubagentBackend>([
        [managedBackend.name, managedBackend],
      ]),
  );
  const runtime = ManagedRuntime.make(
    SubagentManagerLive.pipe(Layer.provide(Registry)),
  );

  try {
    const manager = await runtime.runPromise(SubagentManager);
    await assert.rejects(
      runTool(runtime, manager.spawn("claude", task("failed acquisition"))),
      /mock acquisition failed/,
    );
    assert.equal(releases, 1);
  } finally {
    await runtime.dispose();
  }
});

test("manager accepts an execution owner without a compatibility scope", async () => {
  let stopped = 0;
  const backend: SubagentBackend = {
    name: "claude",
    capabilities: {
      steering: true,
      modelSelection: true,
      reasoningEffort: true,
    },
    available: Effect.succeed(true),
    spawn: () =>
      Effect.succeed({
        conversation: {
          id: "independently-owned-conversation",
          meta: Effect.succeed({ backend: "claude" }),
        },
        execution: {
          send: () => Effect.void,
          interrupt: Effect.void,
          stop: Effect.sync(() => {
            stopped++;
          }),
        },
        management: {
          events: Stream.make(
            { _tag: "RunStarted" },
            {
              _tag: "RunSettled",
              outcome: { _tag: "Completed", finalText: "managed result" },
            },
          ),
        },
      }),
  };
  const Registry = Layer.sync(
    BackendRegistry,
    () => new Map<BackendName, SubagentBackend>([[backend.name, backend]]),
  );
  const runtime = ManagedRuntime.make(
    SubagentManagerLive.pipe(Layer.provide(Registry)),
  );

  try {
    const manager = await runtime.runPromise(SubagentManager);
    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("direct ownership")),
    );
    await runTool(runtime, manager.waitFor([snap.id]));
    assert.equal(manager.view.get(snap.id)?.finalText, "managed result");

    await runTool(runtime, manager.disposeAll);
    assert.equal(stopped, 1, "manager shutdown releases the execution owner");
  } finally {
    await runtime.dispose();
  }
});

test("stub subagent completes and delivers a final result", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("Say hello to the tests")),
    );
    assert.equal(snap.status, "running");
    assert.equal(snap.backend, "claude");
    assert.ok(snap.meta.sessionFilePath);

    await runTool(runtime, manager.waitFor([snap.id]));
    const done = manager.view.get(snap.id);
    assert.ok(done);
    assert.equal(done.status, "done");
    assert.match(
      done.finalText,
      /\[stub:claude\] completed: Say hello to the tests/,
    );
    assert.ok(done.turns >= 2);
    assert.ok(done.transcript.some((item) => item.kind === "toolResult"));
    // The waitFor marked the settle as consumed.
    assert.deepEqual(settled, [{ id: snap.id, consumed: true }]);
  });
});

test("closing the terminal attachment leaves child execution running", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("Finish after the dashboard closes")),
    );
    const ctx = {
      ui: {
        custom: (createComponent: (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: (result: null) => void,
        ) => {
          handleInput(data: string): void;
          dispose(): void;
        }) =>
          new Promise<null>((resolve) => {
            const component = createComponent(
              { requestRender() {}, terminal: { rows: 24 } },
              {},
              {
                matches: (data: string, binding: string) =>
                  data === "escape" && binding === "tui.select.cancel",
              },
              resolve,
            );
            component.handleInput("escape");
            component.dispose();
          }),
      },
    } as unknown as ExtensionContext;

    await compatibilityTerminalAttachment.openTakeover(
      ctx,
      manager.view,
      snap.id,
    );
    assert.equal(manager.view.get(snap.id)?.status, "running");

    await runTool(runtime, manager.waitFor([snap.id]));
    assert.equal(manager.view.get(snap.id)?.status, "done");
  });
});

test("FAIL: prompts settle as errors; unconsumed settles are delivered", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn("codex", task("FAIL: blow up please")),
    );
    // Poll without wait-interest so the settle is delivered unconsumed.
    while (manager.view.get(snap.id)?.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const failed = manager.view.get(snap.id);
    assert.equal(failed?.status, "error");
    assert.match(failed?.errorText ?? "", /task failed/);
    assert.deepEqual(settled, [{ id: snap.id, consumed: false }]);
  });
});

test("cancel interrupts a running stub subagent", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("Long running task")),
    );
    const report = await runTool(runtime, manager.cancel([snap.id]));
    assert.deepEqual(report, [
      { id: snap.id, title: "test", status: "error", cancelled: true },
    ]);
    assert.equal(manager.view.get(snap.id)?.errorText, "Run was aborted");
  });
});

test("aborting a wait releases interest without cancelling the child", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("Long running task")),
    );
    const controller = new AbortController();
    const waiting = runTool(runtime, manager.waitFor([snap.id]), {
      signal: controller.signal,
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    controller.abort();
    await assert.rejects(waiting, /Operation was aborted/);
    assert.equal(manager.view.get(snap.id)?.status, "running");

    const report = await runTool(runtime, manager.cancel([snap.id]));
    assert.equal(report[0]?.cancelled, true);
  });
});

test("spawn origin propagates to ids, snapshots, and settlement", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; origin: string }> = [];
    manager.view.setOnSettled((snap) =>
      settled.push({ id: snap.id, origin: snap.origin }),
    );

    const model = await runTool(
      runtime,
      manager.spawn("codex", task("model task")),
    );
    const btw = await runTool(
      runtime,
      manager.spawn("claude", { ...task("side question"), origin: "btw" }),
    );

    assert.match(model.id, /^sa-/);
    assert.equal(model.origin, "model");
    assert.match(btw.id, /^btw-/);
    assert.equal(btw.origin, "btw");

    await runTool(runtime, manager.cancel([model.id, btw.id]));
    assert.deepEqual(
      settled.sort((a, b) => a.id.localeCompare(b.id)),
      [
        { id: btw.id, origin: "btw" },
        { id: model.id, origin: "model" },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });
});

test("the global concurrency cap includes by-the-way sessions", async () => {
  await withManager(async (manager, runtime) => {
    const tasks: SpawnTask[] = [
      { ...task("side question"), origin: "btw" },
      task("Task 2"),
      task("Task 3"),
      task("Task 4"),
    ];
    const spawns = await runTool(
      runtime,
      Effect.forEach(tasks, (spawnTask) => manager.spawn("codex", spawnTask), {
        concurrency: "unbounded",
      }),
    );
    assert.equal(spawns.length, 4);
    await assert.rejects(
      runTool(
        runtime,
        manager.spawn("codex", {
          ...task("another side question"),
          origin: "btw",
        }),
      ),
      /Max 4 subagents/,
    );
  });
});

test("the concurrency cap rejects a fifth running subagent", async () => {
  await withManager(async (manager, runtime) => {
    const spawns = await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4],
        (n) => manager.spawn("codex", task(`Task ${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    assert.equal(spawns.length, 4);
    await assert.rejects(
      runTool(runtime, manager.spawn("codex", task("Task 5"))),
      /Max 4 subagents/,
    );
  });
});

test("pi spawn fails fast without the parent model registry", async () => {
  await withManager(async (manager, runtime) => {
    await assert.rejects(
      runTool(runtime, manager.spawn("pi", task("needs a registry"))),
      /model registry/,
    );
    // The failed spawn must release its concurrency reservation.
    const snap = await runTool(runtime, manager.spawn("codex", task("ok")));
    assert.equal(snap.backend, "codex");
  });
});

test("idle restarts respect the concurrency cap", async () => {
  await withManager(async (manager, runtime) => {
    // Settle one subagent, then fill all four slots with running ones.
    const settled = await runTool(
      runtime,
      manager.spawn("claude", task("early finisher")),
    );
    await runTool(runtime, manager.waitFor([settled.id]));
    await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4],
        (n) => manager.spawn("codex", task(`Task ${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    // Restarting the settled one would be a fifth concurrent run.
    await assert.rejects(
      runTool(runtime, manager.send(settled.id, "go again")),
      /Max 4 subagents/,
    );
    assert.equal(manager.view.get(settled.id)?.status, "done");
  });
});

test("send steers an idle subagent into another turn", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("First turn")),
    );
    await runTool(runtime, manager.waitFor([snap.id]));
    const afterFirst = manager.view.get(snap.id);
    assert.equal(afterFirst?.status, "done");

    await runTool(runtime, manager.send(snap.id, "Second turn"));
    // The fresh run flips the status back to running...
    while (manager.view.get(snap.id)?.status !== "running") {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await runTool(runtime, manager.waitFor([snap.id]));
    const afterSecond = manager.view.get(snap.id);
    assert.equal(afterSecond?.status, "done");
    assert.match(afterSecond?.finalText ?? "", /Second turn/);
  });
});
