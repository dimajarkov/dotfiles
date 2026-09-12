import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completionSettlementAt, registerChildCompletionProtocol } from "./completion-protocol.ts";
import { CompletionDelivery } from "./completion-delivery.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "herdr-completion-protocol-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function record(directory: string, value: Record<string, unknown>): void {
  writeFileSync(join(directory, `${value.id}.json`), `${JSON.stringify(value)}\n`);
}

function protocolHarness() {
  const registry = temporaryDirectory();
  const markerPath = join(registry, "child-1.generation-1.complete");
  record(registry, {
    id: "child-1",
    rootId: "root-1",
    parentId: "parent-1",
    generation: 1,
    state: "working",
  });
  let endHandler:
    | ((event: { messages: unknown[] }, ctx: ExtensionContext) => Promise<void>)
    | undefined;
  let settledHandler: ((event: unknown, ctx: ExtensionContext) => Promise<void>) | undefined;
  let beforeHandler: ((event: unknown, ctx: ExtensionContext) => Promise<void>) | undefined;
  let blockedHandler: ((event: { active: boolean }) => void) | undefined;
  const pi = {
    events: {
      on(event: string, candidate: typeof blockedHandler) {
        if (event === "herdr:blocked") blockedHandler = candidate;
      },
    },
    on(event: string, candidate: typeof endHandler | typeof settledHandler) {
      if (event === "before_agent_start") beforeHandler = candidate as typeof beforeHandler;
      if (event === "agent_end") endHandler = candidate as typeof endHandler;
      if (event === "agent_settled") settledHandler = candidate as typeof settledHandler;
    },
  } as unknown as ExtensionAPI;
  registerChildCompletionProtocol(pi, {
    HERDR_SUBAGENT_AGENT_ID: "child-1",
    HERDR_SUBAGENT_GENERATION: "1",
    HERDR_SUBAGENT_REGISTRY: registry,
    HERDR_SUBAGENT_COMPLETION_MARKER: markerPath,
  });
  assert.ok(endHandler);
  assert.ok(settledHandler);
  assert.ok(beforeHandler);
  let shutdowns = 0;
  const branch: unknown[] = [];
  const ctx = {
    hasPendingMessages: () => false,
    sessionManager: {
      getBranch: () => branch,
      getLeafId: () => "assistant-entry-2",
      getSessionFile: () => "/tmp/child-session.jsonl",
    },
    shutdown: () => {
      assert.ok(existsSync(markerPath), "marker must be durable before shutdown");
      shutdowns += 1;
    },
  } as unknown as ExtensionContext;
  return {
    registry,
    markerPath,
    branch,
    endHandler,
    settledHandler,
    beforeHandler,
    ctx,
    setBlocked(active: boolean) {
      assert.ok(blockedHandler);
      blockedHandler({ active });
    },
    shutdowns: () => shutdowns,
  };
}

test("agent_end captures the latest outcome but only agent_settled completes the child", async () => {
  const harness = protocolHarness();

  await harness.endHandler(
    {
      messages: [{ role: "assistant", content: [], stopReason: "error" }],
    },
    harness.ctx,
  );
  await harness.endHandler(
    {
      messages: [{ role: "assistant", content: [], stopReason: "stop" }],
    },
    harness.ctx,
  );

  assert.equal(existsSync(harness.markerPath), false);
  assert.equal(harness.shutdowns(), 0);
  assert.deepEqual(completionSettlementAt(harness.markerPath), {
    version: 1,
    childId: "child-1",
    generation: 1,
    phase: "candidate",
    stopReason: "stop",
    entryId: "assistant-entry-2",
    sessionPath: "/tmp/child-session.jsonl",
  });

  await harness.settledHandler({}, harness.ctx);

  assert.deepEqual(JSON.parse(readFileSync(harness.markerPath, "utf8")), {
    version: 1,
    childId: "child-1",
    generation: 1,
    stopReason: "stop",
    entryId: "assistant-entry-2",
    sessionPath: "/tmp/child-session.jsonl",
  });
  assert.equal(harness.shutdowns(), 1);
  assert.equal(existsSync(harness.registry), true);
});

test("a malformed sibling record cannot suppress settlement or completion", async () => {
  const harness = protocolHarness();
  writeFileSync(join(harness.registry, "malformed-sibling.json"), "{not-json\n");

  await harness.endHandler(
    {
      messages: [{ role: "assistant", content: [], stopReason: "stop" }],
    },
    harness.ctx,
  );

  assert.deepEqual(completionSettlementAt(harness.markerPath), {
    version: 1,
    childId: "child-1",
    generation: 1,
    phase: "candidate",
    stopReason: "stop",
    entryId: "assistant-entry-2",
    sessionPath: "/tmp/child-session.jsonl",
  });

  await harness.settledHandler({}, harness.ctx);

  assert.equal(existsSync(harness.markerPath), true);
  assert.equal(harness.shutdowns(), 1);
});

test("a claimed follow-up frontier cannot suppress a durable settlement candidate", async () => {
  const harness = protocolHarness();

  await harness.endHandler(
    {
      messages: [{ role: "assistant", content: [], stopReason: "stop" }],
    },
    harness.ctx,
  );
  record(harness.registry, {
    id: "child-1",
    rootId: "root-1",
    parentId: "parent-1",
    generation: 1,
    state: "starting",
    startedAfterEntryId: "assistant-entry-2",
  });

  await harness.settledHandler({}, harness.ctx);

  assert.equal(existsSync(harness.markerPath), true);
  assert.equal(harness.shutdowns(), 1);
});

test("a new agent turn supersedes an unpublished settlement candidate", async () => {
  const harness = protocolHarness();

  await harness.endHandler(
    {
      messages: [{ role: "assistant", content: [], stopReason: "stop" }],
    },
    harness.ctx,
  );
  await harness.beforeHandler({}, harness.ctx);
  await harness.settledHandler({}, harness.ctx);

  assert.deepEqual(completionSettlementAt(harness.markerPath), {
    version: 1,
    childId: "child-1",
    generation: 1,
    phase: "running",
    sessionPath: "/tmp/child-session.jsonl",
    frontierEntryId: "assistant-entry-2",
  });
  assert.equal(existsSync(harness.markerPath), false);
  assert.equal(harness.shutdowns(), 0);
});

test("a parent cancellation claim suppresses a late settled marker", async () => {
  const harness = protocolHarness();

  await harness.endHandler(
    {
      messages: [{ role: "assistant", content: [], stopReason: "stop" }],
    },
    harness.ctx,
  );
  record(harness.registry, {
    id: "child-1",
    rootId: "root-1",
    parentId: "parent-1",
    generation: 1,
    state: "cancelled",
  });

  await harness.settledHandler({}, harness.ctx);

  assert.equal(existsSync(harness.markerPath), false);
  assert.equal(harness.shutdowns(), 0);
});

test("aborted and blocked child runs retain their surfaces", async () => {
  for (const scenario of [
    { blocked: false, stopReason: "aborted" },
    { blocked: true, stopReason: "stop" },
  ]) {
    const harness = protocolHarness();
    harness.setBlocked(scenario.blocked);
    await harness.endHandler(
      {
        messages: [{ role: "assistant", content: [], stopReason: scenario.stopReason }],
      },
      harness.ctx,
    );
    await harness.settledHandler({}, harness.ctx);
    assert.equal(existsSync(harness.markerPath), false);
    assert.equal(harness.shutdowns(), 0);
  }
});

test("direct descendants suppress parent completion until delivered and cleaned", async () => {
  for (const descendant of [
    { state: "starting", deliveredAt: undefined, surfaceState: "open" },
    { state: "working", deliveredAt: undefined, surfaceState: "open" },
    { state: "blocked", deliveredAt: undefined, surfaceState: "open" },
    { state: "completed", deliveredAt: undefined, surfaceState: "closed" },
    { state: "completed", deliveredAt: undefined, surfaceState: "released" },
    { state: "completed", deliveredAt: 1_000, surfaceState: "cleanup-pending" },
  ]) {
    const harness = protocolHarness();
    record(harness.registry, {
      id: "grandchild-1",
      rootId: "root-1",
      parentId: "child-1",
      generation: 1,
      ...descendant,
    });

    await harness.endHandler(
      {
        messages: [{ role: "assistant", content: [], stopReason: "stop" }],
      },
      harness.ctx,
    );
    await harness.settledHandler({}, harness.ctx);

    assert.equal(existsSync(harness.markerPath), false, JSON.stringify(descendant));
    assert.equal(harness.shutdowns(), 0, JSON.stringify(descendant));
  }
});

test("delivered and cleaned terminal direct descendants permit parent completion", async () => {
  for (const { state, surfaceState } of [
    "completed",
    "failed",
    "cancelled",
    "crashed",
    "stale",
  ].flatMap((state) => ["closed", "released"].map((surfaceState) => ({ state, surfaceState })))) {
    const harness = protocolHarness();
    record(harness.registry, {
      id: "grandchild-1",
      rootId: "root-1",
      parentId: "child-1",
      generation: 1,
      state,
      deliveredAt: 1_000,
      surfaceState,
    });

    await harness.endHandler(
      {
        messages: [{ role: "assistant", content: [], stopReason: "stop" }],
      },
      harness.ctx,
    );
    await harness.settledHandler({}, harness.ctx);

    assert.equal(existsSync(harness.markerPath), true, state);
    assert.equal(harness.shutdowns(), 1, state);
  }
});

test("a durable but unconsumed completion prevents parent exit even when Pi reports no pending messages", async () => {
  const h = protocolHarness();
  let queued: unknown;
  const delivery = new CompletionDelivery({
    getBranch: () => h.branch,
    appendEntry: (customType, data) => {
      h.branch.push({ type: "custom", customType, data });
    },
    sendMessage: (message) => {
      queued = { type: "custom_message", ...message };
    },
    signal: new AbortController().signal,
  });
  delivery.deliver({
    id: "grandchild",
    generation: 1,
    semanticName: "scout",
    role: "scout",
    state: "completed",
    result: "DONE",
  });
  await h.endHandler({ messages: [{ role: "assistant", stopReason: "stop" }] }, h.ctx);
  await h.settledHandler({}, h.ctx);
  assert.equal(h.shutdowns(), 0);
  assert.equal(existsSync(h.markerPath), false);
  h.branch.push(queued);
  await h.settledHandler({}, h.ctx);
  assert.equal(h.shutdowns(), 1);
});

test("error child completion records its settled outcome and shuts down", async () => {
  const harness = protocolHarness();

  await harness.endHandler(
    {
      messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "boom" }],
    },
    harness.ctx,
  );
  await harness.settledHandler({}, harness.ctx);

  assert.equal(JSON.parse(readFileSync(harness.markerPath, "utf8")).stopReason, "error");
  assert.equal(harness.shutdowns(), 1);
});
