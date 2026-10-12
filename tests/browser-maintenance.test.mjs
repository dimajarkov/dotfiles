import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  allowedTarget,
  cleanup,
  prepareProfile,
  readAllocation,
  requestedNavigationTarget,
  requireAttachmentLifecycle,
} from "../home/.agents/skills/browser-routing/scripts/browser-attachment.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const wrapper = join(root, "home/.local/bin/chrome-devtools-axi");

function fixture() {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "browser-maintenance-")));
  const scripts = join(home, ".agents/skills/browser-routing/scripts");
  mkdirSync(dirname(scripts), { recursive: true, mode: 0o700 });
  cpSync(join(root, "home/.agents/skills/browser-routing/scripts"), scripts, { recursive: true });
  const marker = join(home, "executed");
  const source = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');`;
  const preload = join(home, "preload.mjs");
  writeFileSync(preload, source);
  for (const [name, version, entries] of [
    [
      "chrome-devtools-axi",
      "0.1.35",
      ["dist/bin/chrome-devtools-axi.js", "dist/bin/chrome-devtools-axi-bridge.js"],
    ],
    ["chrome-devtools-mcp", "1.6.0", ["build/src/bin/chrome-devtools-mcp.js"]],
  ]) {
    const directory = join(home, ".npm-global/lib/node_modules", name);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name, version, type: "module" }),
    );
    for (const entry of entries) {
      mkdirSync(dirname(join(directory, entry)), { recursive: true, mode: 0o700 });
      writeFileSync(join(directory, entry), source);
    }
  }
  const run = (args, overrides = {}) =>
    spawnSync("/bin/sh", [wrapper, ...args], {
      cwd: root,
      env: { HOME: home, PATH: dirname(process.execPath) + ":/usr/bin:/bin", ...overrides },
      encoding: "utf8",
      timeout: 10000,
    });
  return {
    home,
    marker,
    preload,
    run,
    dispose: () => rmSync(home, { recursive: true, force: true }),
  };
}

test("public inert invocations cannot execute a caller Node preload", () => {
  const f = fixture();
  try {
    for (const args of [[], ["--help"], ["--version"]]) {
      const result = f.run(args, { NODE_OPTIONS: `--import=${f.preload}` });
      assert.equal(existsSync(f.marker), false, "caller preload ran before the public guard");
      assert.equal(result.status, 0);
      assert.equal((result.stdout + result.stderr).includes(f.preload), false);
    }
  } finally {
    f.dispose();
  }
});

test("standalone open, snapshot and stop refuse before the pinned backend", () => {
  const f = fixture();
  try {
    for (const command of ["open", "snapshot", "stop"]) {
      const result = f.run([
        "--repo-qa",
        "maintenance-regression",
        command,
        ...(command === "open" ? ["about:blank"] : []),
      ]);
      assert.equal(result.status, 78);
      assert.match(result.stderr, /standalone.*disabled/i);
      assert.equal(existsSync(f.marker), false, "standalone backend was executed");
    }
  } finally {
    f.dispose();
  }
});

test("public preparation remains private and launch-free with locally neutralized loader controls", () => {
  const f = fixture();
  try {
    const result = f.run(
      ["--repo-qa", "prepared-lifecycle", "prepare-profile", "--target", "http://127.0.0.1:3011"],
      {
        NODE_OPTIONS: `--import=${f.preload}`,
        NODE_PATH: f.home,
        CHROME_DEVTOOLS_AXI_EXECUTABLE_PATH: "/private/test-existing-profile",
        CHROME_DEVTOOLS_AXI_HEADED: "1",
        PLAYWRIGHT_BROWSERS_PATH: "/private/test-existing-profile",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(f.marker), false);
    const prepared = JSON.parse(result.stdout);
    assert.equal(statSync(prepared.profile).mode & 0o777, 0o700);
    assert.equal(statSync(prepared.receipt).mode & 0o777, 0o600);
    assert.equal(result.stdout.includes("/private/test-existing-profile"), false);
  } finally {
    f.dispose();
  }
});

test("a retained old allocation does not block a fresh task-scoped allocation", () => {
  const f = fixture();
  try {
    const old = prepareProfile(f.home, root, "old-task", []);
    const oldDirectory = dirname(old.receipt);
    const marker = join(old.profile, ".cleanup-failed");
    const lock = join(oldDirectory, "lock");
    const lockOwner = join(lock, "owner.json");
    const state = join(oldDirectory, "state.json");
    writeFileSync(marker, "synthetic retained marker\n", { mode: 0o600 });
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(lockOwner, "synthetic lock owner\n", { mode: 0o600 });
    writeFileSync(state, "synthetic retained state\n", { mode: 0o600 });

    const oldAllocation = readAllocation(f.home, root, "old-task", old.receipt);
    assert.equal(oldAllocation.value.task, "old-task");
    const retained = {
      receipt: readFileSync(old.receipt),
      lock: statSync(lock),
      lockOwner: readFileSync(lockOwner),
      state: readFileSync(state),
      marker: readFileSync(marker),
    };
    const oldProfile = statSync(old.profile);
    const fresh = prepareProfile(f.home, root, "new-task", []);
    const freshProfile = statSync(fresh.profile);
    const allocation = readAllocation(f.home, root, "new-task", fresh.receipt);

    assert.notEqual(dirname(fresh.receipt), oldDirectory);
    assert.notEqual(allocation.value.token, oldAllocation.value.token);
    assert.notEqual(fresh.profile, old.profile);
    assert.notDeepEqual(
      { dev: freshProfile.dev, ino: freshProfile.ino },
      { dev: oldProfile.dev, ino: oldProfile.ino },
    );
    assert.deepEqual(
      readdirSync(fresh.profile),
      [],
      "fresh profile is empty, not copied or reused",
    );
    assert.equal(freshProfile.mode & 0o777, 0o700);
    assert.equal(statSync(fresh.receipt).mode & 0o777, 0o600);
    assert.deepEqual(
      { repo: allocation.value.repo, task: allocation.value.task, uid: allocation.value.uid },
      { repo: root, task: "new-task", uid: process.getuid() },
    );
    assert.throws(
      () => readAllocation(f.home, root, "new-task", old.receipt),
      /does not belong to this repository, task, or UID/,
    );

    assert.deepEqual(readFileSync(old.receipt), retained.receipt);
    assert.equal(statSync(lock).ino, retained.lock.ino);
    assert.equal(statSync(lock).dev, retained.lock.dev);
    assert.equal(statSync(lock).mode, retained.lock.mode);
    assert.deepEqual(readFileSync(lockOwner), retained.lockOwner);
    assert.deepEqual(readFileSync(state), retained.state);
    assert.deepEqual(readFileSync(marker), retained.marker);
  } finally {
    f.dispose();
  }
});

test("cleanup retains its profile on unknown ownership or a newly observed survivor", () => {
  const f = fixture();
  try {
    const prepared = prepareProfile(f.home, root, "cleanup-test", []);
    const allocation = readAllocation(f.home, root, "cleanup-test", prepared.receipt);
    const request = { pid: 4321, cdpPort: 9222 };
    const unknown = (operation) => {
      if (operation === "profile-users") throw new Error("inventory incomplete");
      return operation === "record" ? null : [];
    };
    assert.throws(() => cleanup(unknown, allocation, request));
    assert.equal(existsSync(prepared.profile), true);
    for (const changing of ["profile-users", "record", "listeners"]) {
      let observations = 0;
      const survivor = (operation) => {
        if (operation === changing && ++observations === 2)
          return operation === "record" ? { pid: request.pid, start: "800:2" } : [4399];
        return operation === "record" ? null : [];
      };
      assert.throws(() => cleanup(survivor, allocation, request), /retained/);
      assert.equal(existsSync(prepared.profile), true);
    }
    const gone = (operation) => (operation === "record" ? null : []);
    assert.equal(cleanup(gone, allocation, request), 0);
    assert.equal(existsSync(prepared.profile), false);
  } finally {
    f.dispose();
  }
});

test("attached Axi commands are supported while standalone launch and setup stay disabled", () => {
  for (const command of [
    "open",
    "snapshot",
    "screenshot",
    "click",
    "fill",
    "type",
    "press",
    "scroll",
    "back",
    "wait",
    "eval",
    "run",
    "hover",
    "drag",
    "fillform",
    "dialog",
    "upload",
    "pages",
    "newpage",
    "selectpage",
    "closepage",
    "resize",
    "emulate",
    "console",
    "console-get",
    "network",
    "network-get",
    "lighthouse",
    "perf-start",
    "perf-stop",
    "perf-insight",
    "heap",
    "bridge",
    "stop",
    "cleanup",
  ]) {
    assert.doesNotThrow(() => requireAttachmentLifecycle(command), command);
  }
  for (const command of ["start", "setup", "standalone", "unknown"]) {
    assert.throws(() => requireAttachmentLifecycle(command), /unsupported/i, command);
  }
  const origins = ["http://127.0.0.1:3011"];
  assert.equal(allowedTarget("http://127.0.0.1:3011/app", origins), true);
  assert.equal(allowedTarget("https://external.test/", origins), false);
  assert.equal(
    requestedNavigationTarget("open", ["http://127.0.0.1:3011/app"]),
    "http://127.0.0.1:3011/app",
  );
  assert.equal(
    requestedNavigationTarget("newpage", ["--background", "http://127.0.0.1:3011/app"]),
    "http://127.0.0.1:3011/app",
  );
});

test("missing attachment bindings and out-of-scope explicit URLs refuse before backend", () => {
  const f = fixture();
  try {
    const prepared = f.run([
      "--repo-qa",
      "maintenance-regression",
      "prepare-profile",
      "--target",
      "http://127.0.0.1:3011",
    ]);
    assert.equal(prepared.status, 0, prepared.stderr);
    const allocation = JSON.parse(prepared.stdout);
    const common = [
      "--repo-qa",
      "maintenance-regression",
      "attach",
      allocation.receipt,
      "--pid",
      "123",
      "--port",
      "9222",
    ];
    const missing = f.run([...common, "snapshot"]);
    assert.equal(missing.status, 78);
    assert.match(missing.stderr, /live Herdr caller context/i);
    const escaped = f.run([...common, "open", "https://external.test/"]);
    assert.equal(escaped.status, 78);
    assert.match(escaped.stderr, /outside.*target/i);
    assert.equal(existsSync(f.marker), false, "no detached or standalone backend ran");
  } finally {
    f.dispose();
  }
});

test("help describes proof-target scope without claiming network confinement", () => {
  const f = fixture();
  try {
    const result = f.run(["--help"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /bounded backend output/i);
    assert.match(result.stdout, /not an\s+egress firewall/i);
    assert.match(result.stdout, /scripts[\s\S]*redirects[\s\S]*clicks[\s\S]*outside/i);
  } finally {
    f.dispose();
  }
});
