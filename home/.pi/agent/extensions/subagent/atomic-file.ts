import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function removeTemporaryFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    return;
  }
}

export function atomicWriteText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, value, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
  } catch (error) {
    removeTemporaryFile(temporaryPath);
    throw error;
  }
}
