import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, chmod, symlink, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { chmodSync } from "node:fs";
import { createClient } from "../client.mjs";
import { pathToFileURL } from "node:url";

export async function fixture(options: Record<string, unknown> = {}) {
  const dir = await mkdtemp(
    join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "htr-"),
  );
  const checkout = join(dir, "repo");
  const runtimeEntry =
    process.env.HUNK_TURN_REVIEW_TEST_RUNTIME ?? join(import.meta.dir, "../dist/src/runtime.js");
  await mkdir(checkout);
  execFileSync("git", ["init", "-q", checkout]);
  await writeFile(join(checkout, "tracked.txt"), "before\n");
  await writeFile(join(checkout, ".gitignore"), "secret\n");
  execFileSync("git", ["-C", checkout, "add", "."]);
  await writeFile(join(checkout, "tracked.txt"), "pre-existing edit\n");
  const socket = join(dir, "state", "r.sock");
  const clock = join(dir, "clock");
  if (options.now) await writeFile(clock, String(options.now));
  const launch = async () => {
    const argv = options.now
      ? [
          "--input-type=module",
          "-e",
          `import {startRuntime} from ${JSON.stringify(pathToFileURL(runtimeEntry).href)};import {readFileSync} from "node:fs";const runtime=await startRuntime({...${JSON.stringify({ state: join(dir, "state"), socket, maxBytes: options.maxBytes })},now:()=>Number(readFileSync(${JSON.stringify(clock)},"utf8"))});process.stdout.write("ready\\n");process.once("SIGTERM",()=>runtime.close());`,
        ]
      : [
          runtimeEntry,
          "--state",
          join(dir, "state"),
          "--socket",
          socket,
          ...Object.entries(options).flatMap(([k, v]) => [`--${k}`, String(v)]),
        ];
    const process = spawn("node", argv, { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((r, j) => {
      process.stdout.once("data", () => r());
      process.once("exit", (c) => j(new Error(`Runtime exited ${c}`)));
      process.stderr.on("data", (d) => j(new Error(d.toString())));
    });
    return {
      close: () =>
        new Promise<void>((r) => {
          process.once("exit", () => r());
          process.kill("SIGTERM");
        }),
    };
  };
  let runtime = await launch();
  const client = createClient({ socket });
  const identity = {
    kind: "pi",
    nativeId: randomUUID(),
    sessionPath: join(dir, "pi.jsonl"),
    checkout,
  };
  const epoch = randomUUID();
  const attached = await client.request("session.attach", { identity, epoch });
  const sessionId = attached.sessionId;
  const call = (method: string, params = {}) =>
    client.request(method, { sessionId, epoch, ...params });
  return {
    dir,
    checkout,
    socket,
    client,
    call,
    identity,
    epoch,
    sessionId,
    runtimeEntry,
    advance: async (now: number) => writeFile(clock, String(now)),
    restart: async () => {
      await runtime.close();
      runtime = await launch();
    },
    close: async () => {
      await runtime.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("group reviews retain provenance through failure and restart without attributing the cumulative task", async () => {
  const f = await fixture();
  const requestGroup = {
    mode: "all",
    requests: [
      { id: "human", source: "interactive", delivery: "followUp" },
      { id: "feedback", source: "extension", delivery: "followUp", correlationId: "batch" },
    ],
  };
  try {
    await f.call("request.begin", { requestId: "group", requestGroup });
    await writeFile(join(f.checkout, "tracked.txt"), "failed group work\n");
    await f.call("request.complete", { requestId: "group", outcome: "failed" });
    const failed = await f.call("review.get");
    expect(failed).toMatchObject({
      requestId: "group",
      requestGroup,
      outcome: "failed",
      label: "changes observed during intentional Pi all-mode group: 2 user requests",
    });
    expect((await f.call("review.get", { selection: "cumulative" })).requestGroup).toBeUndefined();
    await f.call("request.begin", { requestId: "resumed-group", requestGroup });
    await writeFile(join(f.checkout, "tracked.txt"), "interrupted group work\n");
    await f.restart();
    const interrupted = await f.call("review.get");
    expect(interrupted).toMatchObject({
      requestId: "resumed-group",
      requestGroup,
      outcome: "interrupted",
      label: "changes observed during intentional Pi all-mode group: 2 user requests",
    });
    expect(Buffer.from(interrupted.changes[0].before.content, "base64").toString()).toBe(
      "failed group work\n",
    );
    expect((await f.call("review.status")).latestRequestGroup).toEqual(requestGroup);
    expect(await f.call("review.get", { reviewId: failed.id })).toEqual(failed);
  } finally {
    await f.close();
  }
});

test("group binding retains the prearmed feedback baseline and rejects ambiguous member identity", async () => {
  const f = await fixture();
  const requestGroup = {
    mode: "all",
    requests: [
      { id: "feedback-native", source: "extension", delivery: "followUp", correlationId: "batch" },
      { id: "human-native", source: "interactive", delivery: "followUp" },
    ],
  };
  try {
    await f.call("request.begin", { requestId: "batch" });
    await writeFile(join(f.checkout, "tracked.txt"), "work after feedback prearm\n");
    await expect(
      f.call("request.bind", {
        expectedRequestId: "batch",
        requestId: "group-native",
        requestGroup: {
          ...requestGroup,
          requests: [requestGroup.requests[0], requestGroup.requests[0]],
        },
      }),
    ).rejects.toThrow("distinct");
    expect((await f.call("review.status")).active.requestId).toBe("batch");
    await f.call("request.bind", {
      expectedRequestId: "batch",
      requestId: "group-native",
      requestGroup,
    });
    await f.call("request.begin", { requestId: "group-native", requestGroup });
    await expect(f.call("request.begin", { requestId: "group-native" })).rejects.toThrow("changed");
    await writeFile(join(f.checkout, "tracked.txt"), "group result\n");
    await f.call("request.complete", { requestId: "group-native", outcome: "completed" });
    const review = await f.call("review.get");
    expect(review.requestGroup).toEqual(requestGroup);
    expect(Buffer.from(review.changes[0].before.content, "base64").toString()).toBe(
      "pre-existing edit\n",
    );
    expect(Buffer.from(review.changes[0].after.content, "base64").toString()).toBe(
      "group result\n",
    );
  } finally {
    await f.close();
  }
});

test("whole native checkpoints restore composers without actionable notes and reject stale writers", async () => {
  const f = await fixture();
  try {
    await f.call("request.begin", { requestId: "checkpoint" });
    await writeFile(join(f.checkout, "tracked.txt"), "reviewed\n");
    const { reviewId } = await f.call("request.complete", {
      requestId: "checkpoint",
      outcome: "completed",
    });
    const checkpoint = {
      version: 1,
      checkoutRoot: f.checkout,
      reviewId,
      documentIdentity: "native-document",
      generation: "native-generation",
      stateRevision: 2,
      notes: [],
      draft: {
        id: "native-draft",
        fileKey: "native-file",
        hunkIndex: 0,
        side: "new",
        line: 1,
        body: "Unsent composer",
      },
      selection: { fileKey: "native-file", hunkIndex: 0, activeNoteId: null },
    };
    expect(await f.call("review.checkpoint.read", { reviewId })).toEqual({
      version: 0,
      checkpoint: null,
    });
    expect(
      await f.call("review.checkpoint.write", { reviewId, checkpoint, expectedVersion: 0 }),
    ).toEqual({ version: 1 });
    expect((await f.call("review.status")).notes).toEqual([]);
    await f.restart();
    expect(await f.call("review.checkpoint.read", { reviewId })).toEqual({
      version: 1,
      checkpoint,
    });
    expect((await f.call("review.status")).pinned).toBe(reviewId);
    await expect(
      f.call("review.checkpoint.write", {
        reviewId,
        checkpoint: { ...checkpoint, stateRevision: 0 },
        expectedVersion: 1,
      }),
    ).rejects.toThrow("revision");
    await expect(
      f.call("review.checkpoint.write", {
        reviewId,
        checkpoint: { ...checkpoint, draft: null },
        expectedVersion: 0,
      }),
    ).rejects.toThrow("conflict");
    await expect(
      f.call("review.checkpoint.write", {
        reviewId,
        checkpoint: { ...checkpoint, checkoutRoot: join(f.checkout, "nested") },
        expectedVersion: 1,
      }),
    ).rejects.toThrow("checkout");
    expect(await f.call("review.checkpoint.read", { reviewId })).toEqual({
      version: 1,
      checkpoint,
    });
    await expect(f.call("task.reset")).rejects.toThrow("pending");
    await f.call("task.reset", { discardPending: true });
    expect((await f.call("review.checkpoint.read", { reviewId })).checkpoint.draft).toBeNull();
  } finally {
    await f.close();
  }
});

test("native saved revisions pin until admitted and edits retain immutable earlier batches", async () => {
  const f = await fixture();
  const socket = join(f.dir, "state", "checkpoint-receiver.sock");
  const admitted: any[] = [];
  const receiver = createServer((c) =>
    c.once("data", (d) => {
      const r = JSON.parse(d.toString());
      if (r.method === "admission.enqueue") admitted.push(r.params);
      c.end(
        JSON.stringify({
          version: 1,
          id: r.id,
          result: r.method === "admission.check" ? { ready: true } : { state: "queued" },
        }) + "\n",
      );
    }),
  );
  await new Promise<void>((r) => receiver.listen(socket, r));
  chmodSync(socket, 0o600);
  try {
    await f.client.request("session.attach", {
      identity: f.identity,
      epoch: f.epoch,
      receiver: { socket },
    });
    await f.call("request.begin", { requestId: "native-saved" });
    await writeFile(join(f.checkout, "tracked.txt"), "original context\n");
    const { reviewId } = await f.call("request.complete", {
      requestId: "native-saved",
      outcome: "completed",
    });
    const note = {
      id: "human-native-1",
      source: "user",
      fileKey: "native-file",
      filePath: "tracked.txt",
      summary: "Prepare a handoff",
      status: "open",
      anchor: {
        preferred: { side: "new", line: 1 },
        newRange: [1, 1],
        intersectingHunkIndices: [0],
      },
      provenance: {
        filePath: "tracked.txt",
        contentIdentity: "native-content",
        newContext: ["original context"],
      },
    };
    const checkpoint = {
      version: 1,
      checkoutRoot: f.checkout,
      reviewId,
      documentIdentity: "native-document",
      generation: "native-generation",
      stateRevision: 1,
      notes: [note],
      draft: null,
      selection: { fileKey: "native-file", hunkIndex: 0, activeNoteId: note.id },
    };
    await f.call("review.checkpoint.write", { reviewId, checkpoint, expectedVersion: 0 });
    let status = await f.call("review.status");
    expect(status.notes).toHaveLength(1);
    expect(status.notes[0]).toMatchObject({
      id: note.id,
      text: "Prepare a handoff",
      state: "draft",
    });
    const original = status.notes[0];
    const batch = await f.call("batch.create", { noteIds: [original.id] });
    await f.call("batch.submit", { batchId: batch.id });
    await f.call("request.complete", { requestId: batch.id, outcome: "completed" });
    expect((await f.call("review.status")).selection).toBe("latest");
    expect((await f.call("review.checkpoint.read", { reviewId })).checkpoint.notes[0].status).toBe(
      "open",
    );
    await f.call("review.checkpoint.write", {
      reviewId,
      checkpoint: { ...checkpoint, generation: "resumed", stateRevision: 0 },
      expectedVersion: 1,
    });
    expect((await f.call("review.status")).notes).toHaveLength(1);
    await f.call("review.checkpoint.write", {
      reviewId,
      checkpoint: {
        ...checkpoint,
        stateRevision: 2,
        notes: [{ ...note, summary: "Explain before editing" }],
      },
      expectedVersion: 2,
    });
    status = await f.call("review.status");
    expect(status.selection).toBe("pinned");
    expect(status.notes.find((n: any) => n.id === original.id).state).toBe("submitted");
    const edited = status.notes.find((n: any) => n.state === "draft");
    expect(JSON.parse(edited.context).nativeNoteId).toBe(note.id);
    expect(admitted[0].batch.notes[0].text).toBe("Prepare a handoff");
    expect(admitted[0].identity).toEqual(f.identity);
    await f.call("request.begin", { requestId: "another-context" });
    await writeFile(join(f.checkout, "tracked.txt"), "another immutable context\n");
    await f.call("request.complete", { requestId: "another-context", outcome: "completed" });
    const newer = await f.call("review.get", { selection: "latest" });
    await expect(
      f.call("review.checkpoint.write", {
        reviewId: newer.id,
        checkpoint: { ...checkpoint, reviewId: newer.id },
        expectedVersion: 0,
      }),
    ).rejects.toThrow("original review");
    await expect(
      f.call("review.checkpoint.write", {
        reviewId,
        checkpoint: { ...checkpoint, notes: [note, note] },
        expectedVersion: 3,
      }),
    ).rejects.toThrow("notes");
    expect((await f.call("review.checkpoint.read", { reviewId })).version).toBe(3);
  } finally {
    await new Promise<void>((r) => receiver.close(() => r()));
    await f.close();
  }
});

test("native resolution closes only matching note revisions and preserves frozen feedback", async () => {
  const now = Date.parse("2026-10-01T00:00:00Z"),
    f = await fixture({ now }),
    socket = join(f.dir, "state", "resolution-receiver.sock");
  const admitted: any[] = [];
  const receiver = createServer((c) =>
    c.once("data", (d) => {
      const r = JSON.parse(d.toString());
      if (r.method === "admission.enqueue") admitted.push(r.params);
      c.end(
        JSON.stringify({
          version: 1,
          id: r.id,
          result: r.method === "admission.check" ? { ready: true } : { state: "queued" },
        }) + "\n",
      );
    }),
  );
  await new Promise<void>((r) => receiver.listen(socket, r));
  chmodSync(socket, 0o600);
  try {
    await f.client.request("session.attach", {
      identity: f.identity,
      epoch: f.epoch,
      receiver: { socket },
    });
    await f.call("request.begin", { requestId: "native-resolution-review" });
    await writeFile(join(f.checkout, "tracked.txt"), "original native context\n");
    const { reviewId } = await f.call("request.complete", {
      requestId: "native-resolution-review",
      outcome: "completed",
    });
    const targetOriginal = {
      filePath: "tracked.txt",
      contentIdentity: "target-original-provenance",
      newContext: ["original native context"],
    };
    const targetMoved = {
      ...targetOriginal,
      contentIdentity: "target-moved-provenance",
      newContext: ["different native source context"],
    };
    const controlProvenance = {
      filePath: "tracked.txt",
      contentIdentity: "independent-native-note",
      newContext: ["original native context"],
    };
    const nativeNote = (id: string, summary: string, provenance: unknown, status = "open") => ({
      id,
      source: "user",
      summary,
      status,
      anchor: {
        preferred: { side: "new", line: 1 },
        newRange: [1, 1],
        intersectingHunkIndices: [0],
      },
      provenance,
    });
    const writeCheckpoint = async (
      stateRevision: number,
      target: ReturnType<typeof nativeNote>,
      control: ReturnType<typeof nativeNote>,
    ) =>
      f.call("review.checkpoint.write", {
        reviewId,
        expectedVersion: stateRevision - 1,
        checkpoint: {
          version: 1,
          checkoutRoot: f.checkout,
          reviewId,
          documentIdentity: "native-document",
          generation: "native-generation",
          stateRevision,
          notes: [target, control],
          draft: null,
          selection: { fileKey: "native-file", hunkIndex: 0, activeNoteId: null },
        },
      });
    const checkpointTarget = (summary: string, provenance = targetOriginal, status = "open") =>
      nativeNote("human-target", summary, provenance, status);
    const checkpointControl = (summary = "Independent request") =>
      nativeNote("human-control", summary, controlProvenance);
    const revisions = (status: any, nativeNoteId: string) =>
      status.notes.filter((note: any) => JSON.parse(note.context).nativeNoteId === nativeNoteId);
    const context = (note: any) => JSON.parse(note.context);

    await writeCheckpoint(1, checkpointTarget("Initial target request"), checkpointControl());
    let status = await f.call("review.status");
    const original = revisions(status, "human-target")[0];
    const batch = await f.call("batch.create", { noteIds: [original.id] });
    await f.call("batch.submit", { batchId: batch.id });
    await f.call("request.complete", { requestId: batch.id, outcome: "completed" });
    status = await f.call("review.status");
    expect(revisions(status, "human-target").map((note: any) => note.state)).toEqual(["submitted"]);
    const receipt = status.batches.find((item: any) => item.id === batch.id);
    const batchPath = join(f.dir, "state", "batches", `${receipt.payload}.json`);
    const frozenBytes = await readFile(batchPath);
    const frozenBatch = JSON.parse(frozenBytes.toString());
    expect(admitted).toHaveLength(1);
    expect(frozenBatch.notes[0]).toMatchObject({
      id: original.id,
      text: "Initial target request",
      state: "draft",
      path: "tracked.txt",
      line: 1,
      side: "after",
    });
    expect(context(frozenBatch.notes[0]).provenance).toEqual(targetOriginal);
    expect(Buffer.from(frozenBatch.reviews[0].changes[0].after.content, "base64").toString()).toBe(
      "original native context\n",
    );

    await writeCheckpoint(
      2,
      checkpointTarget("Edited request, same provenance"),
      checkpointControl("Edited independent request"),
    );
    status = await f.call("review.status");
    const editedTargetRevision = revisions(status, "human-target").find(
      (note: any) => context(note).note.summary === "Edited request, same provenance",
    );
    await f.call("note.discard", { noteId: editedTargetRevision.id });
    status = await f.call("review.status");
    expect(
      revisions(status, "human-target").find((note: any) => note.id === original.id).state,
    ).toBe("submitted");
    expect(
      revisions(status, "human-target").find((note: any) => note.id === editedTargetRevision.id)
        .state,
    ).toBe("discarded");
    await writeCheckpoint(
      3,
      checkpointTarget("Moved request, new provenance", targetMoved),
      checkpointControl("Edited independent request"),
    );
    await writeCheckpoint(
      4,
      checkpointTarget("Revised moved request", targetMoved),
      checkpointControl("Edited independent request"),
    );
    status = await f.call("review.status");
    const movedTargetRevision = revisions(status, "human-target").find(
      (note: any) => context(note).note.summary === "Revised moved request",
    );
    await f.call("note.resolve", { noteId: movedTargetRevision.id });
    status = await f.call("review.status");
    const targetAtOtherProvenance = revisions(status, "human-target");
    expect(
      targetAtOtherProvenance
        .filter(
          (note: any) =>
            context(note).provenance.contentIdentity === targetOriginal.contentIdentity,
        )
        .find((note: any) => note.id === original.id).state,
    ).toBe("submitted");
    expect(
      targetAtOtherProvenance
        .filter(
          (note: any) => context(note).provenance.contentIdentity === targetMoved.contentIdentity,
        )
        .map((note: any) => note.state),
    ).toEqual(["resolved", "resolved"]);
    expect(revisions(status, "human-control").map((note: any) => note.state)).toEqual([
      "discarded",
      "draft",
    ]);

    await writeCheckpoint(
      5,
      checkpointTarget("Revised request in original provenance"),
      checkpointControl("Edited independent request"),
    );
    await writeCheckpoint(
      6,
      checkpointTarget("Revised request in original provenance", targetOriginal, "resolved"),
      checkpointControl("Edited independent request"),
    );
    status = await f.call("review.status");
    const targetRevisions = revisions(status, "human-target");
    expect(targetRevisions.map((note: any) => note.state)).toEqual([
      "resolved",
      "resolved",
      "resolved",
      "resolved",
      "resolved",
    ]);
    expect(revisions(status, "human-control").map((note: any) => note.state)).toEqual([
      "discarded",
      "draft",
    ]);
    const latestControlRevision = revisions(status, "human-control").find(
      (note: any) => context(note).note.summary === "Edited independent request",
    );
    await f.call("note.resolve", { noteId: latestControlRevision.id });
    expect(
      revisions(await f.call("review.status"), "human-control").map((note: any) => note.state),
    ).toEqual(["resolved", "resolved"]);

    await f.call("task.reset");
    expect(await readFile(batchPath)).toEqual(frozenBytes);
    await f.advance(now + 31 * 86400000);
    await f.call("maintenance.run");
    await expect(f.call("review.get", { reviewId })).rejects.toThrow("unavailable");
    expect((await f.call("review.status")).notes).toEqual([]);
  } finally {
    await new Promise<void>((r) => receiver.close(() => r()));
    await f.close();
  }
});

test("retention preserves native composers and bounds obsolete checkpoint history", async () => {
  const now = Date.parse("2026-10-01T00:00:00Z"),
    f = await fixture({ now });
  try {
    await f.call("request.begin", { requestId: "old-checkpoint" });
    await writeFile(join(f.checkout, "tracked.txt"), "old\n");
    const { reviewId } = await f.call("request.complete", {
      requestId: "old-checkpoint",
      outcome: "completed",
    });
    const checkpoint = {
      version: 1,
      checkoutRoot: f.checkout,
      reviewId,
      documentIdentity: "document",
      generation: "host",
      stateRevision: 1,
      notes: [],
      draft: { id: "draft", body: "Keep unsaved instructions" },
      selection: { fileKey: null, hunkIndex: 0, activeNoteId: null },
    };
    await f.call("review.checkpoint.write", { reviewId, checkpoint, expectedVersion: 0 });
    await f.call("request.begin", { requestId: "latest-checkpoint" });
    await writeFile(join(f.checkout, "tracked.txt"), "latest\n");
    await f.call("request.complete", { requestId: "latest-checkpoint", outcome: "completed" });
    await f.advance(now + 31 * 86400000);
    await f.call("maintenance.run");
    expect((await f.call("review.checkpoint.read", { reviewId })).checkpoint.draft.body).toBe(
      "Keep unsaved instructions",
    );
    await f.call("review.checkpoint.write", {
      reviewId,
      checkpoint: { ...checkpoint, stateRevision: 2, draft: null },
      expectedVersion: 1,
    });
    await f.call("task.reset");
    await f.call("maintenance.run");
    expect((await f.call("review.status")).checkpoints).toEqual({});
  } finally {
    await f.close();
  }
});

test("public checkpoint transport preserves native context above one MiB and rejects oversize without changing durable state", async () => {
  const f = await fixture();
  try {
    await f.call("request.begin", { requestId: "large-checkpoint" });
    const source = "original native source context ".repeat(400);
    await writeFile(join(f.checkout, "tracked.txt"), source);
    const { reviewId } = await f.call("request.complete", {
      requestId: "large-checkpoint",
      outcome: "completed",
    });
    const checkpoint = {
      version: 1,
      checkoutRoot: f.checkout,
      reviewId,
      documentIdentity: "large-document",
      generation: "host",
      stateRevision: 101,
      notes: Array.from({ length: 101 }, (_, i) => ({
        id: `native-${i}`,
        source: "user",
        summary: `Explain native request ${i}`,
        status: "open",
        anchor: { preferred: { side: "new", line: 1 } },
        provenance: {
          filePath: "tracked.txt",
          contentIdentity: "native-content",
          newContext: [source],
        },
      })),
      draft: null,
      selection: { fileKey: null, hunkIndex: 0, activeNoteId: null },
    };
    expect(Buffer.byteLength(JSON.stringify(checkpoint))).toBeGreaterThan(1024 * 1024);
    expect(
      await f.call("review.checkpoint.write", { reviewId, checkpoint, expectedVersion: 0 }),
    ).toEqual({ version: 1 });
    await f.restart();
    expect((await f.call("review.checkpoint.read", { reviewId })).checkpoint).toEqual(checkpoint);
    await expect(
      f.call("review.checkpoint.write", {
        reviewId,
        checkpoint: {
          ...checkpoint,
          notes: Array.from({ length: 500 }, (_, i) => ({
            ...checkpoint.notes[0],
            id: `native-${i}`,
          })),
        },
        expectedVersion: 1,
      }),
    ).rejects.toThrow();
    expect((await f.call("review.checkpoint.read", { reviewId })).version).toBe(1);
    expect((await f.call("review.status")).notes).toHaveLength(101);
  } finally {
    await f.close();
  }
});

test("unknown admission permits only a reconciled explicit risk-confirmed retry to the original receiver", async () => {
  const f = await fixture();
  const socket = join(f.dir, "state", "unknown.sock");
  let enqueues = 0,
    identityValid = true;
  const identities: any[] = [];
  const receiver = createServer((c) =>
    c.once("data", (d) => {
      const r = JSON.parse(d.toString());
      identities.push(r.params.identity);
      if (r.method === "admission.enqueue") enqueues++;
      c.end(
        JSON.stringify({
          version: 1,
          id: r.id,
          result:
            r.method === "admission.check"
              ? {
                  ready: identityValid,
                  state: identityValid ? "idle" : "blocked",
                  reason: "Original receiver identity invalid",
                }
              : r.method === "admission.reconcile"
                ? { state: "unknown" }
                : { state: enqueues === 1 ? "unknown" : "queued" },
        }) + "\n",
      );
    }),
  );
  await new Promise<void>((r) => receiver.listen(socket, r));
  chmodSync(socket, 0o600);
  try {
    await f.client.request("session.attach", {
      identity: f.identity,
      epoch: f.epoch,
      receiver: { socket },
    });
    await f.call("request.begin", { requestId: "unknown" });
    await writeFile(join(f.checkout, "tracked.txt"), "review\n");
    const { reviewId } = await f.call("request.complete", {
      requestId: "unknown",
      outcome: "completed",
    });
    const note = await f.call("note.save", { reviewId, note: { text: "Explain this" } });
    const batch = await f.call("batch.create", { noteIds: [note.id] });
    expect((await f.call("batch.submit", { batchId: batch.id })).state).toBe("uncertain");
    await expect(
      f.call("batch.retry", { batchId: batch.id, confirmUncertain: true }),
    ).rejects.toThrow("Reconcile");
    expect((await f.call("batch.reconcile", { batchId: batch.id })).reconciliation).toBe("unknown");
    await expect(f.call("batch.retry", { batchId: batch.id })).rejects.toThrow("ambiguous");
    await f.call("session.idle");
    expect(enqueues).toBe(1);
    identityValid = false;
    await expect(
      f.call("batch.retry", { batchId: batch.id, confirmUncertain: true }),
    ).rejects.toThrow("receiver cannot safely retry");
    await f.call("session.idle");
    expect(enqueues).toBe(1);
    identityValid = true;
    expect((await f.call("batch.retry", { batchId: batch.id, confirmUncertain: true })).state).toBe(
      "queued",
    );
    expect(enqueues).toBe(2);
    expect(
      identities.every((identity) => JSON.stringify(identity) === JSON.stringify(f.identity)),
    ).toBe(true);
    await expect(
      f.call("batch.retry", { batchId: batch.id, confirmUncertain: true }),
    ).rejects.toThrow("already admitted");
    expect((await f.call("review.status")).notes[0].state).toBe("submitted");
  } finally {
    await new Promise<void>((r) => receiver.close(() => r()));
    await f.close();
  }
});

test("public review captures the real eligible baseline and immutable completed response", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.checkout, "untracked.txt"), "original untracked\n");
    await writeFile(join(f.checkout, "secret"), "ignored secret");
    await symlink("/etc/passwd", join(f.checkout, "link"));
    await f.call("request.begin", { requestId: "user-request-1" });
    await writeFile(join(f.checkout, "tracked.txt"), "response edit\n");
    await chmod(join(f.checkout, "tracked.txt"), 0o755);
    await rm(join(f.checkout, "untracked.txt"));
    await rm(join(f.checkout, "link"));
    await symlink("tracked.txt", join(f.checkout, "link"));
    await f.call("request.complete", { requestId: "user-request-1", outcome: "completed" });
    const review = await f.call("review.get");
    const changed = review.changes.find((c: { path: string }) => c.path === "tracked.txt");
    expect(Buffer.from(changed.before.content, "base64").toString()).toBe("pre-existing edit\n");
    expect(Buffer.from(changed.after.content, "base64").toString()).toBe("response edit\n");
    expect(changed.after.mode).toBe(0o755);
    expect(
      review.changes.find((c: { path: string }) => c.path === "untracked.txt").after,
    ).toBeNull();
    expect(review.changes.find((c: { path: string }) => c.path === "link").before.content).toBe(
      "/etc/passwd",
    );
    expect(review.changes.some((c: { path: string }) => c.path === "secret")).toBe(false);
    await writeFile(join(f.checkout, "tracked.txt"), "later work\n");
    expect(await f.call("review.get", { reviewId: review.id })).toEqual(review);
    expect(review.label).toBe("changes observed during this response");
  } finally {
    await f.close();
  }
});

test("public snapshots retain tracked __proto__ files", async () => {
  const f = await fixture();
  try {
    const path = join(f.checkout, "__proto__");
    await writeFile(path, "tracked before\n");
    execFileSync("git", ["-C", f.checkout, "add", "--", "__proto__"]);
    await f.call("request.begin", { requestId: "tracked-prototype-name" });
    await writeFile(path, "tracked after\n");
    await f.call("request.complete", {
      requestId: "tracked-prototype-name",
      outcome: "completed",
    });
    await f.restart();
    const review = await f.call("review.get");
    expect(review.changes).toHaveLength(1);
    expect(review.changes[0].path).toBe("__proto__");
    expect(Buffer.from(review.changes[0].before.content, "base64").toString()).toBe(
      "tracked before\n",
    );
    expect(Buffer.from(review.changes[0].after.content, "base64").toString()).toBe(
      "tracked after\n",
    );
    const cumulative = await f.call("review.get", { selection: "cumulative" });
    expect(cumulative.changes.map((change: any) => change.path)).toEqual(["__proto__"]);
  } finally {
    await f.close();
  }
});

test("public snapshots retain nonignored untracked __proto__ files", async () => {
  const f = await fixture();
  try {
    const path = join(f.checkout, "__proto__");
    await writeFile(path, "untracked before\n");
    expect(
      execFileSync("git", ["-C", f.checkout, "ls-files", "--", "__proto__"], {
        encoding: "utf8",
      }),
    ).toBe("");
    expect(
      execFileSync("git", ["-C", f.checkout, "status", "--short", "--", "__proto__"], {
        encoding: "utf8",
      }),
    ).toContain("?? __proto__");
    await f.call("request.begin", { requestId: "untracked-prototype-name" });
    await writeFile(path, "untracked after\n");
    await f.call("request.complete", {
      requestId: "untracked-prototype-name",
      outcome: "completed",
    });
    await f.restart();
    const review = await f.call("review.get");
    expect(review.changes).toHaveLength(1);
    expect(review.changes[0].path).toBe("__proto__");
    expect(Buffer.from(review.changes[0].before.content, "base64").toString()).toBe(
      "untracked before\n",
    );
    expect(Buffer.from(review.changes[0].after.content, "base64").toString()).toBe(
      "untracked after\n",
    );
    const cumulative = await f.call("review.get", { selection: "cumulative" });
    expect(cumulative.changes.map((change: any) => change.path)).toEqual(["__proto__"]);
  } finally {
    await f.close();
  }
});

test("public snapshots handle constructor and toString additions and deletions", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.checkout, "constructor"), "constructor before\n");
    await writeFile(join(f.checkout, "toString"), "toString before\n");
    execFileSync("git", ["-C", f.checkout, "add", "--", "constructor", "toString"]);

    await f.call("request.begin", { requestId: "delete-prototype-properties" });
    await rm(join(f.checkout, "constructor"));
    await writeFile(join(f.checkout, "toString"), "toString changed\n");
    await f.call("request.complete", {
      requestId: "delete-prototype-properties",
      outcome: "completed",
    });
    await f.restart();
    const deleted = await f.call("review.get");
    expect(deleted.changes.map((change: any) => change.path)).toEqual(["constructor", "toString"]);
    expect(
      Buffer.from(
        deleted.changes.find((change: any) => change.path === "constructor").before.content,
        "base64",
      ).toString(),
    ).toBe("constructor before\n");
    expect(deleted.changes.find((change: any) => change.path === "constructor").after).toBeNull();
    expect(
      Buffer.from(
        deleted.changes.find((change: any) => change.path === "toString").after.content,
        "base64",
      ).toString(),
    ).toBe("toString changed\n");

    await f.call("request.begin", { requestId: "add-prototype-properties" });
    await writeFile(join(f.checkout, "constructor"), "constructor after\n");
    await rm(join(f.checkout, "toString"));
    await f.call("request.complete", {
      requestId: "add-prototype-properties",
      outcome: "completed",
    });
    await f.restart();
    const added = await f.call("review.get");
    expect(added.changes.map((change: any) => change.path)).toEqual(["constructor", "toString"]);
    expect(added.changes.find((change: any) => change.path === "constructor").before).toBeNull();
    expect(
      Buffer.from(
        added.changes.find((change: any) => change.path === "constructor").after.content,
        "base64",
      ).toString(),
    ).toBe("constructor after\n");
    expect(
      Buffer.from(
        added.changes.find((change: any) => change.path === "toString").before.content,
        "base64",
      ).toString(),
    ).toBe("toString changed\n");
    expect(added.changes.find((change: any) => change.path === "toString").after).toBeNull();
    const cumulative = await f.call("review.get", { selection: "cumulative" });
    expect(cumulative.changes.map((change: any) => change.path)).toEqual([
      "constructor",
      "toString",
    ]);
    expect(
      Buffer.from(
        cumulative.changes.find((change: any) => change.path === "constructor").before.content,
        "base64",
      ).toString(),
    ).toBe("constructor before\n");
    expect(
      Buffer.from(
        cumulative.changes.find((change: any) => change.path === "constructor").after.content,
        "base64",
      ).toString(),
    ).toBe("constructor after\n");
    expect(cumulative.changes.find((change: any) => change.path === "toString").after).toBeNull();
  } finally {
    await f.close();
  }
});

test("other history expires at 30 days including discarded batches and closed notes", async () => {
  const now = Date.parse("2026-10-01T00:00:00Z"),
    f = await fixture({ now });
  try {
    await f.call("request.begin", { requestId: "old" });
    await writeFile(join(f.checkout, "tracked.txt"), "old change\n");
    await f.call("request.complete", { requestId: "old", outcome: "completed" });
    const old = await f.call("review.get");
    expect(old.createdAt).toBe(new Date(now).toISOString());
    const note = await f.call("note.save", {
      reviewId: old.id,
      note: { text: "Discard this task explicitly" },
    });
    await f.call("batch.create", { noteIds: [note.id] });
    await f.call("task.reset", { discardPending: true });
    await f.call("request.begin", { requestId: "current" });
    await writeFile(join(f.checkout, "tracked.txt"), "current change\n");
    await f.call("request.complete", { requestId: "current", outcome: "completed" });
    await f.advance(now + 29 * 86400000);
    await f.call("maintenance.run");
    expect((await f.call("review.get", { reviewId: old.id })).id).toBe(old.id);
    await f.advance(now + 31 * 86400000);
    await f.call("maintenance.run");
    await expect(f.call("review.get", { reviewId: old.id })).rejects.toThrow("unavailable");
    const status = await f.call("review.status");
    expect(status.notes).toHaveLength(0);
    expect(status.batches).toHaveLength(0);
    expect((await f.call("review.get")).requestId).toBe("current");
  } finally {
    await f.close();
  }
});

test("protected task and pending notes survive storage pressure and crash interruption stays visible", async () => {
  const f = await fixture({ maxBytes: 1024 });
  try {
    await f.call("request.begin", { requestId: "protected" });
    await writeFile(join(f.checkout, "tracked.txt"), "protected content ".repeat(500));
    await f.call("request.complete", { requestId: "protected", outcome: "completed" });
    const review = await f.call("review.get");
    await f.call("note.save", { reviewId: review.id, note: { text: "Keep this pending review" } });
    const maintenance = await f.call("maintenance.run");
    expect(maintenance.protectedBytes).toBeGreaterThan(1024);
    expect((await f.call("review.status")).warnings.join("\n")).toContain(
      "protected bytes exceed storage cap",
    );
    expect(await f.call("review.get", { reviewId: review.id })).toEqual(review);
    await f.call("request.begin", { requestId: "interrupted-by-runtime" });
    await writeFile(join(f.checkout, "tracked.txt"), "work before crash\n");
    await f.restart();
    expect((await f.call("review.get", { selection: "latest" })).outcome).toBe("interrupted");
    expect((await f.call("review.status")).notes[0].text).toBe("Keep this pending review");
    await f.call("note.discard", { noteId: (await f.call("review.status")).notes[0].id });
    await f.call("task.reset");
    const collected = await f.call("maintenance.run");
    expect(collected.removedReviews).toBeGreaterThan(0);
    await expect(f.call("review.get", { reviewId: review.id })).rejects.toThrow("unavailable");
  } finally {
    await f.close();
  }
});

test("first verified content change requests one no-focus right sibling and manual closure opts out", async () => {
  const f = await fixture({ pluginId: "hunk-turn-review", entrypoint: "review" });
  const herdrSocket = join(f.dir, "state", "herdr.sock");
  let opens = 0,
    exists = true,
    columns = 120;
  const requests: any[] = [];
  const herdr = createServer((c) =>
    c.once("data", (chunk) => {
      const r = JSON.parse(chunk.toString());
      requests.push(r);
      const original = {
        pane_id: "opaque-original",
        terminal_id: "terminal-original",
        workspace_id: "workspace-original",
        agent: "pi",
        cwd: f.checkout,
        foreground_cwd: f.checkout,
        agent_session: { agent: "pi", kind: "id", value: f.identity.nativeId },
      };
      let result: any;
      if (r.method === "session.snapshot")
        result = {
          snapshot: {
            version: "0.9.3",
            protocol: 22,
            agents: [original],
            panes: [
              original,
              ...(opens && exists
                ? [
                    {
                      pane_id: "opaque-review",
                      terminal_id: "terminal-review",
                      tokens: {
                        htr_actor: requests.find((r) => r.method === "plugin.pane.open")?.params.env
                          .HUNK_TURN_REVIEW_ACTOR_ID,
                      },
                    },
                  ]
                : []),
            ],
          },
        };
      else if (r.method === "plugin.list")
        result = {
          plugins: [
            {
              plugin_id: "hunk-turn-review",
              enabled: true,
              panes: [{ id: "review", command: ["hunk", "--turn-review"] }],
            },
          ],
        };
      else if (r.method === "pane.layout")
        result = { layout: { panes: [{ pane_id: "opaque-original", rect: { width: columns } }] } };
      else if (r.method === "plugin.pane.open") {
        opens++;
        exists = true;
        result = {
          plugin_pane: { pane: { pane_id: "opaque-review", terminal_id: "terminal-review" } },
        };
      } else result = { type: "ok" };
      c.end(JSON.stringify({ id: r.id, result }) + "\n");
    }),
  );
  await new Promise<void>((r) => herdr.listen(herdrSocket, r));
  chmodSync(herdrSocket, 0o600);
  try {
    await f.client.request("session.attach", {
      identity: f.identity,
      epoch: f.epoch,
      layout: { session: "htr-test", socket: herdrSocket, paneId: "opaque-original" },
    });
    await f.call("request.begin", { requestId: "readonly" });
    await f.call("request.complete", { requestId: "readonly", outcome: "completed" });
    expect(opens).toBe(0);
    await f.call("request.begin", { requestId: "editing" });
    await writeFile(join(f.checkout, "tracked.txt"), "first write\n");
    await f.call("request.reconcile");
    expect(opens).toBe(1);
    expect(requests.find((r) => r.method === "plugin.pane.open").params).toMatchObject({
      placement: "split",
      direction: "right",
      focus: false,
      target_pane_id: "opaque-original",
      entrypoint: "review",
    });
    await f.call("request.complete", { requestId: "editing", outcome: "completed" });
    expect(opens).toBe(1);
    exists = false;
    await f.call("request.begin", { requestId: "next" });
    await writeFile(join(f.checkout, "tracked.txt"), "second write\n");
    await f.call("request.reconcile");
    expect(opens).toBe(1);
    expect((await f.call("review.status")).layoutState.state).toBe("opted-out");
    await f.call("layout.reopen");
    expect(opens).toBe(2);
    await f.call("layout.reopen");
    expect(opens).toBe(2);
    const sourceSessionId = requests.find((r) => r.method === "plugin.pane.open").params.env
      .HUNK_TURN_REVIEW_SESSION_ID;
    await f.call("layout.tab");
    const last = requests.filter((r) => r.method === "plugin.pane.open").at(-1);
    expect(last.params).toMatchObject({
      plugin_id: "hunk-turn-review",
      entrypoint: "review",
      placement: "tab",
      focus: false,
      workspace_id: "workspace-original",
      cwd: f.checkout,
      env: {
        HUNK_TURN_REVIEW_SOCKET: f.socket,
        HUNK_TURN_REVIEW_SESSION_ID: f.sessionId,
      },
    });
    expect(last.params).not.toHaveProperty("target_pane_id");
    expect(last.params).not.toHaveProperty("direction");
    expect(last.params.env.HUNK_TURN_REVIEW_ACTOR_ID).toMatch(/^[0-9a-f-]{36}$/);
    expect(last.params.env.HUNK_TURN_REVIEW_SESSION_ID).toBe(sourceSessionId);
    exists = false;
    columns = 60;
    const before = opens;
    await expect(f.call("layout.reopen")).rejects.toThrow("narrow");
    expect(opens).toBe(before);
    await f.call("layout.tab");
    expect(opens).toBe(before + 1);
  } finally {
    await new Promise<void>((r) => herdr.close(() => r()));
    await f.close();
  }
});

test("explicit feedback keeps instructions and original context, reconciles uncertain admission without retry", async () => {
  const f = await fixture();
  let admissions = 0;
  let recorded: any;
  const receiverSocket = join(f.dir, "state", "pi.sock");
  const receiver = createServer((c) => {
    c.once("data", (chunk) => {
      const req = JSON.parse(chunk.toString());
      if (req.method === "admission.enqueue") {
        admissions++;
        recorded = req.params;
        c.destroy(); // Native queue accepted, but receipt connection was lost.
      } else
        c.end(
          JSON.stringify({
            version: 1,
            id: req.id,
            result:
              req.method === "admission.reconcile"
                ? {
                    state: recorded ? "queued" : "absent",
                    evidence: recorded ? "native-history" : "queue-and-history",
                  }
                : { ready: true },
          }) + "\n",
        );
    });
  });
  await new Promise<void>((r) => receiver.listen(receiverSocket, r));
  chmodSync(receiverSocket, 0o600);
  try {
    await f.client.request("session.attach", {
      identity: f.identity,
      epoch: f.epoch,
      receiver: { socket: receiverSocket },
    });
    await f.call("request.begin", { requestId: "edit" });
    await writeFile(join(f.checkout, "tracked.txt"), "reviewed change\n");
    await f.call("request.complete", { requestId: "edit", outcome: "completed" });
    const review = await f.call("review.get");
    const note = await f.call("note.save", {
      reviewId: review.id,
      note: {
        text: "Clarify why this changed; do not edit yet",
        path: "tracked.txt",
        line: 1,
        side: "after",
      },
    });
    expect(admissions).toBe(0);
    const batch = await f.call("batch.create", { noteIds: [note.id] });
    await f.call("session.idle");
    expect(admissions).toBe(0);
    expect((await f.call("review.status")).notes[0].state).toBe("draft");
    await writeFile(join(f.checkout, "tracked.txt"), "current unrelated change\n");
    expect(await f.call("batch.submit", { batchId: batch.id })).toMatchObject({
      state: "uncertain",
    });
    expect(recorded.batch.notes[0].text).toBe("Clarify why this changed; do not edit yet");
    expect(recorded.batch.reviews[0].id).toBe(review.id);
    expect(recorded.prompt).toContain("Check current code");
    await f.restart();
    expect((await f.call("batch.submit", { batchId: batch.id })).state).toBe("uncertain");
    expect(admissions).toBe(1);
    expect((await f.call("batch.reconcile", { batchId: batch.id })).state).toBe("queued");
    await expect(f.call("batch.retry", { batchId: batch.id })).rejects.toThrow("already admitted");
    expect((await f.call("review.status")).notes[0].state).toBe("submitted");
  } finally {
    await new Promise<void>((r) => receiver.close(() => r()));
    await f.close();
  }
});

test("saved notes pin immutable context across later requests and original-session resume", async () => {
  const f = await fixture();
  try {
    await f.call("request.begin", { requestId: "first" });
    await writeFile(join(f.checkout, "tracked.txt"), "first change\n");
    await f.call("request.complete", { requestId: "first", outcome: "completed" });
    const first = await f.call("review.get");
    const note = await f.call("note.save", {
      reviewId: first.id,
      note: {
        text: "Explain the behavior in a handoff document",
        path: "tracked.txt",
        side: "after",
        line: 1,
        context: "first change",
      },
    });
    await f.call("request.begin", { requestId: "second" });
    await writeFile(join(f.checkout, "tracked.txt"), "second change\n");
    await f.call("request.reconcile");
    await f.call("request.complete", { requestId: "second", outcome: "interrupted" });
    await f.restart();
    await f.client.request("session.attach", { identity: f.identity, epoch: "resumed-process" });
    expect(await f.call("review.get")).toEqual(first);
    const status = await f.call("review.status");
    expect(status.newAvailable).toBe(true);
    expect(status.notes[0]).toMatchObject({
      id: note.id,
      reviewId: first.id,
      text: "Explain the behavior in a handoff document",
      state: "draft",
    });
    const cumulative = await f.call("review.get", { selection: "cumulative" });
    expect(Buffer.from(cumulative.changes[0].before.content, "base64").toString()).toBe(
      "pre-existing edit\n",
    );
    expect(Buffer.from(cumulative.changes[0].after.content, "base64").toString()).toBe(
      "second change\n",
    );
    expect((await f.call("review.get", { selection: "latest" })).outcome).toBe("interrupted");
    await expect(f.call("task.reset")).rejects.toThrow("pending notes");
    await f.call("task.reset", { discardPending: true });
    await expect(f.call("review.get", { selection: "cumulative" })).rejects.toThrow("unavailable");
    await expect(f.call("request.begin", { requestId: "stale" })).rejects.toThrow(
      "Stale runtime epoch",
    );
  } finally {
    await f.close();
  }
});

test("submitted notes retain frozen revisions and an edited note becomes a new unsent revision", async () => {
  const f = await fixture();
  const socket = join(f.dir, "state", "revision.sock");
  let exported: any;
  const receiver = createServer((c) =>
    c.once("data", (d) => {
      const r = JSON.parse(d.toString());
      if (r.method === "admission.enqueue") exported = r.params.batch;
      c.end(
        JSON.stringify({
          version: 1,
          id: r.id,
          result: r.method === "admission.check" ? { ready: true } : { state: "queued" },
        }) + "\n",
      );
    }),
  );
  await new Promise<void>((r) => receiver.listen(socket, r));
  chmodSync(socket, 0o600);
  try {
    await f.client.request("session.attach", {
      identity: f.identity,
      epoch: f.epoch,
      receiver: { socket },
    });
    await f.call("request.begin", { requestId: "reviewed" });
    await writeFile(join(f.checkout, "tracked.txt"), "reviewed\n");
    await f.call("request.complete", { requestId: "reviewed", outcome: "completed" });
    const first = await f.call("review.get");
    const original = await f.call("note.save", {
      reviewId: first.id,
      note: { text: "Original handoff request", context: { nativeNoteId: "human-1" } },
    });
    const batch = await f.call("batch.create", { noteIds: [original.id] });
    await f.call("batch.submit", { batchId: batch.id });
    await f.call("request.complete", { requestId: batch.id, outcome: "completed" });
    expect((await f.call("review.status")).selection).toBe("latest");
    const edited = await f.call("note.save", {
      reviewId: first.id,
      note: {
        id: original.id,
        text: "Revised clarification request",
        context: { nativeNoteId: "human-1" },
      },
    });
    expect(edited.id).not.toBe(original.id);
    expect(edited.state).toBe("draft");
    expect(exported.notes[0].text).toBe("Original handoff request");
    expect((await f.call("review.status")).notes.find((n: any) => n.id === original.id).state).toBe(
      "submitted",
    );
    expect((await f.call("review.get")).id).toBe(first.id);
    await expect(
      f.call("note.save", {
        reviewId: first.id,
        note: { text: "Invalid anchor", path: "../outside" },
      }),
    ).rejects.toThrow("anchor");
  } finally {
    await new Promise<void>((r) => receiver.close(() => r()));
    await f.close();
  }
});

test("an exited original receiver publishes an interrupted interval and retains pending notes", async () => {
  const f = await fixture(),
    socket = join(f.dir, "state", "gone.sock");
  const receiver = createServer((c) =>
    c.once("data", (d) => {
      const r = JSON.parse(d.toString());
      c.end(
        JSON.stringify({ version: 1, id: r.id, result: { ready: false, reason: "busy" } }) + "\n",
      );
    }),
  );
  await new Promise<void>((r) => receiver.listen(socket, r));
  chmodSync(socket, 0o600);
  try {
    await f.client.request("session.attach", {
      identity: f.identity,
      epoch: f.epoch,
      receiver: { socket },
    });
    await f.call("request.begin", { requestId: "original-exited" });
    await writeFile(join(f.checkout, "tracked.txt"), "unfinished original work\n");
    await new Promise<void>((r) => receiver.close(() => r()));
    const end = Date.now() + 3000;
    let status;
    do {
      status = await f.call("review.status");
      if (status.latest) break;
      await new Promise((r) => setTimeout(r, 100));
    } while (Date.now() < end);
    expect(status.active).toBeUndefined();
    expect(status.receiver).toBeUndefined();
    expect((await f.call("review.get")).outcome).toBe("interrupted");
    expect(status.warnings.join("\n")).toContain("Original receiver exited");
  } finally {
    await new Promise<void>((r) => receiver.close(() => r()));
    await f.close();
  }
});

test("private state refuses a checkout target before creating anything there", async () => {
  const f = await fixture(),
    state = join(f.checkout, "forbidden-state");
  try {
    const child = spawn(
      "node",
      [f.runtimeEntry, "--state", state, "--socket", join(state, "r.sock")],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let warning = "";
    child.stderr.on("data", (d) => (warning += d));
    await new Promise((r) => child.once("exit", r));
    expect(warning).toContain("outside every Git checkout");
    await expect(access(state)).rejects.toThrow();
  } finally {
    await f.close();
  }
});

test("public note transport preserves Unicode across socket chunk boundaries", async () => {
  const f = await fixture();
  try {
    await f.call("request.begin", { requestId: "unicode" });
    await writeFile(join(f.checkout, "tracked.txt"), "new\n");
    await f.call("request.complete", { requestId: "unicode", outcome: "completed" });
    const review = await f.call("review.get"),
      text = "😀é文".repeat(25000);
    expect((await f.call("note.save", { reviewId: review.id, note: { text } })).text).toBe(text);
    expect((await f.call("review.status")).notes[0].text).toBe(text);
  } finally {
    await f.close();
  }
});

test("a native session started in a subdirectory reviews the entire canonical checkout", async () => {
  const f = await fixture(),
    subdir = join(f.checkout, "nested");
  try {
    await mkdir(subdir);
    const attached = await f.client.request("session.attach", {
      identity: { ...f.identity, checkout: subdir },
      epoch: f.epoch,
    });
    expect(attached.identity.checkout).toBe(f.checkout);
    await f.client.request("request.begin", {
      sessionId: attached.sessionId,
      epoch: f.epoch,
      requestId: "nested",
    });
    await writeFile(join(f.checkout, "tracked.txt"), "root changed by nested session\n");
    await f.client.request("request.complete", {
      sessionId: attached.sessionId,
      epoch: f.epoch,
      requestId: "nested",
      outcome: "completed",
    });
    expect(
      (await f.client.request("review.get", { sessionId: attached.sessionId })).changes[0].path,
    ).toBe("tracked.txt");
  } finally {
    await f.close();
  }
});

test("a fresh epoch cannot replace a living original receiver and resume is allowed after exit", async () => {
  const f = await fixture(),
    socket = join(f.dir, "state", "owner.sock");
  const receiver = createServer((c) =>
    c.once("data", (d) => {
      const r = JSON.parse(d.toString());
      c.end(
        JSON.stringify({
          version: 1,
          id: r.id,
          result: { ready: false, reason: "busy original" },
        }) + "\n",
      );
    }),
  );
  await new Promise<void>((r) => receiver.listen(socket, r));
  chmodSync(socket, 0o600);
  try {
    await f.client.request("session.attach", {
      identity: f.identity,
      epoch: f.epoch,
      receiver: { socket },
    });
    await f.call("request.begin", { requestId: "owned" });
    await writeFile(join(f.checkout, "tracked.txt"), "original owns this interval\n");
    await expect(
      f.client.request("session.attach", { identity: f.identity, epoch: "replacement" }),
    ).rejects.toThrow("living original");
    expect((await f.call("review.status")).active.requestId).toBe("owned");
    await f.call("request.complete", { requestId: "owned", outcome: "failed" });
    expect((await f.call("review.get")).outcome).toBe("failed");
    await new Promise<void>((r) => receiver.close(() => r()));
    const resumed = await f.client.request("session.attach", {
      identity: f.identity,
      epoch: "resumed-original",
    });
    expect(resumed.sessionId).toBe(f.sessionId);
    expect((await f.call("review.get")).outcome).toBe("failed");
    await expect(f.call("request.begin", { requestId: "old-epoch" })).rejects.toThrow(
      "Stale runtime epoch",
    );
  } finally {
    await new Promise<void>((r) => receiver.close(() => r()));
    await f.close();
  }
});
