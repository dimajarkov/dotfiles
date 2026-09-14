import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { atomicWriteText } from "./atomic-file.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "herdr-atomic-file-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

test("atomic text publication creates private directories and files", () => {
  const root = temporaryDirectory();
  const directory = join(root, "nested");
  const path = join(directory, "record.json");

  atomicWriteText(path, "first\n");
  atomicWriteText(path, "second\n");

  assert.equal(readFileSync(path, "utf8"), "second\n");
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(directory), ["record.json"]);
});

test("failed atomic text publication removes its unique temporary file", () => {
  const root = temporaryDirectory();
  const path = join(root, "occupied");
  mkdirSync(path);

  assert.throws(() => atomicWriteText(path, "value\n"));
  assert.deepEqual(readdirSync(root), ["occupied"]);
});
