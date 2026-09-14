#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  childControlPrompt,
  childControlReceiptAt,
  childControlReceiptPath,
  completionSettlementAt,
  finalAssistantResult,
} from "./completion-protocol.ts";
import { withRegistryLock } from "./registry-lock.ts";

const here = dirname(fileURLToPath(import.meta.url));
const evidence = mkdtempSync(join(tmpdir(), "subagent-control-admission-e2e-"));
console.log(`Evidence: ${evidence}`);

async function until(check, description, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timeout: ${description}`);
}

function monitorChild(child, output, logPath) {
  let timedOut = false;
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, 30_000);
  return {
    wasTimedOut: () => timedOut,
    wait: () => (child.exitCode === null ? exited : Promise.resolve(child.exitCode)),
    async cleanup() {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill("SIGTERM");
      await exited.catch(() => undefined);
      writeFileSync(logPath, output.join(""));
    },
  };
}

for (const action of ["message", "cancel", "receipt-failure"]) {
  const directory = join(evidence, action);
  const registry = join(directory, "registry");
  const sessions = join(directory, "sessions");
  mkdirSync(registry, { recursive: true });
  mkdirSync(sessions);
  const markerPath = join(registry, "child-1.generation-1.complete");
  const receiptPath = childControlReceiptPath(markerPath);
  if (action === "receipt-failure") mkdirSync(receiptPath);
  const barrierPath = join(directory, "agent-end-barrier.json");
  const releasePath = join(directory, "release");
  const callsPath = join(directory, "provider-calls");
  writeFileSync(
    join(registry, "child-1.json"),
    `${JSON.stringify({
      id: "child-1",
      rootId: "root-1",
      parentId: "parent-1",
      generation: 1,
      state: "working",
    })}\n`,
  );
  const output = [];
  const child = spawn(
    "pi",
    [
      "--mode",
      "rpc",
      "--session-dir",
      sessions,
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--offline",
      "--extension",
      join(here, "test-fixtures", "control-admission-provider.ts"),
      "--extension",
      join(here, "completion-protocol.ts"),
      "--model",
      "control-admission-test/fixture",
      "--thinking",
      "off",
      "--tools",
      "read",
    ],
    {
      env: {
        ...process.env,
        HERDR_SUBAGENT_AGENT_ID: "child-1",
        HERDR_SUBAGENT_GENERATION: "1",
        HERDR_SUBAGENT_REGISTRY: registry,
        HERDR_SUBAGENT_COMPLETION_MARKER: markerPath,
        CONTROL_TEST_BARRIER: barrierPath,
        CONTROL_TEST_RELEASE: releasePath,
        CONTROL_TEST_CALLS: callsPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (data) => output.push(data.toString()));
  child.stderr.on("data", (data) => output.push(data.toString()));
  const lifecycle = monitorChild(child, output, join(directory, "pi.log"));
  try {
    child.stdin.write(`${JSON.stringify({ id: "initial", type: "prompt", message: "INITIAL" })}\n`);
    const barrier = await until(
      () => existsSync(barrierPath) && JSON.parse(readFileSync(barrierPath, "utf8")),
      `${action} agent_end barrier`,
    );
    const controlAction = action === "cancel" ? "cancel" : "message";
    const nonce =
      action === "message"
        ? "55555555-5555-4555-8555-555555555555"
        : action === "cancel"
          ? "66666666-6666-4666-8666-666666666666"
          : "99999999-9999-4999-8999-999999999999";
    child.stdin.write(
      `${JSON.stringify({
        id: `control-${action}`,
        type: "prompt",
        message: childControlPrompt({
          version: 1,
          childId: "child-1",
          generation: 1,
          nonce,
          action: controlAction,
          receiptPath,
          ...(controlAction === "message" ? { message: "MUST_NOT_REACH_MODEL" } : {}),
        }),
        streamingBehavior: "steer",
      })}\n`,
    );
    if (action === "receipt-failure") {
      assert.equal(childControlReceiptAt(markerPath), undefined);
      assert.equal(existsSync(receiptPath), true);
      assert.equal(readFileSync(callsPath, "utf8"), "1");
    } else {
      const receipt = await until(
        () => childControlReceiptAt(markerPath),
        `${action} control receipt`,
      );
      assert.equal(receipt.status, "settling");
      assert.equal(receipt.sessionPath, barrier.sessionPath);
      assert.equal(readFileSync(callsPath, "utf8"), "1");
    }
    assert.equal(existsSync(markerPath), false);
    writeFileSync(releasePath, "release\n");
    await until(() => existsSync(markerPath), `${action} completion marker`);
    child.stdin.end();
    const code = await lifecycle.wait();
    assert.equal(lifecycle.wasTimedOut(), false);
    assert.equal(code, 0);
    assert.equal(readFileSync(callsPath, "utf8"), "1");
    assert.match(readFileSync(barrier.sessionPath, "utf8"), /EXACT_PERSISTED_CONCLUSION/);
    assert.doesNotMatch(readFileSync(barrier.sessionPath, "utf8"), /_herdr-subagent-control/);
    console.log(
      action === "receipt-failure"
        ? "PASS receipt failure: control was consumed without reaching the model"
        : `PASS ${action}: persisted conclusion won before control admission`,
    );
  } finally {
    await lifecycle.cleanup();
  }
}

// An accepted steering request must be admitted while the real Pi run is
// still active. This exercises streamingBehavior=steer and the child-side
// message_start consumption receipt, rather than only the settling race above.
for (const contention of [false, true]) {
  const directory = join(evidence, contention ? "contended-continuation" : "active-message");
  const registry = join(directory, "registry");
  const sessions = join(directory, "sessions");
  mkdirSync(registry, { recursive: true });
  mkdirSync(sessions);
  const markerPath = join(registry, "child-1.generation-1.complete");
  const barrierPath = join(directory, "provider-barrier.json");
  const releasePath = join(directory, "release");
  const callsPath = join(directory, "provider-calls");
  writeFileSync(
    join(registry, "child-1.json"),
    `${JSON.stringify({
      id: "child-1",
      rootId: "root-1",
      parentId: "parent-1",
      generation: 1,
      state: "working",
    })}\n`,
  );
  const output = [];
  const child = spawn(
    "pi",
    [
      "--mode",
      "rpc",
      "--session-dir",
      sessions,
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--offline",
      "--extension",
      join(here, "test-fixtures", "control-admission-provider.ts"),
      "--extension",
      join(here, "completion-protocol.ts"),
      "--model",
      "control-admission-test/fixture",
      "--thinking",
      "off",
      "--tools",
      "read",
    ],
    {
      env: {
        ...process.env,
        HERDR_SUBAGENT_AGENT_ID: "child-1",
        HERDR_SUBAGENT_GENERATION: "1",
        HERDR_SUBAGENT_REGISTRY: registry,
        HERDR_SUBAGENT_COMPLETION_MARKER: markerPath,
        CONTROL_TEST_BARRIER: barrierPath,
        CONTROL_TEST_RELEASE: releasePath,
        CONTROL_TEST_CALLS: callsPath,
        CONTROL_TEST_ACTIVE: "1",
        CONTROL_TEST_CONTINUE: contention ? "1" : "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (data) => output.push(data.toString()));
  child.stderr.on("data", (data) => output.push(data.toString()));
  const lifecycle = monitorChild(child, output, join(directory, "pi.log"));
  try {
    child.stdin.write(`${JSON.stringify({ id: "initial", type: "prompt", message: "INITIAL" })}\n`);
    await until(() => existsSync(barrierPath), "active provider barrier");
    const nonce = "77777777-7777-4777-8777-777777777777";
    child.stdin.write(
      `${JSON.stringify({
        id: "control-active-message",
        type: "prompt",
        message: childControlPrompt({
          version: 1,
          childId: "child-1",
          generation: 1,
          nonce,
          action: "message",
          receiptPath: childControlReceiptPath(markerPath),
          message: "ACTIVE_FOLLOW_UP_REQUEST",
        }),
        streamingBehavior: "steer",
      })}\n`,
    );
    // Wait for input preflight so the control is admitted and queued while the
    // first provider stream is still blocked. It is consumed only after release.
    await until(
      () => output.join("").includes('"id":"control-active-message"'),
      "active message admission",
    );
    // Queue an ordinary user message after the admitted custom control. Its
    // identical visible content must not consume the control's nonce.
    child.stdin.write(
      `${JSON.stringify({
        id: "unrelated-active-message",
        type: "prompt",
        message: "ACTIVE_FOLLOW_UP_REQUEST",
        streamingBehavior: "steer",
      })}\n`,
    );
    await until(
      () => output.join("").includes('"id":"unrelated-active-message"'),
      "unrelated message admission",
    );
    const receipt = await until(
      () => childControlReceiptAt(markerPath),
      "active message receipt before releasing the provider (parent admission deadline)",
      5_000,
    );
    assert.equal(receipt.status, "accepted");
    if (contention) {
      await withRegistryLock(`${markerPath}.lock`, async () => {
        writeFileSync(releasePath, "release\n");
        await until(
          () => existsSync(`${barrierPath}.consumption`),
          "control consumption reached the held lock",
        );
        // The earlier extension observed message_start. The protocol's awaited
        // handler must still prevent provider progress until the lock is free.
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(
          readFileSync(callsPath, "utf8"),
          "1",
          "no provider call crosses the consumption barrier",
        );
        const pending = completionSettlementAt(markerPath);
        assert.equal(pending?.phase, "running");
        assert.equal(
          pending.pendingControls,
          1,
          "reservation survives consumption lock contention",
        );
        assert.equal(existsSync(markerPath), false);
      });
      await until(
        () => existsSync(`${barrierPath}.second`),
        "second provider is active after consumption",
      );
      const second = JSON.parse(readFileSync(`${callsPath}.2.json`, "utf8"));
      assert.equal(second.settlement.phase, "running");
      assert.equal(second.settlement.pendingControls, 0);
      assert.equal(
        second.settlement.frontierEntryId,
        finalAssistantResult(receipt.sessionPath).entryId,
      );
      assert.match(JSON.stringify(second.context), /ACTIVE_FOLLOW_UP_REQUEST/);
      const nextNonce = "88888888-8888-4888-8888-888888888888";
      child.stdin.write(
        `${JSON.stringify({
          id: "control-after-consumption",
          type: "prompt",
          message: childControlPrompt({
            version: 1,
            childId: "child-1",
            generation: 1,
            nonce: nextNonce,
            action: "message",
            receiptPath: childControlReceiptPath(markerPath),
            message: "NEXT_CONTROL_WHILE_SECOND_PROVIDER_IS_ACTIVE",
          }),
          streamingBehavior: "steer",
        })}\n`,
      );
      const nextReceipt = await until(
        () => {
          const current = childControlReceiptAt(markerPath);
          return current?.nonce === nextNonce ? current : undefined;
        },
        "consumed-then-continued admission before provider release",
        5_000,
      );
      assert.equal(
        nextReceipt.status,
        "accepted",
        "preceding response is not mistaken for settlement",
      );
      writeFileSync(`${releasePath}.second`, "release\n");
    } else {
      writeFileSync(releasePath, "release\n");
    }
    await until(() => existsSync(markerPath), "active message completion marker");
    child.stdin.end();
    const code = await lifecycle.wait();
    assert.equal(lifecycle.wasTimedOut(), false);
    assert.equal(code, 0);
    assert.equal(readFileSync(callsPath, "utf8"), contention ? "3" : "2");
    if (contention) {
      const third = JSON.parse(readFileSync(`${callsPath}.3.json`, "utf8"));
      assert.match(JSON.stringify(third.context), /NEXT_CONTROL_WHILE_SECOND_PROVIDER_IS_ACTIVE/);
      assert.equal(third.settlement.pendingControls, 0);
    }
    const session = readFileSync(receipt.sessionPath, "utf8");
    const entries = session
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const customIndex = entries.findIndex(
      (entry) =>
        entry.type === "custom_message" &&
        entry.customType === "herdr-subagent-control" &&
        entry.content === "ACTIVE_FOLLOW_UP_REQUEST",
    );
    const unrelatedIndex = entries.findIndex(
      (entry) =>
        entry.type === "message" &&
        entry.message?.role === "user" &&
        entry.message.content?.[0]?.text === "ACTIVE_FOLLOW_UP_REQUEST",
    );
    assert.ok(
      customIndex >= 0 && unrelatedIndex > customIndex,
      "custom control precedes same-text user input",
    );
    assert.doesNotMatch(session, /_herdr-subagent-control/);
    console.log(
      contention
        ? "PASS contention and continuation: provider waits for consumption and each steer advances its frontier"
        : "PASS active message: accepted streaming steer reached the real Pi model",
    );
  } finally {
    await lifecycle.cleanup();
  }
}
