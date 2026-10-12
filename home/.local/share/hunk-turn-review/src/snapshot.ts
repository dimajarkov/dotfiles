import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, normalize } from "node:path";
import { Store, within } from "./storage.js";

export interface Entry {
  kind: "file" | "symlink";
  mode: number;
  sha256: string;
}
export type Snapshot = Record<string, Entry>;
export function capture(store: Store, checkout: string): string {
  const files = execFileSync(
    "git",
    ["-C", checkout, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { maxBuffer: 64 * 1024 * 1024 },
  )
    .toString()
    .split("\0")
    .filter(Boolean);
  const snapshot = Object.create(null) as Snapshot;
  for (const file of [...new Set(files)].sort()) {
    if (file.startsWith("/") || normalize(file) !== file || file === ".." || file.startsWith("../"))
      throw new Error("Invalid Git inventory path");
    const path = join(checkout, file);
    // Reject symlinked ancestors, even links into the checkout. A link itself is metadata.
    let safe = true;
    for (let p = dirname(path); p !== checkout; p = dirname(p)) {
      if (!within(checkout, p)) throw new Error("Inventory escaped checkout");
      try {
        if (lstatSync(p).isSymbolicLink()) {
          safe = false;
          break;
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        safe = false;
        break;
      }
    }
    if (!safe) continue;
    try {
      const st = lstatSync(path);
      if (st.isSymbolicLink()) {
        const bytes = Buffer.from(readlinkSync(path));
        snapshot[file] = { kind: "symlink", mode: st.mode & 0o7777, sha256: store.blob(bytes) };
      } else if (st.isFile()) {
        if (!within(checkout, realpathSync(path))) throw new Error("File escaped checkout");
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const first = fstatSync(fd),
            bytes = readFileSync(fd),
            last = fstatSync(fd);
          if (
            first.ino !== last.ino ||
            first.size !== last.size ||
            first.mtimeMs !== last.mtimeMs ||
            first.ctimeMs !== last.ctimeMs ||
            !within(checkout, realpathSync(path))
          )
            throw new Error("Checkout changed during content capture; retry at next boundary");
          snapshot[file] = { kind: "file", mode: last.mode & 0o7777, sha256: store.blob(bytes) };
        } finally {
          closeSync(fd);
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return store.immutable("snapshots", snapshot);
}
export function differences(store: Store, before: string, after: string) {
  const a = store.read<Snapshot>(`snapshots/${before}.json`),
    b = store.read<Snapshot>(`snapshots/${after}.json`);
  const side = (entry?: Entry) =>
    entry
      ? {
          ...entry,
          content: store.content(entry.sha256).toString(entry.kind === "file" ? "base64" : "utf8"),
        }
      : null;
  const entry = (snapshot: Snapshot, path: string) =>
    Object.hasOwn(snapshot, path) ? snapshot[path] : undefined;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .sort()
    .filter((path) => JSON.stringify(entry(a, path)) !== JSON.stringify(entry(b, path)))
    .map((path) => ({ path, before: side(entry(a, path)), after: side(entry(b, path)) }));
}
