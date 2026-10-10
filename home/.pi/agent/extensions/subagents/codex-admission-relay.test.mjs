import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AdmissionAuthority,
  filterManagedModelCatalog,
  ManagerOwnedQueue,
  NativeRequestPolicy,
  SinglePolicyResponder,
} from "./codex-admission-relay.mjs";

test("managed catalog removes async-question markers and preserves model routing metadata", () => {
  const source = {
    models: [
      {
        slug: "permitted-model",
        provider: "primary-provider",
        default_reasoning_level: "high",
        supported_reasoning_levels: [
          { effort: "medium", description: "balanced" },
          { effort: "xhigh", description: "deep" },
        ],
        experimental_supported_tools: [
          "clock",
          "request_user_input_async",
          "send_user_message_async",
        ],
        multi_agent_version: "v2",
        supports_parallel_tool_calls: true,
      },
    ],
  };

  const managed = filterManagedModelCatalog(source);

  assert.deepEqual(managed.models[0], {
    ...source.models[0],
    experimental_supported_tools: ["clock"],
  });
  assert.deepEqual(source.models[0].experimental_supported_tools, [
    "clock",
    "request_user_input_async",
    "send_user_message_async",
  ]);
});

test("concurrent native starts cannot exceed four shared reservations", async () => {
  const authority = new AdmissionAuthority({ capacity: 4 });
  const upstreamStarts = [];
  for (let index = 0; index < 3; index += 1) {
    await authority.reserve(`other-child-${index}`);
  }
  const policy = new NativeRequestPolicy({ authority, threadId: "managed-thread" });

  const decisions = await Promise.all(
    ["race-a", "race-b"].map((runId) =>
      policy.admitStart(runId, async () => {
        upstreamStarts.push(runId);
        return { accepted: true };
      }),
    ),
  );

  assert.equal(decisions.filter((decision) => decision.admitted).length, 1);
  assert.equal(upstreamStarts.length, 1);
  assert.equal(authority.snapshot().active, 4);
});

test("durable leases survive manager restart and release only after goal quiescence", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-admission-"));
  fs.chmodSync(directory, 0o700);
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const journalPath = path.join(directory, "admission.jsonl");
  const firstAuthority = new AdmissionAuthority({ capacity: 4, journalPath });
  const firstPolicy = new NativeRequestPolicy({
    authority: firstAuthority,
    threadId: "managed-thread",
  });
  let upstreamStarts = 0;
  const admission = await firstPolicy.handleNativeRequest(
    { id: 1, method: "turn/start", params: { threadId: "managed-thread" } },
    async () => {
      upstreamStarts += 1;
      return { accepted: true };
    },
  );
  assert.equal(admission.result.accepted, true);
  assert.equal(fs.statSync(journalPath).mode & 0o777, 0o600);

  const restartedAuthority = new AdmissionAuthority({ capacity: 4, journalPath });
  assert.equal(await restartedAuthority.reacquire("managed-thread"), true);
  const restartedPolicy = new NativeRequestPolicy({
    authority: restartedAuthority,
    threadId: "managed-thread",
  });
  const blockedRestart = await restartedPolicy.handleNativeRequest(
    { id: 2, method: "turn/start", params: { threadId: "managed-thread" } },
    async () => {
      upstreamStarts += 1;
      return { accepted: true };
    },
  );
  assert.equal(blockedRestart.error.code, "THREAD_BUSY_OR_LEASE_HELD");
  assert.equal(upstreamStarts, 1);

  assert.equal(await restartedPolicy.settle("1", { goalStatus: "active" }), false);
  assert.equal(await restartedPolicy.settle("1", { goalStatus: "paused" }), false);
  assert.equal(
    await restartedPolicy.settle("1", {
      goalStatus: "paused",
      pauseBarrierObserved: true,
    }),
    true,
  );
  assert.equal(restartedAuthority.snapshot().active, 0);
});

test("a malformed durable journal prevents authority startup", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-admission-corrupt-"));
  fs.chmodSync(directory, 0o700);
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const journalPath = path.join(directory, "admission.jsonl");
  fs.writeFileSync(journalPath, '{"event":"release","id":"unknown"}\n', { mode: 0o600 });
  assert.throws(
    () => new AdmissionAuthority({ capacity: 4, journalPath }),
    /releases an unknown reservation/,
  );
});

test("native queue additions remain manager-owned and never reach the host", async () => {
  const authority = new AdmissionAuthority({ capacity: 4 });
  const queue = new ManagerOwnedQueue("managed-thread");
  const policy = new NativeRequestPolicy({ authority, threadId: "managed-thread", queue });
  let upstreamEffects = 0;
  const response = await policy.handleNativeRequest(
    {
      id: 1,
      method: "thread/queue/add",
      params: {
        threadId: "managed-thread",
        clientUserMessageId: "client-message",
        input: [{ type: "text", text: "queued work" }],
      },
    },
    async () => {
      upstreamEffects += 1;
      return {};
    },
  );

  assert.equal(response.result.queuedSubmission.clientUserMessageId, "client-message");
  assert.equal(queue.size, 1);
  assert.equal(upstreamEffects, 0);
});

test("native thread, session, and settings replacement routes fail before execution", async () => {
  const authority = new AdmissionAuthority({ capacity: 4 });
  const policy = new NativeRequestPolicy({ authority, threadId: "managed-thread" });
  let upstreamEffects = 0;
  for (const method of [
    "thread/start",
    "thread/fork",
    "thread/settings/update",
    "turn/settings/update",
    "config/value/write",
    "collaborationMode/list",
  ]) {
    const result = await policy.handleNativeRequest(
      { id: method, method, params: { threadId: "managed-thread" } },
      async () => {
        upstreamEffects += 1;
        return {};
      },
    );
    assert.equal(result.error?.code, "UNCLASSIFIED_ROUTE", method);
  }
  const foreignRead = await policy.handleNativeRequest(
    { id: "foreign", method: "thread/read", params: { threadId: "unmanaged-thread" } },
    async () => {
      upstreamEffects += 1;
      return {};
    },
  );
  assert.equal(foreignRead.error.code, "FOREIGN_THREAD");
  const missingThread = await policy.handleNativeRequest(
    { id: "missing", method: "thread/read", params: {} },
    async () => {
      upstreamEffects += 1;
      return {};
    },
  );
  assert.equal(missingThread.error.code, "FOREIGN_THREAD");
  assert.equal(upstreamEffects, 0);
});

test("only the authenticated policy owner can answer an unexpected server request", () => {
  const owner = new SinglePolicyResponder("a-private-controller-token-with-32-bytes");
  assert.deepEqual(owner.connect("native-client", "wrong-token"), {
    accepted: false,
    reason: "unauthorized",
  });
  assert.deepEqual(owner.connect("controller-a", "a-private-controller-token-with-32-bytes"), {
    accepted: true,
  });
  assert.deepEqual(owner.connect("controller-b", "a-private-controller-token-with-32-bytes"), {
    accepted: false,
    reason: "owner-already-connected",
  });
  assert.equal(owner.offer("request-1", { method: "approval/request" }).owner, "controller-a");
  assert.equal(owner.respond("controller-b", "request-1", { decision: "allow" }), false);
  assert.deepEqual(owner.respond("controller-a", "request-1", { decision: "deny" }), {
    requestId: "request-1",
    result: { decision: "deny" },
  });
  owner.offer("request-2", { method: "approval/request" });
  assert.equal(owner.disconnect("controller-a"), true);
  assert.equal(owner.respond("controller-a", "request-2", { decision: "allow" }), false);
  assert.deepEqual(owner.connect("controller-a", "a-private-controller-token-with-32-bytes"), {
    accepted: true,
  });
  assert.deepEqual(owner.offer("request-2", { method: "approval/request" }), {
    owner: "controller-a",
    requestId: "request-2",
    request: { method: "approval/request" },
    replay: true,
  });
  assert.deepEqual(owner.respond("controller-a", "request-2", { decision: "deny" }), {
    requestId: "request-2",
    result: { decision: "deny" },
  });
});

test("missing authority and unknown routes fail before upstream execution", async () => {
  const authority = new AdmissionAuthority({ capacity: 4, available: false });
  const policy = new NativeRequestPolicy({ authority, threadId: "managed-thread" });
  let upstreamEffects = 0;

  const deniedStart = await policy.handleNativeRequest(
    { id: 1, method: "turn/start", params: { threadId: "managed-thread" } },
    async () => {
      upstreamEffects += 1;
      return { accepted: true };
    },
  );
  const deniedUnknown = await policy.handleNativeRequest(
    { id: 2, method: "review/start", params: { threadId: "managed-thread" } },
    async () => {
      upstreamEffects += 1;
      return { accepted: true };
    },
  );

  assert.equal(deniedStart.error?.code, "ADMISSION_UNAVAILABLE");
  assert.equal(deniedUnknown.error?.code, "UNCLASSIFIED_ROUTE");
  assert.equal(upstreamEffects, 0);
});
