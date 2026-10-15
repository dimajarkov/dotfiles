import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const launcher = join(root, "home/.local/bin/chrome-devtools-axi");

test("public launcher forwards arguments and exit status to the upstream CLI", () => {
  const home = mkdtempSync(join(tmpdir(), "chrome launcher "));
  try {
    const backend = join(home, ".npm-global/bin/chrome-devtools-axi");
    mkdirSync(dirname(backend), { recursive: true });
    writeFileSync(backend, '#!/bin/sh\nprintf "%s\\n" "$@"\nexit 23\n');
    chmodSync(backend, 0o700);
    for (const args of [["snapshot"], ["open", "http://localhost:3000/path with spaces"], ["--help"]]) {
      const result = spawnSync("/bin/sh", [launcher, ...args], {
        env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8",
      });
      assert.equal(result.status, 23);
      assert.equal(result.stdout, args.join("\n") + "\n");
      assert.equal(result.stderr, "");
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("missing upstream CLI fails without attempting installation or browser launch", () => {
  const home = mkdtempSync(join(tmpdir(), "chrome-launcher-missing-"));
  try {
    const result = spawnSync("/bin/sh", [launcher, "snapshot"], {
      env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /chrome-devtools-axi/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
