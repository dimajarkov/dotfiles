import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { SubagentOrchestrator, type ChildRecord, type CommandExecution } from "./orchestrator.ts";

async function scenario(t: TestContext, workScope?: string, monitor = false) {
  const directory = mkdtempSync(join(tmpdir(), "subagent-ownership-"));
  const session = join(directory, "child.jsonl");
  writeFileSync(session, `${JSON.stringify({
    type: "message", id: "result-1", parentId: null,
    message: { role: "assistant", content: [{ type: "text", text: "SAVED_FINDINGS" }], stopReason: "stop" },
  })}\n`);
  let nextChild = 0;
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
    agent: "pi", session, present: true,
    foreground: { pane_id: "w1:p9", shell_pid: 100, foreground_processes: [{ pid: 100, argv0: "zsh" }] },
  };
  const orchestrator = new SubagentOrchestrator({
    stateDirectory: directory,
    environment: { HERDR_ENV: "1", HERDR_SESSION: "session-a", HERDR_WORKSPACE_ID: "w1", HERDR_PANE_ID: "w1:p1" },
    id: () => `child-${++nextChild}`, monitor,
    onCompletion: async (child) => { delivered.push({ ...child }); return true; },
    transport: {
      async run(args, signal): Promise<CommandExecution> {
        calls.push([...args]);
        const command = args.slice(0, 2).join(" ");
        if (command === "agent get" && runtime.lookupError) {
          return { code: 1, stdout: "", stderr: runtime.lookupError };
        }
        if (monitor && command === "agent wait") {
          await new Promise<void>((resolve, reject) => {
            const cleanup = () => { pendingWaits.delete(finish); signal?.removeEventListener("abort", abort); };
            const finish = () => { cleanup(); resolve(); };
            const abort = () => { cleanup(); reject(new Error("aborted")); };
            pendingWaits.add(finish);
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
          });
        }
        let result: unknown;
        const agent = {
          pane_id: "w1:p9", agent_status: "done",
          agent_session: runtime.session ? { kind: "path", value: runtime.session } : undefined,
        };
        switch (command) {
          case "tab create":
            if (runtime.allocationError) return { code: 1, stdout: "", stderr: runtime.allocationError };
            result = { tab: { tab_id: "w1:t9" }, root_pane: { pane_id: "w1:p9" } }; break;
          case "tab get": result = { tab: { tab_id: "w1:t9", workspace_id: "w1" } }; break;
          case "pane list": result = { panes: [{ ...agent, tab_id: "w1:t9", workspace_id: "w1", agent: runtime.agent }] }; break;
          case "pane rename": result = { type: "ok" }; break;
          case "agent start":
          case "agent prompt":
          case "agent get":
          case "agent wait":
          case "agent send-keys":
          case "agent focus": result = { agent }; break;
          case "pane get":
            if (runtime.observationError || !runtime.present) return {
              code: 1, stdout: "", stderr: runtime.observationError ?? "pane_not_found",
            };
            result = { pane: { ...agent, workspace_id: "w1", agent: runtime.agent } }; break;
          case "pane process-info": result = { process_info: runtime.foreground }; break;
          case "pane close": runtime.present = false; result = { type: "ok" }; break;
          default: throw new Error(`Unexpected transport command: ${command}`);
        }
        return { code: 0, stdout: JSON.stringify({ result }), stderr: "" };
      },
    },
  });
  t.after(async () => { await orchestrator.shutdown(); rmSync(directory, { recursive: true, force: true }); });
  const child = await orchestrator.spawn({
    name: "owned", task: "Recon", cwd: directory, parentSessionId: "parent", workScope,
    agent: { name: "scout", description: "Scout", tools: ["read"], skillPaths: [], spawnTargets: [] },
  });
  writeFileSync(child.completionMarkerPath, JSON.stringify({
    version: 1, childId: child.id, generation: child.generation,
    stopReason: "stop", entryId: "result-1", sessionPath: session,
  }));
  calls.length = 0;
  return {
    orchestrator, runtime, calls, delivered, session, directory, pendingWaits, registry: dirname(child.completionMarkerPath),
    record: () => orchestrator.list("parent")[0]!,
    cancel: () => orchestrator.cancel("parent", "parent", "owned"),
  };
}

for (const operation of ["message", "cancel"]) {
  test(`a failed ${operation} preflight does not abandon completion monitoring`, { timeout: 5_000 }, async (t) => {
    const s = await scenario(t, undefined, true);
    assert.equal(s.pendingWaits.size, 1);
    const before = s.record();
    s.runtime.lookupError = "temporary agent lookup failure";
    await assert.rejects(operation === "message"
      ? s.orchestrator.message("parent", "parent", "owned", "CONTINUE")
      : s.cancel(), /temporary agent lookup failure/);
    assert.deepEqual(s.record(), before);
    assert.equal(s.pendingWaits.size, 1, "The live child still needs a completion observer");
    s.runtime.lookupError = undefined;
    for (const finish of s.pendingWaits) finish();
    while (s.record().surfaceState !== "closed") await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(s.delivered.length, 1);
    assert.equal(s.delivered[0]?.result, "SAVED_FINDINGS");
  });
}

for (const session of [undefined, "/tmp/replacement.jsonl"]) {
  test(`scope allocation rejects ${session ? "changed" : "unproven"} anchor occupancy before creating a surface`, async (t) => {
    const s = await scenario(t, "ownership");
    const before = s.record();
    s.runtime.session = session;
    await assert.rejects(s.orchestrator.spawn({
      name: "next-stage", task: "Review", cwd: s.directory, parentSessionId: "parent", workScope: "ownership",
      agent: { name: "reviewer", description: "Review", tools: ["read"], skillPaths: [], spawnTargets: [] },
    }), /occupant session (?:changed|is unproven)/);
    assert.deepEqual(s.record(), before);
    assert.deepEqual(s.calls.map((args) => args.slice(0, 2)), [["tab", "get"], ["pane", "list"]]);
    const rejected = s.orchestrator.list("parent").find((child) => child.semanticName === "next-stage");
    assert.equal(rejected?.state, "failed");
    assert.equal(rejected?.paneId, undefined);
  });
}

for (const operation of ["spawn", "message"]) {
  test(`${operation} reconciles a released claim after interrupted scope bookkeeping`, async (t) => {
    const s = await scenario(t, "ownership");
    const scopeFile = readdirSync(s.registry).find((entry) => entry.startsWith(".scope-") && entry.endsWith(".json"));
    assert.ok(scopeFile);
    const scopePath = join(s.registry, scopeFile);
    const savedScope = readFileSync(scopePath, "utf8");
    // Corrupt only this test's disposable scope file to interrupt post-release bookkeeping.
    writeFileSync(scopePath, "incomplete scope write");
    s.runtime.session = "/tmp/replacement.jsonl";
    await s.cancel();
    assert.equal(s.record().surfaceState, "released");
    assert.ok(s.record().cleanupError);
    writeFileSync(scopePath, savedScope);
    s.calls.length = 0;
    s.runtime.allocationError = "fresh managed tab requested";
    await assert.rejects(operation === "spawn" ? s.orchestrator.spawn({
      name: "next-stage", task: "Review", cwd: s.directory, parentSessionId: "parent", workScope: "ownership",
      agent: { name: "reviewer", description: "Review", tools: ["read"], skillPaths: [], spawnTargets: [] },
    }) : s.orchestrator.message("parent", "parent", "owned", "CONTINUE"), /fresh managed tab requested/);
    assert.deepEqual(JSON.parse(readFileSync(scopePath, "utf8")).ownedPaneIds, []);
    assert.deepEqual(mutations(s.calls), []);
    assert.equal(s.runtime.present, true);
    assert.match(readFileSync(s.session, "utf8"), /SAVED_FINDINGS/);
  });
}

function mutations(calls: string[][]): string[][] {
  return calls.filter(([kind, action]) =>
    (kind === "pane" && action === "close") ||
    (kind === "agent" && ["send-keys", "prompt", "focus"].includes(action!)));
}

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
  assert.equal((await s.orchestrator.inspect("parent", "parent", "owned")).surfaceState, "released");
  await assert.rejects(s.orchestrator.resume("parent", "parent", "owned"), /released.*message/);
  assert.deepEqual(s.calls, [], "Released ownership cannot be reclaimed after the replacement leaves");
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
  test(`follow-up and focus reject a ${agent} replacement before mutation`, async (t) => {
    const s = await scenario(t);
    s.runtime.agent = agent;
    s.runtime.session = "/tmp/new-occupant.jsonl";
    const before = s.record();
    await assert.rejects(s.orchestrator.message("parent", "parent", "owned", "PRIVATE_FOLLOW_UP"), /session artifact changed/);
    await assert.rejects(s.orchestrator.resume("parent", "parent", "owned"), /session artifact changed/);
    assert.deepEqual(s.record(), before);
    assert.deepEqual(mutations(s.calls), []);
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
  ["original empty shell", { pane_id: "w1:p9", shell_pid: 100, foreground_processes: [{ pid: 100, argv0: "zsh" }] }, "closed"],
  ["foreign command", { pane_id: "w1:p9", shell_pid: 100, foreground_processes: [{ pid: 200, argv0: "vim" }] }, "released"],
  ["unreported Pi", { pane_id: "w1:p9", shell_pid: 100, foreground_processes: [{ pid: 200, argv0: "pi", name: "node" }] }, "cleanup-pending"],
  ["malformed process observation", { pane_id: "w1:p9" }, "cleanup-pending"],
  ["unidentified foreground command", { pane_id: "w1:p9", shell_pid: 100, foreground_processes: [{ pid: 200 }] }, "cleanup-pending"],
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
