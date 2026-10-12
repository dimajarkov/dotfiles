import { lstatSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type {
  ExtensionCliCommandContext,
  ExtensionCliCommandResult,
  ExtensionCommandContext,
  ExtensionReviewControls,
  ExtensionReviewSnapshot,
  ExtensionEventContext,
  ExtensionReviewCheckpoint,
  HunkExtensionAPI,
} from "hunkdiff/extension";
import {
  createClient,
  nativeNoteRevision,
} from "../../../../.local/share/hunk-turn-review/client.mjs";
import {
  attestBinding,
  createSnapshotAdapter,
  parseSnapshot,
  record,
  selectedSnapshot,
  text,
} from "./snapshot-adapter";
import type { Binding } from "./snapshot-adapter";
import { digest } from "./process";
import { stateDirectory, writeBatch } from "./storage";

type TurnReviewHost = Pick<
  HunkExtensionAPI,
  | "apiVersion"
  | "registerReviewPersistence"
  | "registerVcsAdapter"
  | "registerCliCommand"
  | "registerCommand"
  | "on"
>;
export function registerTurnReview(hunk: TurnReviewHost, binding: Binding): void {
  if (Number(hunk.apiVersion) !== 29)
    throw new Error(
      "Owned turn review requires the matching patched Hunk API 29; manual delivery is disabled",
    );
  let displayed: string | undefined;
  let loaded = false;
  let next: string | undefined;
  let prepared: { reviewId?: string; root: string; title: string } | undefined;
  let live: ExtensionEventContext | undefined;
  let polling = false;
  let closed = false;
  let busy = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let durable: ExtensionReviewCheckpoint | undefined;
  let heldLatest: string | undefined;
  type CheckpointOwner = {
    reviewId: string;
    documentIdentity: string;
    root: string;
    version: number;
    generation?: string;
  };
  const opened = new Map<string, CheckpointOwner>();
  const writers = new Map<string, CheckpointOwner>();
  /** Bind a native writer to its immutable source as well as its reusable publication generation. */
  const writerKey = (checkpoint: ExtensionReviewCheckpoint) =>
    JSON.stringify([
      checkpoint.reviewId,
      checkpoint.checkoutRoot,
      checkpoint.documentIdentity,
      checkpoint.generation,
    ]);
  hunk.registerVcsAdapter(
    createSnapshotAdapter(
      binding,
      () => (next ? { reviewId: next } : {}),
      (review, root, title) => {
        prepared = { reviewId: review?.id, root, title };
      },
    ),
  );
  async function writeCheckpoint(checkpoint: ExtensionReviewCheckpoint): Promise<void> {
    const key = writerKey(checkpoint);
    const bound = writers.get(key);
    const owner = bound ?? opened.get(checkpoint.reviewId);
    if (
      !owner ||
      owner.reviewId !== checkpoint.reviewId ||
      owner.root !== checkpoint.checkoutRoot ||
      owner.documentIdentity !== checkpoint.documentIdentity ||
      (owner.generation !== undefined && owner.generation !== checkpoint.generation) ||
      closed
    )
      throw new Error("Checkpoint has no matching original source owner");
    // A controller keeps its own read-time version across same-review reload preparation.
    // Outgoing writes must not borrow the incoming generation's storage authority.
    owner.generation = checkpoint.generation;
    writers.set(key, owner);
    try {
      const result = await binding.client.request("review.checkpoint.write", {
        sessionId: binding.sessionId,
        reviewId: checkpoint.reviewId,
        checkpoint,
        expectedVersion: owner.version,
      });
      if (!record(result) || !Number.isSafeInteger(result.version) || Number(result.version) < 0)
        throw new Error("Checkpoint durability not acknowledged");
      owner.version = Number(result.version);
    } catch (error) {
      // A failed first acknowledgement owns no generation. Retain established outgoing writers.
      if (!bound && writers.get(key) === owner) {
        writers.delete(key);
        owner.generation = undefined;
      }
      throw error;
    }
    if (
      durable?.generation === checkpoint.generation ||
      (opened.get(checkpoint.reviewId) === owner && prepared?.reviewId === checkpoint.reviewId)
    )
      durable = checkpoint;
  }
  hunk.registerReviewPersistence({
    async open(context) {
      // Capture the actual adapter result before any await. Latest can advance
      // while the host opens this document, without changing its identity.
      const source = prepared;
      if (!source?.reviewId) return null;
      if (context.checkoutRoot !== source.root || context.sourceLabel !== source.root)
        throw new Error("Native checkpoint source does not match the loaded immutable review");
      const saved = await binding.client.request("review.checkpoint.read", {
        sessionId: binding.sessionId,
        reviewId: source.reviewId,
      });
      if (prepared !== source || closed)
        throw new Error("Review source changed during checkpoint open");
      if (!record(saved) || !Number.isSafeInteger(saved.version) || Number(saved.version) < 0)
        throw new Error("Checkpoint read not acknowledged");
      if (
        saved.checkpoint !== null &&
        (!record(saved.checkpoint) ||
          saved.checkpoint.documentIdentity !== context.documentIdentity)
      )
        throw new Error("Persisted checkpoint belongs to another source document");
      opened.set(source.reviewId, {
        reviewId: source.reviewId,
        documentIdentity: context.documentIdentity,
        root: source.root,
        version: Number(saved.version),
      });
      return { reviewId: source.reviewId, checkpoint: saved.checkpoint ?? undefined };
    },
    write: writeCheckpoint,
  });
  hunk.registerCliCommand(
    {
      name: "turn-review",
      summary: "Review the original native session's immutable user-request turn",
      usage: "[latest|cumulative|pinned|status]",
    },
    (args, ctx) => turnReviewCli(binding, args, ctx),
  );
  const poll = async () => {
    if (polling || closed || !live || !loaded || busy) return;
    polling = true;
    const ctx = live;
    try {
      const status = await binding.client.request("review.status", {
        sessionId: binding.sessionId,
      });
      if (closed || !record(status)) return;
      const desired =
        status.selection === "pinned"
          ? status.pinned
          : status.selection === "cumulative"
            ? status.cumulative
            : status.latest;
      const newer = typeof status.latest === "string" && status.latest !== displayed;
      const pending = Array.isArray(status.batches)
        ? status.batches.filter((batch) => record(batch) && batch.state !== "queued").length
        : 0;
      ctx.statusLine.clear("integration");
      ctx.statusLine.set({
        id: "turn-review",
        priority: 30,
        spans: [
          {
            text: `${newer ? "Newer review available | " : ""}${displayed ? (status.selection ?? "latest") : "Waiting for first completed response"} | ${pending} pending | Ctrl-G`,
          },
        ],
      });
      if (heldLatest !== undefined) {
        if (status.latest === heldLatest && status.selection === "latest") return;
        heldLatest = undefined;
      }
      if (typeof desired === "string" && desired !== displayed) {
        next = desired;
        const checkpoint = durable?.reviewId === displayed ? durable : undefined;
        const admitted = Array.isArray(status.admittedNoteIds) ? status.admittedNoteIds : [];
        const acknowledgedNotes = checkpoint?.notes
          .filter(
            (note) =>
              Array.isArray(status.notes) &&
              status.notes.some(
                (n) =>
                  record(n) &&
                  admitted.includes(n.id) &&
                  hasRevision(n.context, nativeNoteRevision(note, note.provenance)),
              ),
          )
          .map((note) => note.id);
        const result = await ctx.review.requestReload({
          mode: "automatic",
          ...(checkpoint
            ? {
                expected: {
                  generation: checkpoint.generation,
                  stateRevision: checkpoint.stateRevision,
                },
                acknowledgedNotes,
              }
            : {}),
        });
        if (!result.ok) next = displayed;
      }
    } catch (error) {
      if (!closed)
        ctx.notify(
          error instanceof Error ? error.message : "Turn-review runtime unavailable",
          "warning",
        );
    } finally {
      polling = false;
    }
  };
  hunk.on("startup", (_event, ctx) => {
    live = ctx;
    timer = setInterval(() => void poll(), 2000);
  });
  hunk.on("changeset_loaded", async ({ changeset }, ctx) => {
    live = ctx;
    loaded = false;
    const source = prepared;
    if (!source || changeset.sourceLabel !== source.root || changeset.title !== source.title)
      return;
    if (!source.reviewId) {
      displayed = undefined;
      next = undefined;
      loaded = true;
      await poll();
      return;
    }
    try {
      // The host acknowledges its validated, rehydrated checkpoint before changeset_loaded.
      // Lifecycle contexts intentionally expose only requestReload, not command-time readers.
      const checkpoint = durable;
      const owner = checkpoint && opened.get(checkpoint.reviewId);
      if (
        !checkpoint ||
        checkpoint.reviewId !== source.reviewId ||
        !owner ||
        owner.generation !== checkpoint.generation ||
        writers.get(writerKey(checkpoint)) !== owner ||
        owner.root !== source.root ||
        owner.documentIdentity !== checkpoint.documentIdentity ||
        checkpoint.checkoutRoot !== source.root ||
        closed ||
        prepared !== source
      )
        throw new Error("Restored native checkpoint has not been durably acknowledged by the host");
      displayed = source.reviewId;
      next = displayed;
      loaded = true;
      await poll();
    } catch (error) {
      durable = undefined;
      ctx.notify(
        `Restored checkpoint durability is uncertain; automatic following is on hold: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  });
  hunk.on("shutdown", () => {
    closed = true;
    if (timer) clearInterval(timer);
  });
  hunk.registerCommand(
    { id: "actions", title: "Human turn-review actions...", key: "ctrl+g" },
    async (ctx) => {
      if (busy) {
        ctx.notify("Review actions already running", "warning");
        return;
      }
      busy = true;
      try {
        const action = await ctx.dialogs.select({
          title: "Human turn-review actions",
          options: [
            "Export saved human feedback",
            "Send review",
            "Latest / cumulative / pinned review",
            "Status / pending batch history",
            "Start a new review task",
            "Full-width review tab",
          ],
        });
        if (action === "Export saved human feedback") await sendTurnReview(binding, ctx, true);
        else if (action === "Send review") await sendTurnReview(binding, ctx);
        else if (action === "Status / pending batch history") await reviewStatus(binding, ctx);
        else if (action === "Start a new review task") {
          await startNewReviewTask(binding, ctx, (latest) => {
            heldLatest = latest !== displayed ? latest : undefined;
          });
        } else if (action === "Full-width review tab") {
          const result = await binding.client.request("layout.tab", {
            sessionId: binding.sessionId,
          });
          ctx.notify(`Full-width review tab: ${JSON.stringify(result)}`);
        } else if (action === "Latest / cumulative / pinned review") {
          const checkpoint = ctx.review.checkpoint();
          const captured = ctx.review.snapshot();
          if (!checkpoint || !captured)
            throw new Error(
              "Original immutable checkpoint is unavailable; saved notes remain on this review",
            );
          if (checkpoint.draft)
            throw new Error("Save or cancel the native composer before switching review");
          const chosen = await ctx.dialogs.select({
            title: "Explicit immutable review selection",
            options: ["latest", "cumulative", "pinned"],
          });
          if (!chosen) return;
          if (
            !(await ctx.dialogs.confirm({
              title: `Switch to ${chosen}?`,
              body: "Keep saved comments on their original immutable review. Incoming review restores only its own notes.",
              confirmLabel: "Switch review",
              cancelLabel: "Stay here",
            }))
          )
            return;
          current(captured, ctx);
          const previous = await binding.client.request("review.status", {
            sessionId: binding.sessionId,
          });
          if (!record(previous)) throw new Error("Original review selection unavailable");
          const selectedReview = parseSnapshot(
            await binding.client.request("review.get", {
              sessionId: binding.sessionId,
              selection: chosen,
            }),
          );
          current(captured, ctx);
          next = selectedReview.id;
          const result = await ctx.review.requestReload({
            mode: "explicit",
            expected: { generation: captured.generation, stateRevision: captured.stateRevision },
          });
          if (!result.ok) {
            next = displayed;
            throw new Error(result.detail);
          }
          await binding.client.request("review.select", {
            sessionId: binding.sessionId,
            selection: chosen,
          });
        }
      } catch (error) {
        ctx.notify(error instanceof Error ? error.message : "Turn-review action failed", "warning");
      } finally {
        busy = false;
      }
    },
  );
}

type FeedbackContext = Pick<
  ExtensionCommandContext,
  "cwd" | "dialogs" | "notify" | "statusLine"
> & { review: Pick<ExtensionReviewControls, "snapshot" | "checkpoint"> };
function current(captured: ExtensionReviewSnapshot, ctx: Pick<FeedbackContext, "review">): void {
  const now = ctx.review.snapshot();
  if (
    !now ||
    now.generation !== captured.generation ||
    now.stateRevision !== captured.stateRevision
  )
    throw new Error("Review changed; reopen Send review");
}

type NewTaskContext = Pick<FeedbackContext, "cwd" | "dialogs" | "notify" | "review">;

async function startNewReviewTask(
  binding: Binding,
  ctx: NewTaskContext,
  preserveView: (latest: string | undefined) => void,
): Promise<void> {
  const captured = ctx.review.snapshot();
  const checkpoint = ctx.review.checkpoint();
  if (
    !captured ||
    !checkpoint ||
    captured.generation !== checkpoint.generation ||
    captured.stateRevision !== checkpoint.stateRevision
  )
    throw new Error("Original immutable review checkpoint is unavailable");
  if (checkpoint.draft) {
    ctx.notify(
      "New task not started: save or cancel the current draft first; it will not be discarded.",
      "warning",
    );
    return;
  }
  const status = await binding.client.request("review.status", { sessionId: binding.sessionId });
  if (!record(status)) throw new Error("Original native review status unavailable");
  current(captured, ctx);
  if (
    !(await ctx.dialogs.confirm({
      title: "Start a new review task?",
      body: "This resets the cumulative baseline and starts a fresh task. Existing immutable reviews and comments remain available. Pending notes and comments will not be discarded; the core refuses the reset if any are pending or a response is active.",
      confirmLabel: "Start new task",
      cancelLabel: "Keep current task",
    }))
  )
    return;
  current(captured, ctx);
  try {
    const result = await binding.client.request("task.reset", { sessionId: binding.sessionId });
    if (!record(result) || result.reset !== true)
      throw new Error("Task reset was not acknowledged");
  } catch (error) {
    if (error instanceof Error && error.message.includes("Explicit discard required")) {
      ctx.notify(
        "New task not started: core found pending notes or a draft. Save or resolve them first; nothing was discarded.",
        "warning",
      );
      return;
    }
    throw error;
  }
  // Keep an older pinned immutable review on screen until this new task produces a review.
  preserveView(typeof status.latest === "string" ? status.latest : undefined);
  ctx.notify("Started a new review task. Existing reviews and comments remain available.");
}

function hasRevision(context: unknown, revision: string): boolean {
  if (typeof context !== "string") return false;
  try {
    const value: unknown = JSON.parse(context);
    return record(value) && value.revision === revision;
  } catch {
    return false;
  }
}

/** Called only by the explicit native Send review action. Saves and drafts never invoke it. */
export async function sendTurnReview(
  binding: Binding,
  ctx: FeedbackContext,
  exportOnly = false,
): Promise<void> {
  const captured = ctx.review.snapshot();
  const checkpoint = ctx.review.checkpoint();
  if (
    !captured ||
    !checkpoint ||
    captured.generation !== checkpoint.generation ||
    captured.stateRevision !== checkpoint.stateRevision
  )
    throw new Error("Original immutable review checkpoint is unavailable");
  const human = captured.notes.filter(
    (note) => note.source === "user" && note.status !== "resolved",
  );
  if (!human.length) {
    ctx.notify("No saved human requests; drafts are excluded", "warning");
    return;
  }
  const checkout = await attestBinding(binding, ctx.cwd);
  if (checkpoint.checkoutRoot !== checkout)
    throw new Error("Checkpoint checkout does not match original native session");
  const immutable = parseSnapshot(
    await binding.client.request("review.get", {
      sessionId: binding.sessionId,
      reviewId: checkpoint.reviewId,
    }),
  );
  current(captured, ctx);
  const persisted = await binding.client.request("review.checkpoint.read", {
    sessionId: binding.sessionId,
    reviewId: checkpoint.reviewId,
  });
  if (
    !record(persisted) ||
    !record(persisted.checkpoint) ||
    persisted.checkpoint.generation !== checkpoint.generation ||
    persisted.checkpoint.stateRevision !== checkpoint.stateRevision
  )
    throw new Error(
      "Saved human state has no matching durable checkpoint; wait for save acknowledgement",
    );
  const status = await binding.client.request("review.status", { sessionId: binding.sessionId });
  if (!record(status) || !Array.isArray(status.notes))
    throw new Error("Pending human feedback inventory unavailable");
  const noteIds: string[] = [];
  for (const note of human) {
    const original = checkpoint.notes.find((saved) => saved.id === note.id);
    if (!original)
      throw new Error(
        "Saved note original provenance unavailable; refusing to guess from current files",
      );
    const revision = nativeNoteRevision(note, original.provenance);
    const prior = status.notes.find(
      (candidate: unknown) =>
        record(candidate) &&
        candidate.reviewId === checkpoint.reviewId &&
        hasRevision(candidate.context, revision) &&
        candidate.state !== "discarded" &&
        candidate.state !== "resolved",
    );
    if (record(prior) && prior.state !== "draft") continue;
    if (!record(prior)) throw new Error("Saved human revision missing from durable checkpoint");
    const saved = prior;
    noteIds.push(text(saved.id, "note ID"));
  }
  current(captured, ctx);
  if (!noteIds.length) {
    ctx.notify(
      "These requests already belong to retained batches; inspect pending batch history",
      "warning",
    );
    return;
  }
  const frozen = await binding.client.request("batch.create", {
    sessionId: binding.sessionId,
    noteIds,
    reviewId: checkpoint.reviewId,
    expectedCheckpointVersion: persisted.version,
  });
  if (!record(frozen)) throw new Error("Immutable batch creation not acknowledged");
  const batchId = text(frozen.id, "batch ID");
  const exported = writeBatch(
    stateDirectory(checkout),
    {
      nativeBatchId: batchId,
      originalSessionId: binding.sessionId,
      immutableReview: immutable,
      review: captured,
      notes: checkpoint.notes.filter((note) => human.some((saved) => saved.id === note.id)),
    },
    digest([binding.sessionId, checkpoint.reviewId, human]),
    `Original native batch: ${batchId}\n\n${human.map((note) => `${note.id} [${note.resolution}]\n${note.summary}`).join("\n\n")}`,
  );
  ctx.notify(`Exported immutable batch ${batchId}: ${exported.json}`);
  if (
    exportOnly ||
    !(await ctx.dialogs.confirm({
      title: "Send review to original native session?",
      body: `Batch: ${batchId}\nOriginal checkout: ${checkout}\n${noteIds.length} saved requests. Busy sessions queue for idle. Missing or unverified sessions hold pending. Send does not resolve notes.`,
      confirmLabel: "Send review",
      cancelLabel: "Keep pending",
    }))
  )
    return;
  current(captured, ctx);
  // All receiver choice, admission, reconciliation and durable receipts belong to the core.
  const receipt = await binding.client.request("batch.submit", {
    sessionId: binding.sessionId,
    batchId,
    reviewId: checkpoint.reviewId,
    expectedCheckpointVersion: persisted.version,
  });
  showReceipt(receipt, ctx);
}

function showReceipt(receipt: unknown, ctx: Pick<FeedbackContext, "notify" | "statusLine">): void {
  if (!record(receipt))
    throw new Error("No durable delivery receipt; reconcile pending batch history before retry");
  const state = text(receipt.state, "batch state");
  const id = text(receipt.id, "batch ID");
  const message = `${id}: ${state}${typeof receipt.message === "string" ? ` - ${receipt.message}` : ""}; admission is not processing or resolution`;
  ctx.statusLine.set({ id: "delivery", priority: 20, spans: [{ text: message }] });
  ctx.notify(message, ["uncertain", "blocked"].includes(state) ? "warning" : "info");
}

export async function reviewStatus(
  binding: Binding,
  ctx: Pick<FeedbackContext, "dialogs" | "notify" | "statusLine">,
): Promise<void> {
  const status = await binding.client.request("review.status", { sessionId: binding.sessionId });
  if (!record(status) || !record(status.identity))
    throw new Error("Original native review status unavailable");
  const notes = Array.isArray(status.notes) ? status.notes.filter(record) : [];
  const receipts = Array.isArray(status.batches) ? status.batches.filter(record) : [];
  const unresolved = notes.filter(
    (note) => note.state !== "resolved" && note.state !== "discarded",
  ).length;
  const warnings = Array.isArray(status.warnings)
    ? status.warnings.filter((value): value is string => typeof value === "string")
    : [];
  const body = [
    `Native session: ${text(status.identity.kind, "native kind")}:${text(status.identity.nativeId, "native ID")}`,
    `Original checkout: ${text(status.identity.checkout, "checkout")}`,
    `Selection: ${status.selection}; latest: ${status.latest ?? "none"}; pinned: ${status.pinned ?? "none"}; cumulative: ${status.cumulative ?? "none"}`,
    `${unresolved} unresolved human request revisions. Queued means admission only; sending never resolves notes.`,
    receipts.length
      ? receipts
          .map(
            (receipt) =>
              `${text(receipt.id, "batch ID")}: ${text(receipt.state, "batch state")}${typeof receipt.message === "string" ? ` - ${receipt.message}` : ""}`,
          )
          .join("\n")
      : "No retained feedback batches.",
    ...warnings.map((warning) => `Warning: ${warning}`),
  ].join("\n\n");
  if (
    await ctx.dialogs.confirm({
      title: "Original review status",
      body,
      confirmLabel: "Batch history",
      cancelLabel: "Close",
    })
  )
    await pendingBatchHistory(binding, ctx);
}

export async function pendingBatchHistory(
  binding: Binding,
  ctx: Pick<FeedbackContext, "dialogs" | "notify" | "statusLine">,
): Promise<void> {
  const status = await binding.client.request("review.status", { sessionId: binding.sessionId });
  if (!record(status) || !Array.isArray(status.batches))
    throw new Error("Pending batch history unavailable");
  const receipts = status.batches.filter(record);
  if (!receipts.length) {
    ctx.notify("No retained feedback batches");
    return;
  }
  const selected = await ctx.dialogs.select({
    title: "Immutable batch history - admission is not resolution",
    options: receipts.map(
      (receipt, index) =>
        `${index + 1}. ${text(receipt.id, "batch ID")} | ${text(receipt.state, "batch state")}`,
    ),
  });
  if (selected === null) return;
  const ordinal = /^(\d+)\. /.exec(selected)?.[1];
  const prior = ordinal ? receipts[Number(ordinal) - 1] : undefined;
  if (!prior) throw new Error("Batch selection is unavailable");
  const batchId = text(prior.id, "batch ID");
  let receipt = prior;
  if (["uncertain", "submitting"].includes(String(receipt.state))) {
    const reconciled = await binding.client.request("batch.reconcile", {
      sessionId: binding.sessionId,
      batchId,
    });
    if (!record(reconciled)) throw new Error("Native reconciliation was not acknowledged");
    receipt = reconciled;
    showReceipt(receipt, ctx);
    if (receipt.state === "queued") return;
    const uncertain = receipt.reconciliation === "unknown";
    if (receipt.reconciliation !== "absent" && !uncertain) return;
    if (
      await ctx.dialogs.confirm({
        title: uncertain ? "Retry uncertain delivery?" : "Explicitly retry reconciled batch?",
        body: `${batchId}\n${uncertain ? "Native queue/history cannot establish admission. Retrying may duplicate instructions." : "Native queue/history reports absent."} Confirm retry to the original session only. Notes remain unresolved.`,
        confirmLabel: "Retry original batch",
        cancelLabel: "Keep pending",
      })
    )
      showReceipt(
        await binding.client.request("batch.retry", {
          sessionId: binding.sessionId,
          batchId,
          ...(uncertain ? { confirmUncertain: true } : {}),
        }),
        ctx,
      );
    return;
  }
  showReceipt(receipt, ctx);
  if (receipt.state === "queued") return;
  if (!["pending", "blocked"].includes(String(receipt.state))) return;
  if (
    await ctx.dialogs.confirm({
      title: "Send retained pending batch?",
      body: `${batchId}\nThe original native session is the only receiver. Busy or unverified sessions remain pending.`,
      confirmLabel: "Send review",
      cancelLabel: "Keep pending",
    })
  )
    showReceipt(
      await binding.client.request("batch.submit", { sessionId: binding.sessionId, batchId }),
      ctx,
    );
}

export function bindingFromEnvironment(): Binding | null {
  const socket = process.env.HUNK_TURN_REVIEW_SOCKET;
  const sessionId = process.env.HUNK_TURN_REVIEW_SESSION_ID;
  if (socket === undefined && sessionId === undefined) return null;
  if (!socket || !isAbsolute(socket) || !sessionId)
    throw new Error(
      "Missing trusted turn-review socket/session binding; manual delivery is disabled",
    );
  const node = lstatSync(socket);
  const directory = lstatSync(dirname(socket));
  if (
    !node.isSocket() ||
    node.uid !== process.getuid?.() ||
    node.mode & 0o077 ||
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== process.getuid?.() ||
    directory.mode & 0o077
  )
    throw new Error("Turn-review runtime socket must be owner-private");
  return { sessionId, client: createClient({ socket }) };
}

export async function turnReviewCli(
  binding: Binding,
  args: readonly string[],
  ctx: ExtensionCliCommandContext,
): Promise<ExtensionCliCommandResult> {
  ctx.signal.throwIfAborted();
  if (args.length === 1 && ["--help", "help"].includes(args[0])) {
    await ctx.stdout.write(
      "hunk turn-review [latest|cumulative|pinned|status]\nUses the original attested native session; review is optional.\n",
    );
    return { kind: "exit", code: 0 };
  }
  if (
    args.length > 1 ||
    (args.length && !["latest", "cumulative", "pinned", "status"].includes(args[0]))
  )
    throw new Error("Usage: hunk turn-review [latest|cumulative|pinned|status]");
  await attestBinding(binding, ctx.cwd);
  if (args[0] === "status") {
    await ctx.stdout.write(
      JSON.stringify(
        await binding.client.request("review.status", { sessionId: binding.sessionId }),
        null,
        2,
      ) + "\n",
    );
    return { kind: "exit", code: 0 };
  }
  const selection = args[0];
  await selectedSnapshot(
    binding,
    selection === "latest" || selection === "cumulative" || selection === "pinned"
      ? { selection }
      : {},
  );
  if (args[0])
    await binding.client.request("review.select", {
      sessionId: binding.sessionId,
      selection: args[0],
    });
  ctx.signal.throwIfAborted();
  return { kind: "delegate", argv: ["diff", "--vcs", "turn-review"] };
}
