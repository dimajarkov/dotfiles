import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Session, Review } from "./runtime.js";
import type { Snapshot } from "./snapshot.js";
import type { Batch } from "./feedback.js";
import { Store, syncDirectory } from "./storage.js";

const days30 = 30 * 24 * 60 * 60 * 1000;
export function retain(
  store: Store,
  sessions: Record<string, Session>,
  maxBytes: number,
  save: () => void,
  now = Date.now(),
) {
  const protectedReviews = new Set<string>(),
    protectedSnapshots = new Set<string>(),
    protectedBatches = new Set<string>();
  const allReviews = new Map<string, Review>();
  for (const s of Object.values(sessions))
    for (const id of s.reviews) allReviews.set(id, store.read<Review>(`reviews/${id}.json`));
  const keptBatches = new Set<string>();
  const pending = (state: string) => state === "draft" || state === "submitted";
  for (const s of Object.values(sessions)) {
    for (const id of [s.latest, s.cumulative, s.pinned]) if (id) protectedReviews.add(id);
    for (const id of [s.taskBaseline, s.active?.before]) if (id) protectedSnapshots.add(id);
    for (const n of s.notes) if (pending(n.state)) protectedReviews.add(n.reviewId);
    for (const [id, saved] of Object.entries(s.checkpoints ?? {}))
      if (saved.checkpoint.draft) protectedReviews.add(id);
    for (const b of s.batches) {
      const batch = store.read<Batch>(`batches/${b.payload}.json`);
      const protectedBatch =
        b.state !== "discarded" &&
        ((b.requested && b.state !== "queued") ||
          batch.notes.some((original) =>
            s.notes.some((n) => n.id === original.id && pending(n.state)),
          ));
      if (protectedBatch) protectedBatches.add(b.payload);
      if (protectedBatch || now - Date.parse(b.createdAt ?? batch.createdAt) <= days30)
        keptBatches.add(b.payload);
    }
    s.notes = s.notes.filter(
      (n) =>
        pending(n.state) ||
        now - Date.parse(n.updatedAt ?? allReviews.get(n.reviewId)?.createdAt ?? "1970-01-01") <=
          days30,
    );
  }
  const filesFor = (ids: Set<string>, batches: Set<string>) => {
    const files = new Set<string>(),
      snapshots = new Set(protectedSnapshots);
    for (const id of ids) {
      const r = allReviews.get(id);
      if (!r) continue;
      files.add(`reviews/${id}.json`);
      snapshots.add(r.before);
      snapshots.add(r.after);
    }
    for (const id of snapshots) {
      files.add(`snapshots/${id}.json`);
      for (const e of Object.values(store.read<Snapshot>(`snapshots/${id}.json`)))
        files.add(`blobs/${e.sha256}`);
    }
    for (const id of batches) files.add(`batches/${id}.json`);
    return files;
  };
  const bytes = (files: Set<string>) =>
    [...files].reduce((n, f) => n + lstatSync(join(store.root, f)).size, 0);
  const stateBytes = () => Buffer.byteLength(JSON.stringify({ version: 1, sessions }));
  const kept = new Set(allReviews.keys());
  const unprotected = [...allReviews.entries()]
    .filter(([id]) => !protectedReviews.has(id))
    .sort((a, b) => a[1].createdAt.localeCompare(b[1].createdAt));
  let removedReviews = 0;
  for (const [id, r] of unprotected)
    if (now - Date.parse(r.createdAt) > days30) {
      kept.delete(id);
      removedReviews++;
    }
  const pressureWarning =
    "storage pressure evicted unprotected history before 30 days; active task baselines and pending comments were preserved";
  const warnPressure = (session: Session) => {
    if (!session.warnings.includes(pressureWarning)) session.warnings.push(pressureWarning);
  };
  const update = () => {
    for (const s of Object.values(sessions)) {
      s.reviews = s.reviews.filter((id) => kept.has(id));
      if (s.checkpoints)
        s.checkpoints = Object.fromEntries(
          Object.entries(s.checkpoints).filter(([id]) => kept.has(id)),
        );
      s.batches = s.batches.filter((b) => keptBatches.has(b.payload));
    }
  };
  update();
  const total = () => bytes(filesFor(kept, keptBatches)) + stateBytes();
  for (const [id] of unprotected) {
    if (total() <= maxBytes) break;
    if (kept.delete(id)) {
      for (const session of Object.values(sessions))
        if (session.reviews.includes(id)) warnPressure(session);
      removedReviews++;
      update();
    }
  }
  const historicalBatches = Object.values(sessions)
    .flatMap((s) => s.batches)
    .filter((b) => !protectedBatches.has(b.payload))
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  for (const b of historicalBatches) {
    if (total() <= maxBytes) break;
    keptBatches.delete(b.payload);
    for (const session of Object.values(sessions))
      if (session.batches.some((batch) => batch.payload === b.payload)) warnPressure(session);
    update();
  }
  const closedNotes = Object.values(sessions)
    .flatMap((s) => s.notes.map((n) => ({ s, n })))
    .filter(({ n }) => !pending(n.state))
    .sort((a, b) => (a.n.updatedAt ?? "").localeCompare(b.n.updatedAt ?? ""));
  for (const { s, n } of closedNotes) {
    if (total() <= maxBytes) break;
    s.notes = s.notes.filter((note) => note !== n);
    warnPressure(s);
  }
  const protectedState = Object.fromEntries(
    Object.entries(sessions).map(([id, s]) => [
      id,
      {
        ...s,
        reviews: s.reviews.filter((id) => protectedReviews.has(id)),
        notes: s.notes.filter((n) => pending(n.state)),
        batches: s.batches.filter((b) => protectedBatches.has(b.payload)),
        checkpoints: Object.fromEntries(
          Object.entries(s.checkpoints ?? {}).filter(([id]) => protectedReviews.has(id)),
        ),
      },
    ]),
  );
  const protectedBytes =
    bytes(filesFor(protectedReviews, protectedBatches)) +
    Buffer.byteLength(JSON.stringify({ version: 1, sessions: protectedState }));
  const warning =
    "protected bytes exceed storage cap; active task baselines and pending comments were preserved";
  for (const s of Object.values(sessions)) {
    s.warnings = s.warnings.filter((w) => w !== warning);
    if (protectedBytes > maxBytes) s.warnings.push(warning);
  }
  save(); // Remove durable references before deleting unreachable content.
  const reachable = filesFor(kept, keptBatches);
  for (const dir of ["reviews", "snapshots", "blobs", "batches"]) {
    for (const name of readdirSync(join(store.root, dir))) {
      if (!/^[a-f0-9]{64}(\.json)?$/.test(name)) throw new Error("Unexpected retention state file");
      if (!reachable.has(`${dir}/${name}`)) unlinkSync(join(store.root, dir, name));
    }
    syncDirectory(join(store.root, dir));
  }
  return { protectedBytes, totalBytes: total(), maxBytes, removedReviews, retentionDays: 30 };
}
