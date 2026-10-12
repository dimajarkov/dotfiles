import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { createClient } from "../../../../.local/share/hunk-turn-review/client.mjs";
import { createSnapshotAdapter } from "./snapshot-adapter";
import {
  bindingFromEnvironment,
  pendingBatchHistory,
  registerTurnReview,
  reviewStatus,
  sendTurnReview,
  turnReviewCli,
} from "./turn-review";
import type {
  ExtensionCommandHandler,
  ExtensionReviewCheckpoint,
  ExtensionReviewSnapshot,
  ExtensionReviewPersistence,
  ExtensionVcsAdapter,
  ExtensionEventContext,
  ExtensionEventName,
  HunkExtensionAPI,
} from "hunkdiff/extension";

// Short paths leave room for macOS's canonical /private Unix-socket prefix.
const fixture = mkdtempSync("/tmp/hunk-snapshot-provider.");
let checkout = join(fixture, "checkout");
const state = join(fixture, "state");
execFileSync("mkdir", ["-m", "700", checkout, state]);
execFileSync("git", ["init", "-q", checkout]);
writeFileSync(join(checkout, "source.txt"), "original\n");
execFileSync("git", ["-C", checkout, "add", "."]);
const socket = join(state, "runtime.sock");
const client = createClient({ socket });
let runtime: ReturnType<typeof Bun.spawn>;
let sessionId: string;
const epoch = "fixture-epoch";

beforeAll(async () => {
  const built = await Bun.build({
    entrypoints: [
      resolve(import.meta.dir, "../../../../.local/share/hunk-turn-review/src/runtime.ts"),
    ],
    target: "node",
    outdir: join(fixture, "compiled"),
  });
  if (!built.success) throw new Error("Fixture runtime could not be compiled for Node");
  runtime = Bun.spawn(
    ["node", realpathSync(built.outputs[0].path), "--state", state, "--socket", socket],
    { stdout: "ignore", stderr: "pipe" },
  );
  for (let i = 0; i < 200 && !existsSync(socket); i++) await Bun.sleep(10);
  if (!existsSync(socket))
    throw new Error(
      typeof runtime.stderr === "object"
        ? await new Response(runtime.stderr).text()
        : "Runtime socket unavailable",
    );
});
beforeEach(async () => {
  checkout = mkdtempSync(join(fixture, "checkout."));
  execFileSync("git", ["init", "-q", checkout]);
  writeFileSync(join(checkout, "source.txt"), "original\n");
  execFileSync("git", ["-C", checkout, "add", "."]);
  const attached = await client.request("session.attach", {
    identity: { kind: "codex", nativeId: "snapshot-fixture", checkout },
    epoch,
  });
  sessionId = attached.sessionId;
  await client.request("request.begin", { sessionId, epoch, requestId: "fixture-baseline" });
  writeFileSync(join(checkout, "source.txt"), "later checkout\n");
  await client.request("request.complete", {
    sessionId,
    epoch,
    requestId: "fixture-baseline",
    outcome: "completed",
  });
  writeFileSync(join(checkout, "source.txt"), "original\n");
});
afterAll(async () => {
  runtime?.kill();
  await runtime?.exited;
});

async function uncertainBatch(receiverSocket: string): Promise<string> {
  await client.request("session.attach", {
    identity: { kind: "codex", nativeId: "snapshot-fixture", checkout },
    epoch,
    receiver: { socket: receiverSocket },
  });
  const reviewed = await client.request("review.get", { sessionId });
  const note = await client.request("note.save", {
    sessionId,
    reviewId: reviewed.id,
    note: { text: "Explain this fixture" },
  });
  const batch = await client.request("batch.create", { sessionId, noteIds: [note.id] });
  expect((await client.request("batch.submit", { sessionId, batchId: batch.id })).state).toBe(
    "uncertain",
  );
  return batch.id;
}
async function persistCheckpoint(
  checkpoint: ExtensionReviewCheckpoint,
  bound = { sessionId, client },
) {
  const prior = await bound.client.request("review.checkpoint.read", {
    sessionId: bound.sessionId,
    reviewId: checkpoint.reviewId,
  });
  await bound.client.request("review.checkpoint.write", {
    sessionId: bound.sessionId,
    reviewId: checkpoint.reviewId,
    checkpoint,
    expectedVersion: prior.version,
  });
}

async function newTaskFixture(suffix: string, kind: "pi" | "codex" = "codex") {
  const attached = await client.request("session.attach", {
    identity: { kind, nativeId: `new-task-${suffix}`, checkout },
    epoch,
  });
  sessionId = attached.sessionId;
  await client.request("request.begin", {
    sessionId,
    epoch,
    requestId: `baseline-${suffix}`,
  });
  writeFileSync(join(checkout, "source.txt"), `first task ${suffix}\n`);
  await client.request("request.complete", {
    sessionId,
    epoch,
    requestId: `baseline-${suffix}`,
    outcome: "completed",
  });
  writeFileSync(join(checkout, "source.txt"), "original\n");
}

async function invokeNewTaskMenu(confirmed: boolean, hasDraft = false) {
  let handler: ExtensionCommandHandler | undefined;
  let menuOptions: readonly string[] = [];
  const confirmations: {
    title: string;
    body?: string;
    confirmLabel?: string;
    cancelLabel?: string;
  }[] = [];
  const messages: string[] = [];
  const current = await client.request("review.get", { sessionId, selection: "latest" });
  const snapshot: ExtensionReviewSnapshot = {
    generation: "menu-fixture",
    stateRevision: 1,
    files: [],
    notes: [],
  };
  const checkpoint: ExtensionReviewCheckpoint = {
    version: 1,
    checkoutRoot: realpathSync(checkout),
    reviewId: current.id,
    documentIdentity: "menu-fixture",
    generation: snapshot.generation,
    stateRevision: snapshot.stateRevision,
    notes: [],
    draft: hasDraft
      ? {
          id: "in-progress-draft",
          fileKey: "fixture-file",
          hunkIndex: 0,
          side: "new",
          line: 1,
          body: "Keep this draft",
        }
      : null,
    selection: { fileKey: null, hunkIndex: 0, activeNoteId: null },
  };
  registerTurnReview(
    {
      apiVersion: 29,
      registerReviewPersistence() {},
      registerVcsAdapter() {},
      registerCliCommand() {},
      registerCommand(_command, value) {
        handler = value;
      },
      on() {},
    },
    { sessionId, client },
  );
  if (!handler) throw new Error("Missing public Hunk actions command");
  const context = {
    cwd: checkout,
    review: { snapshot: () => snapshot, checkpoint: () => checkpoint },
    dialogs: {
      async select({ options }: { options: readonly string[] }) {
        menuOptions = options;
        return "Start a new review task";
      },
      async confirm(options: (typeof confirmations)[number]) {
        confirmations.push(options);
        return confirmed;
      },
    },
    notify(message: string) {
      messages.push(message);
    },
  };
  await Reflect.apply(handler, undefined, [context]);
  return { menuOptions, confirmations, messages };
}

test("trusted environment binding works with the private runtime socket in the Hunk Bun host", async () => {
  const previousSocket = process.env.HUNK_TURN_REVIEW_SOCKET;
  const previousSession = process.env.HUNK_TURN_REVIEW_SESSION_ID;
  process.env.HUNK_TURN_REVIEW_SOCKET = socket;
  process.env.HUNK_TURN_REVIEW_SESSION_ID = sessionId;
  try {
    const bound = bindingFromEnvironment();
    if (!bound) throw new Error("Binding unavailable");
    const status = await bound.client.request("review.status", { sessionId: bound.sessionId });
    expect(status).toMatchObject({
      identity: { nativeId: "snapshot-fixture", checkout: realpathSync(checkout) },
    });
  } finally {
    if (previousSocket === undefined) delete process.env.HUNK_TURN_REVIEW_SOCKET;
    else process.env.HUNK_TURN_REVIEW_SOCKET = previousSocket;
    if (previousSession === undefined) delete process.env.HUNK_TURN_REVIEW_SESSION_ID;
    else process.env.HUNK_TURN_REVIEW_SESSION_ID = previousSession;
  }
});

test("first-edit review stays registered while waiting and loads only a completed immutable response", async () => {
  const attached = await client.request("session.attach", {
    identity: { kind: "codex", nativeId: "waiting-fixture", checkout },
    epoch,
  });
  const bound = { sessionId: attached.sessionId, client };
  await client.request("request.begin", {
    sessionId: bound.sessionId,
    epoch,
    requestId: "initial-response",
  });
  writeFileSync(join(checkout, "waiting.txt"), "still working\n");
  const terminal = {
    cwd: checkout,
    signal: new AbortController().signal,
    stdin: {
      [Symbol.asyncIterator]() {
        throw new Error("Unexpected terminal input");
      },
    },
    stdout: {
      async write() {
        throw new Error("Unexpected terminal output");
      },
    },
    stderr: { async write() {} },
  };
  expect(await turnReviewCli(bound, [], terminal)).toEqual({
    kind: "delegate",
    argv: ["diff", "--vcs", "turn-review"],
  });
  const operation = createSnapshotAdapter(bound).operations?.["working-tree-diff"];
  if (!operation) throw new Error("Missing public snapshot operation");
  const waiting = await operation.load(
    { kind: "vcs", staged: false, options: {} },
    { cwd: checkout },
  );
  expect(waiting.repoRoot).toBe(realpathSync(checkout));
  expect(waiting.sourceLabel).toBe(realpathSync(checkout));
  expect(waiting.title).toContain("Waiting for first completed response");
  expect(waiting.patchText).toBe("");
  expect(
    await waiting.readFileSource?.({
      path: "waiting.txt",
      side: "new",
      changeType: "new",
      isUntracked: false,
    }),
  ).toBeNull();
  const completed = await client.request("request.complete", {
    sessionId: bound.sessionId,
    epoch,
    requestId: "initial-response",
    outcome: "completed",
  });
  const reviewed = await operation.load(
    { kind: "vcs", staged: false, options: {} },
    { cwd: checkout },
  );
  expect(reviewed.title).toContain(completed.reviewId);
  expect(reviewed.patchText).toContain("+still working");
  expect(reviewed.sourceCacheKey).not.toBe(waiting.sourceCacheKey);
});

test("explicit turn provider registers canonical root and reads immutable captured source after checkout changes", async () => {
  await client.request("request.begin", { sessionId, epoch, requestId: "first" });
  writeFileSync(join(checkout, "source.txt"), "completed turn\n");
  await client.request("request.complete", {
    sessionId,
    epoch,
    requestId: "first",
    outcome: "completed",
  });
  const provider = createSnapshotAdapter({ sessionId, client });
  expect(provider.detect(checkout)).toBeNull();
  const operation = provider.operations?.["working-tree-diff"];
  if (!operation) throw new Error("Missing public snapshot operation");
  const loaded = await operation.load(
    { kind: "vcs", staged: false, options: {} },
    { cwd: checkout },
  );
  writeFileSync(join(checkout, "source.txt"), "later checkout\n");
  expect(loaded.repoRoot).toBe(realpathSync(checkout));
  expect(loaded.sourceLabel).toBe(realpathSync(checkout));
  expect(loaded.title).toContain("changes observed during this response");
  expect(loaded.patchText).toContain("-original\n+completed turn");
  expect(
    await loaded.readFileSource?.({
      path: "source.txt",
      side: "old",
      changeType: "change",
      isUntracked: false,
    }),
  ).toBe("original\n");
  expect(
    await loaded.readFileSource?.({
      path: "source.txt",
      side: "new",
      changeType: "change",
      isUntracked: false,
    }),
  ).toBe("completed turn\n");
});

test("additions and deletions use captured absent sides, including exact unusual paths and empty files", async () => {
  await client.request("request.begin", { sessionId, epoch, requestId: "second" });
  unlinkSync(join(checkout, "source.txt"));
  writeFileSync(join(checkout, 'a space\nquote".txt'), "without final newline");
  writeFileSync(join(checkout, "empty.txt"), "");
  await client.request("request.complete", {
    sessionId,
    epoch,
    requestId: "second",
    outcome: "interrupted",
  });
  const op = createSnapshotAdapter({ sessionId, client }).operations?.["working-tree-diff"];
  if (!op) throw new Error("Missing snapshot operation");
  const loaded = await op.load({ kind: "vcs", staged: false, options: {} }, { cwd: checkout });
  expect(loaded.title).toContain("interrupted");
  expect(loaded.patchText).toContain("new file mode 100644");
  expect(loaded.patchText).toContain("deleted file mode 100644");
  expect(loaded.patchText).toContain("\\ No newline at end of file");
  expect(loaded.patchText).toContain('"b/a space\\nquote\\\".txt"');
  expect(
    await loaded.readFileSource?.({
      path: "empty.txt",
      side: "new",
      changeType: "new",
      isUntracked: true,
    }),
  ).toBe("");
  expect(
    await loaded.readFileSource?.({
      path: "source.txt",
      side: "new",
      changeType: "deleted",
      isUntracked: false,
    }),
  ).toBeNull();
  const stable = await op.load({ kind: "vcs", staged: false, options: {} }, { cwd: checkout });
  expect(stable.sourceCacheKey).toBe(loaded.sourceCacheKey);
});

test("turn review command delegates once to the explicit provider without consuming terminal input or stdout", async () => {
  const result = await turnReviewCli({ sessionId, client }, [], {
    cwd: checkout,
    signal: new AbortController().signal,
    stdin: {
      [Symbol.asyncIterator]() {
        throw new Error("Terminal input was consumed");
      },
    },
    stdout: {
      async write() {
        throw new Error("Terminal output was consumed");
      },
    },
    stderr: { async write() {} },
  });
  expect(result).toEqual({ kind: "delegate", argv: ["diff", "--vcs", "turn-review"] });
});

test("owned review registration exposes only the bound snapshot and explicit review actions", () => {
  const surfaces: string[] = [];
  registerTurnReview(
    {
      apiVersion: 29,
      registerReviewPersistence() {
        surfaces.push("persistence");
      },
      registerVcsAdapter(adapter) {
        surfaces.push(`vcs:${adapter.id}`);
      },
      registerCliCommand(command) {
        surfaces.push(`cli:${command.name}`);
      },
      registerCommand(command) {
        surfaces.push(`action:${command.id}`);
      },
      on() {},
    },
    { sessionId, client },
  );
  expect(surfaces).toEqual(["vcs:turn-review", "persistence", "cli:turn-review", "action:actions"]);
});

test("public persistence opens the exact loaded snapshot when latest changes during open and acknowledges durable composer state", async () => {
  let persistence: ExtensionReviewPersistence | undefined;
  let adapter: ExtensionVcsAdapter | undefined;
  registerTurnReview(
    {
      apiVersion: 29,
      registerVcsAdapter(value) {
        adapter = value;
      },
      registerReviewPersistence(value) {
        persistence = value;
      },
      registerCliCommand() {},
      registerCommand() {},
      on() {},
    },
    { sessionId, client },
  );
  const first = await client.request("review.get", { sessionId });
  const operation = adapter?.operations?.["working-tree-diff"];
  if (!operation) throw new Error("Missing snapshot provider");
  const loaded = await operation.load(
    { kind: "vcs", staged: false, options: {} },
    { cwd: checkout },
  );
  await client.request("request.begin", { sessionId, epoch, requestId: "newer-open" });
  writeFileSync(join(checkout, "source.txt"), "newer\n");
  await client.request("request.complete", {
    sessionId,
    epoch,
    requestId: "newer-open",
    outcome: "completed",
  });
  if (!persistence) throw new Error("Missing public persistence port");
  const opened = await persistence.open({
    checkoutRoot: realpathSync(checkout),
    sourceLabel: loaded.sourceLabel,
    documentIdentity: "document",
    files: [],
  });
  expect(opened?.reviewId).toBe(first.id);
  const checkpoint: ExtensionReviewCheckpoint = {
    version: 1,
    checkoutRoot: realpathSync(checkout),
    reviewId: first.id,
    documentIdentity: "document",
    generation: "host",
    stateRevision: 1,
    notes: [],
    draft: {
      id: "draft",
      fileKey: "file",
      hunkIndex: 0,
      side: "new",
      line: 1,
      body: "Still composing",
    },
    selection: { fileKey: "file", hunkIndex: 0, activeNoteId: null },
  };
  await persistence.write(checkpoint);
  expect(
    (await client.request("review.checkpoint.read", { sessionId, reviewId: first.id })).checkpoint,
  ).toEqual(checkpoint);
  expect((await client.request("review.status", { sessionId })).notes).toEqual([]);
  expect(
    (
      await persistence.open({
        checkoutRoot: realpathSync(checkout),
        sourceLabel: loaded.sourceLabel,
        documentIdentity: "document",
        files: [],
      })
    )?.checkpoint,
  ).toEqual(checkpoint);
});

test("an unavailable explicit review selection preserves the previously pinned original review", async () => {
  const attached = await client.request("session.attach", {
    identity: { kind: "codex", nativeId: "selection-fixture", checkout },
    epoch,
  });
  const bound = { sessionId: attached.sessionId, client };
  await client.request("request.begin", {
    sessionId: bound.sessionId,
    epoch,
    requestId: "read-only-response",
  });
  const reviewed = await client.request("request.complete", {
    sessionId: bound.sessionId,
    epoch,
    requestId: "read-only-response",
    outcome: "completed",
  });
  await client.request("review.pin", { sessionId: bound.sessionId, reviewId: reviewed.reviewId });
  await expect(
    turnReviewCli(bound, ["cumulative"], {
      cwd: checkout,
      signal: new AbortController().signal,
      stdin: {
        [Symbol.asyncIterator]() {
          throw new Error("Unexpected terminal input");
        },
      },
      stdout: {
        async write() {
          throw new Error("Unexpected terminal output");
        },
      },
      stderr: { async write() {} },
    }),
  ).rejects.toThrow("Review unavailable");
  const status = await client.request("review.status", { sessionId: bound.sessionId });
  expect(status.selection).toBe("pinned");
  expect(status.pinned).toBe(reviewed.reviewId);
});

test("explicit Send review freezes only saved human requests and holds safely when the original receiver is unavailable", async () => {
  const reviewed = await client.request("review.get", { sessionId });
  const saved: ExtensionReviewSnapshot = {
    generation: "native-generation",
    stateRevision: 1,
    files: [],
    notes: [
      {
        id: "native-note",
        source: "user",
        fileKey: "retired-file",
        filePath: "source.txt",
        fileAvailability: "unavailable",
        anchor: {
          oldRange: [1, 1],
          preferred: { side: "old", line: 1 },
          intersectingHunkIndices: [],
        },
        summary: "Explain the deletion and prepare a handoff",
        editable: true,
        resolution: "orphaned",
      },
    ],
  };
  const checkpoint: ExtensionReviewCheckpoint = {
    version: 1,
    checkoutRoot: realpathSync(checkout),
    reviewId: reviewed.id,
    documentIdentity: "document",
    generation: saved.generation,
    stateRevision: 1,
    notes: saved.notes.map((note) => ({
      ...note,
      provenance: {
        filePath: "source.txt",
        contentIdentity: "original",
        oldContext: ["later checkout"],
      },
    })),
    draft: {
      id: "unsaved",
      fileKey: "file",
      hunkIndex: 0,
      side: "new",
      line: 1,
      body: "Do not send draft",
    },
    selection: { fileKey: null, hunkIndex: 0, activeNoteId: null },
  };
  const messages: string[] = [];
  const previousState = process.env.HUNK_HUMAN_REVIEW_STATE_DIRECTORY;
  process.env.HUNK_HUMAN_REVIEW_STATE_DIRECTORY = join(fixture, "exports");
  try {
    await expect(
      sendTurnReview(
        { sessionId, client },
        {
          cwd: checkout,
          review: { snapshot: () => saved, checkpoint: () => checkpoint },
          dialogs: {
            async select() {
              return null;
            },
            async input() {
              return null;
            },
            async confirm() {
              return true;
            },
          },
          notify() {},
          statusLine: { set() {}, clear() {} },
        },
      ),
    ).rejects.toThrow("durable checkpoint");
    await persistCheckpoint(checkpoint);
    await sendTurnReview(
      { sessionId, client },
      {
        cwd: checkout,
        review: { snapshot: () => saved, checkpoint: () => checkpoint },
        dialogs: {
          async select() {
            return null;
          },
          async input() {
            return null;
          },
          async confirm() {
            return true;
          },
        },
        notify(message) {
          messages.push(message);
        },
        statusLine: { set() {}, clear() {} },
      },
    );
  } finally {
    if (previousState === undefined) delete process.env.HUNK_HUMAN_REVIEW_STATE_DIRECTORY;
    else process.env.HUNK_HUMAN_REVIEW_STATE_DIRECTORY = previousState;
  }
  const status = await client.request("review.status", { sessionId });
  expect(status.notes).toHaveLength(1);
  expect(status.notes[0].text).toBe("Explain the deletion and prepare a handoff");
  expect(JSON.parse(status.notes[0].context).note.resolution).toBe("orphaned");
  expect(status.batches[0].state).toBe("blocked");
  expect(messages.join("\n")).toContain("blocked");
  expect(status.notes[0].state).not.toBe("resolved");
});

test("review status identifies the original native session and distinguishes retained blocked admission from note resolution", async () => {
  const attached = await client.request("session.attach", {
    identity: { kind: "codex", nativeId: "status-fixture", checkout },
    epoch,
  });
  const bound = { sessionId: attached.sessionId, client };
  await client.request("request.begin", {
    sessionId: bound.sessionId,
    epoch,
    requestId: "status-response",
  });
  writeFileSync(join(checkout, "status.txt"), "status context\n");
  const reviewed = await client.request("request.complete", {
    sessionId: bound.sessionId,
    epoch,
    requestId: "status-response",
    outcome: "completed",
  });
  const note = await client.request("note.save", {
    sessionId: bound.sessionId,
    reviewId: reviewed.reviewId,
    note: { text: "Explain the status" },
  });
  const batch = await client.request("batch.create", {
    sessionId: bound.sessionId,
    noteIds: [note.id],
  });
  await client.request("batch.submit", { sessionId: bound.sessionId, batchId: batch.id });
  let body = "";
  await reviewStatus(bound, {
    dialogs: {
      async select() {
        return null;
      },
      async input() {
        return null;
      },
      async confirm(options) {
        body = options.body ?? "";
        return false;
      },
    },
    notify() {},
    statusLine: { set() {}, clear() {} },
  });
  expect(body).toContain("Native session: codex:status-fixture");
  expect(body).toContain(realpathSync(checkout));
  expect(body).toContain("blocked");
  expect(body).toContain("admission only");
  expect(body).toContain("unresolved");
});

test("reconciliation does not resubmit an unchanged human revision, while editing retains the original immutable batch", async () => {
  const attached = await client.request("session.attach", {
    identity: { kind: "codex", nativeId: "human-revision-fixture", checkout },
    epoch,
  });
  const bound = { sessionId: attached.sessionId, client };
  await client.request("request.begin", {
    sessionId: bound.sessionId,
    epoch,
    requestId: "human-revision",
  });
  writeFileSync(join(checkout, "revision.txt"), "original reviewed source\n");
  const completed = await client.request("request.complete", {
    sessionId: bound.sessionId,
    epoch,
    requestId: "human-revision",
    outcome: "completed",
  });
  let saved: ExtensionReviewSnapshot = {
    generation: "human-revision",
    stateRevision: 1,
    files: [],
    notes: [
      {
        id: "editable-human-note",
        source: "user",
        fileKey: "revision-file",
        filePath: "revision.txt",
        fileAvailability: "available",
        anchor: {
          newRange: [1, 1],
          preferred: { side: "new", line: 1 },
          intersectingHunkIndices: [0],
        },
        summary: "Explain the original behavior",
        updatedAt: "2026-10-11T00:00:00Z",
        editable: true,
        resolution: "active",
        status: "open",
      },
    ],
  };
  const provenance = {
    filePath: "revision.txt",
    contentIdentity: "original-source",
    newContext: ["original reviewed source"],
  };
  const ctx = {
    cwd: checkout,
    review: {
      snapshot: () => saved,
      checkpoint: (): ExtensionReviewCheckpoint => ({
        version: 1,
        checkoutRoot: realpathSync(checkout),
        reviewId: completed.reviewId,
        documentIdentity: "revision-document",
        generation: saved.generation,
        stateRevision: saved.stateRevision,
        notes: saved.notes.map((note) => ({ ...note, provenance })),
        draft: null,
        selection: { fileKey: null, hunkIndex: 0, activeNoteId: null },
      }),
    },
    dialogs: {
      async select() {
        return null;
      },
      async input() {
        return null;
      },
      async confirm() {
        return true;
      },
    },
    notify() {},
    statusLine: { set() {}, clear() {} },
  };
  const previousState = process.env.HUNK_HUMAN_REVIEW_STATE_DIRECTORY;
  process.env.HUNK_HUMAN_REVIEW_STATE_DIRECTORY = join(fixture, "revision-exports");
  try {
    await persistCheckpoint(ctx.review.checkpoint(), bound);
    await sendTurnReview(bound, ctx);
    const original = await client.request("review.status", { sessionId: bound.sessionId });
    saved = {
      ...saved,
      stateRevision: 2,
      notes: saved.notes.map((note) => ({
        ...note,
        fileAvailability: "unavailable",
        resolution: "orphaned",
        anchor: { ...note.anchor, intersectingHunkIndices: [] },
      })),
    };
    await persistCheckpoint(ctx.review.checkpoint(), bound);
    await sendTurnReview(bound, ctx);
    const reconciled = await client.request("review.status", { sessionId: bound.sessionId });
    expect(reconciled.notes).toHaveLength(1);
    expect(reconciled.batches).toEqual(original.batches);
    saved = {
      ...saved,
      stateRevision: 3,
      notes: saved.notes.map((note) => ({
        ...note,
        summary: "Write a handoff instead",
        updatedAt: "2026-10-11T00:01:00Z",
      })),
    };
    await persistCheckpoint(ctx.review.checkpoint(), bound);
    await sendTurnReview(bound, ctx);
    const edited = await client.request("review.status", { sessionId: bound.sessionId });
    expect(edited.notes).toHaveLength(2);
    expect(edited.batches).toHaveLength(2);
    expect(edited.batches[0]).toEqual(original.batches[0]);
    expect(edited.notes[0].text).toBe("Explain the original behavior");
    expect(edited.notes[1].text).toBe("Write a handoff instead");
    expect(JSON.parse(edited.notes[1].context).note.resolution).toBe("orphaned");
    expect(edited.notes.every((note: { state: string }) => note.state !== "resolved")).toBe(true);
  } finally {
    if (previousState === undefined) delete process.env.HUNK_HUMAN_REVIEW_STATE_DIRECTORY;
    else process.env.HUNK_HUMAN_REVIEW_STATE_DIRECTORY = previousState;
  }
});

test("uncertain feedback reconciles native queue/history without blind retry when admission remains ambiguous", async () => {
  const receiverSocket = join(state, "receiver.sock");
  let reconciliations = 0;
  let enqueues = 0;
  const server = createServer((connection) => {
    let input = "";
    connection.on("data", (chunk) => {
      input += chunk.toString();
      if (!input.includes("\n")) return;
      const request = JSON.parse(input);
      if (request.method === "admission.enqueue") enqueues++;
      if (request.method === "admission.reconcile") reconciliations++;
      connection.end(
        JSON.stringify({
          version: 1,
          id: request.id,
          result:
            request.method === "admission.check"
              ? { ready: true }
              : {
                  state:
                    request.method === "admission.enqueue" && enqueues > 1 ? "queued" : "unknown",
                },
        }) + "\n",
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(receiverSocket, resolve));
  chmodSync(receiverSocket, 0o600);
  try {
    await uncertainBatch(receiverSocket);
    const messages: string[] = [];
    const confirmations: string[] = [];
    await pendingBatchHistory(
      { sessionId, client },
      {
        dialogs: {
          async select({ options }) {
            return options[0];
          },
          async input() {
            return null;
          },
          async confirm(options) {
            confirmations.push(options.body ?? "");
            return false;
          },
        },
        notify(message) {
          messages.push(message);
        },
        statusLine: { set() {}, clear() {} },
      },
    );
    // Safe readiness probes may interleave; assert reconciliation and delivery semantics instead.
    expect(reconciliations).toBeGreaterThan(0);
    expect(enqueues).toBe(1);
    expect(messages.join("\n")).toContain("uncertain");
    expect(confirmations[0]).toContain("may duplicate instructions");
    expect((await client.request("review.status", { sessionId })).batches[0].state).toBe(
      "uncertain",
    );
    await client.request("session.idle", { sessionId, epoch });
    expect(enqueues).toBe(1);
    await pendingBatchHistory(
      { sessionId, client },
      {
        dialogs: {
          async select({ options }) {
            return options[0];
          },
          async input() {
            return null;
          },
          async confirm(options) {
            expect(options.body).toContain("may duplicate instructions");
            return true;
          },
        },
        notify() {},
        statusLine: { set() {}, clear() {} },
      },
    );
    expect(enqueues).toBe(2);
    expect((await client.request("review.status", { sessionId })).batches[0].state).toBe("queued");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("busy native feedback remains visibly pending and is admitted at the original idle boundary without resolving notes", async () => {
  const receiverSocket = join(state, "busy.sock");
  let ready = false;
  const deliveries: { identity: { nativeId: string; checkout: string }; prompt: string }[] = [];
  const server = createServer((connection) => {
    let input = "";
    connection.on("data", (chunk) => {
      input += chunk.toString();
      if (!input.includes("\n")) return;
      const request = JSON.parse(input);
      if (request.method === "admission.enqueue") deliveries.push(request.params);
      connection.end(
        JSON.stringify({
          version: 1,
          id: request.id,
          result:
            request.method === "admission.check"
              ? { ready, reason: "Original session is busy; queued for idle" }
              : { state: "queued" },
        }) + "\n",
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(receiverSocket, resolve));
  chmodSync(receiverSocket, 0o600);
  try {
    const attached = await client.request("session.attach", {
      identity: { kind: "pi", nativeId: "busy-original-fixture", checkout },
      epoch,
      receiver: { socket: receiverSocket },
    });
    const bound = { sessionId: attached.sessionId, client };
    await client.request("request.begin", {
      sessionId: bound.sessionId,
      epoch,
      requestId: "busy-turn",
    });
    writeFileSync(join(checkout, "busy.txt"), "review me\n");
    const review = await client.request("request.complete", {
      sessionId: bound.sessionId,
      epoch,
      requestId: "busy-turn",
      outcome: "completed",
    });
    const note = await client.request("note.save", {
      sessionId: bound.sessionId,
      reviewId: review.reviewId,
      note: { text: "Explain this; do not edit yet", path: "busy.txt", side: "after", line: 1 },
    });
    await client.request("batch.create", { sessionId: bound.sessionId, noteIds: [note.id] });
    const messages: string[] = [];
    await pendingBatchHistory(bound, {
      dialogs: {
        async select({ options }) {
          return options[0];
        },
        async input() {
          return null;
        },
        async confirm() {
          return true;
        },
      },
      notify(message) {
        messages.push(message);
      },
      statusLine: { set() {}, clear() {} },
    });
    expect(deliveries).toHaveLength(0);
    expect(messages.join("\n")).toContain("pending");
    ready = true;
    const idle = await client.request("session.idle", { sessionId: bound.sessionId, epoch });
    expect(idle.batches[0].state).toBe("queued");
    expect(deliveries[0].identity).toMatchObject({
      nativeId: "busy-original-fixture",
      checkout: realpathSync(checkout),
    });
    expect(deliveries[0].prompt).toContain("Explain this; do not edit yet");
    expect(deliveries[0].prompt).toContain("ask the user");
    expect(
      (await client.request("review.status", { sessionId: bound.sessionId })).notes[0].state,
    ).not.toBe("resolved");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the public actions menu confirms a new task and cancellation leaves its core state unchanged", async () => {
  await newTaskFixture("cancel");
  const before = await client.request("review.status", { sessionId });
  const { menuOptions, confirmations, messages } = await invokeNewTaskMenu(false);
  expect(menuOptions).toContain("Start a new review task");
  expect(confirmations).toHaveLength(1);
  expect(confirmations[0]).toMatchObject({
    title: "Start a new review task?",
    confirmLabel: "Start new task",
    cancelLabel: "Keep current task",
  });
  expect(confirmations[0].body).toContain("Pending notes and comments will not be discarded");
  expect(confirmations[0].body).toContain("response is active");
  expect(messages).toEqual([]);
  expect(await client.request("review.status", { sessionId })).toEqual(before);
  expect((await client.request("review.get", { sessionId, selection: "cumulative" })).id).toBe(
    before.cumulative,
  );
});

test("the same new-task action is available to Pi sessions", async () => {
  await newTaskFixture("pi-menu", "pi");
  const before = await client.request("review.status", { sessionId });
  const { menuOptions } = await invokeNewTaskMenu(false);
  expect(menuOptions).toContain("Start a new review task");
  expect(await client.request("review.status", { sessionId })).toEqual(before);
});

test("starting a new task resets only the cumulative baseline and preserves immutable reviews and comments", async () => {
  await newTaskFixture("success");
  const previous = await client.request("review.get", { sessionId, selection: "latest" });
  const note = await client.request("note.save", {
    sessionId,
    reviewId: previous.id,
    note: {
      text: "Keep this resolved historical comment",
      path: "source.txt",
      side: "after",
      line: 1,
    },
  });
  await client.request("note.resolve", { sessionId, noteId: note.id });
  await client.request("review.pin", { sessionId, reviewId: previous.id });
  const before = await client.request("review.status", { sessionId });
  const beforeComment = before.notes.find((item: { id: string }) => item.id === note.id);
  const { messages } = await invokeNewTaskMenu(true);
  expect(messages).toEqual([
    "Started a new review task. Existing reviews and comments remain available.",
  ]);
  const reset = await client.request("review.status", { sessionId });
  expect(reset.selection).toBe("latest");
  expect(reset.pinned).toBeUndefined();
  expect(reset.cumulative).toBeUndefined();
  expect(reset.reviews).toContain(previous.id);
  expect(reset.notes.find((item: { id: string }) => item.id === note.id)).toEqual(beforeComment);
  expect(await client.request("review.get", { sessionId, reviewId: previous.id })).toEqual(
    previous,
  );

  writeFileSync(join(checkout, "source.txt"), "new task baseline\n");
  await client.request("request.begin", { sessionId, epoch, requestId: "new-task-response" });
  writeFileSync(join(checkout, "source.txt"), "new task output\n");
  await client.request("request.complete", {
    sessionId,
    epoch,
    requestId: "new-task-response",
    outcome: "completed",
  });
  const cumulative = await client.request("review.get", { sessionId, selection: "cumulative" });
  expect(cumulative.label).toBe("changes observed during this task");
  expect(Buffer.from(cumulative.changes[0].before.content, "base64").toString()).toBe(
    "new task baseline\n",
  );
  expect(Buffer.from(cumulative.changes[0].after.content, "base64").toString()).toBe(
    "new task output\n",
  );
  const afterResponse = await client.request("review.status", { sessionId });
  expect(afterResponse.reviews).toContain(previous.id);
  expect(afterResponse.notes.find((item: { id: string }) => item.id === note.id)).toEqual(
    beforeComment,
  );
  expect(await client.request("review.get", { sessionId, reviewId: previous.id })).toEqual(
    previous,
  );
});

test("the new-task menu refuses an in-memory composer draft before calling core", async () => {
  await newTaskFixture("draft");
  const before = await client.request("review.status", { sessionId });
  const { confirmations, messages } = await invokeNewTaskMenu(true, true);
  expect(confirmations).toEqual([]);
  expect(messages).toEqual([
    "New task not started: save or cancel the current draft first; it will not be discarded.",
  ]);
  expect(await client.request("review.status", { sessionId })).toEqual(before);
});

test("the new-task menu leaves pending notes untouched when core refuses reset", async () => {
  await newTaskFixture("pending");
  const previous = await client.request("review.get", { sessionId, selection: "latest" });
  const note = await client.request("note.save", {
    sessionId,
    reviewId: previous.id,
    note: { text: "Do not discard this pending comment" },
  });
  const before = await client.request("review.status", { sessionId });
  const { messages, confirmations } = await invokeNewTaskMenu(true);
  const after = await client.request("review.status", { sessionId });
  expect(confirmations).toHaveLength(1);
  expect(messages).toEqual([
    "New task not started: core found pending notes or a draft. Save or resolve them first; nothing was discarded.",
  ]);
  expect(after.taskBaseline).toBe(before.taskBaseline);
  expect(after.cumulative).toBe(before.cumulative);
  expect(after.selection).toBe(before.selection);
  expect(after.notes.find((item: { id: string }) => item.id === note.id)).toMatchObject({
    id: note.id,
    state: "draft",
    text: "Do not discard this pending comment",
  });
  expect(await client.request("review.get", { sessionId, selection: "cumulative" })).toMatchObject({
    id: before.cumulative,
  });
});

test("the new-task menu delegates active-response refusal to core without ending the response", async () => {
  await newTaskFixture("active");
  await client.request("request.begin", { sessionId, epoch, requestId: "active-reset-guard" });
  const before = await client.request("review.status", { sessionId });
  const { messages } = await invokeNewTaskMenu(true);
  const after = await client.request("review.status", { sessionId });
  expect(messages).toEqual(["Cannot reset task during an active request"]);
  expect(after.active).toEqual(before.active);
  expect(after.taskBaseline).toBe(before.taskBaseline);
  await client.request("request.complete", {
    sessionId,
    epoch,
    requestId: "active-reset-guard",
    outcome: "interrupted",
  });
});

test("a reconciled absent batch requires explicit retry confirmation and queued batches cannot be resent", async () => {
  const receiverSocket = join(state, "retry.sock");
  const methods: string[] = [];
  let enqueues = 0;
  const server = createServer((connection) => {
    let input = "";
    connection.on("data", (chunk) => {
      input += chunk.toString();
      if (!input.includes("\n")) return;
      const request = JSON.parse(input);
      methods.push(request.method);
      if (request.method === "admission.enqueue") enqueues++;
      connection.end(
        JSON.stringify({
          version: 1,
          id: request.id,
          result:
            request.method === "admission.reconcile"
              ? { state: "absent", evidence: "Fixture queue and history contain no batch" }
              : request.method === "admission.check"
                ? { ready: true }
                : { state: enqueues === 1 ? "unknown" : "queued" },
        }) + "\n",
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(receiverSocket, resolve));
  chmodSync(receiverSocket, 0o600);
  try {
    await uncertainBatch(receiverSocket);
    methods.length = 0;
    let confirmed = false;
    const labels: string[] = [];
    const ctx = {
      dialogs: {
        async select({ options }: { options: readonly string[] }) {
          return options[0];
        },
        async input() {
          return null;
        },
        async confirm({ confirmLabel }: { confirmLabel?: string }) {
          labels.push(confirmLabel ?? "");
          return confirmed;
        },
      },
      notify() {},
      statusLine: { set() {}, clear() {} },
    };
    await pendingBatchHistory({ sessionId, client }, ctx);
    expect(methods).toEqual(["admission.reconcile"]);
    expect((await client.request("review.status", { sessionId })).batches[0].state).toBe(
      "uncertain",
    );
    confirmed = true;
    await pendingBatchHistory({ sessionId, client }, ctx);
    expect(labels).toEqual(["Retry original batch", "Retry original batch"]);
    expect(methods).toEqual([
      "admission.reconcile",
      "admission.reconcile",
      "admission.check",
      "admission.check",
      "admission.enqueue",
    ]);
    expect((await client.request("review.status", { sessionId })).batches[0].state).toBe("queued");
    await pendingBatchHistory({ sessionId, client }, ctx);
    expect(labels).toHaveLength(2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// Runtime modules come from the exact source host; public contexts use its emitted contract.
const nativeHostTest = process.env.HUNK_SOURCE_ROOT ? test : test.skip;
let nativeGeneration = 0;

/** Load actual factory, controller, producer, parser and lifecycle delivery without copied host shapes. */
async function nativeHostModules() {
  const root = process.env.HUNK_SOURCE_ROOT;
  if (!root) throw new Error("Set HUNK_SOURCE_ROOT to the Hunk API 29 checkout");
  const [factory, extensionTypes, controller, reviewSnapshot, parser, producer, events] =
    await Promise.all([
      import(`${root}/packages/hunk/src/extensions/runExtension.ts`),
      import(`${root}/packages/hunk/src/extensions/types.ts`),
      import(`${root}/packages/hunk/src/core/review/controller.ts`),
      import(`${root}/packages/hunk/src/extensions/reviewSnapshot.ts`),
      import(`${root}/packages/hunk/src/core/changeset/fromPatch.ts`),
      import(`${root}/packages/hunk/src/app/review/producer.ts`),
      import(`${root}/packages/hunk/src/extensions/events.ts`),
    ]);
  return { factory, extensionTypes, controller, reviewSnapshot, parser, producer, events };
}
type NativeController = InstanceType<
  Awaited<ReturnType<typeof nativeHostModules>>["controller"]["ReviewController"]
>;
type NativeHost = Awaited<ReturnType<typeof nativeReviewHost>>;

/** Register the real extension factory and project the real immutable adapter output. */
async function nativeReviewHost(
  bound = { sessionId, client },
  previous?: {
    result: ReturnType<
      Awaited<
        ReturnType<typeof nativeHostModules>
      >["extensionTypes"]["createEmptyExtensionLoadResult"]
    >;
    adapter?: ExtensionVcsAdapter;
  },
) {
  const modules = await nativeHostModules();
  const result =
    previous?.result ?? modules.extensionTypes.createEmptyExtensionLoadResult(checkout);
  let adapter: ExtensionVcsAdapter | undefined = previous?.adapter;
  if (!previous)
    await modules.factory.runExtensionFactory({
      metadata: {
        id: "human-review-native-resume-test",
        sourcePath: "hunk:bundled/human-review-native-resume-test",
        origin: "bundled",
      },
      registry: result.registry,
      issues: result.issues,
      factory(api: HunkExtensionAPI) {
        const captured = new Proxy(api, {
          get(target, property, receiver) {
            if (property === "registerVcsAdapter")
              return (value: ExtensionVcsAdapter) => {
                adapter = value;
                target.registerVcsAdapter(value);
              };
            return Reflect.get(target, property, receiver);
          },
        });
        registerTurnReview(captured, bound);
      },
    });
  expect(result.issues).toEqual([]);
  const operation = adapter?.operations?.["working-tree-diff"];
  if (!operation) throw new Error("Public Hunk factory did not register the review adapter");
  const loaded = await operation.load(
    { kind: "vcs", staged: false, options: {} },
    { cwd: checkout, signal: new AbortController().signal },
  );
  const changeset = modules.parser.changesetFromPatch(
    loaded.patchText,
    loaded.title,
    loaded.sourceLabel,
    null,
  );
  const producer = new modules.producer.ReviewProducer(
    { files: changeset.files, sourceLabel: loaded.sourceLabel },
    { producerId: `native-producer-${++nativeGeneration}` },
  );
  const controller = new modules.controller.ReviewController({
    document: producer.getPublication().document,
    checkoutRoot: realpathSync(checkout),
    sourceLabel: loaded.sourceLabel,
    generation: producer.getPublication().generation,
    persistence: result.registry.reviewPersistence[0].persistence,
  });
  await controller.initialize();
  producer.attachStore(controller.store);
  const native = {
    ...modules,
    getPositionedReviewState: () => producer.getPositionedReviewState(),
  };
  return {
    controller,
    loaded,
    native,
    result,
    adapter,
    async event(
      name: ExtensionEventName,
      _payload: object,
      context: ReturnType<typeof nativeReviewContext>,
    ) {
      const panes = { open() {}, close() {}, toggle() {}, isOpen: () => false };
      const eventContext: ExtensionEventContext = {
        cwd: checkout,
        notify: context.notify,
        statusLine: context.statusLine,
        panes,
        sidebars: panes,
        navigation: { selectFile() {}, selectHunk() {}, revealLine() {} },
        dialogs: {
          async confirm() {
            return false;
          },
          async select() {
            return null;
          },
          async input() {
            return null;
          },
        },
        review: { requestReload: context.review.requestReload },
        events: { emit() {} },
      };
      expect(Object.keys(eventContext.review)).toEqual(["requestReload"]);
      result.eventContextProvider = () => eventContext;
      await modules.events.emitExtensionEventBounded(
        result,
        name,
        name === "changeset_loaded" ? { changeset } : {},
        1000,
      );
    },
  };
}

/** Supply command-time readers from the real producer and controller, never to lifecycle events. */
function nativeReviewContext(
  controller: NativeController,
  native: Awaited<ReturnType<typeof nativeHostModules>> & {
    getPositionedReviewState: InstanceType<
      Awaited<ReturnType<typeof nativeHostModules>>["producer"]["ReviewProducer"]
    >["getPositionedReviewState"];
  },
  reloads: unknown[],
  warnings: string[],
) {
  return {
    cwd: checkout,
    review: {
      snapshot: (): ExtensionReviewSnapshot => {
        const positioned = native.getPositionedReviewState();
        return native.reviewSnapshot.buildExtensionReviewSnapshot(
          positioned.generation,
          positioned.state,
        );
      },
      checkpoint: (): ExtensionReviewCheckpoint | null => controller.checkpoint(),
      async requestReload(options: unknown) {
        reloads.push(options);
        return {
          ok: false as const,
          reason: "busy" as const,
          detail: "Test keeps the restored review open",
        };
      },
    },
    statusLine: { set() {}, clear() {} },
    notify(message: string) {
      warnings.push(message);
    },
  };
}

async function saveNativeNote(controller: NativeController, id: string, summary: string) {
  const state = controller.store.getSnapshot();
  controller.apply(
    {
      type: "notes/start-draft",
      fileKey: state.document.files[0].key,
      hunkIndex: 0,
      target: { side: "new", line: 1 },
    },
    { draftId: `draft:${id}` },
  );
  controller.apply({ type: "notes/update-draft", body: summary });
  const saved = await controller.save(
    { type: "notes/create-user", consumeDraft: true },
    { noteId: id, timestamp: "2026-10-12T00:00:00Z" },
  );
  if (!saved) throw new Error("Native human note was not saved");
  await controller.flush();
  const checkpoint = controller.checkpoint();
  if (!checkpoint) throw new Error("Native checkpoint is unavailable");
  return checkpoint;
}

nativeHostTest(
  "native API 29 restore re-establishes Send readiness without promoting an edit draft",
  async () => {
    const originalStateDirectory = process.env.HUNK_HUMAN_REVIEW_STATE_DIRECTORY;
    process.env.HUNK_HUMAN_REVIEW_STATE_DIRECTORY = join(fixture, "native-resume-exports");
    let oldHost: NativeHost | undefined;
    let restoredHost: NativeHost | undefined;
    let context: ReturnType<typeof nativeReviewContext> | undefined;
    try {
      oldHost = await nativeReviewHost();
      const oldContext = nativeReviewContext(oldHost.controller, oldHost.native, [], []);
      const noteId = "native-resume-saved-note";
      const original = await saveNativeNote(
        oldHost.controller,
        noteId,
        "Explain the saved behavior",
      );
      oldHost.controller.apply({ type: "notes/start-edit", noteId }, { draftId: "edit-unsaved" });
      oldHost.controller.apply({ type: "notes/update-draft", body: "Unsaved edit text" });
      await oldHost.controller.flush();
      const beforeCrash = oldHost.controller.checkpoint();
      if (!beforeCrash) throw new Error("Pre-crash checkpoint is unavailable");
      expect(beforeCrash.notes[0].anchor).toEqual(original.notes[0].anchor);
      expect(beforeCrash?.draft).toMatchObject({
        kind: "edit",
        targetNoteId: noteId,
        body: "Unsaved edit text",
      });
      await oldHost.event("shutdown", {}, oldContext);

      restoredHost = await nativeReviewHost();
      const reloads: unknown[] = [];
      const warnings: string[] = [];
      context = nativeReviewContext(
        restoredHost.controller,
        restoredHost.native,
        reloads,
        warnings,
      );
      await restoredHost.event(
        "changeset_loaded",
        {
          changeset: {
            sourceLabel: restoredHost.loaded.sourceLabel,
            title: restoredHost.loaded.title,
          },
        },
        context,
      );
      const restored = restoredHost.controller.checkpoint();
      if (!restored) throw new Error("Restored checkpoint is unavailable");
      const durable = await client.request("review.checkpoint.read", {
        sessionId,
        reviewId: restored.reviewId,
      });
      expect(durable.checkpoint).toEqual(restored);
      expect(restored.generation).not.toBe(beforeCrash.generation);
      expect(restored.notes[0]).toMatchObject({ id: noteId, anchor: beforeCrash.notes[0].anchor });
      expect(restored.selection).toEqual(beforeCrash.selection);
      expect(restored.draft).toMatchObject({
        kind: "edit",
        targetNoteId: noteId,
        body: "Unsaved edit text",
      });

      await sendTurnReview(
        { sessionId, client },
        {
          ...context,
          dialogs: {
            async select() {
              return null;
            },
            async input() {
              return null;
            },
            async confirm() {
              return true;
            },
          },
        },
      );
      const status = await client.request("review.status", { sessionId });
      expect(status.notes).toHaveLength(1);
      expect(status.notes[0].text).toBe("Explain the saved behavior");
      expect(status.notes[0].text).not.toContain("Unsaved edit text");
      expect(status.batches).toHaveLength(1);
      expect(reloads).toEqual([]);
      expect(warnings.join("\n")).not.toContain("Restored checkpoint durability is uncertain");
    } finally {
      if (restoredHost && context) await restoredHost.event("shutdown", {}, context);
      if (originalStateDirectory === undefined)
        delete process.env.HUNK_HUMAN_REVIEW_STATE_DIRECTORY;
      else process.env.HUNK_HUMAN_REVIEW_STATE_DIRECTORY = originalStateDirectory;
    }
  },
);

nativeHostTest("native API 29 restores queued-note auto-follow without another save", async () => {
  const receiverSocket = join(state, "native-resume-receiver.sock");
  const server = createServer((connection) => {
    let input = "";
    connection.on("data", (chunk) => {
      input += chunk.toString();
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(input.slice(0, newline));
      const result =
        request.method === "admission.check"
          ? { ready: true }
          : request.method === "admission.enqueue"
            ? { state: "queued" }
            : { state: "unknown" };
      connection.end(JSON.stringify({ version: 1, id: request.id, result }) + "\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(receiverSocket, resolve));
  chmodSync(receiverSocket, 0o600);
  const originalStateDirectory = process.env.HUNK_HUMAN_REVIEW_STATE_DIRECTORY;
  process.env.HUNK_HUMAN_REVIEW_STATE_DIRECTORY = join(fixture, "native-follow-exports");
  let oldHost: NativeHost | undefined;
  let restoredHost: NativeHost | undefined;
  let context: ReturnType<typeof nativeReviewContext> | undefined;
  try {
    const attached = await client.request("session.attach", {
      identity: { kind: "codex", nativeId: "snapshot-fixture", checkout },
      epoch,
      receiver: { socket: receiverSocket },
    });
    const bound = { sessionId: attached.sessionId, client };
    oldHost = await nativeReviewHost(bound);
    const original = await saveNativeNote(
      oldHost.controller,
      "native-auto-follow-note",
      "Explain the submitted behavior",
    );
    await sendTurnReview(bound, {
      ...nativeReviewContext(oldHost.controller, oldHost.native, [], []),
      dialogs: {
        async select() {
          return null;
        },
        async input() {
          return null;
        },
        async confirm() {
          return true;
        },
      },
    });
    const submitted = await client.request("review.status", { sessionId: bound.sessionId });
    expect(submitted.batches[0].state).toBe("queued");
    expect(submitted.admittedNoteIds).toContain("native-auto-follow-note");
    const batchId = submitted.batches[0].id;
    await oldHost.event(
      "shutdown",
      {},
      nativeReviewContext(oldHost.controller, oldHost.native, [], []),
    );

    restoredHost = await nativeReviewHost(bound);
    const reloads: unknown[] = [];
    const warnings: string[] = [];
    context = nativeReviewContext(restoredHost.controller, restoredHost.native, reloads, warnings);
    const restored = restoredHost.controller.checkpoint();
    if (!restored) throw new Error("Restored checkpoint is unavailable");
    expect(restored.notes[0].anchor).toEqual(original.notes[0].anchor);
    writeFileSync(join(checkout, "source.txt"), "review produced after restart\n");
    const next = await client.request("request.complete", {
      sessionId: bound.sessionId,
      epoch,
      requestId: batchId,
      outcome: "completed",
    });
    expect(next.reviewId).not.toBe(restored.reviewId);
    await restoredHost.event("startup", {}, context);
    await restoredHost.event(
      "changeset_loaded",
      {
        changeset: {
          sourceLabel: restoredHost.loaded.sourceLabel,
          title: restoredHost.loaded.title,
        },
      },
      context,
    );
    expect(reloads).toEqual([
      {
        mode: "automatic",
        expected: { generation: restored.generation, stateRevision: restored.stateRevision },
        acknowledgedNotes: ["native-auto-follow-note"],
      },
    ]);
    expect(warnings).toEqual([]);
    const durable = await client.request("review.checkpoint.read", {
      sessionId: bound.sessionId,
      reviewId: restored.reviewId,
    });
    expect(durable.checkpoint).toEqual(restored);
  } finally {
    if (restoredHost && context) await restoredHost.event("shutdown", {}, context);
    if (oldHost)
      await oldHost.event(
        "shutdown",
        {},
        nativeReviewContext(oldHost.controller, oldHost.native, [], []),
      );
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (originalStateDirectory === undefined) delete process.env.HUNK_HUMAN_REVIEW_STATE_DIRECTORY;
    else process.env.HUNK_HUMAN_REVIEW_STATE_DIRECTORY = originalStateDirectory;
  }
});

nativeHostTest(
  "native API 29 holds auto-follow and Send when checkpoint durability conflicts",
  async () => {
    const originalStateDirectory = process.env.HUNK_HUMAN_REVIEW_STATE_DIRECTORY;
    process.env.HUNK_HUMAN_REVIEW_STATE_DIRECTORY = join(fixture, "native-uncertain-exports");
    let oldHost: NativeHost | undefined;
    let restoredHost: NativeHost | undefined;
    let context: ReturnType<typeof nativeReviewContext> | undefined;
    try {
      oldHost = await nativeReviewHost();
      const checkpoint = await saveNativeNote(
        oldHost.controller,
        "native-uncertain-note",
        "Keep this note anchored to its original review",
      );
      await oldHost.event(
        "shutdown",
        {},
        nativeReviewContext(oldHost.controller, oldHost.native, [], []),
      );
      let raced = false;
      const competingClient = {
        async request(method: string, params?: object) {
          const response = await client.request(method, params);
          if (method === "review.checkpoint.read" && !raced) {
            raced = true;
            const competing = structuredClone(response.checkpoint);
            competing.notes[0].summary = "A competing saved human revision";
            competing.stateRevision++;
            await client.request("review.checkpoint.write", {
              sessionId,
              reviewId: checkpoint.reviewId,
              checkpoint: competing,
              expectedVersion: response.version,
            });
          }
          return response;
        },
      };
      restoredHost = await nativeReviewHost({ sessionId, client: competingClient });
      expect(restoredHost.controller.position().generation).not.toBe(checkpoint.generation);
      expect(restoredHost.controller.checkpoint()).toBeNull();
      expect(restoredHost.controller.getWarning()).toContain("Checkpoint write conflict");
      await client.request("note.resolve", { sessionId, noteId: "native-uncertain-note" });
      await client.request("request.begin", {
        sessionId,
        epoch,
        requestId: "review-after-durability-race",
      });
      writeFileSync(join(checkout, "source.txt"), "new review after a restart\n");
      const next = await client.request("request.complete", {
        sessionId,
        epoch,
        requestId: "review-after-durability-race",
        outcome: "completed",
      });
      expect(next.reviewId).not.toBe(checkpoint.reviewId);

      const reloads: unknown[] = [];
      const warnings: string[] = [];
      context = nativeReviewContext(
        restoredHost.controller,
        restoredHost.native,
        reloads,
        warnings,
      );
      await restoredHost.event("startup", {}, context);
      await restoredHost.event(
        "changeset_loaded",
        {
          changeset: {
            sourceLabel: restoredHost.loaded.sourceLabel,
            title: restoredHost.loaded.title,
          },
        },
        context,
      );
      expect(reloads).toEqual([]);
      expect(warnings.join("\n")).toContain("Restored checkpoint durability is uncertain");
      await expect(
        sendTurnReview(
          { sessionId, client },
          {
            ...context,
            dialogs: {
              async select() {
                return null;
              },
              async input() {
                return null;
              },
              async confirm() {
                return true;
              },
            },
          },
        ),
      ).rejects.toThrow("Original immutable review checkpoint is unavailable");
    } finally {
      if (restoredHost && context) await restoredHost.event("shutdown", {}, context);
      if (oldHost)
        await oldHost.event(
          "shutdown",
          {},
          nativeReviewContext(oldHost.controller, oldHost.native, [], []),
        );
      if (originalStateDirectory === undefined)
        delete process.env.HUNK_HUMAN_REVIEW_STATE_DIRECTORY;
      else process.env.HUNK_HUMAN_REVIEW_STATE_DIRECTORY = originalStateDirectory;
    }
  },
);

nativeHostTest(
  "native API 29 direct handoff keeps the tab's current version after closing the previous viewer",
  async () => {
    const previous = await nativeReviewHost();
    const original = await saveNativeNote(
      previous.controller,
      "native-handoff-note",
      "Original saved note",
    );
    const tab = await nativeReviewHost();
    const adopted = await client.request("review.checkpoint.read", {
      sessionId,
      reviewId: original.reviewId,
    });
    expect(adopted.checkpoint).toEqual(tab.controller.checkpoint());
    await previous.controller.flush();
    await previous.event(
      "shutdown",
      {},
      nativeReviewContext(previous.controller, previous.native, [], []),
    );
    expect(
      await client.request("review.checkpoint.read", { sessionId, reviewId: original.reviewId }),
    ).toEqual(adopted);
    tab.controller.apply(
      { type: "notes/start-edit", noteId: "native-handoff-note" },
      { draftId: "tab-edit" },
    );
    tab.controller.apply({
      type: "notes/update-draft",
      body: "Edited directly after split closure",
    });
    expect(
      await tab.controller.save(
        { type: "notes/update-user", noteId: "native-handoff-note", consumeDraft: true },
        { timestamp: "2026-10-12T00:01:00Z" },
      ),
    ).not.toBeNull();
    await tab.controller.flush();
    const durable = await client.request("review.checkpoint.read", {
      sessionId,
      reviewId: original.reviewId,
    });
    expect(durable.checkpoint).toEqual(tab.controller.checkpoint());
    expect(durable.checkpoint.notes[0]).toMatchObject({
      id: "native-handoff-note",
      anchor: original.notes[0].anchor,
      summary: "Edited directly after split closure",
    });
    expect(durable.checkpoint.draft).toBeNull();
    await tab.event("shutdown", {}, nativeReviewContext(tab.controller, tab.native, [], []));
  },
);

nativeHostTest(
  "native API 29 same-factory adoption never lends the incoming version to an outgoing composer",
  async () => {
    const previous = await nativeReviewHost();
    const original = await saveNativeNote(
      previous.controller,
      "native-owner-note",
      "Original saved note",
    );
    const incoming = await nativeReviewHost({ sessionId, client }, previous);
    const adopted = await client.request("review.checkpoint.read", {
      sessionId,
      reviewId: original.reviewId,
    });
    previous.controller.apply(
      { type: "notes/start-edit", noteId: "native-owner-note" },
      { draftId: "competing-old-edit" },
    );
    previous.controller.apply({
      type: "notes/update-draft",
      body: "Keep this competing composer local",
    });
    expect(
      await previous.controller.save(
        { type: "notes/update-user", noteId: "native-owner-note", consumeDraft: true },
        { timestamp: "2026-10-12T00:01:00Z" },
      ),
    ).toBeNull();
    expect(previous.controller.getWarning()).toContain("Checkpoint write conflict");
    expect(previous.controller.store.getSnapshot().draftNote.body).toBe(
      "Keep this competing composer local",
    );
    expect(
      await client.request("review.checkpoint.read", { sessionId, reviewId: original.reviewId }),
    ).toEqual(adopted);
    await incoming.event(
      "shutdown",
      {},
      nativeReviewContext(incoming.controller, incoming.native, [], []),
    );
  },
);

nativeHostTest(
  "native API 29 same-factory failed adoption cannot reuse the mounted readiness checkpoint",
  async () => {
    let unavailable = false;
    const bound = {
      sessionId,
      client: {
        async request(method: string, params?: object) {
          if (method === "review.checkpoint.write" && unavailable)
            throw new Error("Fixture transient adoption failure");
          return client.request(method, params);
        },
      },
    };
    const previous = await nativeReviewHost(bound);
    const original = await saveNativeNote(
      previous.controller,
      "same-factory-ready",
      "Preserve the mounted native note",
    );
    unavailable = true;
    const failed = await nativeReviewHost(bound, previous);
    const reloads: unknown[] = [];
    const warnings: string[] = [];
    const context = nativeReviewContext(failed.controller, failed.native, reloads, warnings);
    await failed.event("changeset_loaded", {}, context);
    expect(failed.controller.checkpoint()).toBeNull();
    expect(warnings.join("\n")).toContain("Restored checkpoint durability is uncertain");
    expect(reloads).toEqual([]);
    expect(
      (await client.request("review.checkpoint.read", { sessionId, reviewId: original.reviewId }))
        .checkpoint,
    ).toEqual(original);
    await expect(
      sendTurnReview(bound, {
        ...context,
        dialogs: {
          async select() {
            return null;
          },
          async input() {
            return null;
          },
          async confirm() {
            return true;
          },
        },
      }),
    ).rejects.toThrow("Original immutable review checkpoint is unavailable");
    await failed.event("shutdown", {}, context);
  },
);

for (const retryReview of ["same", "newer"] as const)
  nativeHostTest(
    `native API 29 failed preparation permits ${retryReview} review retry and outgoing saves`,
    async () => {
      let failedReview: string | undefined;
      const bound = {
        sessionId,
        client: {
          async request(method: string, params?: object) {
            if (
              method === "review.checkpoint.write" &&
              (params as { reviewId?: string })?.reviewId === failedReview
            )
              throw new Error("Fixture transient checkpoint failure");
            return client.request(method, params);
          },
        },
      };
      const previous = await nativeReviewHost(bound);
      const original = await saveNativeNote(
        previous.controller,
        "outgoing-human",
        "Keep the original human identity",
      );
      const producer = new previous.native.producer.ReviewProducer({
        files: previous.native.parser.changesetFromPatch(
          previous.loaded.patchText,
          previous.loaded.title,
          previous.loaded.sourceLabel,
          null,
        ).files,
        sourceLabel: previous.loaded.sourceLabel,
      });
      const completeTestReview = async (id: string) => {
        await client.request("request.begin", { sessionId, epoch, requestId: id });
        writeFileSync(join(checkout, "source.txt"), `${id}\n`);
        return (
          await client.request("request.complete", {
            sessionId,
            epoch,
            requestId: id,
            outcome: "completed",
          })
        ).reviewId as string;
      };
      const prepareTestController = async () => {
        await client.request("review.select", { sessionId, selection: "latest" });
        const loaded = await previous.adapter!.operations!["working-tree-diff"]!.load(
          { kind: "vcs", staged: false, options: {} },
          { cwd: checkout, signal: new AbortController().signal },
        );
        const prepared = producer.preparePublication({
          files: previous.native.parser.changesetFromPatch(
            loaded.patchText,
            loaded.title,
            loaded.sourceLabel,
            null,
          ).files,
          sourceLabel: loaded.sourceLabel,
        });
        const controller = new previous.native.controller.ReviewController({
          document: prepared.publication.document,
          checkoutRoot: realpathSync(checkout),
          sourceLabel: loaded.sourceLabel,
          generation: prepared.publication.generation,
          persistence: previous.result.registry.reviewPersistence[0].persistence,
        });
        await controller.initialize();
        return controller;
      };
      failedReview = await completeTestReview("failed-review-B");
      const failed = await prepareTestController();
      expect(failed.getWarning()).toContain("Fixture transient checkpoint failure");
      const reviewB = failedReview;
      failedReview = undefined;
      let retained: ExtensionReviewCheckpoint | undefined;
      if (retryReview === "same") {
        const otherViewer = await nativeReviewHost(bound);
        retained = await saveNativeNote(
          otherViewer.controller,
          "retained-B",
          "Saved while the failed attempt had no ownership",
        );
        await otherViewer.event(
          "shutdown",
          {},
          nativeReviewContext(otherViewer.controller, otherViewer.native, [], []),
        );
      }
      const desiredReview =
        retryReview === "same" ? reviewB : await completeTestReview("newer-review-C");
      const incoming = await prepareTestController();
      expect(incoming.position().generation).toBe(failed.position().generation);
      expect(incoming.getWarning()).toBeNull();
      expect(incoming.checkpoint()!.reviewId).toBe(desiredReview);
      if (retained) expect(incoming.checkpoint()!.notes).toEqual(retained.notes);
      const saved = await saveNativeNote(
        incoming,
        "incoming-human",
        "Save after the transient failure",
      );
      expect(
        (await client.request("review.checkpoint.read", { sessionId, reviewId: desiredReview }))
          .checkpoint,
      ).toEqual(saved);
      previous.controller.apply(
        { type: "notes/start-edit", noteId: "outgoing-human" },
        { draftId: "outgoing-edit" },
      );
      previous.controller.apply({
        type: "notes/update-draft",
        body: "Still save to the original review",
      });
      expect(
        await previous.controller.save(
          { type: "notes/update-user", noteId: "outgoing-human", consumeDraft: true },
          { timestamp: "2026-10-12T00:01:00Z" },
        ),
      ).not.toBeNull();
      await previous.controller.flush();
      const outgoing = (
        await client.request("review.checkpoint.read", { sessionId, reviewId: original.reviewId })
      ).checkpoint;
      expect(outgoing.notes[0]).toMatchObject({
        id: "outgoing-human",
        anchor: original.notes[0].anchor,
        provenance: original.notes[0].provenance,
        summary: "Still save to the original review",
      });
      expect(
        (await client.request("review.checkpoint.read", { sessionId, reviewId: desiredReview }))
          .checkpoint,
      ).toEqual(saved);
      await previous.event(
        "shutdown",
        {},
        nativeReviewContext(previous.controller, previous.native, [], []),
      );
    },
  );
