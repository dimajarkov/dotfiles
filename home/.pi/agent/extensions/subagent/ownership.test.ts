import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { childControlRequestFromPrompt, completionSettlementAt } from "./completion-protocol.ts";
import { SubagentOrchestrator, type ChildRecord, type CommandExecution } from "./orchestrator.ts";

async function scenario(
  t: TestContext,
  workScope?: string,
  monitor = false,
  markerInitially = true,
) {
  const directory = mkdtempSync(join(tmpdir(), "subagent-ownership-"));
  const session = join(directory, "child.jsonl");
  const parentSession = join(directory, "parent.jsonl");
  writeFileSync(parentSession, "");
  const savedSession = `${JSON.stringify({
    type: "message",
    id: "result-1",
    parentId: null,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "SAVED_FINDINGS" }],
      stopReason: "stop",
    },
  })}\n`;
  writeFileSync(
    session,
    markerInitially
      ? savedSession
      : `${JSON.stringify({ type: "session", version: 3, id: "session", cwd: directory })}\n`,
  );
  let nextChild = 0;
  let allocated = false;
  const pendingWaits = new Set<() => void>();
  const calls: string[][] = [];
  const delivered: ChildRecord[] = [];
  const runtime: {
    agent?: string;
    session?: string;
    present: boolean;
    foreground: unknown;
    observationError?: string;
    allocationError?: string;
    lookupError?: string;
  } = {
    agent: "pi",
    session,
    present: true,
    foreground: {
      pane_id: "w1:p9",
      shell_pid: 100,
      foreground_processes: [{ pid: 100, argv0: "zsh" }],
    },
  };
  const orchestrator = new SubagentOrchestrator({
    stateDirectory: directory,
    environment: {
      HERDR_ENV: "1",
      HERDR_SESSION: "session-a",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_TAB_ID: "w1:t1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => `child-${++nextChild}`,
    monitor,
    onCompletion: async (child) => {
      delivered.push({ ...child });
      return true;
    },
    transport: {
      async run(args, signal): Promise<CommandExecution> {
        calls.push([...args]);
        const command = args.slice(0, 2).join(" ");
        let result: unknown;
        if (command === "agent get" && runtime.lookupError) {
          return { code: 1, stdout: "", stderr: runtime.lookupError };
        }
        if (monitor && command === "agent wait") {
          await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
              pendingWaits.delete(finish);
              signal?.removeEventListener("abort", abort);
            };
            const finish = () => {
              cleanup();
              resolve();
            };
            const abort = () => {
              cleanup();
              reject(new Error("aborted"));
            };
            pendingWaits.add(finish);
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
          });
        }
        const agent = {
          pane_id: "w1:p9",
          agent_status: "done",
          agent_session: runtime.session ? { kind: "path", value: runtime.session } : undefined,
        };
        switch (command) {
          case "pane current":
            result = {
              pane: {
                pane_id: "w1:p1",
                tab_id: "w1:t1",
                workspace_id: "w1",
                agent: "pi",
                agent_session: { kind: "path", value: parentSession },
              },
            };
            break;
          case "pane layout":
            result = {
              layout: {
                tab_id: "w1:t1",
                workspace_id: "w1",
                panes: [
                  { pane_id: "w1:p1", rect: { width: 120, height: 60 } },
                  ...(allocated ? [{ pane_id: "w1:p9", rect: { width: 120, height: 60 } }] : []),
                ],
              },
            };
            break;
          case "pane split":
            if (runtime.allocationError)
              return { code: 1, stdout: "", stderr: runtime.allocationError };
            allocated = true;
            result = { pane: { pane_id: "w1:p9", tab_id: "w1:t1" } };
            break;
          case "tab get":
            result = { tab: { tab_id: "w1:t1", workspace_id: "w1" } };
            break;
          case "pane list":
            result = {
              panes: [{ ...agent, tab_id: "w1:t1", workspace_id: "w1", agent: runtime.agent }],
            };
            break;
          case "pane rename":
            result = { type: "ok" };
            break;
          case "agent start":
          case "agent prompt":
          case "agent get":
          case "agent wait":
          case "agent send-keys":
          case "agent focus":
            result = { agent };
            break;
          case "pane get":
            if (runtime.observationError || !runtime.present)
              return {
                code: 1,
                stdout: "",
                stderr: runtime.observationError ?? "pane_not_found",
              };
            result = {
              pane: { ...agent, tab_id: "w1:t1", workspace_id: "w1", agent: runtime.agent },
            };
            break;
          case "pane process-info":
            result = { process_info: runtime.foreground };
            break;
          case "pane close":
            runtime.present = false;
            result = { type: "ok" };
            break;
          default:
            throw new Error(`Unexpected transport command: ${command}`);
        }
        const control =
          command === "agent prompt" ? childControlRequestFromPrompt(args[3] ?? "") : undefined;
        if (control) {
          const settlement = completionSettlementAt(
            control.receiptPath.slice(0, -".control".length),
          );
          writeFileSync(
            control.receiptPath,
            `${JSON.stringify({
              version: 1,
              childId: control.childId,
              generation: control.generation,
              nonce: control.nonce,
              action: control.action,
              status: settlement?.phase === "candidate" ? "settling" : "accepted",
              sessionPath: session,
              ...(settlement?.phase === "running" && settlement.frontierEntryId
                ? { frontierEntryId: settlement.frontierEntryId }
                : {}),
            })}\n`,
          );
        }
        return { code: 0, stdout: JSON.stringify({ result }), stderr: "" };
      },
    },
  });
  t.after(async () => {
    await orchestrator.shutdown();
    rmSync(directory, { recursive: true, force: true });
  });
  const child = await orchestrator.spawn({
    name: "owned",
    task: "Recon",
    cwd: directory,
    parentSessionId: "parent",
    workScope,
    agent: {
      name: "scout",
      description: "Scout",
      tools: ["read"],
      skillPaths: [],
      spawnTargets: [],
    },
  });
  const publishMarker = () => {
    writeFileSync(session, savedSession);
    writeFileSync(
      child.completionMarkerPath,
      JSON.stringify({
        version: 1,
        childId: child.id,
        generation: child.generation,
        stopReason: "stop",
        entryId: "result-1",
        sessionPath: session,
      }),
    );
  };
  if (markerInitially) publishMarker();
  calls.length = 0;
  return {
    orchestrator,
    runtime,
    calls,
    delivered,
    session,
    directory,
    pendingWaits,
    publishMarker,
    registry: dirname(child.completionMarkerPath),
    record: () => orchestrator.list("parent")[0]!,
    cancel: () => orchestrator.cancel("parent", "parent", "owned"),
  };
}

for (const operation of ["message", "cancel"]) {
  test(
    `a failed ${operation} preflight does not abandon completion monitoring`,
    { timeout: 5_000 },
    async (t) => {
      const s = await scenario(t, undefined, true, false);
      assert.equal(s.pendingWaits.size, 1);
      const before = s.record();
      s.runtime.lookupError = "temporary agent lookup failure";
      await assert.rejects(
        operation === "message"
          ? s.orchestrator.message("parent", "parent", "owned", "CONTINUE")
          : s.cancel(),
        /temporary agent lookup failure/,
      );
      assert.deepEqual(s.record(), before);
      assert.equal(s.pendingWaits.size, 1, "The live child still needs a completion observer");
      s.runtime.lookupError = undefined;
      s.publishMarker();
      for (const finish of s.pendingWaits) finish();
      while (s.record().surfaceState !== "closed")
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(s.delivered.length, 1);
      assert.equal(s.delivered[0]?.result, "SAVED_FINDINGS");
    },
  );
}

function mutations(calls: string[][]): string[][] {
  return calls.filter(
    ([kind, action]) =>
      (kind === "pane" && action === "close") ||
      (kind === "agent" && ["send-keys", "prompt", "focus"].includes(action!)),
  );
}

test("read-only inspect does not stop an outstanding completion monitor", async (t) => {
  const s = await scenario(t, undefined, true);
  assert.equal(s.pendingWaits.size, 1);
  const before = s.record();

  await s.orchestrator.inspect("parent", "parent", "owned");

  assert.equal(s.record().revision, before.revision);
  for (const finish of s.pendingWaits) finish();
  for (let attempt = 0; attempt < 100 && s.record().state !== "completed"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(s.record().state, "completed");
  assert.equal(s.record().result, "SAVED_FINDINGS");
  assert.equal(s.delivered.length, 1);
  assert.deepEqual(mutations(s.calls), [["pane", "close", "w1:p9"]]);
});

test("monitor reconciles proven completion before validating replaced runtime", async (t) => {
  const s = await scenario(t, undefined, true);
  assert.equal(s.pendingWaits.size, 1);
  s.runtime.session = "/tmp/replacement.jsonl";

  for (const finish of s.pendingWaits) finish();
  for (let attempt = 0; attempt < 100 && s.record().state !== "completed"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(s.record().state, "completed");
  assert.equal(s.record().result, "SAVED_FINDINGS");
  assert.equal(s.delivered.length, 1);
  assert.equal(
    s.calls.some(([kind, action]) => kind === "agent" && action === "get"),
    false,
  );
  assert.deepEqual(mutations(s.calls), []);
});

test("recovery reconciles proven completion before validating replaced runtime", async (t) => {
  const s = await scenario(t);
  s.runtime.session = "/tmp/replacement.jsonl";

  await s.orchestrator.recover("parent", "parent");

  assert.equal(s.record().state, "completed");
  assert.equal(s.record().result, "SAVED_FINDINGS");
  assert.equal(s.record().surfaceState, "released");
  assert.equal(s.delivered.length, 1);
  assert.equal(
    s.calls.some(([kind, action]) => kind === "agent" && action === "get"),
    false,
  );
  assert.deepEqual(mutations(s.calls), []);
});

test("active cancellation observes a replacement before input and preserves proven original findings", async (t) => {
  const s = await scenario(t);
  const before = readFileSync(s.session, "utf8");
  s.runtime.session = "/tmp/replacement.jsonl";
  const cancelled = await s.cancel();
  assert.equal(cancelled.state, "completed");
  assert.equal(cancelled.result, "SAVED_FINDINGS");
  assert.equal(cancelled.surfaceState, "released");
  assert.equal(typeof cancelled.deliveredAt, "number");
  assert.equal(s.runtime.present, true);
  assert.deepEqual(mutations(s.calls), []);
  assert.equal(s.delivered.length, 1);
  assert.equal(readFileSync(s.session, "utf8"), before);

  s.runtime.agent = undefined;
  s.runtime.session = undefined;
  s.calls.length = 0;
  await s.cancel();
  await s.orchestrator.recover("parent", "parent");
  assert.equal(
    (await s.orchestrator.inspect("parent", "parent", "owned")).surfaceState,
    "released",
  );
  const resumed = await s.orchestrator.resume("parent", "parent", "owned");
  assert.equal(resumed.action, "reconciled");
  assert.equal(resumed.child.surfaceState, "released");
  assert.deepEqual(
    s.calls,
    [],
    "Released ownership cannot be reclaimed after the replacement leaves",
  );
  assert.equal(s.delivered.length, 1);
});

test("recovery retries cleanup-pending without closing a replacement or losing its delivered result", async (t) => {
  const s = await scenario(t);
  s.runtime.observationError = "temporary socket failure";
  await s.orchestrator.recover("parent", "parent");
  assert.equal(s.record().state, "completed");
  assert.equal(s.record().surfaceState, "cleanup-pending");
  assert.equal(s.delivered.length, 1);
  assert.deepEqual(mutations(s.calls), []);
  s.runtime.observationError = undefined;
  s.runtime.session = "/tmp/new-occupant.jsonl";
  await s.orchestrator.recover("parent", "parent");
  assert.equal(s.record().surfaceState, "released");
  assert.equal(s.record().result, "SAVED_FINDINGS");
  assert.equal(s.delivered.length, 1);
  assert.deepEqual(mutations(s.calls), []);
});

for (const agent of ["pi", "claude"]) {
  test(`follow-up and focus preserve a ${agent} replacement surface`, async (t) => {
    const followUp = await scenario(t);
    followUp.runtime.agent = agent;
    followUp.runtime.session = "/tmp/new-occupant.jsonl";
    await assert.rejects(
      followUp.orchestrator.message("parent", "parent", "owned", "PRIVATE_FOLLOW_UP"),
      /different session artifact/,
    );
    assert.equal(followUp.runtime.present, true);
    assert.equal(followUp.delivered.length, 1);
    assert.equal(followUp.delivered[0]?.result, "SAVED_FINDINGS");
    assert.deepEqual(mutations(followUp.calls), []);

    const focus = await scenario(t);
    focus.runtime.agent = agent;
    focus.runtime.session = "/tmp/new-occupant.jsonl";
    const resumed = await focus.orchestrator.resume("parent", "parent", "owned");
    assert.equal(resumed.action, "reconciled");
    assert.equal(resumed.child.state, "completed");
    assert.equal(resumed.child.result, "SAVED_FINDINGS");
    assert.equal(resumed.child.surfaceState, "released");
    assert.equal(focus.runtime.present, true);
    assert.equal(focus.delivered.length, 1);
    assert.deepEqual(mutations(focus.calls), []);
  });
}

test("unidentified Pi occupancy stays cleanup-pending until its original session is proven", async (t) => {
  const s = await scenario(t);
  s.runtime.observationError = "temporary socket failure";
  await s.orchestrator.recover("parent", "parent");
  s.runtime.observationError = undefined;
  s.runtime.session = undefined;
  await s.cancel();
  assert.equal(s.record().surfaceState, "cleanup-pending");
  assert.match(s.record().cleanupError ?? "", /unproven/);
  assert.deepEqual(mutations(s.calls), []);
  s.runtime.session = s.session;
  await s.cancel();
  assert.equal(s.record().surfaceState, "closed");
  assert.deepEqual(mutations(s.calls), [["pane", "close", "w1:p9"]]);
});

for (const [description, foreground, expected] of [
  [
    "original empty shell",
    { pane_id: "w1:p9", shell_pid: 100, foreground_processes: [{ pid: 100, argv0: "zsh" }] },
    "closed",
  ],
  [
    "foreign command",
    { pane_id: "w1:p9", shell_pid: 100, foreground_processes: [{ pid: 200, argv0: "vim" }] },
    "released",
  ],
  [
    "unreported Pi",
    {
      pane_id: "w1:p9",
      shell_pid: 100,
      foreground_processes: [{ pid: 200, argv0: "pi", name: "node" }],
    },
    "cleanup-pending",
  ],
  ["malformed process observation", { pane_id: "w1:p9" }, "cleanup-pending"],
  [
    "unidentified foreground command",
    { pane_id: "w1:p9", shell_pid: 100, foreground_processes: [{ pid: 200 }] },
    "cleanup-pending",
  ],
] as const) {
  test(`cleanup handles ${description} without guessing ownership`, async (t) => {
    const s = await scenario(t);
    s.runtime.observationError = "temporary socket failure";
    await s.orchestrator.recover("parent", "parent");
    s.runtime.observationError = undefined;
    s.runtime.agent = undefined;
    s.runtime.session = undefined;
    s.runtime.foreground = foreground;
    await s.cancel();
    assert.equal(s.record().surfaceState, expected);
    assert.deepEqual(mutations(s.calls), expected === "closed" ? [["pane", "close", "w1:p9"]] : []);
    assert.equal(s.record().result, "SAVED_FINDINGS");
  });
}
