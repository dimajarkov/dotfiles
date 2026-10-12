import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import hunkTurnReview from "../home/.pi/agent/extensions/hunk-turn-review/index.ts";
import { createClient } from "../home/.local/share/hunk-turn-review/client.mjs";
import { barrier, fixture } from "../nix/tests/pi-user-request-fixture.mjs";
import { createSnapshotAdapter } from "../home/.config/hunk/extensions/human-review/snapshot-adapter.ts";

const packages = resolve(process.env.PI_TEST_PACKAGES!);

async function reviewFixture(options: Record<string, any> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-hunk-lifecycle-"));
  const checkout = join(dir, "repo"),
    cwd = join(checkout, "subdir"),
    state = join(dir, "state");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(state, { mode: 0o700 });
  execFileSync("git", ["init", "-q", checkout]);
  const file = join(checkout, "tracked.txt");
  writeFileSync(file, "TRACKED\n");
  execFileSync("git", ["-C", checkout, "add", "tracked.txt"]);
  writeFileSync(file, "PREEXISTING\n");
  const socket = join(state, "runtime.sock");
  // The actual core runs under its declared Node owner, including socket checks.
  const child = spawn(
    "node",
    [
      realpathSync(
        process.env.HUNK_REVIEW_TEST_RUNTIME ??
          resolve(import.meta.dir, "../home/.local/share/hunk-turn-review/dist/src/runtime.js"),
      ),
      "--state",
      state,
      "--socket",
      socket,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.stderr.once("data", (data) => reject(new Error(data.toString())));
    child.once("exit", (code) => reject(new Error(`Native core exited ${code}`)));
  });
  const runtime = {
    close: () =>
      new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      }),
  };
  const client = createClient({ socket });
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries({
    HERDR_ENV: options.herdr === false ? undefined : "1",
    HERDR_SESSION: undefined,
    HERDR_SOCKET_PATH: undefined,
    HERDR_PANE_ID: undefined,
    HUNK_TURN_REVIEW_SOCKET: socket,
    HUNK_TURN_REVIEW_STATE: state,
    HUNK_TURN_REVIEW_CLIENT: resolve(
      import.meta.dir,
      "../home/.local/share/hunk-turn-review/client.mjs",
    ),
  })) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const f = await fixture(options.packages ?? packages, {
    ...options,
    cwd,
    agentDir: join(dir, "pi"),
    mode: options.mode ?? "tui",
    factory: (pi: any) => {
      if (options.factoryBeforeAdapter) options.factory?.(pi, file);
      hunkTurnReview(pi);
      if (!options.factoryBeforeAdapter) options.factory?.(pi, file);
    },
    respond: (index: number, context: any, streamOptions: any) =>
      options.respond?.(index, context, streamOptions, file),
  });
  const attached = () =>
    client.request("session.find", {
      kind: "pi",
      nativeId: f.session.sessionId,
      sessionPath: join(
        realpathSync(dirname(f.session.sessionFile)),
        basename(f.session.sessionFile),
      ),
      checkout: realpathSync(checkout),
    });
  const call = async (method: string, params = {}) => {
    const a = await attached();
    return client.request(method, { sessionId: a.sessionId, epoch: a.epoch, ...params });
  };
  return {
    ...f,
    file,
    checkout,
    client,
    attached,
    call,
    async close() {
      // Public original-session shutdown releases the receiver before disposal.
      delete process.env.HERDR_ENV;
      await f.session.reload();
      await f.close();
      await runtime.close();
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const bytes = (side: { content: string }) => Buffer.from(side.content, "base64").toString();

for (const factoryBeforeAdapter of [false, true]) {
  test(`first input-hook edit retains the pre-request Hunk baseline (writer first: ${factoryBeforeAdapter})`, async () => {
    const f = await reviewFixture({
      factoryBeforeAdapter,
      factory: (pi: any, file: string) => {
        pi.on("input", () => ({ action: "transform", text: "TRANSFORMED" }));
        pi.on("input", (event: any) => {
          expect(event.text).toBe("TRANSFORMED");
          writeFileSync(file, "INPUT PREPARATION\n");
        });
      },
    });
    try {
      await f.session.prompt("FIRST EDIT");
      const review = await f.call("review.get");
      expect(review.changes).toHaveLength(1);
      expect(bytes(review.changes[0].before)).toBe("PREEXISTING\n");
      expect(bytes(review.changes[0].after)).toBe("INPUT PREPARATION\n");
      expect(review.requestId).toBe(f.inputs[0].request.id);
      const status = await f.call("review.status");
      expect(status.taskBaseline).toBeDefined();
      expect(status.active).toBeUndefined();
      const cumulative = await f.call("review.get", { selection: "cumulative" });
      expect(bytes(cumulative.changes[0].before)).toBe("PREEXISTING\n");
      expect(bytes(cumulative.changes[0].after)).toBe("INPUT PREPARATION\n");
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  }, 15000);
}

test("read-only and handled read-only input leave Hunk without a pane or task baseline", async () => {
  const f = await reviewFixture({
    factory: (pi: any) =>
      pi.on("input", (event: any) =>
        event.text === "HANDLED" ? { action: "handled" } : undefined,
      ),
  });
  try {
    await f.session.prompt("READ ONLY");
    await f.session.prompt("HANDLED");
    const status = await f.call("review.status");
    expect(status.taskBaseline).toBeUndefined();
    expect(status.layoutState).toBeUndefined();
    expect(status.active).toBeUndefined();
    expect((await f.call("review.get")).changes).toEqual([]);
    expect(f.calls).toHaveLength(1);
    expect(f.events.filter((e: any) => e.type === "user_request_start")).toHaveLength(1);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
}, 15000);

for (const outcome of ["completed", "failed", "interrupted"] as const) {
  test(`input-only ${outcome} work is reviewed and releases its preparation interval`, async () => {
    const f = await reviewFixture({
      factory: (pi: any, file: string) =>
        pi.on("input", (_event: any, ctx: any) => {
          writeFileSync(file, "INPUT ONLY\n");
          if (outcome === "interrupted") ctx.abort();
          if (outcome !== "failed") return { action: "handled" };
        }),
    });
    try {
      if (outcome === "failed") {
        // Public agent-core model state permits an SDK host to have no selected model.
        f.session.agent.state.model = undefined;
        await expect(f.session.prompt("INPUT ONLY")).rejects.toThrow();
      } else await f.session.prompt("INPUT ONLY");
      const review = await f.call("review.get");
      expect(review.outcome).toBe(outcome);
      expect(review.requestId).toBe(f.inputs[0].request.id);
      expect(bytes(review.changes[0].before)).toBe("PREEXISTING\n");
      expect(bytes(review.changes[0].after)).toBe("INPUT ONLY\n");
      expect((await f.call("review.status")).active).toBeUndefined();
      expect(f.session.userRequest).toBeUndefined();
      expect(f.context.getUserRequestPreparation()).toBeUndefined();
      expect(f.calls).toHaveLength(0);
      expect(f.events).toEqual([]);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  }, 15000);
}

test("busy input-hook writes retain the active baseline and do not start a queued response", async () => {
  const busy = barrier(),
    release = barrier();
  const f = await reviewFixture({
    factory: (pi: any, file: string) =>
      pi.on("input", (event: any) => {
        if (event.text === "QUEUED") writeFileSync(file, "BUSY INPUT\n");
      }),
    respond: async (index: number, _context: any, _options: any, file: string) => {
      if (index === 0) {
        writeFileSync(file, "FIRST\n");
        busy.release();
        await release.promise;
      } else writeFileSync(file, "SECOND\n");
    },
  });
  const run = f.session.prompt("FIRST");
  try {
    await busy.promise;
    const before = await f.call("review.status");
    await f.session.prompt("QUEUED", { streamingBehavior: "followUp" });
    const during = await f.call("review.status");
    expect(during.active).toEqual(before.active);
    expect(f.events.filter((e: any) => e.type === "user_request_start")).toHaveLength(1);
    expect(f.preparations).toHaveLength(1);
    expect(f.calls).toHaveLength(1);
    release.release();
    await run;
    const status = await f.call("review.status");
    const first = await f.call("review.get", { reviewId: status.reviews[0] });
    const second = await f.call("review.get", { selection: "latest" });
    expect(bytes(first.changes[0].before)).toBe("PREEXISTING\n");
    expect(bytes(first.changes[0].after)).toBe("BUSY INPUT\n");
    expect(bytes(second.changes[0].before)).toBe("BUSY INPUT\n");
    expect(bytes(second.changes[0].after)).toBe("SECOND\n");
    expect(status.active).toBeUndefined();
    expect(status.warnings).toEqual([]);
    expect(f.errors).toEqual([]);
  } finally {
    release.release();
    await run;
    await f.close();
  }
}, 15000);

test("asynchronous input routing binds the original preparation baseline without replacing it", async () => {
  const transforming = barrier(),
    transform = barrier(),
    busy = barrier(),
    release = barrier();
  const f = await reviewFixture({
    factory: (pi: any, file: string) =>
      pi.on("input", async (event: any) => {
        if (event.text !== "SLOW") return;
        writeFileSync(file, "SLOW INPUT\n");
        transforming.release();
        await transform.promise;
        return { action: "transform", text: "TRANSFORMED" };
      }),
    respond: async (index: number, _context: any, _options: any, file: string) => {
      if (index === 0) {
        busy.release();
        await release.promise;
      } else writeFileSync(file, "STEER RESULT\n");
    },
  });
  const slow = f.session.prompt("SLOW", { streamingBehavior: "steer" });
  await transforming.promise;
  const run = f.session.prompt("ACTIVE");
  try {
    await busy.promise;
    transform.release();
    await slow;
    release.release();
    await run;
    const status = await f.call("review.status");
    const first = await f.call("review.get", { reviewId: status.reviews[0] });
    expect(bytes(first.changes[0].before)).toBe("PREEXISTING\n");
    expect(bytes(first.changes[0].after)).toBe("SLOW INPUT\n");
    expect(first.requestId).toBe(f.inputs[1].request.id);
    expect(first.outcome).toBe("interrupted");
    const latest = await f.call("review.get", { selection: "latest" });
    expect(latest.requestId).toBe(f.inputs[0].request.id);
    expect(bytes(latest.changes[0].before)).toBe("SLOW INPUT\n");
    expect(bytes(latest.changes[0].after)).toBe("STEER RESULT\n");
    expect(status.active).toBeUndefined();
    expect(status.warnings).toEqual([]);
    expect(f.calls).toHaveLength(2);
    expect(f.errors).toEqual([]);
  } finally {
    transform.release();
    release.release();
    await slow;
    await run;
    await f.close();
  }
}, 15000);

test("explicit all-mode Hunk review preserves one baseline and every grouped input", async () => {
  const started = barrier(),
    release = barrier(),
    groupStarted = barrier(),
    groupRelease = barrier();
  const f = await reviewFixture({
    factory: (pi: any, file: string) => {
      pi.on("before_agent_start", () => writeFileSync(file, "FIRST\n"));
      pi.on("user_request_start", async (event: any) => {
        if (!event.request.requests) return;
        writeFileSync(file, "GROUP PREPARATION\n");
        groupStarted.release();
        await groupRelease.promise;
      });
    },
    respond: async (index: number, _context: any, _options: any, file: string) => {
      if (index === 0) {
        started.release();
        await release.promise;
      } else writeFileSync(file, "GROUP RESULT\n");
    },
  });
  f.session.setFollowUpMode("all");
  const run = f.session.prompt("FIRST");
  try {
    await started.promise;
    await f.session.followUp("IDENTICAL");
    await f.session.followUp("IDENTICAL");
    release.release();
    await groupStarted.promise;
    const group = f.events.filter((e: any) => e.type === "user_request_start")[1].request;
    const requestGroup = { mode: "all", requests: f.inputs.slice(1).map((e: any) => e.request) };
    const active = await f.call("review.status");
    expect(active.active).toMatchObject({ requestId: group.id, requestGroup });
    expect(f.calls.length).toBe(1);
    const first = await f.call("review.get");
    expect(bytes(first.changes[0].before)).toBe("PREEXISTING\n");
    expect(bytes(first.changes[0].after)).toBe("FIRST\n");
    const note = await f.call("note.save", {
      reviewId: first.id,
      note: { text: "Keep original context" },
    });
    groupRelease.release();
    await run;
    const latest = await f.call("review.get", { selection: "latest" });
    const status = await f.call("review.status");
    expect(latest.requestId).toBe(group.id);
    expect(latest.requestGroup).toEqual(requestGroup);
    expect(latest.label).toBe(
      "changes observed during intentional Pi all-mode group: 2 user requests",
    );
    expect(latest.outcome).toBe("completed");
    expect(bytes(latest.changes[0].before)).toBe("FIRST\n");
    expect(bytes(latest.changes[0].after)).toBe("GROUP RESULT\n");
    expect(status.latestRequestGroup).toEqual(requestGroup);
    expect(status.pinned).toBe(first.id);
    expect((await f.call("review.get")).id).toBe(first.id);
    expect(status.notes.find((n: any) => n.id === note.id).reviewId).toBe(first.id);
    expect(status.active).toBeUndefined();
    expect(f.calls.length).toBe(2);
    expect(status.warnings).toEqual([]);
    expect(f.errors).toEqual([]);
    const attached = await f.attached();
    const adapter = createSnapshotAdapter(
      { sessionId: attached.sessionId, client: f.client },
      () => ({ selection: "latest" }),
    );
    const displayed = await adapter.operations["working-tree-diff"].load({}, { cwd: f.checkout });
    expect(displayed.title).toBe(`${latest.label} (completed; ${latest.id})`);
  } finally {
    release.release();
    groupRelease.release();
    await run;
    await f.close();
  }
}, 15000);

for (const outcome of ["failed", "interrupted"] as const) {
  test(`intentional all-mode ${outcome} publishes one honest grouped Hunk outcome`, async () => {
    const started = barrier(),
      release = barrier(),
      groupStarted = barrier();
    const f = await reviewFixture({
      factory: (pi: any, file: string) =>
        pi.on("before_agent_start", () => writeFileSync(file, "FIRST\n")),
      respond: async (index: number, _context: any, options: any, file: string) => {
        if (index === 0) {
          started.release();
          await release.promise;
          return;
        }
        writeFileSync(file, `GROUP ${outcome}\n`);
        groupStarted.release();
        if (outcome === "interrupted") {
          await new Promise<void>((resolve) =>
            options.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          return { stopReason: "aborted" };
        }
        return { stopReason: "error", errorMessage: "Terminal group fixture failure" };
      },
    });
    f.session.setFollowUpMode("all");
    const run = f.session.prompt("FIRST");
    try {
      await started.promise;
      await f.session.followUp("IDENTICAL");
      await f.session.followUp("IDENTICAL");
      release.release();
      await groupStarted.promise;
      if (outcome === "interrupted") await f.session.abort();
      await run;
      const starts = f.events.filter((e: any) => e.type === "user_request_start");
      const ends = f.events.filter((e: any) => e.type === "user_request_end");
      const group = starts[1].request;
      expect(starts.length).toBe(2);
      expect(ends).toEqual([
        { type: "user_request_end", request: starts[0].request, outcome: "completed" },
        { type: "user_request_end", request: group, outcome },
      ]);
      const review = await f.call("review.get", { selection: "latest" });
      expect(review).toMatchObject({
        requestId: group.id,
        outcome,
        requestGroup: { mode: "all", requests: f.inputs.slice(1).map((e: any) => e.request) },
        label: "changes observed during intentional Pi all-mode group: 2 user requests",
      });
      expect(bytes(review.changes[0].before)).toBe("FIRST\n");
      expect(bytes(review.changes[0].after)).toBe(`GROUP ${outcome}\n`);
      expect((await f.call("review.status")).active).toBeUndefined();
      expect(f.calls.length).toBe(2);
      expect(f.errors).toEqual([]);
    } finally {
      release.release();
      if (f.session.userRequest) await f.session.abort();
      await run;
      await f.close();
    }
  }, 15000);
}

test("latest Hunk review is exactly the last queued identical native request", async () => {
  const started = barrier(),
    release = barrier();
  const f = await reviewFixture({
    factory: (pi: any, file: string) =>
      pi.on("before_agent_start", () => writeFileSync(file, "FIRST\n")),
    respond: async (index: number, _context: any, _options: any, file: string) => {
      if (index === 0) {
        started.release();
        await release.promise;
      } else writeFileSync(file, index === 1 ? "SECOND\n" : "THIRD\n");
    },
  });
  const run = f.session.prompt("IDENTICAL");
  try {
    await started.promise;
    await f.session.followUp("IDENTICAL");
    await f.session.followUp("IDENTICAL");
    release.release();
    await run;
    const status = await f.call("review.status");
    const latest = await f.call("review.get", { selection: "latest" });
    expect(latest.requestId).toBe(f.inputs[2].request.id);
    expect(latest.outcome).toBe("completed");
    expect(latest.label).toBe("changes observed during this response");
    expect(bytes(latest.changes[0].before)).toBe("SECOND\n");
    expect(bytes(latest.changes[0].after)).toBe("THIRD\n");
    const first = await f.call("review.get", { reviewId: status.reviews[0] });
    expect(bytes(first.changes[0].before)).toBe("PREEXISTING\n");
    expect(bytes(first.changes[0].after)).toBe("FIRST\n");
    expect(status.active).toBeUndefined();
    expect(status.warnings).toEqual([]);
  } finally {
    release.release();
    await run;
    await f.close();
  }
}, 15000);

test("busy feedback waits through queued input and corrective tools receive a fresh baseline", async () => {
  const busy = barrier(),
    release = barrier();
  const f = await reviewFixture({
    factory: (pi: any, file: string) => {
      let prompts = 0;
      pi.on("before_agent_start", () =>
        writeFileSync(file, prompts++ === 0 ? "FIRST\n" : "BUSY\n"),
      );
      pi.registerTool({
        name: "correct",
        label: "Correct",
        description: "Local corrective fixture",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          writeFileSync(file, "CORRECTED\n");
          return { content: [{ type: "text", text: "DONE" }], details: {} };
        },
      });
    },
    respond: async (index: number, _context: any, _options: any, file: string) => {
      if (index === 1) {
        busy.release();
        await release.promise;
      }
      if (index === 2) writeFileSync(file, "QUEUED\n");
      if (index === 3)
        return {
          content: [{ type: "toolCall", id: "correction", name: "correct", arguments: {} }],
          stopReason: "toolUse",
        };
    },
  });
  f.session.setActiveToolsByName(["correct"]);
  try {
    await f.session.prompt("FIRST");
    const original = await f.call("review.get");
    const note = await f.call("note.save", {
      reviewId: original.id,
      note: { text: "Apply this explicit correction" },
    });
    const batch = await f.call("batch.create", { noteIds: [note.id] });
    const run = f.session.prompt("BUSY");
    await busy.promise;
    expect(await f.call("batch.submit", { batchId: batch.id })).toMatchObject({ state: "pending" });
    await f.session.followUp("HUMAN FOLLOWUP");
    expect(f.calls.length).toBe(2);
    release.release();
    await run;
    const latest = await f.call("review.get", { selection: "latest" });
    const feedback = f.events.filter((event: any) => event.type === "user_request_start").at(-1);
    expect(latest.requestId).toBe(feedback.request.id);
    expect(latest.requestId).not.toBe(batch.id);
    expect(feedback.request.source).toBe("extension");
    expect(feedback.request.delivery).toBe("followUp");
    expect(bytes(latest.changes[0].before)).toBe("QUEUED\n");
    expect(bytes(latest.changes[0].after)).toBe("CORRECTED\n");
    expect(latest.outcome).toBe("completed");
    expect((await f.call("batch.reconcile", { batchId: batch.id })).state).toBe("queued");
    expect((await f.call("review.status")).notes[0].state).toBe("submitted");
    expect(f.inputs.length).toBe(3);
    expect(f.calls.length).toBe(5);
    const persisted = f.session.sessionManager
      .getEntries()
      .find(
        (entry: any) => entry.type === "custom_message" && entry.customType === "hunk-turn-review",
      );
    expect(persisted.details.batchId).toBe(batch.id);
  } finally {
    release.release();
    await f.session.waitForIdle();
    await f.close();
  }
}, 15000);

test("receiver rejects changed original UUID, transcript path, and epoch", async () => {
  const f = await reviewFixture();
  try {
    await f.session.prompt("READ ONLY");
    const attached = await f.attached();
    const receiver = createClient({ socket: attached.receiver.socket });
    for (const changes of [
      { identity: { ...attached.identity, nativeId: randomUUID() } },
      { identity: { ...attached.identity, sessionPath: join(f.checkout, "replacement.jsonl") } },
      { epoch: randomUUID() },
    ]) {
      const result = await receiver.request("admission.enqueue", {
        identity: attached.identity,
        epoch: attached.epoch,
        batchId: "blocked",
        batch: { id: "blocked" },
        prompt: "Must not consume work",
        ...changes,
      });
      expect(result.state).toBe("blocked");
    }
    expect(f.calls.length).toBe(1);
    expect(attached.identity.checkout).toBe(realpathSync(f.checkout));
  } finally {
    await f.close();
  }
}, 15000);

test("feedback native binding retains the batch baseline before request-start hook edits", async () => {
  const f = await reviewFixture({
    factoryBeforeAdapter: true,
    factory: (pi: any, file: string) => {
      pi.on("input", () => writeFileSync(file, "FIRST INPUT\n"));
      pi.on("user_request_start", (event: any) => {
        if (event.request.source === "extension") writeFileSync(file, "FEEDBACK PREPARATION\n");
      });
    },
  });
  try {
    await f.session.prompt("FIRST");
    const original = await f.call("review.get");
    const note = await f.call("note.save", {
      reviewId: original.id,
      note: { text: "Explicit feedback" },
    });
    const batch = await f.call("batch.create", { noteIds: [note.id] });
    expect(await f.call("batch.submit", { batchId: batch.id })).toMatchObject({ state: "queued" });
    await f.session.waitForIdle();
    const review = await f.call("review.get", { selection: "latest" });
    const request = f.events.filter((e: any) => e.type === "user_request_start").at(-1).request;
    expect(request.correlationId).toBe(batch.id);
    expect(review.requestId).toBe(request.id);
    expect(review.requestId).not.toBe(batch.id);
    expect(bytes(review.changes[0].before)).toBe("FIRST INPUT\n");
    expect(bytes(review.changes[0].after)).toBe("FEEDBACK PREPARATION\n");
    expect((await f.call("review.status")).active).toBeUndefined();
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
}, 15000);

for (const options of [
  { mode: "rpc" },
  { mode: "json" },
  { mode: "print" },
  { mode: "tui", herdr: false },
]) {
  test(`review attachment requires original TUI inside Herdr: ${JSON.stringify(options)}`, async () => {
    const f = await reviewFixture(options);
    try {
      await f.session.prompt("READ ONLY");
      await expect(f.attached()).rejects.toThrow("missing or ambiguous");
    } finally {
      await f.close();
    }
  }, 15000);
}

test("interrupted steering and terminal failure publish separate immutable outcomes", async () => {
  const provider = barrier(),
    release = barrier();
  const f = await reviewFixture({
    factory: (pi: any, file: string) =>
      pi.on("before_agent_start", () => writeFileSync(file, "ORIGINAL\n")),
    respond: async (index: number, _context: any, _options: any, file: string) => {
      if (index === 0) {
        provider.release();
        await release.promise;
      } else {
        writeFileSync(file, "FAILED\n");
        return { stopReason: "error", errorMessage: "Terminal fixture failure" };
      }
    },
  });
  const run = f.session.prompt("ORIGINAL");
  try {
    await provider.promise;
    await f.session.steer("SUPERSEDING REQUEST");
    release.release();
    await run;
    const status = await f.call("review.status");
    const interrupted = await f.call("review.get", { reviewId: status.reviews[0] });
    const failed = await f.call("review.get", { selection: "latest" });
    expect(interrupted.outcome).toBe("interrupted");
    expect(failed.outcome).toBe("failed");
    expect(interrupted.requestId).toBe(f.inputs[0].request.id);
    expect(failed.requestId).toBe(f.inputs[1].request.id);
    expect(bytes(failed.changes[0].before)).toBe("ORIGINAL\n");
    expect(bytes(failed.changes[0].after)).toBe("FAILED\n");
  } finally {
    release.release();
    await run;
    await f.close();
  }
}, 15000);

test.skipIf(!process.env.PI_OLD_TEST_PACKAGES)(
  "older native host leaves exact review disabled",
  async () => {
    const notices: string[] = [];
    const f = await reviewFixture({
      packages: process.env.PI_OLD_TEST_PACKAGES,
      onNotification: (text: string) => notices.push(text),
    });
    try {
      await f.session.prompt("READ ONLY");
      await expect(f.attached()).rejects.toThrow("missing or ambiguous");
      expect(f.events).toEqual([]);
      expect(notices.some((text) => text.includes("input preparation support is required"))).toBe(
        true,
      );
    } finally {
      await f.close();
    }
  },
  15000,
);

test.skipIf(!process.env.PI_PREPARATION_OLD_TEST_PACKAGES)(
  "host with late request starts warns and disables exact review",
  async () => {
    const notices: string[] = [];
    const f = await reviewFixture({
      packages: process.env.PI_PREPARATION_OLD_TEST_PACKAGES,
      onNotification: (text: string) => notices.push(text),
    });
    try {
      expect(typeof f.context.getUserRequest).toBe("function");
      await f.session.prompt("READ ONLY");
      await expect(f.attached()).rejects.toThrow("missing or ambiguous");
      expect(notices.some((text) => text.includes("input preparation support is required"))).toBe(
        true,
      );
    } finally {
      await f.close();
    }
  },
  15000,
);

for (const outcome of ["completed", "failed", "interrupted"] as const) {
  test(`pending feedback wakes after ${outcome} input preparation and gets a fresh native response`, async () => {
    const preparing = barrier();
    const releasePreparation = barrier();
    const feedbackStarted = barrier();
    const releaseFeedback = barrier();
    let preparationId: string | undefined;
    let restoreModel: (() => void) | undefined;
    const f = await reviewFixture({
      factoryBeforeAdapter: true,
      factory: (pi: any, file: string) => {
        pi.on("input", async (event: any) => {
          if (event.text !== `PREPARE ${outcome}`) return;
          preparationId = event.request.id;
          writeFileSync(file, `PREPARATION ${outcome}\n`);
          preparing.release();
          await releasePreparation.promise;
          if (outcome !== "failed") return { action: "handled" };
        });
        pi.on("user_request_prepare_end", (event: any) => {
          if (outcome === "failed" && event.request.id === preparationId) restoreModel?.();
        });
      },
      respond: async (index: number, _context: any, _options: any, file: string) => {
        if (index === 0) {
          writeFileSync(file, "INITIAL RESPONSE\n");
          return;
        }
        feedbackStarted.release();
        await releaseFeedback.promise;
        writeFileSync(file, "FOLLOWUP RESPONSE\n");
      },
    });
    const model = f.session.agent.state.model;
    restoreModel = () => {
      f.session.agent.state.model = model;
    };
    let preparationRun: Promise<void> | undefined;
    try {
      await f.session.prompt("INITIAL");
      const initial = await f.call("review.get");
      const note = await f.call("note.save", {
        reviewId: initial.id,
        note: { text: "Apply this explicit correction" },
      });
      const batch = await f.call("batch.create", { noteIds: [note.id] });

      preparationRun = f.session.prompt(`PREPARE ${outcome}`);
      await preparing.promise;
      expect(preparationId).toBeDefined();
      expect(f.context.getUserRequestPreparation().id).toBe(preparationId);
      expect(await f.call("batch.submit", { batchId: batch.id })).toMatchObject({
        state: "pending",
      });
      expect((await f.call("batch.reconcile", { batchId: batch.id })).state).toBe("pending");
      expect(f.calls).toHaveLength(1);
      expect(f.events.filter((event: any) => event.type === "user_request_start")).toHaveLength(1);

      if (outcome === "failed") f.session.agent.state.model = undefined;
      if (outcome === "interrupted") {
        const aborting = f.session.abort();
        releasePreparation.release();
        await aborting;
      } else {
        releasePreparation.release();
      }
      if (outcome === "failed") await expect(preparationRun).rejects.toThrow();
      else await preparationRun;

      const feedbackWasStarted = await Promise.race([
        feedbackStarted.promise.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
      ]);
      expect(feedbackWasStarted).toBe(true);
      const preparationEnd = f.preparations.find(
        (event: any) =>
          event.type === "user_request_prepare_end" && event.request.id === preparationId,
      );
      expect(preparationEnd.outcome).toBe(outcome);
      expect(f.context.getUserRequestPreparation()).toBeUndefined();
      const preparedReview = await f.call("review.get", { selection: "latest" });
      expect(preparedReview.requestId).toBe(preparationId);
      expect(preparedReview.outcome).toBe(outcome);
      expect(bytes(preparedReview.changes[0].before)).toBe("INITIAL RESPONSE\n");
      expect(bytes(preparedReview.changes[0].after)).toBe(`PREPARATION ${outcome}\n`);

      const feedbackStart = f.events
        .filter((event: any) => event.type === "user_request_start")
        .at(-1);
      expect(feedbackStart.request).toMatchObject({
        source: "extension",
        delivery: "followUp",
        correlationId: batch.id,
      });
      expect(feedbackStart.request.id).not.toBe(batch.id);
      expect((await f.call("review.status")).active.requestId).toBe(feedbackStart.request.id);
      expect((await f.call("batch.reconcile", { batchId: batch.id })).state).toBe("queued");
      expect((await f.call("review.status")).notes[0].state).toBe("submitted");
      expect(f.events.filter((event: any) => event.type === "user_request_end")).toHaveLength(1);
      expect(f.calls).toHaveLength(2);

      releaseFeedback.release();
      await f.session.waitForIdle();
      const feedbackReview = await f.call("review.get", { selection: "latest" });
      expect(feedbackReview.requestId).toBe(feedbackStart.request.id);
      expect(feedbackReview.outcome).toBe("completed");
      expect(bytes(feedbackReview.changes[0].before)).toBe(`PREPARATION ${outcome}\n`);
      expect(bytes(feedbackReview.changes[0].after)).toBe("FOLLOWUP RESPONSE\n");
      expect(f.events.filter((event: any) => event.type === "user_request_end").at(-1)).toEqual({
        type: "user_request_end",
        request: feedbackStart.request,
        outcome: "completed",
      });
      expect(f.errors).toEqual([]);
    } finally {
      releasePreparation.release();
      releaseFeedback.release();
      if (preparationRun) await preparationRun.catch(() => {});
      await f.session.waitForIdle();
      await f.close();
    }
  }, 20000);
}

test("pending feedback does not interrupt a prepared native response", async () => {
  const preparing = barrier();
  const releasePreparation = barrier();
  const responseStarted = barrier();
  const releaseResponse = barrier();
  const feedbackStarted = barrier();
  const releaseFeedback = barrier();
  const f = await reviewFixture({
    factory: (pi: any, file: string) =>
      pi.on("input", async (event: any) => {
        if (event.text !== "NORMAL TURN") return;
        writeFileSync(file, "NORMAL INPUT\n");
        preparing.release();
        await releasePreparation.promise;
        return { action: "transform", text: event.text };
      }),
    respond: async (index: number, _context: any, _options: any, file: string) => {
      if (index === 0) {
        writeFileSync(file, "INITIAL RESPONSE\n");
        return;
      }
      if (index === 1) {
        responseStarted.release();
        await releaseResponse.promise;
        writeFileSync(file, "NORMAL RESPONSE\n");
        return;
      }
      feedbackStarted.release();
      await releaseFeedback.promise;
      writeFileSync(file, "FEEDBACK RESPONSE\n");
    },
  });
  let responseRun: Promise<void> | undefined;
  try {
    await f.session.prompt("INITIAL");
    const initial = await f.call("review.get");
    const note = await f.call("note.save", {
      reviewId: initial.id,
      note: { text: "Apply this explicit correction" },
    });
    const batch = await f.call("batch.create", { noteIds: [note.id] });

    responseRun = f.session.prompt("NORMAL TURN");
    await preparing.promise;
    const preparationId = f.context.getUserRequestPreparation().id;
    expect(await f.call("batch.submit", { batchId: batch.id })).toMatchObject({
      state: "pending",
    });
    expect(f.calls).toHaveLength(1);
    releasePreparation.release();
    await responseStarted.promise;

    const responseRequest = f.inputs.at(-1).request;
    expect(f.context.getUserRequest().id).toBe(responseRequest.id);
    expect(f.context.getUserRequestPreparation()).toBeUndefined();
    expect(f.preparations.some((event: any) => event.type === "user_request_prepare_end")).toBe(
      false,
    );
    expect(
      f.events.filter((event: any) => event.type === "user_request_start").at(-1).request.id,
    ).toBe(responseRequest.id);
    expect((await f.call("review.status")).active.requestId).toBe(responseRequest.id);
    expect((await f.call("batch.reconcile", { batchId: batch.id })).state).toBe("pending");
    expect(f.events.filter((event: any) => event.type === "user_request_start")).toHaveLength(2);
    expect(f.calls).toHaveLength(2);

    releaseResponse.release();
    await feedbackStarted.promise;
    const feedbackStart = f.events
      .filter((event: any) => event.type === "user_request_start")
      .at(-1);
    expect(feedbackStart.request.correlationId).toBe(batch.id);
    expect(feedbackStart.request.id).not.toBe(batch.id);
    expect(f.events.filter((event: any) => event.type === "user_request_end")[1]).toEqual({
      type: "user_request_end",
      request: responseRequest,
      outcome: "completed",
    });
    const responseReview = await f.call("review.get", { selection: "latest" });
    expect(responseReview.requestId).toBe(responseRequest.id);
    expect(responseReview.outcome).toBe("completed");
    expect(bytes(responseReview.changes[0].before)).toBe("INITIAL RESPONSE\n");
    expect(bytes(responseReview.changes[0].after)).toBe("NORMAL RESPONSE\n");
    expect(preparationId).toBe(responseRequest.id);
    expect((await f.call("batch.reconcile", { batchId: batch.id })).state).toBe("queued");
    expect((await f.call("review.status")).notes[0].state).toBe("submitted");

    releaseFeedback.release();
    await responseRun;
    await f.session.waitForIdle();
    const feedbackReview = await f.call("review.get", { selection: "latest" });
    expect(feedbackReview.requestId).toBe(feedbackStart.request.id);
    expect(bytes(feedbackReview.changes[0].before)).toBe("NORMAL RESPONSE\n");
    expect(bytes(feedbackReview.changes[0].after)).toBe("FEEDBACK RESPONSE\n");
    expect(f.errors).toEqual([]);
  } finally {
    releasePreparation.release();
    releaseResponse.release();
    releaseFeedback.release();
    if (responseRun) await responseRun.catch(() => {});
    await f.session.waitForIdle();
    await f.close();
  }
}, 20000);

test("pending feedback waits behind queued human requests selected as an all-mode group", async () => {
  const preparing = barrier();
  const releasePreparation = barrier();
  const triggerStarted = barrier();
  const releaseTrigger = barrier();
  const groupStarted = barrier();
  const releaseGroup = barrier();
  const feedbackStarted = barrier();
  const releaseFeedback = barrier();
  const f = await reviewFixture({
    factory: (pi: any, file: string) =>
      pi.on("input", async (event: any) => {
        if (event.text !== "PREPARE HUMAN QUEUE") return;
        writeFileSync(file, "PREPARATION QUEUE\n");
        preparing.release();
        await releasePreparation.promise;
        return { action: "handled" };
      }),
    respond: async (index: number, _context: any, _options: any, file: string) => {
      if (index === 0) {
        writeFileSync(file, "INITIAL RESPONSE\n");
        return;
      }
      if (index === 1) {
        triggerStarted.release();
        await releaseTrigger.promise;
        writeFileSync(file, "TRIGGER RESPONSE\n");
        return;
      }
      if (index === 2) {
        groupStarted.release();
        await releaseGroup.promise;
        writeFileSync(file, "HUMAN GROUP RESPONSE\n");
        return;
      }
      feedbackStarted.release();
      await releaseFeedback.promise;
      writeFileSync(file, "FEEDBACK RESPONSE\n");
    },
  });
  f.session.setFollowUpMode("all");
  let preparationRun: Promise<void> | undefined;
  let triggerRun: Promise<void> | undefined;
  try {
    await f.session.prompt("INITIAL");
    const initial = await f.call("review.get");
    const note = await f.call("note.save", {
      reviewId: initial.id,
      note: { text: "Apply this explicit correction" },
    });
    const batch = await f.call("batch.create", { noteIds: [note.id] });

    preparationRun = f.session.prompt("PREPARE HUMAN QUEUE");
    await preparing.promise;
    const preparationId = f.context.getUserRequestPreparation().id;
    expect(await f.call("batch.submit", { batchId: batch.id })).toMatchObject({
      state: "pending",
    });
    await f.session.followUp("HUMAN ONE");
    await f.session.followUp("HUMAN TWO");
    expect(f.context.hasPendingMessages()).toBe(true);
    releasePreparation.release();
    await preparationRun;

    const preparationReview = await f.call("review.get", { selection: "latest" });
    expect(preparationReview.requestId).toBe(preparationId);
    expect(bytes(preparationReview.changes[0].after)).toBe("PREPARATION QUEUE\n");
    expect(f.events.filter((event: any) => event.type === "user_request_start")).toHaveLength(1);
    expect((await f.call("batch.reconcile", { batchId: batch.id })).state).toBe("pending");
    expect(f.calls).toHaveLength(1);

    triggerRun = f.session.prompt("TRIGGER");
    await triggerStarted.promise;
    expect(f.events.filter((event: any) => event.type === "user_request_start")).toHaveLength(2);
    expect((await f.call("batch.reconcile", { batchId: batch.id })).state).toBe("pending");
    releaseTrigger.release();
    await groupStarted.promise;

    const startsBeforeFeedback = f.events.filter(
      (event: any) => event.type === "user_request_start",
    );
    const humanRequests = f.inputs
      .filter((event: any) => event.text === "HUMAN ONE" || event.text === "HUMAN TWO")
      .map((event: any) => event.request);
    const groupRequest = startsBeforeFeedback.at(-1).request;
    expect(groupRequest.mode).toBe("all");
    expect(groupRequest.requests).toEqual(humanRequests);
    expect(startsBeforeFeedback).toHaveLength(3);
    expect(startsBeforeFeedback.some((event: any) => event.request.source === "extension")).toBe(
      false,
    );
    expect((await f.call("batch.reconcile", { batchId: batch.id })).state).toBe("pending");
    expect(f.calls).toHaveLength(3);

    releaseGroup.release();
    await feedbackStarted.promise;
    const starts = f.events.filter((event: any) => event.type === "user_request_start");
    const feedbackStart = starts.at(-1);
    expect(starts).toHaveLength(4);
    expect(feedbackStart.request).toMatchObject({
      source: "extension",
      delivery: "followUp",
      correlationId: batch.id,
    });
    expect(feedbackStart.request.id).not.toBe(batch.id);
    expect(f.events.filter((event: any) => event.type === "user_request_end").at(-1)).toEqual({
      type: "user_request_end",
      request: groupRequest,
      outcome: "completed",
    });
    const groupReview = await f.call("review.get", { selection: "latest" });
    expect(groupReview.requestId).toBe(groupRequest.id);
    expect(groupReview.requestGroup.requests).toEqual(humanRequests);
    expect(bytes(groupReview.changes[0].before)).toBe("TRIGGER RESPONSE\n");
    expect(bytes(groupReview.changes[0].after)).toBe("HUMAN GROUP RESPONSE\n");
    expect((await f.call("batch.reconcile", { batchId: batch.id })).state).toBe("queued");
    expect((await f.call("review.status")).notes[0].state).toBe("submitted");
    expect(f.calls).toHaveLength(4);

    releaseFeedback.release();
    await triggerRun;
    await f.session.waitForIdle();
    const feedbackReview = await f.call("review.get", { selection: "latest" });
    expect(feedbackReview.requestId).toBe(feedbackStart.request.id);
    expect(bytes(feedbackReview.changes[0].before)).toBe("HUMAN GROUP RESPONSE\n");
    expect(bytes(feedbackReview.changes[0].after)).toBe("FEEDBACK RESPONSE\n");
    expect(f.errors).toEqual([]);
  } finally {
    releasePreparation.release();
    releaseTrigger.release();
    releaseGroup.release();
    releaseFeedback.release();
    if (preparationRun) await preparationRun.catch(() => {});
    if (triggerRun) await triggerRun.catch(() => {});
    await f.session.waitForIdle();
    await f.close();
  }
}, 20000);
