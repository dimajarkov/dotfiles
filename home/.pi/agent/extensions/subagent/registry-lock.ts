import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

async function openLock(path: string, timeoutSeconds: number): Promise<number> {
  const deadline = performance.now() + timeoutSeconds * 1_000;
  for (;;) {
    let fd: number;
    try {
      fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EISDIR") throw error;
      // Old runtimes used a directory at this path. Never infer that their ownership expired.
      if (performance.now() >= deadline) throw new Error(`Timed out waiting for legacy directory lock ${path}; reload its owner`);
      await delay(25);
      continue;
    }
    try {
      if (!fstatSync(fd).isFile()) throw new Error(`Registry lock is not a regular file: ${path}`);
      return fd;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
}

async function acquire(fd: number, path: string, timeoutSeconds: number): Promise<void> {
  let stderr = "";
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const helper = spawn("/usr/bin/lockf", ["-s", "-t", String(timeoutSeconds), "3"], {
      stdio: ["ignore", "ignore", "pipe", fd],
    });
    helper.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-2_000); });
    helper.once("error", (cause) => reject(new Error("Registry locking requires macOS /usr/bin/lockf with descriptor-mode support", { cause })));
    helper.once("close", (code, signal) => resolve({ code, signal }));
  });
  if (result.code === 0) return;
  if (result.code === 75) throw new Error(`Timed out acquiring registry lock ${path}`);
  const reason = result.signal ? `signal ${result.signal}` : `exit ${result.code ?? "unknown"}`;
  throw new Error(`Failed to acquire registry lock ${path}: ${reason}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
}

/**
 * Serialize registry work across processes, releasing ownership on return, throw, or process death.
 * The directory must already exist. Lock files persist and must never be unlinked or renamed.
 * macOS lockf's short helper shares the parent's open file description, so its exit retains the lock.
 */
export async function withRegistryLock<T>(
  path: string,
  operation: () => T | Promise<T>,
  { timeoutSeconds = 10 }: { timeoutSeconds?: number } = {},
): Promise<T> {
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 0) {
    throw new Error("Registry lock timeout must be a nonnegative integer number of seconds");
  }
  const fd = await openLock(path, timeoutSeconds);
  try {
    await acquire(fd, path, timeoutSeconds);
    return await operation();
  } finally {
    closeSync(fd);
  }
}
