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
        timer = setTimeout(() => reject(new Error("Lifecycle control blocked on queued completion")), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function scenario() {
  const directory = mkdtempSync(join(tmpdir(), "subagent-lifecycle-"));
  const session = join(directory, "child.jsonl");
  const parentSession = join(directory, "parent.jsonl");
  writeFileSync(parentSession, "");
  writeFileSync(session, `${JSON.stringify({
    type: "message", id: "result-1", parentId: null,
    message: { role: "assistant", content: [{ type: "text", text: "SAVED_SCOUT_FINDINGS" }], stopReason: "stop" },
  })}\n`);
  mkdirSync(join(directory, "parent"));
  writeFileSync(join(directory, "parent", "child-1.generation-1.complete"), JSON.stringify({
    version: 1, childId: "child-1", generation: 1, stopReason: "stop", entryId: "result-1", sessionPath: session,
  }));
  const branch: unknown[] = [];
  const queued: unknown[] = [];
  const controller = new AbortController();
  let resolveQueued!: () => void;
  const completionQueued = new Promise<void>((resolve) => { resolveQueued = resolve; });
  const delivery = new CompletionDelivery({
    getBranch: () => branch,
    appendEntry: (customType, data) => { branch.push({ type: "custom", customType, data }); },
    sendMessage: (message) => { queued.push(message); resolveQueued(); },
    signal: controller.signal,
  });
  let generation = 0;
  const orchestrator = new SubagentOrchestrator({
    stateDirectory: directory,
    environment: { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_TAB_ID: "w1:t1", HERDR_PANE_ID: "w1:p1" },
    id: () => "child-1",
    transport: {
      async run(args, signal): Promise<CommandExecution> {
        let result: unknown;
        if (args[0] === "pane" && args[1] === "current") {
          result = { pane: {
            pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent: "pi",
            agent_session: { kind: "path", value: parentSession },
          } };
        } else if (args[0] === "pane" && args[1] === "layout") {
          result = {
            layout: {
              tab_id: "w1:t1", workspace_id: "w1",
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
          result = { pane: {
            pane_id: `w1:p${generation + 1}`, tab_id: "w1:t1", workspace_id: "w1", agent: "pi",
            agent_session: { kind: "path", value: session },
          } };
        } else if (args[0] === "agent") {
          if (args[1] === "wait" && generation > 1) {
            return new Promise((_resolve, reject) => {
              if (signal?.aborted) reject(new Error("aborted"));
              else signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            });
          }
          result = { agent: {
            name: "scout-scout-child1", pane_id: `w1:p${generation + 1}`, agent_status: "done",
            agent_session: { kind: "path", value: session },
          } };
        } else {
          throw new Error(`Unexpected Herdr command: ${args.join(" ")}`);
        }
        return { code: 0, stdout: JSON.stringify({ result }), stderr: "" };
      },
    },
    onCompletion: async (child) => delivery.deliver(child),
  });
  return {
    orchestrator, branch, queued, completionQueued, session,
    spawn: () => orchestrator.spawn({
      name: "scout", task: "Recon", cwd: directory, parentSessionId: "parent",
      agent: { name: "scout", description: "Scout", tools: ["read"], skillPaths: [], spawnTargets: [] },
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

test("message can reactivate a completed child before the parent consumes its queued result", async () => {
  const s = scenario();
  try {
    await s.spawn();
    await within(s.completionQueued);
    const child = await within(s.orchestrator.message("parent", "parent", "scout", "Continue the investigation"));
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
