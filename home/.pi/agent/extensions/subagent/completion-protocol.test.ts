import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  childControlPrompt,
  childControlReceiptAt,
  childControlReceiptPath,
  completionSettlementPath,
  completionSettlementAt,
  finalAssistantResult,
  registerChildCompletionProtocol,
} from "./completion-protocol.ts";
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

function protocolHarness(
  options: {
    rejectQueue?: boolean;
    afterQueue?: () => void;
    legacyQueue?: boolean;
    missingAcknowledgment?: boolean;
  } = {},
) {
  const registry = temporaryDirectory();
  const markerPath = join(registry, "child-1.generation-1.complete");
  const sessionPath = join(registry, "child-session.jsonl");
  writeFileSync(
    sessionPath,
    `${JSON.stringify({ type: "session", version: 3, id: "session", cwd: "/work" })}\n`,
  );
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
  let inputHandler:
    | ((
        event: { text: string },
        ctx: ExtensionContext,
      ) =>
        | { action: string; text?: string }
        | Promise<{ action: string; text?: string } | undefined>
        | undefined)
    | undefined;
  let messageStartHandler: ((event: unknown, ctx: ExtensionContext) => void) | undefined;
  let blockedHandler: ((event: { active: boolean }) => void) | undefined;
  const queuedMessages: unknown[] = [];
  const pi = {
    events: {
      on(event: string, candidate: typeof blockedHandler) {
        if (event === "herdr:blocked") blockedHandler = candidate;
      },
    },
    sendMessage: () => {
      assert.fail("Private admission must not fall back to void sendMessage");
    },
    enqueueMessage: options.legacyQueue
      ? undefined
      : (message: unknown) => {
          if (options.rejectQueue) throw new Error("Private message queue rejected admission");
          queuedMessages.push(message);
          options.afterQueue?.();
          return options.missingAcknowledgment ? undefined : { status: "queued" };
        },
    on(event: string, candidate: typeof endHandler | typeof settledHandler | typeof inputHandler) {
      if (event === "input") inputHandler = candidate as typeof inputHandler;
      if (event === "message_start") messageStartHandler = candidate as typeof messageStartHandler;
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
  assert.ok(inputHandler);
  assert.ok(messageStartHandler);
  let shutdowns = 0;
  let aborts = 0;
  let leafId = "assistant-entry-2";
  let pendingMessages = false;
  const branch: unknown[] = [];
  const ctx = {
    hasPendingMessages: () => pendingMessages,
    sessionManager: {
      getBranch: () => branch,
      getLeafId: () => leafId,
      getSessionFile: () => sessionPath,
    },
    abort: () => {
      aborts += 1;
    },
    shutdown: () => {
      assert.ok(existsSync(markerPath), "marker must be durable before shutdown");
      shutdowns += 1;
    },
  } as unknown as ExtensionContext;
  return {
    registry,
    markerPath,
    sessionPath,
    branch,
    queuedMessages,
    endHandler,
    settledHandler,
    beforeHandler,
    inputHandler,
    messageStartHandler,
    ctx,
    setBlocked(active: boolean) {
      assert.ok(blockedHandler);
      blockedHandler({ active });
    },
    shutdowns: () => shutdowns,
    aborts: () => aborts,
    setLeafId(value: string) {
      leafId = value;
    },
    setPendingMessages(value: boolean) {
      pendingMessages = value;
    },
  };
}

for (const options of [{ legacyQueue: true }, { missingAcknowledgment: true }]) {
  test(`private input fails closed without explicit native admission: ${JSON.stringify(options)}`, async () => {
    const h = protocolHarness(options);
    const result = await h.inputHandler(
      {
        text: childControlPrompt({
          version: 1,
          childId: "child-1",
          generation: 1,
          nonce: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          action: "message",
          receiptPath: childControlReceiptPath(h.markerPath),
          message: "PRIVATE_CONTROL",
        }),
      },
      h.ctx,
    );
    assert.deepEqual(result, { action: "handled" });
    assert.equal(childControlReceiptAt(h.markerPath), undefined);
    const settlement = completionSettlementAt(h.markerPath);
    assert.equal(settlement?.phase, "running");
    assert.equal(
      settlement?.phase === "running" && settlement.pendingControls,
      options.missingAcknowledgment ? 1 : 0,
    );
    if (options.missingAcknowledgment) {
      await h.messageStartHandler(
        { message: { role: "custom", ...(h.queuedMessages[0] as object) } },
        h.ctx,
      );
      assert.equal(h.aborts(), 1);
    } else {
      assert.equal(h.queuedMessages.length, 0);
    }
    assert.equal(existsSync(h.markerPath), false);
  });
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
    sessionPath: harness.sessionPath,
  });

  await harness.settledHandler({}, harness.ctx);

  assert.deepEqual(JSON.parse(readFileSync(harness.markerPath, "utf8")), {
    version: 1,
    childId: "child-1",
    generation: 1,
    stopReason: "stop",
    entryId: "assistant-entry-2",
    sessionPath: harness.sessionPath,
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
    sessionPath: harness.sessionPath,
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

test("direct input behind a settlement candidate advances the response frontier", async () => {
  const harness = protocolHarness();
  writeFileSync(
    harness.sessionPath,
    `${JSON.stringify({
      type: "message",
      id: "assistant-entry-2",
      parentId: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "FIRST_CONCLUSION" }],
        stopReason: "stop",
      },
    })}\n`,
    { flag: "a" },
  );

  await harness.endHandler(
    { messages: [{ role: "assistant", content: [], stopReason: "stop" }] },
    harness.ctx,
  );
  harness.setPendingMessages(true);
  await harness.settledHandler({}, harness.ctx);
  assert.equal(existsSync(harness.markerPath), false);

  harness.setPendingMessages(false);
  await harness.beforeHandler({}, harness.ctx);
  assert.deepEqual(completionSettlementAt(harness.markerPath), {
    version: 1,
    childId: "child-1",
    generation: 1,
    phase: "running",
    frontierEntryId: "assistant-entry-2",
    pendingControls: 0,
    sessionPath: harness.sessionPath,
  });

  writeFileSync(
    harness.sessionPath,
    `${JSON.stringify({
      type: "message",
      id: "assistant-entry-3",
      parentId: "assistant-entry-2",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "SECOND_CONCLUSION" }],
        stopReason: "stop",
      },
    })}\n`,
    { flag: "a" },
  );
  harness.setLeafId("assistant-entry-3");
  await harness.endHandler(
    { messages: [{ role: "assistant", content: [], stopReason: "stop" }] },
    harness.ctx,
  );
  await harness.settledHandler({}, harness.ctx);

  assert.equal(existsSync(harness.markerPath), true);
  assert.equal(harness.shutdowns(), 1);
  assert.equal(JSON.parse(readFileSync(harness.markerPath, "utf8")).entryId, "assistant-entry-3");
});

test("child admission accepts steering before persistence and advances only that turn", async () => {
  const harness = protocolHarness();
  await harness.beforeHandler({ prompt: "INITIAL" }, harness.ctx);
  const nonce = "11111111-1111-4111-8111-111111111111";
  const admitted = await harness.inputHandler(
    {
      text: childControlPrompt({
        version: 1,
        childId: "child-1",
        generation: 1,
        nonce,
        action: "message",
        receiptPath: childControlReceiptPath(harness.markerPath),
        message: "FOLLOW_UP",
      }),
    },
    harness.ctx,
  );
  assert.deepEqual(admitted, { action: "handled" });
  assert.equal(childControlReceiptAt(harness.markerPath)?.status, "accepted");
  assert.equal(harness.queuedMessages.length, 1);

  // A direct/unrelated user message may start while the custom control is
  // queued. It must not consume this claim.
  await harness.messageStartHandler(
    // Deliberately use the same visible content as the private control. Text
    // matching alone would incorrectly consume the reservation here.
    { message: { role: "user", content: [{ type: "text", text: "FOLLOW_UP" }] } },
    harness.ctx,
  );
  assert.equal(completionSettlementAt(harness.markerPath)?.phase, "running");
  assert.equal(childControlReceiptAt(harness.markerPath)?.status, "accepted");

  writeFileSync(
    harness.sessionPath,
    `${JSON.stringify({
      type: "message",
      id: "assistant-before-follow-up",
      parentId: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "FIRST_CONCLUSION" }],
        stopReason: "stop",
      },
    })}\n`,
    { flag: "a" },
  );
  harness.setLeafId("assistant-before-follow-up");
  const queuedControl = harness.queuedMessages[0] as {
    customType: string;
    content: string;
    details: unknown;
  };
  await harness.messageStartHandler(
    {
      message: {
        role: "custom",
        customType: queuedControl.customType,
        content: queuedControl.content,
        details: queuedControl.details,
      },
    },
    harness.ctx,
  );
  assert.equal(childControlReceiptAt(harness.markerPath)?.status, "accepted");
  await harness.endHandler(
    { messages: [{ role: "assistant", content: [], stopReason: "stop" }] },
    harness.ctx,
  );
  await harness.settledHandler({}, harness.ctx);

  // The preceding response cannot satisfy the admitted turn, even if an
  // agent_end callback reports it again without a new persisted result.
  assert.deepEqual(completionSettlementAt(harness.markerPath), {
    version: 1,
    childId: "child-1",
    generation: 1,
    phase: "running",
    frontierEntryId: "assistant-before-follow-up",
    pendingControls: 0,
    sessionPath: harness.sessionPath,
  });
  assert.equal(existsSync(harness.markerPath), false);
  assert.equal(harness.shutdowns(), 0);
  writeFileSync(
    harness.sessionPath,
    `${JSON.stringify({
      type: "message",
      id: "assistant-after-follow-up",
      parentId: "assistant-before-follow-up",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "NEW_CONCLUSION" }],
        stopReason: "stop",
      },
    })}\n`,
    { flag: "a" },
  );
  harness.setLeafId("assistant-after-follow-up");
  await harness.endHandler(
    { messages: [{ role: "assistant", content: [], stopReason: "stop" }] },
    harness.ctx,
  );
  await harness.settledHandler({}, harness.ctx);
  assert.deepEqual(completionSettlementAt(harness.markerPath), {
    version: 1,
    childId: "child-1",
    generation: 1,
    phase: "candidate",
    stopReason: "stop",
    entryId: "assistant-after-follow-up",
    sessionPath: harness.sessionPath,
    settlementEvidence: {
      version: 1,
      blocked: false,
      admittedMessages: 0,
      pendingMessages: false,
      pendingCompletions: false,
      descendants: [],
    },
  });
  assert.equal(existsSync(harness.markerPath), true);
  assert.equal(harness.shutdowns(), 1);
});

test("child admission rejects late message and cancel before agent_end publication", async () => {
  for (const action of ["message", "cancel"] as const) {
    const harness = protocolHarness();
    await harness.beforeHandler({ prompt: "INITIAL" }, harness.ctx);
    writeFileSync(
      harness.sessionPath,
      `${JSON.stringify({
        type: "message",
        id: `assistant-before-${action}`,
        parentId: null,
        message: {
          role: "assistant",
          content: [{ type: "text", text: `EXACT_${action.toUpperCase()}_CONCLUSION` }],
          stopReason: "stop",
        },
      })}\n`,
      { flag: "a" },
    );
    harness.setLeafId(`assistant-before-${action}`);
    const nonce =
      action === "message"
        ? "22222222-2222-4222-8222-222222222222"
        : "33333333-3333-4333-8333-333333333333";
    const result = await harness.inputHandler(
      {
        text: childControlPrompt({
          version: 1,
          childId: "child-1",
          generation: 1,
          nonce,
          action,
          receiptPath: childControlReceiptPath(harness.markerPath),
          ...(action === "message" ? { message: "MUST_NOT_CROSS" } : {}),
        }),
      },
      harness.ctx,
    );

    assert.deepEqual(result, { action: "handled" });
    assert.equal(childControlReceiptAt(harness.markerPath)?.status, "settling");
    assert.equal(harness.aborts(), 0);
    assert.equal(completionSettlementAt(harness.markerPath)?.phase, "candidate");

    await harness.endHandler(
      { messages: [{ role: "assistant", content: [], stopReason: "stop" }] },
      harness.ctx,
    );
    await harness.settledHandler({}, harness.ctx);
    assert.equal(existsSync(harness.markerPath), true);
    assert.equal(harness.shutdowns(), 1);
  }
});

test("child admission aborts only an open generation", async () => {
  const harness = protocolHarness();
  await harness.beforeHandler({ prompt: "INITIAL" }, harness.ctx);
  const result = await harness.inputHandler(
    {
      text: childControlPrompt({
        version: 1,
        childId: "child-1",
        generation: 1,
        nonce: "44444444-4444-4444-8444-444444444444",
        action: "cancel",
        receiptPath: childControlReceiptPath(harness.markerPath),
      }),
    },
    harness.ctx,
  );

  assert.deepEqual(result, { action: "handled" });
  assert.equal(childControlReceiptAt(harness.markerPath)?.status, "cancelled");
  assert.equal(harness.queuedMessages.length, 0);
  assert.equal(harness.aborts(), 1);
});

test("expired cancellation cannot abort after delayed child-side admission", async () => {
  const harness = protocolHarness();
  await harness.beforeHandler({ prompt: "INITIAL" }, harness.ctx);
  const result = await harness.inputHandler(
    {
      text: childControlPrompt({
        version: 1,
        childId: "child-1",
        generation: 1,
        nonce: "45454545-4545-4454-8454-454545454545",
        action: "cancel",
        receiptPath: childControlReceiptPath(harness.markerPath),
        expiresAt: Date.now() - 1,
      }),
    },
    harness.ctx,
  );

  assert.deepEqual(result, { action: "handled" });
  assert.equal(childControlReceiptAt(harness.markerPath), undefined);
  assert.equal(harness.aborts(), 0);
});

test("an unadmitted custom control cannot reach the model", async () => {
  const harness = protocolHarness();
  await harness.messageStartHandler(
    {
      message: {
        role: "custom",
        customType: "herdr-subagent-control",
        content: "UNTRUSTED",
        details: {
          version: 1,
          childId: "child-1",
          generation: 1,
          nonce: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          action: "message",
          receiptPath: childControlReceiptPath(harness.markerPath),
          message: "UNTRUSTED",
        },
      },
    },
    harness.ctx,
  );
  assert.equal(harness.aborts(), 1);
  assert.equal(childControlReceiptAt(harness.markerPath), undefined);
});

test("rejected private queue admission never publishes an accepted receipt", async () => {
  const harness = protocolHarness({ rejectQueue: true });
  const result = await harness.inputHandler(
    {
      text: childControlPrompt({
        version: 1,
        childId: "child-1",
        generation: 1,
        nonce: "99999999-9999-4999-8999-999999999999",
        action: "message",
        receiptPath: childControlReceiptPath(harness.markerPath),
        message: "MUST_NOT_BE_ACKNOWLEDGED",
      }),
    },
    harness.ctx,
  );
  assert.deepEqual(result, { action: "handled" });
  assert.equal(harness.queuedMessages.length, 0);
  assert.equal(childControlReceiptAt(harness.markerPath), undefined);
});

test("receipt publication failure after queueing cannot authorize consumption", async () => {
  const harness = protocolHarness({
    afterQueue: () => {
      const path = childControlReceiptPath(harness.markerPath);
      assert.equal(
        childControlReceiptAt(harness.markerPath),
        undefined,
        "enqueue sees no premature acceptance",
      );
      rmSync(path);
      mkdirSync(path);
    },
  });
  await harness.inputHandler(
    {
      text: childControlPrompt({
        version: 1,
        childId: "child-1",
        generation: 1,
        nonce: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        action: "message",
        receiptPath: childControlReceiptPath(harness.markerPath),
        message: "MUST_NOT_REACH_MODEL",
      }),
    },
    harness.ctx,
  );
  assert.equal(childControlReceiptAt(harness.markerPath), undefined);
  assert.equal(harness.queuedMessages.length, 1);
  await harness.messageStartHandler(
    { message: { role: "custom", ...(harness.queuedMessages[0] as object) } },
    harness.ctx,
  );
  assert.equal(harness.aborts(), 1);
  await harness.endHandler(
    { messages: [{ role: "assistant", content: [], stopReason: "stop" }] },
    harness.ctx,
  );
  await harness.settledHandler({}, harness.ctx);
  const settlement = completionSettlementAt(harness.markerPath);
  assert.equal(settlement?.phase, "running");
  assert.equal(settlement?.phase === "running" && settlement.pendingControls, 1);
  assert.equal(
    existsSync(harness.markerPath),
    false,
    "unauthorized consumption cannot complete its preceding response",
  );
});

test("older consumption cannot replace a newer receipt or permit nonce replay", async () => {
  const harness = protocolHarness();
  const requests = [
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  ].map((nonce) =>
    childControlPrompt({
      version: 1,
      childId: "child-1",
      generation: 1,
      nonce,
      action: "message",
      receiptPath: childControlReceiptPath(harness.markerPath),
      message: "IDENTICAL_TEXT",
    }),
  );
  for (const text of requests) await harness.inputHandler({ text }, harness.ctx);
  const newest = childControlReceiptAt(harness.markerPath);
  assert.equal(newest?.nonce, "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  await harness.messageStartHandler(
    { message: { role: "custom", ...(harness.queuedMessages[0] as object) } },
    harness.ctx,
  );
  assert.deepEqual(childControlReceiptAt(harness.markerPath), newest);
  await harness.inputHandler({ text: requests[0]! }, harness.ctx);
  assert.equal(harness.queuedMessages.length, 2, "consumed nonce must not be admitted twice");
  assert.deepEqual(childControlReceiptAt(harness.markerPath), newest);
  assert.equal(harness.aborts(), 0);
});

test("recognized control input fails closed when its receipt cannot be written", async () => {
  const harness = protocolHarness();
  mkdirSync(childControlReceiptPath(harness.markerPath));

  const result = await harness.inputHandler(
    {
      text: childControlPrompt({
        version: 1,
        childId: "child-1",
        generation: 1,
        nonce: "77777777-7777-4777-8777-777777777777",
        action: "message",
        receiptPath: childControlReceiptPath(harness.markerPath),
        message: "MUST_NOT_REACH_MODEL",
      }),
    },
    harness.ctx,
  );

  assert.deepEqual(result, { action: "handled" });
  assert.equal(childControlReceiptAt(harness.markerPath), undefined);
  assert.equal(harness.queuedMessages.length, 0);
  assert.equal(harness.aborts(), 0);
});

test("recognized control input fails closed when a candidate cannot be written", async () => {
  const harness = protocolHarness();
  record(harness.registry, {
    id: "child-1",
    rootId: "root-1",
    parentId: "parent-1",
    generation: 1,
    state: "working",
    startedAfterEntryId: "older-assistant",
  });
  writeFileSync(
    harness.sessionPath,
    `${JSON.stringify({
      type: "message",
      id: "assistant-entry-2",
      parentId: null,
      message: { role: "assistant", content: [], stopReason: "stop" },
    })}\n`,
    { flag: "a" },
  );
  mkdirSync(completionSettlementPath(harness.markerPath));
  assert.equal(finalAssistantResult(harness.sessionPath).entryId, "assistant-entry-2");

  const result = await harness.inputHandler(
    {
      text: childControlPrompt({
        version: 1,
        childId: "child-1",
        generation: 1,
        nonce: "88888888-8888-4888-8888-888888888888",
        action: "message",
        receiptPath: childControlReceiptPath(harness.markerPath),
        message: "MUST_NOT_REACH_MODEL",
      }),
    },
    harness.ctx,
  );

  assert.deepEqual(result, { action: "handled" });
  assert.equal(childControlReceiptAt(harness.markerPath), undefined);
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
