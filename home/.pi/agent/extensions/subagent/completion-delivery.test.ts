import assert from "node:assert/strict";
import { test } from "node:test";
import { CompletionDelivery, COMPLETION_OUTBOX_TYPE, COMPLETION_TYPE } from "./completion-delivery.ts";

const child = {
  id: "child-1", generation: 2, semanticName: "review", role: "reviewer", state: "completed",
  paneId: "w1:p9", sessionPath: "/tmp/child.jsonl", result: "DONE",
};

function parent(branch: unknown[] = []) {
  const queued: Array<{ customType: string; content: string; details: { runId: string } }> = [];
  const controller = new AbortController();
  const options = {
    getBranch: () => branch,
    appendEntry: (customType: string, data: unknown) => { branch.push({ type: "custom", customType, data }); },
    sendMessage: (message: typeof queued[number]) => { queued.push(message); },
    signal: controller.signal,
  };
  return { branch, queued, controller, options, delivery: new CompletionDelivery(options) };
}

test("delivery persists an outbox before enqueueing and does not wait for the active tool to finish", () => {
  const p = parent();
  const delivery = new CompletionDelivery({
    ...p.options,
    sendMessage: (message) => {
      assert.match(JSON.stringify(p.branch), /DONE/);
      p.options.sendMessage(message);
    },
  });
  assert.equal(delivery.deliver(child), true);
  assert.equal(p.queued.length, 1);
  assert.deepEqual(p.branch, [{
    type: "custom", customType: COMPLETION_OUTBOX_TYPE, data: { version: 1, message: p.queued[0] },
  }]);
});

test("restart replays an unconsumed outbox even after the child record advances to another generation", () => {
  const p = parent();
  p.delivery.deliver(child);
  p.delivery.deliver({ ...child, generation: 3, result: "NEXT_RESULT" });
  const restarted = parent(JSON.parse(JSON.stringify(p.branch)));
  restarted.delivery.replay();
  assert.deepEqual(restarted.queued.map((message) => message.details.runId), ["child-1:2", "child-1:3"]);
  assert.match(restarted.queued[0].content, /DONE/);
  assert.match(restarted.queued[1].content, /NEXT_RESULT/);
});

test("duplicate callbacks and recovery do not enqueue the same completion twice", () => {
  const p = parent();
  p.delivery.deliver(child);
  p.delivery.deliver(child);
  assert.equal(p.queued.length, 1);
  assert.equal(p.branch.length, 1);
  const restarted = parent(p.branch);
  restarted.delivery.replay();
  restarted.delivery.deliver(child);
  assert.equal(restarted.queued.length, 1);
});

test("consumed completions are not replayed or appended again", () => {
  const p = parent();
  p.delivery.deliver(child);
  p.branch.push({ type: "custom_message", ...p.queued[0] });
  const restarted = parent(p.branch);
  restarted.delivery.replay();
  assert.equal(restarted.delivery.deliver(child), true);
  assert.equal(restarted.queued.length, 0);
  assert.equal(restarted.branch.length, 2);
});

test("only the active branch controls replay and acknowledgement", () => {
  const abandoned = parent();
  abandoned.delivery.deliver(child);
  abandoned.branch.push({ type: "custom_message", ...abandoned.queued[0] });
  const active = parent();
  active.delivery.replay();
  assert.equal(active.queued.length, 0);
  assert.equal(active.delivery.deliver(child), true);
  assert.equal(active.queued.length, 1);
  assert.equal(active.branch.length, 1);
});

test("shutdown does not send or persist a new completion", () => {
  const p = parent();
  p.controller.abort();
  assert.equal(p.delivery.deliver(child), false);
  p.delivery.replay();
  assert.deepEqual(p.queued, []);
  assert.deepEqual(p.branch, []);
});

test("failed persistence prevents enqueueing and acknowledgement", () => {
  const p = parent();
  const delivery = new CompletionDelivery({
    ...p.options,
    appendEntry: () => { throw new Error("Disk full"); },
  });
  assert.throws(() => delivery.deliver(child), /Disk full/);
  assert.deepEqual(p.queued, []);
  assert.deepEqual(p.branch, []);
});

test("a failed send retains the original result for retry", () => {
  const p = parent();
  const failing = new CompletionDelivery({
    ...p.options, sendMessage: () => { throw new Error("Queue unavailable"); },
  });
  assert.throws(() => failing.deliver(child), /Queue unavailable/);
  assert.equal(p.branch.length, 1);
  p.delivery.replay();
  assert.equal(p.queued.length, 1);
  assert.match(p.queued[0].content, /DONE/);
});

test("settling after a cleared volatile queue can replay its durable outbox", () => {
  const p = parent();
  p.delivery.deliver(child);
  p.queued.length = 0;
  p.delivery.replay();
  assert.equal(p.queued.length, 1);
  assert.equal(p.branch.length, 1);
});

test("legacy messages without an outbox remain acknowledged", () => {
  const p = parent([{ type: "custom_message", customType: COMPLETION_TYPE, details: { runId: "child-1:2" } }]);
  assert.equal(p.delivery.deliver(child), true);
  assert.deepEqual(p.queued, []);
  assert.equal(p.branch.length, 1);
});

test("malformed persisted outbox fails closed rather than dropping a saved result", () => {
  const p = parent([{ type: "custom", customType: COMPLETION_OUTBOX_TYPE, data: { version: 99 } }]);
  assert.throws(() => p.delivery.replay(), /Invalid persisted/);
  assert.deepEqual(p.queued, []);
});
