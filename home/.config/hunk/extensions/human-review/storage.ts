import {
  constants,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
  fchmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { digest } from "./process";

export function stateDirectory(checkout: string): string {
  const path =
    process.env.HUNK_HUMAN_REVIEW_STATE_DIRECTORY ??
    join(homedir(), ".local", "state", "hunk-human-review");
  if (!isAbsolute(path)) throw new Error("Review state directory must be absolute");
  privateDirectory(path);
  const rel = relative(realpathSync(checkout), realpathSync(path));
  if (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
    throw new Error("Review exports must be outside the reviewed checkout");
  for (let ancestor = realpathSync(path); ; ancestor = dirname(ancestor)) {
    try {
      lstatSync(join(ancestor, ".git"));
      throw new Error("Review exports must be outside all Git checkouts");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (dirname(ancestor) === ancestor) break;
  }
  return realpathSync(path);
}

export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error(
      "Review state directory must be an owner-private directory (0700), without a symlink",
    );
}

export function immutableFile(path: string, text: string): void {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, text, "utf8");
    fchmodSync(fd, 0o400);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function readPrivateJson<T>(path: string): T {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
}

export function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export interface Origin {
  note: unknown;
  file: unknown;
  patch: string | null;
  inventory: { id: string; path: string; previousPath?: string; patch: string }[];
  scope: unknown;
  capturedAt: string;
}

export function rememberOrigin(root: string, checkout: string, id: string, origin: Origin): Origin {
  const dir = join(root, "origins");
  privateDirectory(dir);
  const path = join(dir, `${digest([checkout, id])}.json`);
  try {
    immutableFile(path, JSON.stringify(origin, null, 2) + "\n");
    syncDirectory(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return readPrivateJson<Origin>(path);
}

export interface Exported {
  id: string;
  fingerprint: string;
  directory: string;
  json: string;
  markdown: string;
  sha256: string;
}

export function writeBatch(
  root: string,
  payload: object,
  fingerprint: string,
  markdown: string,
): Exported {
  const batches = join(root, "batches");
  privateDirectory(batches);
  const id = randomUUID();
  const directory = join(batches, id);
  privateDirectory(directory);
  const json = join(directory, "feedback.json");
  const body =
    JSON.stringify(
      {
        schema: "hunk-human-review",
        schemaVersion: 1,
        batchId: id,
        fingerprint,
        createdAt: new Date().toISOString(),
        ...payload,
      },
      null,
      2,
    ) + "\n";
  immutableFile(json, body);
  immutableFile(join(directory, "feedback.md"), `# Hunk human review ${id}\n\n${markdown}`);
  immutableFile(join(directory, "SHA256"), `${digest(body)}  feedback.json\n`);
  syncDirectory(directory);
  syncDirectory(batches);
  return {
    id,
    fingerprint,
    directory,
    json,
    markdown: join(directory, "feedback.md"),
    sha256: digest(body),
  };
}

export function attempts(root: string, fingerprint: string): unknown[] {
  const dir = join(root, "deliveries", fingerprint);
  try {
    return readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => readPrivateJson(join(dir, file)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Exclusive per-content delivery lock; a crash leaves evidence and blocks automatic retry. */
export async function deliver(
  root: string,
  batch: Exported,
  target: unknown,
  send: () => Promise<void>,
): Promise<void> {
  const dir = join(root, "deliveries");
  privateDirectory(dir);
  const receiptDir = join(dir, batch.fingerprint);
  privateDirectory(receiptDir);
  const lock = join(receiptDir, "in-flight");
  immutableFile(
    lock,
    JSON.stringify({ pid: process.pid, batchId: batch.id, startedAt: new Date().toISOString() }),
  );
  const attempt = randomUUID();
  const receipt = { attempt, batchId: batch.id, target, at: new Date().toISOString() };
  try {
    immutableFile(
      join(receiptDir, `${attempt}-started.json`),
      JSON.stringify({ ...receipt, state: "started" }, null, 2),
    );
    syncDirectory(receiptDir);
    try {
      await send();
    } catch (error) {
      immutableFile(
        join(receiptDir, `${attempt}-result.json`),
        JSON.stringify(
          {
            ...receipt,
            state: "uncertain",
            error: error instanceof Error ? error.message : "Delivery failed",
          },
          null,
          2,
        ),
      );
      throw error;
    }
    immutableFile(
      join(receiptDir, `${attempt}-result.json`),
      JSON.stringify(
        {
          ...receipt,
          state: "accepted",
          meaning: "Herdr acknowledged input, not addressed feedback",
        },
        null,
        2,
      ),
    );
  } finally {
    syncDirectory(receiptDir);
    unlinkSync(lock);
    syncDirectory(receiptDir);
  }
}
