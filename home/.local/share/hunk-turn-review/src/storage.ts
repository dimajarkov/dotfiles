import {
  constants,
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export function within(parent: string, child: string) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
export function privateDirectory(path: string) {
  if (!isAbsolute(path)) throw new Error("State path must be absolute");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || st.mode & 0o077)
    throw new Error("State requires owner-private nonsymlink directories");
}
export function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function privateRead(path: string): Buffer {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.() || st.mode & 0o077)
    throw new Error("Unsafe state file");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function durableWrite(path: string, bytes: Buffer | string, immutable = false) {
  const target = immutable ? path : join(dirname(path), `.${randomUUID()}.tmp`);
  const fd = openSync(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, bytes);
    if (immutable) fchmodSync(fd, 0o400);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (!immutable) renameSync(target, path);
  syncDirectory(dirname(path));
}
export class Store {
  readonly root: string;
  constructor(root: string) {
    if (!isAbsolute(root)) throw new Error("State path must be absolute");
    let ancestor = resolve(root);
    while (true) {
      try {
        lstatSync(ancestor);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        ancestor = dirname(ancestor);
      }
    }
    const canonical = join(realpathSync(ancestor), relative(ancestor, resolve(root)));
    for (let p = canonical; ; p = dirname(p)) {
      try {
        lstatSync(join(p, ".git"));
        throw new Error("Review state must be outside every Git checkout");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if (dirname(p) === p) break;
    }
    privateDirectory(root);
    this.root = realpathSync(root);
    for (const name of ["blobs", "snapshots", "reviews", "batches"])
      privateDirectory(join(this.root, name));
  }
  read<T>(name: string): T {
    const bytes = privateRead(join(this.root, name));
    const immutable = name.match(/^(?:snapshots|reviews|batches)\/([a-f0-9]{64})\.json$/);
    if (immutable && hash(bytes) !== immutable[1])
      throw new Error("Immutable state checksum mismatch");
    return JSON.parse(bytes.toString());
  }
  save(name: string, value: unknown, immutable = false) {
    durableWrite(join(this.root, name), JSON.stringify(value), immutable);
  }
  blob(bytes: Buffer) {
    const id = hash(bytes),
      path = join(this.root, "blobs", id);
    try {
      durableWrite(path, bytes, true);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    if (hash(privateRead(path)) !== id) throw new Error("Snapshot content checksum mismatch");
    return id;
  }
  content(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid content ID");
    const bytes = privateRead(join(this.root, "blobs", id));
    if (hash(bytes) !== id) throw new Error("Snapshot content checksum mismatch");
    return bytes;
  }
  immutable<T>(kind: "snapshots" | "reviews" | "batches", value: T) {
    const id = hash(JSON.stringify(value));
    try {
      this.save(`${kind}/${id}.json`, value, true);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    return id;
  }
  acquire() {
    const path = join(this.root, "runtime.lock");
    try {
      durableWrite(path, JSON.stringify({ pid: process.pid }), true);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const prior = this.read<{ pid: number }>("runtime.lock");
      try {
        process.kill(prior.pid, 0);
        throw new Error("Runtime already owns state");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      unlinkSync(path);
      durableWrite(path, JSON.stringify({ pid: process.pid }), true);
    }
    return () => {
      unlinkSync(path);
      syncDirectory(this.root);
    };
  }
  assertCheckout(checkout: string) {
    if (within(checkout, this.root)) throw new Error("State must be outside checkout");
  }
}
