import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withRegistryLock } from "./registry-lock.ts";

const moduleUrl = new URL("./registry-lock.ts", import.meta.url).href;

function claimant(path: string) {
  const child = spawn(process.execPath, [
    "--experimental-strip-types", "--input-type=module", "-e",
    `import { withRegistryLock } from ${JSON.stringify(moduleUrl)};
     process.send("requesting");
     await withRegistryLock(${JSON.stringify(path)}, async () => {
       process.send("entered");
       await new Promise(resolve => process.once("message", resolve));
     });
     process.disconnect();`,
  ], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  let entered = false;
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const exit = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0 || signal === "SIGKILL") resolve();
      else reject(new Error(`Lock claimant exited ${code}/${signal}: ${stderr}`));
    });
  });
  const event = (wanted: string) => new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      dispose();
      reject(new Error(`Lock claimant did not reach ${wanted}: ${stderr}`));
    }, 5_000);
    const receive = (message: unknown) => {
      if (message !== wanted) return;
      if (wanted === "entered") entered = true;
      dispose();
      resolve();
    };
    const dispose = () => {
      clearTimeout(timeout);
      child.off("message", receive);
    };
    child.on("message", receive);
    void exit.catch((error) => { dispose(); reject(error); });
  });
  const requesting = event("requesting");
  const acquired = event("entered");
  // Keep teardown from leaving unhandled rejections after an earlier assertion fails.
  void requesting.catch(() => {});
  void acquired.catch(() => {});
  return {
    child, requesting, acquired, exit,
    get entered() { return entered; },
    release: () => child.send("release"),
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exit;
    },
  };
}

async function rejectsContender(path: string) {
  await assert.rejects(
    withRegistryLock(path, () => assert.fail("A contender entered a held lock"), { timeoutSeconds: 0 }),
    /Timed out acquiring registry lock/,
  );
}

test("a parent descriptor retains the registry lock after its native helper exits", async () => {
  const directory = mkdtempSync(join(tmpdir(), "registry-lock-descriptor-"));
  const path = join(directory, "lock");
  const holder = claimant(path);
  try {
    await holder.acquired;
    await rejectsContender(path);
    const inode = statSync(path).ino;
    holder.release();
    await holder.exit;
    assert.equal(await withRegistryLock(path, () => "released"), "released");
    assert.equal(statSync(path).ino, inode, "Release never unlinks the shared lock inode");
  } finally {
    await holder.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("three independent processes survive holder death without overlapping or replacing a successor", async () => {
  const directory = mkdtempSync(join(tmpdir(), "registry-lock-crash-"));
  const path = join(directory, "lock");
  const first = claimant(path);
  const claimants = [first];
  try {
    await first.acquired;
    const inode = statSync(path).ino;
    // Even a very old timestamp cannot revoke a live process's kernel lock.
    utimesSync(path, new Date(0), new Date(0));
    const second = claimant(path);
    const third = claimant(path);
    claimants.push(second, third);
    await Promise.all([second.requesting, third.requesting]);
    await rejectsContender(path);
    assert.equal(second.entered, false);
    assert.equal(third.entered, false);

    first.child.kill("SIGKILL");
    await first.exit;
    const winner = await Promise.race([
      second.acquired.then(() => second),
      third.acquired.then(() => third),
    ]);
    const loser = winner === second ? third : second;
    assert.equal(loser.entered, false);
    await rejectsContender(path);
    assert.equal(statSync(path).ino, inode);
    winner.release();
    await winner.exit;
    await loser.acquired;
    await rejectsContender(path);
    loser.release();
    await loser.exit;
    assert.equal(await withRegistryLock(path, () => "usable after crash"), "usable after crash");
    assert.equal(statSync(path).ino, inode);
  } finally {
    await Promise.all(claimants.map((claim) => claim.stop()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("registry locks release after a failing operation and preserve its error", async () => {
  const directory = mkdtempSync(join(tmpdir(), "registry-lock-error-"));
  const path = join(directory, "lock");
  try {
    const failure = new Error("operation failed");
    await assert.rejects(withRegistryLock(path, () => { throw failure; }), (error) => error === failure);
    assert.equal(await withRegistryLock(path, () => 42, { timeoutSeconds: 0 }), 42);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy directory locks fail closed without stealing or deleting ownership", async () => {
  const directory = mkdtempSync(join(tmpdir(), "registry-lock-legacy-"));
  const path = join(directory, "lock");
  mkdirSync(path);
  try {
    utimesSync(path, new Date(0), new Date(0));
    await assert.rejects(
      withRegistryLock(path, () => assert.fail("Legacy ownership was stolen"), { timeoutSeconds: 0 }),
      /legacy directory lock/,
    );
    assert.ok(statSync(path).isDirectory());
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
