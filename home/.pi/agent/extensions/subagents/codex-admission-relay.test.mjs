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

test("settlement is fenced by the exact reservation generation", async () => {
  const authority = new AdmissionAuthority({ capacity: 4 });
  const policy = new NativeRequestPolicy({ authority, threadId: "managed-thread" });
  const first = await policy.admitStart("reused-run-id", async () => ({ accepted: true }));

  assert.equal(await policy.settle("reused-run-id", first.reservation, {
    goalStatus: "paused",
    pauseBarrierObserved: true,
  }), true);

  const second = await policy.admitStart("reused-run-id", async () => ({ accepted: true }));
  assert.ok(second.reservation.generation > first.reservation.generation);
  assert.equal(await policy.settle("reused-run-id", first.reservation, {
    goalStatus: "paused",
    pauseBarrierObserved: true,
  }), false);
  assert.equal(authority.snapshot().active, 1);
  assert.equal(await policy.settle("reused-run-id", second.reservation, {
    goalStatus: "paused",
    pauseBarrierObserved: true,
  }), true);
  assert.equal(authority.snapshot().active, 0);
});

test("journal recovery requires reconciliation against the observed owner and generation", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-admission-recovery-"));
  fs.chmodSync(directory, 0o700);
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const journalPath = path.join(directory, "admission.jsonl");
  const firstAuthority = new AdmissionAuthority({ capacity: 4, journalPath });
  const firstPolicy = new NativeRequestPolicy({
    authority: firstAuthority,
    threadId: "managed-thread",
  });
  const first = await firstPolicy.admitStart("run-1", async () => ({ accepted: true }));
  assert.equal(firstAuthority.snapshot().active, 1);
  assert.equal(fs.statSync(journalPath).mode & 0o777, 0o600);

  const restartedAuthority = new AdmissionAuthority({ capacity: 4, journalPath });
  const observedGeneration = restartedAuthority.snapshot().leases[0].generation;
  const restartedPolicy = new NativeRequestPolicy({
    authority: restartedAuthority,
    threadId: "managed-thread",
  });
  assert.equal(await restartedPolicy.reconcileRecoveredOwner("other-run", observedGeneration), false);
  assert.equal(await restartedPolicy.reconcileRecoveredOwner("run-1", observedGeneration + 1), false);
  assert.equal(restartedAuthority.snapshot().active, 1);

  const recovered = await restartedPolicy.reconcileRecoveredOwner("run-1", observedGeneration);
  assert.ok(recovered);
  assert.ok(recovered.generation > observedGeneration);
  assert.equal(await restartedPolicy.settle("run-1", first.reservation, {
    goalStatus: "paused",
    pauseBarrierObserved: true,
  }), false);
  assert.equal(await restartedPolicy.settle("run-1", recovered, { goalStatus: "active" }), false);
  assert.equal(restartedAuthority.snapshot().active, 1);
  assert.equal(await restartedPolicy.settle("run-1", recovered, {
    goalStatus: "paused",
    pauseBarrierObserved: true,
  }), true);
  assert.equal(restartedAuthority.snapshot().active, 0);
});

test("a malformed journal prevents authority startup", (context) => {
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

test("queued submission and fallback IDs stay unique after dequeue and preserve caller IDs", async () => {
  const authority = new AdmissionAuthority({ capacity: 4 });
  const queue = new ManagerOwnedQueue("managed-thread");
  const policy = new NativeRequestPolicy({ authority, threadId: "managed-thread", queue });
  let upstreamEffects = 0;

  const enqueue = async (id, clientUserMessageId) => policy.handleNativeRequest(
    {
      id,
      method: "thread/queue/add",
      params: {
        threadId: "managed-thread",
        ...(clientUserMessageId === undefined ? {} : { clientUserMessageId }),
        input: [{ type: "text", text: `queued work ${id}` }],
      },
    },
    async () => {
      upstreamEffects += 1;
      return {};
    },
  );

  const first = await enqueue(1, "client-2");
  const firstTaken = queue.take();
  const second = await enqueue(2);
  const secondTaken = queue.take();
  const third = await enqueue(3);
  const thirdTaken = queue.take();
  const fourth = await enqueue(4);
  const fourthTaken = queue.take();

  assert.equal(first.result.queuedSubmission.clientUserMessageId, "client-2");
  assert.equal(third.result.queuedSubmission.clientUserMessageId, "client-3");
  assert.deepEqual(
    [firstTaken.id, secondTaken.id, thirdTaken.id, fourthTaken.id],
    ["manager-queue-1", "manager-queue-2", "manager-queue-3", "manager-queue-4"],
  );
  assert.deepEqual(
    [
      secondTaken.clientUserMessageId,
      thirdTaken.clientUserMessageId,
      fourthTaken.clientUserMessageId,
    ],
    ["client-1", "client-3", "client-4"],
  );
  assert.equal(queue.size, 0);
  assert.equal(upstreamEffects, 0);
});

test("thread resume forwards only canonical parameters for the assigned thread", async () => {
  const authority = new AdmissionAuthority({ capacity: 4 });
  const policy = new NativeRequestPolicy({ authority, threadId: "managed-thread" });
  const forwarded = [];
  const accepted = await policy.handleNativeRequest(
    { id: "resume", method: "thread/resume", params: { threadId: "managed-thread" } },
    async (request) => {
      forwarded.push(request);
      return { thread: { id: "managed-thread" } };
    },
  );

  assert.deepEqual(accepted, { result: { thread: { id: "managed-thread" } } });
  assert.deepEqual(forwarded, [
    { id: "resume", method: "thread/resume", params: { threadId: "managed-thread" } },
  ]);

  for (const override of [
    { history: [] },
    { path: "" },
    { path: "/tmp/other-thread.jsonl" },
    { config: { model: "different-model" } },
    { cwd: "/tmp/other-worktree" },
    { model: "different-model" },
    { unsupported: true },
  ]) {
    const rejected = await policy.handleNativeRequest(
      {
        id: `resume-${Object.keys(override)[0]}`,
        method: "thread/resume",
        params: { threadId: "managed-thread", ...override },
      },
      async (request) => {
        forwarded.push(request);
        return { thread: { id: "managed-thread" } };
      },
    );
    assert.deepEqual(rejected, { error: { code: "NONCANONICAL_THREAD_RESUME_PARAMS" } });
  }

  assert.equal(forwarded.length, 1, "noncanonical resume requests must not reach the host");
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
