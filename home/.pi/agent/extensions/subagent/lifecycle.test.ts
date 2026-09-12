import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CompletionDelivery } from "./completion-delivery.ts";
import { SubagentOrchestrator, type CommandExecution } from "./orchestrator.ts";

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Lifecycle control blocked on queued completion")),
          1_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

interface ScenarioOptions {
  result?: string;
  stopReason?: "stop" | "error";
  errorMessage?: string;
  monitor?: boolean;
  agentStatus?: "working" | "done";
  markerInitially?: boolean;
  markerOnGet?: boolean;
}

function scenario(options: ScenarioOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "subagent-lifecycle-"));
  const session = join(directory, "child.jsonl");
  const parentSession = join(directory, "parent.jsonl");
  const result = options.result ?? "SAVED_SCOUT_FINDINGS";
  const stopReason = options.stopReason ?? "stop";
  writeFileSync(parentSession, "");
  writeFileSync(
    session,
    `${JSON.stringify({
      type: "message",
      id: "result-1",
      parentId: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: result }],
        stopReason,
        ...(options.errorMessage === undefined ? {} : { errorMessage: options.errorMessage }),
      },
    })}\n`,
  );
  const registry = join(directory, "parent");
  const markerPath = join(registry, "child-1.generation-1.complete");
  mkdirSync(registry);
  const publishMarker = () =>
    writeFileSync(
      markerPath,
      JSON.stringify({
        version: 1,
        childId: "child-1",
        generation: 1,
        stopReason,
        entryId: "result-1",
        sessionPath: session,
      }),
    );
  if (options.markerInitially !== false) publishMarker();
  const branch: unknown[] = [];
  const queued: unknown[] = [];
  const events: string[] = [];
  const controller = new AbortController();
  let resolveQueued!: () => void;
  const completionQueued = new Promise<void>((resolve) => {
    resolveQueued = resolve;
  });
  const delivery = new CompletionDelivery({
    getBranch: () => branch,
    appendEntry: (customType, data) => {
      branch.push({ type: "custom", customType, data });
    },
    sendMessage: (message) => {
      queued.push(message);
      resolveQueued();
    },
    signal: controller.signal,
  });
  let generation = 0;
  let markerPublishedOnGet = false;
  const orchestrator = new SubagentOrchestrator({
    stateDirectory: directory,
    environment: {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_TAB_ID: "w1:t1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    transport: {
      async run(args, signal): Promise<CommandExecution> {
        let result: unknown;
        if (args[0] === "pane" && args[1] === "current") {
          result = {
            pane: {
              pane_id: "w1:p1",
              tab_id: "w1:t1",
              workspace_id: "w1",
              agent: "pi",
              agent_session: { kind: "path", value: parentSession },
            },
          };
        } else if (args[0] === "pane" && args[1] === "layout") {
          result = {
            layout: {
              tab_id: "w1:t1",
              workspace_id: "w1",
              panes: [
                { pane_id: "w1:p1", rect: { width: 120, height: 60 } },
                ...(generation > 0
                  ? [{ pane_id: `w1:p${generation + 1}`, rect: { width: 120, height: 60 } }]
                  : []),
              ],
            },
          };
        } else if (args[0] === "pane" && args[1] === "split") {
          generation += 1;
          result = { pane: { pane_id: `w1:p${generation + 1}`, tab_id: "w1:t1" } };
        } else if (args[0] === "pane") {
          result = {
            pane: {
              pane_id: `w1:p${generation + 1}`,
              tab_id: "w1:t1",
              workspace_id: "w1",
              agent: "pi",
              agent_session: { kind: "path", value: session },
            },
          };
        } else if (args[0] === "agent") {
          if (args[1] === "prompt") events.push(`prompt:${generation}`);
          if (args[1] === "send-keys") events.push(`send-keys:${generation}`);
          if (args[1] === "get" && options.markerOnGet && !markerPublishedOnGet) {
            markerPublishedOnGet = true;
            await new Promise<void>((resolve) => setImmediate(resolve));
            publishMarker();
          }
          if (args[1] === "wait" && generation > 1) {
            return new Promise((_resolve, reject) => {
              if (signal?.aborted) reject(new Error("aborted"));
              else
                signal?.addEventListener("abort", () => reject(new Error("aborted")), {
                  once: true,
                });
            });
          }
          result = {
            agent: {
              name: "scout-scout-child1",
              pane_id: `w1:p${generation + 1}`,
              agent_status: options.agentStatus ?? "done",
              agent_session: { kind: "path", value: session },
            },
          };
        } else {
          throw new Error(`Unexpected Herdr command: ${args.join(" ")}`);
        }
        return { code: 0, stdout: JSON.stringify({ result }), stderr: "" };
      },
    },
    monitor: options.monitor,
    onCompletion: async (child) => {
      events.push(`delivery:${child.generation}`);
      return delivery.deliver(child);
    },
  });
  return {
    orchestrator,
    branch,
    queued,
    completionQueued,
    session,
    events,
    spawn: () =>
      orchestrator.spawn({
        name: "scout",
        task: "Recon",
        cwd: directory,
        parentSessionId: "parent",
        agent: {
          name: "scout",
          description: "Scout",
          tools: ["read"],
          skillPaths: [],
          spawnTargets: [],
        },
      }),
    async close() {
      controller.abort();
      await orchestrator.shutdown();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("shutdown does not wait for the parent to consume a saved completion", async () => {
  const s = scenario();
  try {
    await s.spawn();
    await within(s.completionQueued);
    await within(s.orchestrator.shutdown());
    assert.match(JSON.stringify(s.branch), /SAVED_SCOUT_FINDINGS/);
  } finally {
    await s.close();
  }
});

test("cancelling an already completed child returns promptly and preserves its queued findings", async () => {
  const s = scenario();
  try {
    await s.spawn();
    await within(s.completionQueued);
    const child = await within(s.orchestrator.cancel("parent", "parent", "scout"));
    assert.equal(child.state, "completed");
    assert.equal(child.result, "SAVED_SCOUT_FINDINGS");
    assert.equal(child.surfaceState, "closed");
    assert.equal(s.queued.length, 1);
  } finally {
    await s.close();
  }
});

test("cancel reconciles proven failure before sending input or clearing exact output", async () => {
  const result = "PARTIAL \n\t";
  const s = scenario({
    result,
    stopReason: "error",
    errorMessage: "EXACT_FAILURE",
    monitor: false,
  });
  try {
    await s.spawn();

    const child = await within(s.orchestrator.cancel("parent", "parent", "scout"));

    assert.equal(child.state, "failed");
    assert.equal(child.result, result);
    assert.equal(child.error, "EXACT_FAILURE");
    assert.deepEqual(
      s.events.filter((event) => event.startsWith("delivery:")),
      ["delivery:1"],
    );
    assert.equal(
      s.events.some((event) => event.startsWith("send-keys:")),
      false,
    );
    assert.equal(s.queued.length, 1);
  } finally {
    await s.close();
  }
});

test("recovery reconciles proven completion despite stale working status", async () => {
  const s = scenario({ monitor: false, agentStatus: "working" });
  try {
    await s.spawn();

    const [child] = await s.orchestrator.recover("parent", "parent");

    assert.equal(child?.state, "completed");
    assert.equal(child?.result, "SAVED_SCOUT_FINDINGS");
    assert.equal(child?.surfaceState, "closed");
    assert.deepEqual(
      s.events.filter((event) => event.startsWith("delivery:")),
      ["delivery:1"],
    );
    assert.equal(s.queued.length, 1);
  } finally {
    await s.close();
  }
});

test("message can reactivate a completed child before the parent consumes its queued result", async () => {
  const s = scenario();
  try {
    await s.spawn();
    await within(s.completionQueued);
    const child = await within(
      s.orchestrator.message("parent", "parent", "scout", "Continue the investigation"),
    );
    assert.equal(child.state, "working");
    assert.equal(child.generation, 2);
    assert.equal(child.sessionPath, s.session);
    assert.equal(s.queued.length, 1);
    assert.match(readFileSync(s.session, "utf8"), /SAVED_SCOUT_FINDINGS/);
    assert.match(JSON.stringify(s.branch), /SAVED_SCOUT_FINDINGS/);
  } finally {
    await s.close();
  }
});

for (const [label, result] of [
  ["empty", ""],
  ["whitespace", " \n\t"],
] as const) {
  test(`message reconciles a settled ${label} result before prompting a fresh generation`, async () => {
    const s = scenario({ result, monitor: false });
    try {
      const spawned = await s.spawn();
      assert.equal(spawned.state, "working");
      assert.equal(spawned.generation, 1);

      const child = await within(
        s.orchestrator.message("parent", "parent", "scout", "Continue the investigation"),
      );

      assert.equal(child.state, "working");
      assert.equal(child.generation, 2);
      assert.equal(s.queued.length, 1);
      const completion = s.queued[0] as {
        details: { runId: string; result?: string; error?: string };
      };
      assert.equal(completion.details.runId, "child-1:1");
      assert.equal(completion.details.result, result);
      assert.equal(completion.details.error, undefined);
      assert.deepEqual(
        s.events.filter((event) => event.startsWith("delivery:")),
        ["delivery:1"],
      );
      assert.ok(s.events.indexOf("delivery:1") < s.events.indexOf("prompt:2"));
    } finally {
      await s.close();
    }
  });
}

test("message delivers a settled error once before prompting a fresh generation", async () => {
  const s = scenario({
    result: "PARTIAL_RESULT",
    stopReason: "error",
    errorMessage: "CHILD_FAILURE",
    monitor: false,
  });
  try {
    await s.spawn();

    const child = await within(
      s.orchestrator.message("parent", "parent", "scout", "Try a different approach"),
    );

    assert.equal(child.state, "working");
    assert.equal(child.generation, 2);
    assert.equal(s.queued.length, 1);
    const completion = s.queued[0] as {
      details: { runId: string; state: string; result?: string; error?: string };
    };
    assert.deepEqual(completion.details, {
      completionDataVersion: 1,
      childId: "child-1",
      runId: "child-1:1",
      semanticName: "scout",
      role: "scout",
      state: "failed",
      workScope: undefined,
      model: undefined,
      thinking: undefined,
      paneId: "w1:p2",
      sessionPath: s.session,
      result: "PARTIAL_RESULT",
      error: "CHILD_FAILURE",
    });
    assert.deepEqual(
      s.events.filter((event) => event.startsWith("delivery:")),
      ["delivery:1"],
    );
    assert.ok(s.events.indexOf("delivery:1") < s.events.indexOf("prompt:2"));
  } finally {
    await s.close();
  }
});

test("message reconciles current completion proof while Herdr still reports working", async () => {
  const s = scenario({ monitor: false, agentStatus: "working" });
  try {
    await s.spawn();

    const child = await within(
      s.orchestrator.message("parent", "parent", "scout", "Continue after completion"),
    );

    assert.equal(child.generation, 2);
    assert.equal(s.queued.length, 1);
    assert.deepEqual(
      s.events.filter((event) => event.startsWith("delivery:")),
      ["delivery:1"],
    );
    assert.ok(s.events.indexOf("delivery:1") < s.events.indexOf("prompt:2"));
  } finally {
    await s.close();
  }
});

test("message catches completion proof published during asynchronous preflight", async () => {
  const s = scenario({
    monitor: false,
    agentStatus: "working",
    markerInitially: false,
    markerOnGet: true,
  });
  try {
    await s.spawn();

    const child = await within(
      s.orchestrator.message("parent", "parent", "scout", "Continue after preflight"),
    );

    assert.equal(child.generation, 2);
    assert.equal(s.queued.length, 1);
    assert.deepEqual(
      s.events.filter((event) => event.startsWith("delivery:")),
      ["delivery:1"],
    );
    assert.ok(s.events.indexOf("delivery:1") < s.events.indexOf("prompt:2"));
  } finally {
    await s.close();
  }
});
