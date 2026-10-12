import { StringDecoder } from "node:string_decoder";
import { createServer } from "node:net";
import {
  chmodSync,
  existsSync,
  lstatSync,
  realpathSync,
  unlinkSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Store, hash, within } from "./storage.js";
import { capture, differences } from "./snapshot.js";
import {
  instructions,
  receiverRequest,
  type Batch,
  type Receipt,
  type Receiver,
} from "./feedback.js";
import { ensureLayout, type Layout, type LayoutState, type ReviewPlugin } from "./layout.js";
import { retain } from "./retention.js";
import { canonicalCheckout, nativeNoteRevision } from "../client.mjs";
import { validateCheckpoint, type StoredCheckpoint } from "./checkpoint.js";

export interface Identity {
  kind: "pi" | "codex";
  nativeId: string;
  sessionPath?: string;
  checkout: string;
}
export interface Review {
  requestId: string;
  requestGroup?: RequestGroup;
  before: string;
  after: string;
  outcome: string;
  createdAt: string;
  label: string;
}
export interface RequestGroup {
  mode: "all";
  requests: {
    id: string;
    source: string;
    delivery: "prompt" | "steer" | "followUp";
    correlationId?: string;
  }[];
}
export interface Note {
  id: string;
  reviewId: string;
  text: string;
  path?: string;
  side?: "before" | "after";
  line?: number;
  context?: unknown;
  updatedAt?: string;
  state: "draft" | "submitted" | "resolved" | "discarded";
}
export interface Session {
  identity: Identity;
  epoch: string;
  active?: { requestId: string; before: string; requestGroup?: RequestGroup };
  latest?: string;
  taskBaseline?: string;
  reviews: string[];
  notes: Note[];
  batches: Receipt[];
  receiver?: Receiver;
  warnings: string[];
  selection: "latest" | "cumulative" | "pinned";
  pinned?: string;
  cumulative?: string;
  layout?: Layout;
  layoutState?: LayoutState;
  layoutWarning?: { version: number; message: string };
  layoutWarningDeliveredVersion?: number;
  pinReason?: "manual" | "comments";
  checkpoints?: Record<string, StoredCheckpoint>;
}
interface State {
  version: 1;
  sessions: Record<string, Session>;
}
function requestGroup(value: unknown, requestId: string): RequestGroup | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "object" ||
    value === null ||
    !("mode" in value) ||
    value.mode !== "all" ||
    !("requests" in value) ||
    !Array.isArray(value.requests) ||
    value.requests.length < 2
  )
    throw new Error("Invalid request group");
  const requests = value.requests.map((r) => {
    if (
      typeof r !== "object" ||
      r === null ||
      typeof r.id !== "string" ||
      !r.id ||
      typeof r.source !== "string" ||
      !r.source ||
      !["prompt", "steer", "followUp"].includes(r.delivery) ||
      (r.correlationId !== undefined && typeof r.correlationId !== "string")
    )
      throw new Error("Invalid request group member");
    return {
      id: r.id,
      source: r.source,
      delivery: r.delivery,
      ...(r.correlationId === undefined ? {} : { correlationId: r.correlationId }),
    };
  });
  if (new Set([requestId, ...requests.map((r) => r.id)]).size !== requests.length + 1)
    throw new Error("Request group identities must be distinct");
  return { mode: "all", requests };
}
type NativeNoteContext = {
  nativeNoteId: string;
  revision: string;
  provenance?: unknown;
  reviewId?: string;
};
function nativeContext(note: Note): NativeNoteContext | null {
  if (typeof note.context !== "string") return null;
  try {
    const value = JSON.parse(note.context);
    return typeof value?.nativeNoteId === "string" && typeof value?.revision === "string"
      ? value
      : null;
  } catch {
    return null;
  }
}
function sameNativeNoteScope(left: Note, right: Note): boolean {
  const a = nativeContext(left);
  const b = nativeContext(right);
  return (
    a !== null &&
    b !== null &&
    typeof left.reviewId === "string" &&
    left.reviewId === right.reviewId &&
    a.reviewId === left.reviewId &&
    b.reviewId === right.reviewId &&
    a.nativeNoteId === b.nativeNoteId &&
    a.provenance !== undefined &&
    isDeepStrictEqual(a.provenance, b.provenance)
  );
}
function resolveNativeNoteRevisions(notes: Note[], target: Note, updatedAt: string): void {
  const context = nativeContext(target);
  if (
    context?.provenance === undefined ||
    typeof target.reviewId !== "string" ||
    context.reviewId !== target.reviewId
  ) {
    target.state = "resolved";
    target.updatedAt = updatedAt;
    return;
  }
  for (const note of notes)
    if (sameNativeNoteScope(note, target)) {
      note.state = "resolved";
      note.updatedAt = updatedAt;
    }
}
export async function startRuntime(options: {
  state: string;
  socket: string;
  reviewPlugin?: ReviewPlugin;
  maxBytes?: number;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const store = new Store(options.state);
  const release = store.acquire();
  const socket = resolve(options.socket);
  if (!within(store.root, realpathSync(dirname(socket)))) {
    release();
    throw new Error("Socket must be inside private state");
  }
  if (existsSync(socket)) {
    const st = lstatSync(socket);
    if (!st.isSocket() || st.uid !== process.getuid?.()) {
      release();
      throw new Error("Unsafe existing socket");
    }
    unlinkSync(socket);
  }
  const state: State = existsSync(`${store.root}/state.json`)
    ? store.read("state.json")
    : { version: 1, sessions: {} };
  if (state.version !== 1) {
    release();
    throw new Error("Unsupported durable state version");
  }
  const watchers = new Map<string, FSWatcher>();
  for (const s of Object.values(state.sessions))
    for (const b of s.batches)
      if (b.state === "submitting") {
        b.state = "uncertain";
        b.message = "Runtime restarted before durable admission receipt";
      }
  let serial: Promise<unknown> = Promise.resolve();
  const save = () => store.save("state.json", state);
  const warning = (s: Session, message: string) => {
    if (!s.warnings.includes(message)) s.warnings.push(message);
    s.warnings = s.warnings.slice(-100);
    save();
  };
  const followLatestIfSent = (s: Session) => {
    const unsent =
      Object.values(s.checkpoints ?? {}).some((c) => c.checkpoint.draft !== null) ||
      s.notes.some(
        (n) =>
          n.state === "draft" ||
          (n.state === "submitted" &&
            !s.batches.some(
              (b) =>
                b.state === "queued" &&
                store
                  .read<Batch>(`batches/${b.payload}.json`)
                  .notes.some((original) => original.id === n.id),
            )),
      );
    if (!unsent && s.pinReason !== "manual") {
      delete s.pinned;
      delete s.pinReason;
      if (s.selection === "pinned") s.selection = "latest";
    }
  };
  const submit = async (s: Session, receipt: Receipt) => {
    if (!receipt.requested || !["pending", "blocked"].includes(receipt.state) || receipt.attempted)
      return receipt;
    const batch = store.read<Batch>(`batches/${receipt.payload}.json`);
    const params = { identity: s.identity, epoch: s.epoch, batchId: batch.id };
    const prompt = instructions(batch);
    if (Buffer.byteLength(JSON.stringify({ ...params, batch, prompt })) + 1024 > 16 * 1024 * 1024) {
      receipt.state = "blocked";
      receipt.message =
        "Immutable feedback exceeds the native receiver limit; retained without an admission attempt";
      warning(s, receipt.message);
      return receipt;
    }
    try {
      const check = await receiverRequest(s.receiver, "admission.check", params);
      if (!check.ready) {
        receipt.state = "pending";
        receipt.message = check.reason ?? "Original session is busy";
        save();
        return receipt;
      }
    } catch (e) {
      receipt.state = "blocked";
      receipt.message = String(e);
      save();
      return receipt;
    }
    const sessionId = Object.keys(state.sessions).find((id) => state.sessions[id] === s)!;
    if (s.active?.requestId === receipt.id && !receipt.attempted)
      await dispatch("request.complete", {
        sessionId,
        epoch: s.epoch,
        requestId: receipt.id,
        outcome: "interrupted",
      });
    if (s.active) {
      receipt.state = "pending";
      receipt.message = "A user request still owns observation";
      save();
      return receipt;
    }
    try {
      arm(sessionId);
      s.active = { requestId: receipt.id, before: capture(store, s.identity.checkout) };
      save();
    } catch (e) {
      receipt.state = "blocked";
      receipt.message = `Feedback baseline unavailable: ${String(e)}`;
      save();
      return receipt;
    }
    receipt.state = "submitting";
    receipt.attempted = true;
    save();
    try {
      const result = await receiverRequest(s.receiver, "admission.enqueue", {
        ...params,
        batch,
        prompt,
      });
      if (result.state === "queued") {
        receipt.state = "queued";
        receipt.message = "Native queue admission only; not processed or resolved";
      } else if (result.state === "pending" || result.state === "blocked") {
        receipt.state = result.state;
        receipt.attempted = false;
        receipt.message = result.reason;
      } else {
        receipt.state = "uncertain";
        receipt.message = "Native receiver returned no admission receipt";
      }
    } catch (e) {
      receipt.state = "uncertain";
      receipt.message = String(e);
    }
    if (!receipt.attempted && s.active?.requestId === receipt.id) {
      delete s.active;
      watchers.get(sessionId)?.close();
      watchers.delete(sessionId);
    }
    followLatestIfSent(s);
    save();
    return receipt;
  };
  const reconcile = async (id: string) => {
    const s = state.sessions[id];
    if (!s?.active) return;
    const after = capture(store, s.identity.checkout);
    if (after !== s.active.before && !s.taskBaseline) s.taskBaseline = s.active.before;
    save();
    if (after !== s.active.before && s.layout) {
      const priorLayoutState = s.layoutState;
      try {
        await ensureLayout({
          layout: s.layout,
          identity: s.identity,
          current: s.layoutState,
          plugin: options.reviewPlugin,
          socket,
          sessionId: id,
          persist: (value) => {
            s.layoutState = value;
            save();
          },
        });
      } catch (e) {
        const detail = String(e);
        const message = `Automatic review unavailable: ${detail}. Offer full-width review tab.`;
        const repeatedWarning =
          s.layoutWarning?.message === message &&
          (priorLayoutState?.state === "unavailable" || priorLayoutState === undefined);
        if (!repeatedWarning)
          s.layoutWarning = {
            version: (s.layoutWarning?.version ?? 0) + 1,
            message,
          };
        warning(s, message);
      }
    }
  };
  const schedule = (work: () => Promise<unknown>) => {
    const result = serial.then(work);
    serial = result.catch(() => {});
    return result;
  };
  const arm = (id: string) => {
    if (watchers.has(id)) return;
    let queued = false;
    const watcher = watch(state.sessions[id].identity.checkout, { recursive: true }, () => {
      if (queued) return;
      queued = true;
      void schedule(() => reconcile(id))
        .catch((e) => warning(state.sessions[id], String(e)))
        .finally(() => {
          queued = false;
        });
    });
    watcher.on("error", (e) =>
      warning(state.sessions[id], `Observation unavailable: ${e.message}`),
    );
    watchers.set(id, watcher);
  };
  const dispatch = async (method: string, p: Record<string, any>) => {
    if (method === "session.find") {
      const matches = Object.entries(state.sessions).filter(
        ([, s]) =>
          s.identity.kind === p.kind &&
          s.identity.nativeId === p.nativeId &&
          s.identity.checkout === canonicalCheckout(p.checkout) &&
          (!p.sessionPath || s.identity.sessionPath === p.sessionPath),
      );
      if (matches.length !== 1)
        throw new Error("Native session is missing or ambiguous; specify the exact session path");
      return { sessionId: matches[0][0], ...matches[0][1] };
    }
    if (method === "session.attach") {
      const identity: Identity = {
        ...p.identity,
        checkout: canonicalCheckout(p.identity.checkout),
      };
      if (!["pi", "codex"].includes(identity.kind) || !identity.nativeId || !p.epoch)
        throw new Error("Missing native identity/epoch");
      store.assertCheckout(identity.checkout);
      const sessionId = hash(
        JSON.stringify([
          identity.kind,
          identity.nativeId,
          identity.sessionPath ?? null,
          identity.checkout,
        ]),
      );
      const s = (state.sessions[sessionId] ??= {
        identity,
        epoch: p.epoch,
        reviews: [],
        notes: [],
        batches: [],
        warnings: [],
        selection: "latest",
      });
      if (s.epoch !== p.epoch && s.receiver) {
        try {
          const owner = await receiverRequest(s.receiver, "admission.check", {
            identity: s.identity,
            epoch: s.epoch,
          });
          if (owner.state !== "blocked")
            throw new Error(
              "A living original receiver owns this native session; refusing replacement binding",
            );
        } catch (e) {
          if (!["ENOENT", "ECONNREFUSED"].includes((e as NodeJS.ErrnoException).code ?? ""))
            throw e;
        }
      }
      if (s.active && s.epoch !== p.epoch) {
        warning(
          s,
          "Original session resumed with a new runtime epoch; interrupted observation retained",
        );
        await dispatch("session.detach", { sessionId, epoch: s.epoch });
      }
      s.epoch = p.epoch;
      s.receiver = p.receiver;
      s.layout = p.layout;
      save();
      return { sessionId, ...s };
    }
    const s = state.sessions[p.sessionId];
    if (!s) throw new Error("Unknown session");
    if (
      p.expectedCheckpointVersion !== undefined &&
      (!s.reviews.includes(p.reviewId) ||
        s.checkpoints?.[p.reviewId]?.version !== p.expectedCheckpointVersion)
    )
      throw new Error("Checkpoint changed before feedback action");
    if (method.startsWith("request.") || method === "session.detach") {
      if (s.epoch !== p.epoch) throw new Error("Stale runtime epoch");
    }
    if (method === "request.begin") {
      if (!p.requestId) throw new Error("Missing external request ID");
      const group = requestGroup(p.requestGroup, p.requestId);
      if (s.active) {
        if (s.active.requestId === p.requestId) {
          if (JSON.stringify(s.active.requestGroup) !== JSON.stringify(group))
            throw new Error("Active request group changed");
          return { armed: true };
        }
        throw new Error("Previous user request is still active");
      }
      arm(p.sessionId);
      s.active = {
        requestId: p.requestId,
        before: capture(store, s.identity.checkout),
        ...(group ? { requestGroup: group } : {}),
      };
      save();
      return { armed: true };
    }
    if (method === "request.reconcile") {
      if (p.warningConsumer !== undefined && p.warningConsumer !== "codex-hook")
        throw new Error("Unknown warning consumer");
      if (p.warningConsumer === "codex-hook" && s.identity.kind !== "codex")
        throw new Error("Codex hook warning delivery requires the original Codex session");
      await reconcile(p.sessionId);
      if (
        p.warningConsumer === "codex-hook" &&
        s.layoutWarning &&
        s.layoutWarning.version > (s.layoutWarningDeliveredVersion ?? 0)
      ) {
        s.layoutWarningDeliveredVersion = s.layoutWarning.version;
        save();
        return {
          observed: true,
          warnings: [
            `Automatic Hunk review is unavailable for original Codex session ${s.identity.nativeId} (review session ${p.sessionId}): ${s.layoutWarning.message} Open the same review in a full-width tab with: hunk-turn-review-control tab --session-id ${p.sessionId}`,
          ],
        };
      }
      return { observed: true };
    }
    if (method === "request.bind") {
      if (!s.active || s.active.requestId !== p.expectedRequestId || !p.requestId)
        throw new Error("Observation identity changed before native request binding");
      const group = requestGroup(p.requestGroup, p.requestId);
      s.active.requestId = p.requestId;
      if (group) s.active.requestGroup = group;
      else delete s.active.requestGroup;
      save();
      return { armed: true };
    }
    if (method === "request.complete" || method === "session.detach") {
      if (method === "session.detach") {
        delete s.receiver;
        save();
      }
      if (!s.active) {
        watchers.get(p.sessionId)?.close();
        watchers.delete(p.sessionId);
      }
      if (!s.active)
        return {
          reviewId: s.reviews.find(
            (id) => store.read<Review>(`reviews/${id}.json`).requestId === p.requestId,
          ),
        };
      if (method !== "session.detach" && s.active.requestId !== p.requestId)
        throw new Error("Wrong external request ID");
      if (
        method !== "session.detach" &&
        !["completed", "interrupted", "failed"].includes(p.outcome)
      )
        throw new Error("Invalid outcome");
      await reconcile(p.sessionId);
      const review = {
        requestId: s.active.requestId,
        ...(s.active.requestGroup ? { requestGroup: s.active.requestGroup } : {}),
        before: s.active.before,
        after: capture(store, s.identity.checkout),
        outcome: method === "session.detach" ? "interrupted" : p.outcome,
        createdAt: new Date(now()).toISOString(),
        label: s.active.requestGroup
          ? `changes observed during intentional ${s.identity.kind === "pi" ? "Pi" : "Codex"} all-mode group: ${s.active.requestGroup.requests.length} user requests`
          : p.boundaryUnavailable
            ? "changes observed across unseparated Pi user requests"
            : "changes observed during this response",
      };
      const id = store.immutable("reviews", review);
      s.latest = id;
      s.reviews.push(id);
      if (s.taskBaseline) {
        const { requestGroup: _group, ...taskReview } = review;
        const cumulative = {
          ...taskReview,
          before: s.taskBaseline,
          label: "changes observed during this task",
        };
        s.cumulative = store.immutable("reviews", cumulative);
        s.reviews.push(s.cumulative);
      }
      delete s.active;
      watchers.get(p.sessionId)?.close();
      watchers.delete(p.sessionId);
      save();
      retain(store, state.sessions, options.maxBytes ?? 1024 * 1024 * 1024, save, now());
      return { reviewId: id };
    }
    if (method === "review.status")
      return {
        ...s,
        latestRequestGroup: s.latest
          ? store.read<Review>(`reviews/${s.latest}.json`).requestGroup
          : undefined,
        newAvailable: !!s.pinned && s.pinned !== s.latest,
        admittedNoteIds: s.batches
          .filter((b) => b.state === "queued")
          .flatMap((b) => store.read<Batch>(`batches/${b.payload}.json`).notes.map((n) => n.id)),
      };
    if (method === "session.warn") {
      if (s.epoch !== p.epoch || typeof p.message !== "string")
        throw new Error("Invalid native warning");
      warning(s, p.message);
      return { warnings: s.warnings };
    }
    if (method === "review.get") {
      const selection = p.selection ?? s.selection;
      const id =
        p.reviewId ??
        (selection === "pinned" ? s.pinned : selection === "cumulative" ? s.cumulative : s.latest);
      if (!id || !s.reviews.includes(id)) throw new Error("Review unavailable");
      const review = store.read<Review>(`reviews/${id}.json`);
      return {
        id,
        requestId: review.requestId,
        ...(review.requestGroup ? { requestGroup: review.requestGroup } : {}),
        outcome: review.outcome,
        label: review.label,
        createdAt: review.createdAt,
        changes: differences(store, review.before, review.after),
      };
    }
    if (method === "review.checkpoint.read" || method === "review.checkpoint.write") {
      if (!s.reviews.includes(p.reviewId)) throw new Error("Review unavailable");
      const prior = s.checkpoints?.[p.reviewId];
      if (method === "review.checkpoint.read") return prior ?? { version: 0, checkpoint: null };
      if (!Number.isSafeInteger(p.expectedVersion) || p.expectedVersion !== (prior?.version ?? 0))
        throw new Error("Checkpoint write conflict; reopen the original review");
      const checkpoint = validateCheckpoint(p.checkpoint, s.identity.checkout, p.reviewId);
      if (prior && prior.checkpoint.documentIdentity !== checkpoint.documentIdentity)
        throw new Error("Checkpoint document identity mismatch");
      if (
        prior?.checkpoint.generation === checkpoint.generation &&
        checkpoint.stateRevision < prior.checkpoint.stateRevision
      )
        throw new Error("Checkpoint native revision moved backwards");
      if (prior && isDeepStrictEqual(prior.checkpoint, checkpoint))
        return { version: prior.version };
      const updated = structuredClone(s);
      updated.checkpoints ??= {};
      updated.checkpoints[p.reviewId] = { version: (prior?.version ?? 0) + 1, checkpoint };
      const paths = new Set(
        differences(
          store,
          store.read<Review>(`reviews/${p.reviewId}.json`).before,
          store.read<Review>(`reviews/${p.reviewId}.json`).after,
        ).map((c) => c.path),
      );
      const revisions = new Set<string>();
      for (const native of checkpoint.notes) {
        if (
          updated.notes.some(
            (n) => n.reviewId !== p.reviewId && nativeContext(n)?.nativeNoteId === native.id,
          )
        )
          throw new Error("Native note cannot move from its original review");
        if (!paths.has(native.provenance.filePath))
          throw new Error("Native note anchor is not in immutable review");
        const revision = nativeNoteRevision(native, native.provenance);
        revisions.add(revision);
        const context = {
          nativeNoteId: native.id,
          revision,
          note: native,
          provenance: native.provenance,
          reviewId: p.reviewId,
        };
        const priorNote = updated.notes.find(
          (n) => n.reviewId === p.reviewId && nativeContext(n)?.revision === revision,
        );
        if (priorNote) {
          if (native.status === "resolved")
            resolveNativeNoteRevisions(updated.notes, priorNote, new Date(now()).toISOString());
          else if (priorNote.state === "resolved" || priorNote.state === "discarded")
            priorNote.state = "draft";
          continue;
        }
        // The first revision uses the native ID. Later immutable revisions retain
        // it in context and use an explicit derived revision ID, never a new native ID.
        const id = updated.notes.some((n) => n.id === native.id)
          ? `${native.id}@${revision}`
          : native.id;
        const updatedAt = new Date(now()).toISOString();
        const note: Note = {
          id,
          reviewId: p.reviewId,
          text: native.summary,
          path: native.provenance.filePath,
          side:
            native.anchor.preferred?.side === "old"
              ? "before"
              : native.anchor.preferred?.side === "new"
                ? "after"
                : undefined,
          line: native.anchor.preferred?.line,
          context: JSON.stringify(context),
          updatedAt,
          state: native.status === "resolved" ? "resolved" : "draft",
        };
        updated.notes.push(note);
        if (native.status === "resolved")
          resolveNativeNoteRevisions(updated.notes, note, updatedAt);
      }
      for (const n of updated.notes) {
        const context = nativeContext(n);
        if (
          n.reviewId === p.reviewId &&
          context &&
          !revisions.has(context.revision) &&
          n.state === "draft"
        )
          n.state = "discarded";
      }
      if (
        checkpoint.draft ||
        updated.notes.some((n) => n.reviewId === p.reviewId && n.state === "draft")
      ) {
        if (updated.pinReason !== "manual") {
          updated.pinned = p.reviewId;
          updated.pinReason = "comments";
        }
        updated.selection = "pinned";
      } else followLatestIfSent(updated);
      store.save("state.json", {
        ...state,
        sessions: { ...state.sessions, [p.sessionId]: updated },
      });
      Object.assign(s, updated);
      // Object.assign must also reflect removal of automatic pin fields.
      if (!updated.pinned) delete s.pinned;
      if (!updated.pinReason) delete s.pinReason;
      return { version: updated.checkpoints[p.reviewId].version };
    }
    if (method === "review.select" || method === "review.pin") {
      if (method === "review.pin") {
        if (!s.reviews.includes(p.reviewId)) throw new Error("Review unavailable");
        s.pinned = p.reviewId;
        s.pinReason = "manual";
        s.selection = "pinned";
      } else {
        if (!["latest", "cumulative", "pinned"].includes(p.selection))
          throw new Error("Invalid selection");
        s.selection = p.selection;
      }
      save();
      return { selection: s.selection, pinned: s.pinned };
    }
    if (method === "note.save") {
      if (
        !s.reviews.includes(p.reviewId) ||
        typeof p.note?.text !== "string" ||
        !p.note.text.trim()
      )
        throw new Error("Invalid note/review");
      const prior = s.notes.find((n) => n.id === p.note.id);
      if (prior && prior.reviewId !== p.reviewId)
        throw new Error("A note cannot change its original review anchor");
      if (p.note.path !== undefined) {
        const review = store.read<Review>(`reviews/${p.reviewId}.json`);
        if (
          typeof p.note.path !== "string" ||
          !differences(store, review.before, review.after).some((c) => c.path === p.note.path)
        )
          throw new Error("Note anchor is not in the immutable review");
      }
      if (p.note.line !== undefined && (!Number.isInteger(p.note.line) || p.note.line < 1))
        throw new Error("Invalid note line");
      if (p.note.side !== undefined && !["before", "after"].includes(p.note.side))
        throw new Error("Invalid note side");
      const editable = prior?.state === "draft" ? prior : undefined;
      const note: Note = {
        id: editable?.id ?? randomUUID(),
        reviewId: p.reviewId,
        text: p.note.text,
        path: p.note.path,
        side: p.note.side,
        line: p.note.line,
        context: p.note.context,
        updatedAt: new Date(now()).toISOString(),
        state: "draft",
      };
      if (editable) Object.assign(editable, note);
      else s.notes.push(note);
      s.pinned ??= p.reviewId;
      if (s.pinReason !== "manual") s.pinReason = "comments";
      s.selection = "pinned";
      save();
      return note;
    }
    if (method === "note.discard" || method === "note.resolve") {
      const note = s.notes.find((n) => n.id === p.noteId);
      if (!note) throw new Error("Unknown note");
      const updatedAt = new Date(now()).toISOString();
      if (method === "note.discard") {
        note.state = "discarded";
        note.updatedAt = updatedAt;
      } else resolveNativeNoteRevisions(s.notes, note, updatedAt);
      followLatestIfSent(s);
      save();
      return note;
    }
    if (method === "task.reset") {
      if (s.active) throw new Error("Cannot reset task during an active request");
      const pending = s.notes.filter((n) => ["draft", "submitted"].includes(n.state));
      const composers = Object.values(s.checkpoints ?? {}).some((c) => c.checkpoint.draft);
      if ((pending.length || composers) && p.discardPending !== true)
        throw new Error("Explicit discard required for pending notes");
      for (const n of pending) {
        n.state = "discarded";
        n.updatedAt = new Date(now()).toISOString();
      }
      if (p.discardPending === true)
        for (const saved of Object.values(s.checkpoints ?? {})) {
          saved.version++;
          saved.checkpoint.draft = null;
          saved.checkpoint.notes = saved.checkpoint.notes.filter((n) => n.status === "resolved");
          saved.checkpoint.selection.activeNoteId = null;
        }
      for (const b of s.batches)
        if (b.state !== "queued") {
          b.state = "discarded";
          b.requested = false;
        }
      delete s.taskBaseline;
      delete s.cumulative;
      delete s.pinned;
      delete s.pinReason;
      s.selection = "latest";
      save();
      return { reset: true };
    }
    if (method === "batch.create") {
      if (
        !Array.isArray(p.noteIds) ||
        !p.noteIds.length ||
        new Set(p.noteIds).size !== p.noteIds.length
      )
        throw new Error("Select pending human notes");
      const notes: Note[] = p.noteIds.map((id: string) => {
        const note = s.notes.find((n) => n.id === id);
        if (!note || note.state !== "draft") throw new Error("Select unsent draft notes");
        return note;
      });
      const fingerprint = hash(JSON.stringify([s.identity, notes]));
      const existing = s.batches.find((b) => b.fingerprint === fingerprint);
      if (existing) return { id: existing.id, state: existing.state };
      const reviews = [...new Set(notes.map((n: Note) => n.reviewId))].map((id) => {
        const review = store.read<Review>(`reviews/${id}.json`);
        return { id, ...review, changes: differences(store, review.before, review.after) };
      });
      const batch: Batch = {
        id: randomUUID(),
        createdAt: new Date(now()).toISOString(),
        identity: s.identity,
        notes: structuredClone(notes),
        reviews,
      };
      const payload = store.immutable("batches", batch);
      const receipt: Receipt = {
        id: batch.id,
        payload,
        state: "pending",
        requested: false,
        fingerprint,
        createdAt: batch.createdAt,
      };
      s.batches.push(receipt);
      save();
      return { id: batch.id, state: receipt.state };
    }
    if (method === "batch.submit" || method === "batch.reconcile" || method === "batch.retry") {
      const receipt = s.batches.find((b) => b.id === p.batchId);
      if (!receipt) throw new Error("Unknown immutable batch");
      if (method === "batch.submit") {
        if (receipt.state === "discarded") throw new Error("Batch was explicitly discarded");
        if (receipt.attempted) return receipt;
        receipt.requested = true;
        const batch = store.read<Batch>(`batches/${receipt.payload}.json`);
        for (const n of s.notes)
          if (
            n.state === "draft" &&
            batch.notes.some((original) => JSON.stringify(original) === JSON.stringify(n))
          )
            n.state = "submitted";
        save();
        return submit(s, receipt);
      }
      if (method === "batch.reconcile") {
        try {
          const result = await receiverRequest(s.receiver, "admission.reconcile", {
            identity: s.identity,
            epoch: s.epoch,
            batchId: receipt.id,
          });
          if (result.state === "queued") {
            receipt.state = "queued";
            receipt.reconciliation = "queued";
            receipt.message = result.evidence;
          } else if (result.state === "absent") {
            receipt.reconciliation = "absent";
            receipt.message = result.evidence;
          } else {
            receipt.reconciliation = "unknown";
            receipt.message = "Native queue/history cannot establish admission";
          }
        } catch (e) {
          receipt.reconciliation = "unknown";
          receipt.message = String(e);
        }
        followLatestIfSent(s);
        save();
        return receipt;
      }
      if (receipt.state === "queued") throw new Error("Batch already admitted");
      if (receipt.state === "discarded") throw new Error("Batch was explicitly discarded");
      if (
        receipt.reconciliation !== "absent" &&
        !(receipt.reconciliation === "unknown" && p.confirmUncertain === true)
      )
        throw new Error(
          "Reconcile native queue/history before explicit retry; admission remains ambiguous",
        );
      // Confirmation acknowledges duplicate risk, never receiver uncertainty.
      const checked = await receiverRequest(s.receiver, "admission.check", {
        identity: s.identity,
        epoch: s.epoch,
        batchId: receipt.id,
      });
      if (checked.ready !== true)
        throw new Error(
          "Original native receiver cannot safely retry; identity or idle boundary unavailable",
        );
      receipt.state = "pending";
      receipt.attempted = false;
      delete receipt.reconciliation;
      save();
      return submit(s, receipt);
    }
    if (method === "session.idle") {
      if (s.epoch !== p.epoch) throw new Error("Stale runtime epoch");
      for (const receipt of s.batches) if (receipt.requested) await submit(s, receipt);
      return { batches: s.batches };
    }
    if (method === "layout.reopen" || method === "layout.tab") {
      if (!s.layout) throw new Error("Named Herdr layout is unavailable");
      // Only explicit commands may create a replacement after closure/uncertainty.
      return ensureLayout({
        layout: s.layout,
        identity: s.identity,
        current: s.layoutState,
        explicit: true,
        plugin: options.reviewPlugin,
        socket,
        sessionId: p.sessionId,
        placement: method === "layout.tab" ? "tab" : "split",
        persist: (value) => {
          s.layoutState = value;
          save();
        },
      });
    }
    if (method === "maintenance.run")
      return retain(store, state.sessions, options.maxBytes ?? 1024 * 1024 * 1024, save, now());
    throw new Error(`Unknown command: ${method}`);
  };
  const server = createServer((connection) => {
    connection.setTimeout(30000, () => connection.destroy());
    let buffer = "",
      used = false;
    const decoder = new StringDecoder("utf8");
    connection.on("error", () => {});
    connection.on("data", (chunk) => {
      if (used) return;
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024 + 65536) {
        connection.destroy();
        return;
      }
      if (!buffer.includes("\n")) return;
      used = true;
      let request: { version: number; id: string; method: string; params: Record<string, any> };
      try {
        request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      } catch {
        connection.destroy();
        return;
      }
      void schedule(async () => {
        try {
          if (request.version !== 1) throw new Error("Unsupported protocol version");
          const result = await dispatch(request.method, request.params ?? {});
          connection.end(JSON.stringify({ version: 1, id: request.id, result }) + "\n");
        } catch (e) {
          connection.end(
            JSON.stringify({
              version: 1,
              id: request.id,
              error: { code: "REFUSED", message: e instanceof Error ? e.message : String(e) },
            }) + "\n",
          );
        }
      });
    });
  });
  // An observation gap cannot be described as a completed response.
  for (const [sessionId, s] of Object.entries(state.sessions))
    if (s.active) {
      s.warnings.push(
        "Runtime restarted during observation; interrupted interval includes possible shared-writer changes",
      );
      const receiver = s.receiver;
      await dispatch("session.detach", { sessionId, epoch: s.epoch });
      s.receiver = receiver;
      save();
    }
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(socket, res);
  });
  chmodSync(socket, 0o600);
  let checking = false;
  const monitor = setInterval(() => {
    if (checking) return;
    checking = true;
    void schedule(async () => {
      for (const [sessionId, s] of Object.entries(state.sessions))
        if (s.active && s.receiver) {
          try {
            const result = await receiverRequest(s.receiver, "admission.check", {
              identity: s.identity,
              epoch: s.epoch,
            });
            if (result.state === "blocked") {
              warning(
                s,
                "Original receiver identity was invalidated; interrupted observation retained",
              );
              await dispatch("session.detach", { sessionId, epoch: s.epoch });
            }
          } catch (e) {
            if (["ENOENT", "ECONNREFUSED"].includes((e as NodeJS.ErrnoException).code ?? "")) {
              warning(s, "Original receiver exited; interrupted observation retained");
              await dispatch("session.detach", { sessionId, epoch: s.epoch });
            } else warning(s, `Original receiver liveness uncertain: ${String(e)}`);
          }
        }
    })
      .catch(() => {})
      .finally(() => {
        checking = false;
      });
  }, 1000);
  monitor.unref();
  const maintenance = setInterval(
    () =>
      void schedule(async () =>
        retain(store, state.sessions, options.maxBytes ?? 1024 * 1024 * 1024, save, now()),
      ).catch((e) => {
        for (const s of Object.values(state.sessions))
          warning(s, `Storage maintenance unavailable: ${String(e)}`);
      }),
    60 * 60 * 1000,
  );
  maintenance.unref();
  return {
    close: async () => {
      clearInterval(monitor);
      clearInterval(maintenance);
      for (const w of watchers.values()) w.close();
      await serial;
      await new Promise<void>((r) => server.close(() => r()));
      if (existsSync(socket)) unlinkSync(socket);
      release();
    },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const value = (name: string) => {
    const i = process.argv.indexOf(name);
    if (i < 0 || !process.argv[i + 1]) throw new Error(`Required ${name}`);
    return process.argv[i + 1];
  };
  const runtime = await startRuntime({
    state: value("--state"),
    socket: value("--socket"),
    reviewPlugin: process.argv.includes("--pluginId")
      ? { id: value("--pluginId"), entrypoint: value("--entrypoint") }
      : undefined,
    maxBytes: process.argv.includes("--maxBytes") ? Number(value("--maxBytes")) : undefined,
  });
  process.stdout.write("Hunk turn-review runtime ready\n");
  process.once("SIGTERM", () => void runtime.close());
  process.once("SIGINT", () => void runtime.close());
}
