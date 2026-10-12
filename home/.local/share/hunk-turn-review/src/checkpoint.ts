// The host validates native source semantics. Core owns bounded JSON storage and
// canonical session/review membership, without depending on Hunk internals.
export interface Checkpoint {
  version: 1;
  checkoutRoot: string;
  reviewId: string;
  documentIdentity: string;
  generation: string;
  stateRevision: number;
  notes: Record<string, any>[];
  draft: Record<string, any> | null;
  selection: Record<string, any>;
}
export interface StoredCheckpoint {
  version: number;
  checkpoint: Checkpoint;
}
const record = (v: unknown): v is Record<string, any> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
export function validateCheckpoint(value: unknown, checkout: string, reviewId: string): Checkpoint {
  const json = JSON.stringify(value);
  if (!json || Buffer.byteLength(json) > 4 * 1024 * 1024)
    throw new Error("Checkpoint exceeds JSON bounds");
  const visit = (v: unknown, depth = 0): void => {
    if (depth > 64) throw new Error("Checkpoint exceeds JSON depth");
    if (typeof v === "number" && !Number.isFinite(v))
      throw new Error("Checkpoint requires JSON-safe values");
    if (v === null || ["string", "number", "boolean"].includes(typeof v)) return;
    if (Array.isArray(v)) {
      for (const child of v) visit(child, depth + 1);
      return;
    }
    if (!record(v)) throw new Error("Checkpoint requires JSON-safe values");
    for (const child of Object.values(v)) visit(child, depth + 1);
  };
  visit(value);
  if (!record(value) || value.version !== 1 || value.checkoutRoot !== checkout)
    throw new Error("Checkpoint checkout/version mismatch");
  if (value.reviewId !== reviewId) throw new Error("Checkpoint review mismatch");
  if (
    typeof value.documentIdentity !== "string" ||
    !value.documentIdentity ||
    typeof value.generation !== "string" ||
    !value.generation ||
    !Number.isSafeInteger(value.stateRevision) ||
    value.stateRevision < 0 ||
    !Array.isArray(value.notes) ||
    value.notes.length > 2048 ||
    !(value.draft === null || record(value.draft)) ||
    !record(value.selection)
  )
    throw new Error("Invalid native checkpoint");
  const ids = new Set<string>();
  for (const note of value.notes) {
    if (
      !record(note) ||
      typeof note.id !== "string" ||
      !note.id ||
      ids.has(note.id) ||
      note.source !== "user" ||
      typeof note.summary !== "string" ||
      !note.summary.trim() ||
      !record(note.anchor) ||
      !record(note.provenance) ||
      typeof note.provenance.filePath !== "string" ||
      !note.provenance.filePath ||
      ![undefined, "open", "resolved"].includes(note.status)
    )
      throw new Error("Inconsistent native checkpoint notes");
    ids.add(note.id);
  }
  for (const note of value.notes)
    if (note.parentId !== undefined && (!ids.has(note.parentId) || note.parentId === note.id))
      throw new Error("Inconsistent native note parent");
  if (value.draft?.targetNoteId !== undefined && !ids.has(value.draft.targetNoteId))
    throw new Error("Inconsistent native draft target");
  return JSON.parse(json);
}
