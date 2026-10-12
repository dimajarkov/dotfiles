import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import type {
  ExtensionVcsAdapter,
  ExtensionVcsExtraFile,
  ExtensionVcsPatchResult,
} from "hunkdiff/extension";
import { digest } from "./process";

export interface RuntimeClient {
  request(method: string, params?: object): Promise<unknown>;
}
export interface Binding {
  sessionId: string;
  client: RuntimeClient;
}
export interface SnapshotSide {
  kind: "file" | "symlink";
  mode: number;
  sha256: string;
  content: string;
}
export interface TurnSnapshot {
  id: string;
  requestId: string;
  outcome: string;
  createdAt: string;
  label: string;
  changes: { path: string; before: SnapshotSide | null; after: SnapshotSide | null }[];
}
export interface SnapshotSelection {
  reviewId?: string;
  selection?: "latest" | "cumulative" | "pinned";
}
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || value.includes("\0"))
    throw new Error(`Invalid runtime ${name}`);
  return value;
}
function side(value: unknown): SnapshotSide | null {
  if (value === null) return null;
  if (
    !record(value) ||
    !["file", "symlink"].includes(String(value.kind)) ||
    typeof value.mode !== "number" ||
    !Number.isInteger(value.mode) ||
    typeof value.content !== "string"
  )
    throw new Error("Invalid captured source");
  const kind = value.kind === "file" ? "file" : "symlink";
  const sha256 = text(value.sha256, "source checksum");
  const bytes = Buffer.from(value.content, kind === "file" ? "base64" : "utf8");
  if (createHash("sha256").update(bytes).digest("hex") !== sha256)
    throw new Error("Captured source checksum mismatch");
  return { kind, mode: value.mode, sha256, content: value.content };
}
export function parseSnapshot(value: unknown): TurnSnapshot {
  if (!record(value) || !Array.isArray(value.changes)) throw new Error("Invalid immutable review");
  const paths = new Set<string>();
  const changes = value.changes.map((entry: unknown) => {
    if (!record(entry)) throw new Error("Invalid review change");
    const path = text(entry.path, "path");
    if (
      isAbsolute(path) ||
      path === ".." ||
      path.startsWith("../") ||
      normalize(path) !== path ||
      paths.has(path)
    )
      throw new Error("Unsafe or duplicate snapshot path");
    paths.add(path);
    return { path, before: side(entry.before), after: side(entry.after) };
  });
  return {
    id: text(value.id, "review ID"),
    requestId: text(value.requestId, "request ID"),
    outcome: text(value.outcome, "outcome"),
    createdAt: text(value.createdAt, "createdAt"),
    label: text(value.label, "label"),
    changes,
  };
}
/** An uncompleted first response has no immutable snapshot yet. Never read its live files. */
export async function selectedSnapshot(
  binding: Binding,
  selection: SnapshotSelection = {},
): Promise<TurnSnapshot | null> {
  if (!selection.reviewId) {
    const status = await binding.client.request("review.status", { sessionId: binding.sessionId });
    if (!record(status)) throw new Error("Original review selection unavailable");
    if ((selection.selection ?? status.selection) === "latest" && status.latest === undefined)
      return null;
  }
  return parseSnapshot(
    await binding.client.request("review.get", { sessionId: binding.sessionId, ...selection }),
  );
}
export async function attestBinding(binding: Binding, cwd: string): Promise<string> {
  const status = await binding.client.request("review.status", { sessionId: binding.sessionId });
  if (
    !record(status) ||
    !record(status.identity) ||
    !["pi", "codex"].includes(String(status.identity.kind))
  )
    throw new Error("Original native binding unavailable");
  text(status.identity.nativeId, "native session");
  const checkout = text(status.identity.checkout, "checkout");
  const root = realpathSync(checkout);
  const rel = relative(root, realpathSync(cwd));
  if (root !== checkout || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error("Review checkout does not match original canonical binding");
  return root;
}
const maxBytes = 2 * 1024 * 1024;
function bytes(side: SnapshotSide): Buffer {
  return Buffer.from(side.content, side.kind === "file" ? "base64" : "utf8");
}
function mode(side: SnapshotSide): string {
  return side.kind === "symlink" ? "120000" : side.mode & 0o111 ? "100755" : "100644";
}
function quoted(path: string): string {
  return JSON.stringify(path);
}

async function patch(
  path: string,
  before: SnapshotSide | null,
  after: SnapshotSide | null,
  signal?: AbortSignal,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hunk-turn-source."));
  try {
    await chmod(dir, 0o700);
    for (const [name, source] of [
      ["before", before],
      ["after", after],
    ] satisfies [string, SnapshotSide | null][]) {
      if (source) {
        await writeFile(join(dir, name), bytes(source), { mode: 0o600 });
        await chmod(join(dir, name), source.mode & 0o111 ? 0o700 : 0o600);
      }
    }
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        [
          "-c",
          "core.quotePath=false",
          "diff",
          "--no-index",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--no-prefix",
          "--",
          before ? "before" : "/dev/null",
          after ? "after" : "/dev/null",
        ],
        { cwd: dir, signal, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout) => {
          if (error && error.code !== 1) reject(new Error("Captured source diff failed"));
          else resolve(stdout);
        },
      );
    });
    const header = `diff --git ${quoted(`a/${path}`)} ${quoted(`b/${path}`)}\n`;
    const modes =
      !before && after
        ? `new file mode ${mode(after)}\n`
        : before && !after
          ? `deleted file mode ${mode(before)}\n`
          : before && after && mode(before) !== mode(after)
            ? `old mode ${mode(before)}\nnew mode ${mode(after)}\n`
            : "";
    const body = output
      .split("\n")
      .filter((line) => !/^(diff --git |(?:old|new|deleted file|new file) mode |index )/.test(line))
      .map((line) => {
        if (line === "--- before") return `--- ${quoted(`a/${path}`)}`;
        if (line === "+++ after") return `+++ ${quoted(`b/${path}`)}`;
        if (line.startsWith("Binary files "))
          return `Binary files ${quoted(`a/${path}`)} and ${quoted(`b/${path}`)} differ`;
        return line;
      })
      .join("\n");
    return header + modes + body;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function createSnapshotAdapter(
  binding: Binding,
  selection: () => SnapshotSelection = () => ({}),
  onLoad?: (review: TurnSnapshot | null, root: string, title: string) => void,
): ExtensionVcsAdapter {
  return {
    id: "turn-review",
    name: "Immutable user-request turn",
    detect: () => null,
    operations: {
      "working-tree-diff": {
        async load(input, ctx): Promise<ExtensionVcsPatchResult> {
          if (input.staged || input.range || input.rangeEndpoints || input.pathspecs?.length)
            throw new Error("Turn review requires its complete immutable scope");
          ctx.signal?.throwIfAborted();
          const root = await attestBinding(binding, ctx.cwd);
          const review = await selectedSnapshot(binding, selection());
          const extraFiles: ExtensionVcsExtraFile[] = [];
          const patches: string[] = [];
          for (const change of review?.changes ?? []) {
            ctx.signal?.throwIfAborted();
            if (
              [change.before, change.after].some(
                (source) => source && bytes(source).length > maxBytes,
              )
            )
              extraFiles.push({
                kind: "skipped",
                path: change.path,
                reason: "too-large",
                changeType: !change.before ? "new" : !change.after ? "deleted" : "change",
              });
            else patches.push(await patch(change.path, change.before, change.after, ctx.signal));
          }
          const sources = new Map((review?.changes ?? []).map((change) => [change.path, change]));
          const title = review
            ? `${review.label} (${review.outcome}; ${review.id})`
            : "Waiting for first completed response";
          ctx.signal?.throwIfAborted();
          onLoad?.(review, root, title);
          return {
            repoRoot: root,
            sourceLabel: root,
            title,
            patchText: patches.join(""),
            extraFiles,
            sourceCacheKey: digest(
              (review?.changes ?? []).map(({ path, before, after }) => [path, before, after]),
            ),
            async readFileSource(request) {
              const change = sources.get(
                request.side === "old" ? (request.previousPath ?? request.path) : request.path,
              );
              const source = request.side === "old" ? change?.before : change?.after;
              if (!source) return null;
              const content = bytes(source);
              if (content.length > maxBytes) return { kind: "too-large", maxBytes };
              const result = content.toString("utf8");
              return Buffer.from(result).equals(content) ? result : null;
            },
          };
        },
      },
    },
  };
}
