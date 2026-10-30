#!/usr/bin/env node
// Native focus is global. Callers serialize Computer Use; a workspace is not a lock.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const APP = join(homedir(), "Applications/Google Chrome for Testing.app");
const BUNDLE = "com.google.chrome.for.testing";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) =>
  execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5000,
  }).trim();
function check(ok, message) {
  if (!ok) throw new Error(message);
}
export function workspaceName(task, repo) {
  check(
    /^[a-z0-9][a-z0-9-]{0,47}$/.test(task),
    "Task must be a lowercase slug of at most 48 characters",
  );
  return `qa-${task}-${createHash("sha256")
    .update(repo + "\0" + task)
    .digest("hex")
    .slice(0, 8)}`;
}
export function workspaceBinding(task, repo, requestedWorkspace) {
  const derived = workspaceName(task, repo);
  if (requestedWorkspace === undefined) return { workspace: derived };
  check(
    typeof requestedWorkspace === "string" &&
      /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(requestedWorkspace),
    "Explicit workspace must be a nonempty name without whitespace or flags",
  );
  return {
    workspace: requestedWorkspace,
    requestedWorkspace,
    workspaceIdentity: createHash("sha256")
      .update(repo + "\0" + task + "\0" + requestedWorkspace)
      .digest("hex"),
  };
}
export function validateWorkspaceBinding(s) {
  const expected = workspaceBinding(s.task, s.repo, s.requestedWorkspace);
  check(
    s.workspace === expected.workspace && s.workspaceIdentity === expected.workspaceIdentity,
    "Saved workspace binding changed",
  );
}
export function workspacePlacement(s, rows, monitors) {
  validateWorkspaceBinding(s);
  if (s.requestedWorkspace !== undefined) {
    const owned = rows.filter(
      (r) => r.workspace === s.workspace && r["window-id"] === s.nativeWindowId,
    );
    check(owned.length === 1, "Owned window is not in the explicit workspace");
    const monitor = monitors.find((m) => m["monitor-id"] === owned[0]["monitor-id"]);
    check(monitor, "Explicit workspace monitor is unavailable");
    return { monitor, moveWorkspace: false };
  }
  check(
    !rows.some((r) => r.workspace === s.workspace && r["window-id"] !== s.nativeWindowId),
    "Task workspace contains another window; preserve it instead of moving the workspace",
  );
  return { monitor: chooseMonitor(monitors, s.monitorName), moveWorkspace: true };
}
function requireExplicitWorkspace(s) {
  if (s.requestedWorkspace === undefined) return;
  const rows = JSON.parse(
    run("aerospace", ["list-workspaces", "--all", "--json", "--format", "%{workspace}"]),
  );
  check(
    rows.some((r) => r.workspace === s.workspace),
    "Explicit workspace must already exist",
  );
}
export function selectWindow(rows, pid, marker) {
  const matches = rows.filter(
    (r) =>
      r["app-pid"] === pid && r["app-bundle-id"] === BUNDLE && r["window-title"].includes(marker),
  );
  check(matches.length === 1, "Native window mapping is missing or ambiguous");
  return matches[0];
}
export function chooseMonitor(monitors, previous) {
  check(monitors.length > 0, "No AeroSpace monitor is available");
  const external = monitors.filter((m) => !/built-in|built in|internal/i.test(m["monitor-name"]));
  const candidates = external.length ? external : monitors;
  return (
    candidates.find((m) => m["monitor-name"] === previous) ??
    candidates.find((m) => m["monitor-name"] === "LS49C95xU") ??
    candidates.find((m) => m["monitor-name"] === "LEN S24e-10") ??
    [...candidates].sort((a, b) => a["monitor-name"].localeCompare(b["monitor-name"]))[0]
  );
}
function placeWorkspace(s) {
  const monitors = JSON.parse(
    run("aerospace", ["list-monitors", "--json", "--format", "%{monitor-id}%{monitor-name}"]),
  );
  const { monitor, moveWorkspace } = workspacePlacement(s, windows(), monitors);
  if (moveWorkspace)
    run("aerospace", [
      "move-workspace-to-monitor",
      "--workspace",
      s.workspace,
      String(monitor["monitor-id"]),
    ]);
  return monitor;
}
function windows(focused = false) {
  return JSON.parse(
    run("aerospace", [
      "list-windows",
      focused ? "--focused" : "--all",
      "--json",
      "--format",
      "%{window-id}%{app-pid}%{app-bundle-id}%{workspace}%{window-title}%{monitor-name}%{monitor-id}",
    ]),
  );
}
function birth(pid) {
  return run("/bin/ps", ["-p", String(pid), "-o", "lstart="]);
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === "ESRCH") return false;
    throw e;
  }
}
function listener(port) {
  try {
    return [
      ...new Set(
        run("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"])
          .split(/\s+/)
          .map(Number),
      ),
    ];
  } catch (e) {
    if (e.status === 1 && !e.stdout?.length) return [];
    throw e;
  }
}
function profileIdentity(profile) {
  const s = lstatSync(profile);
  check(
    s.isDirectory() && !s.isSymbolicLink() && s.uid === process.getuid() && (s.mode & 0o077) === 0,
    "Profile must be a private owned directory",
  );
  return `${s.dev}:${s.ino}`;
}
function endpoint(port) {
  check(Number.isInteger(port) && port >= 1024 && port <= 65535, "Invalid dedicated CDP port");
  return `http://127.0.0.1:${port}`;
}
async function json(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: "error" });
  check(res.ok, "CDP endpoint request failed");
  return res.json();
}
function socketURL(value, port) {
  const u = new URL(value);
  check(
    u.protocol === "ws:" &&
      ["127.0.0.1", "localhost"].includes(u.hostname) &&
      u.port === String(port) &&
      !u.username &&
      !u.password &&
      u.pathname.startsWith("/devtools/"),
    "CDP socket escaped the owned endpoint",
  );
  return value;
}
export async function connect(url) {
  const ws = new WebSocket(url);
  let next = 0;
  const pending = new Map();
  const listeners = new Map();
  await new Promise((res, rej) => {
    const t = setTimeout(() => {
      ws.close();
      rej(new Error("CDP connection timed out"));
    }, 3000);
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(t);
        res();
      },
      { once: true },
    );
    ws.addEventListener(
      "error",
      () => {
        clearTimeout(t);
        rej(new Error("CDP connection failed"));
      },
      { once: true },
    );
  });
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data));
    if (m.method) for (const fn of listeners.get(m.method) ?? []) fn(m.params);
    const p = pending.get(m.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(m.id);
    if (m.error) p.reject(new Error("CDP method failed: " + m.error.message));
    else p.resolve(m.result);
  });
  ws.addEventListener("close", () => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("CDP disconnected"));
    }
    pending.clear();
  });
  return {
    close: () => ws.close(),
    on(method, fn) {
      const callbacks = listeners.get(method) ?? [];
      callbacks.push(fn);
      listeners.set(method, callbacks);
    },
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("CDP method timed out: " + method));
        }, 10000);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}
function runtimeIdentity() {
  const file = join(process.cwd(), ".arena/worktree-runtime.json");
  if (!existsSync(file)) return null;
  const r = JSON.parse(readFileSync(file, "utf8"));
  return JSON.stringify({
    runtimeIdentity: r.runtimeIdentity,
    worktreePath: r.worktreePath,
    branch: r.branch,
    urls: r.urls,
  });
}
export function readRoute(statePath, requireRuntime = true) {
  const st = lstatSync(statePath);
  check(
    st.isFile() && st.uid === process.getuid() && (st.mode & 0o077) === 0,
    "State must be a private owned regular file",
  );
  const s = JSON.parse(readFileSync(statePath, "utf8"));
  check(
    s.version === 1 && s.repo === realpathSync(process.cwd()) && typeof s.workspace === "string",
    "Task state does not belong to this repository",
  );
  validateWorkspaceBinding(s);
  check(
    !requireRuntime || s.runtimeIdentity === runtimeIdentity(),
    "Repository runtime binding changed; revalidate and attach the replacement",
  );
  return s;
}
export function writeRoute(statePath, s, fresh = false) {
  writeFileSync(statePath, JSON.stringify(s, null, 2) + "\n", {
    flag: fresh ? "wx" : "w",
    mode: 0o600,
  });
}
export function verifyProcess(s, requireEndpoint = true) {
  check(
    alive(s.pid) && birth(s.pid) === s.birth,
    "Browser process is gone or its birth identity changed",
  );
  check(
    run("/bin/ps", ["-p", String(s.pid), "-o", "uid="]) === String(process.getuid()),
    "Browser UID changed",
  );
  const command = run("/bin/ps", ["-ww", "-p", String(s.pid), "-o", "command="]);
  check(
    command.startsWith(s.executable + " ") &&
      s.executable === realpathSync(join(APP, "Contents/MacOS/Google Chrome for Testing")),
    "Browser executable changed",
  );
  for (const flag of [
    `--user-data-dir=${s.profile}`,
    `--remote-debugging-port=${s.port}`,
    "--disable-sync",
    "--disable-extensions",
    "--use-mock-keychain",
  ]) {
    // Paths may contain spaces, so require the complete argument plus its boundary.
    check(
      command.includes(flag + " ") || command.endsWith(flag),
      "Browser isolation flags changed",
    );
  }
  check(profileIdentity(s.profile) === s.profileIdentity, "Browser profile identity changed");
  if (requireEndpoint) {
    const pids = listener(s.port);
    check(pids.length === 1 && pids[0] === s.pid, "CDP endpoint is not owned by this browser");
  }
}
async function browser(s) {
  verifyProcess(s);
  const version = await json(endpoint(s.port) + "/json/version");
  const url = socketURL(version.webSocketDebuggerUrl, s.port);
  if (s.browserSocket) check(url === s.browserSocket, "Browser endpoint generation changed");
  return { url, cdp: await connect(url) };
}
function allowedURL(url, origin, loopbackOnly = false) {
  const u = new URL(url);
  const local = u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  check(
    u.origin === origin &&
      (local || (!loopbackOnly && u.protocol === "https:")) &&
      !u.username &&
      !u.password,
    "Target left its approved origin (start requires loopback)",
  );
  return u;
}
async function page(s) {
  const rows = await json(endpoint(s.port) + "/json/list");
  const matches = rows.filter((r) => r.id === s.targetId && r.type === "page");
  const target = matches[0];
  check(matches.length === 1 && target, "Saved tab is gone; explicitly bind its replacement");
  allowedURL(target.url, s.origin);
  return { target, cdp: await connect(socketURL(target.webSocketDebuggerUrl, s.port)) };
}
// Ownership is independent of OS foreground state. No activation/title/focus calls here.
export async function withOwnedPage(statePath, task, operation) {
  const s = readRoute(statePath);
  check(s.task === task && s.targetId, "An exact task/page binding is required");
  check(!s.nativePending, "Finish or cancel native acquisition before background work");
  const { cdp: browserCDP } = await browser(s);
  let client;
  let invalidated = false;
  try {
    const { target, cdp } = await page(s);
    client = cdp;
    const window = await browserCDP.send("Browser.getWindowForTarget", { targetId: s.targetId });
    if (s.cdpWindowId !== undefined)
      check(
        window.windowId === s.cdpWindowId,
        "Saved tab moved to another window; explicitly rebind it",
      );
    for (const event of [
      "Page.frameNavigated",
      "Page.navigatedWithinDocument",
      "Page.frameDetached",
      "Page.frameStartedLoading",
    ])
      client.on(event, () => {
        invalidated = true;
      });
    await client.send("Page.enable");
    const before = (await client.send("Page.getFrameTree")).frameTree.frame;
    check(before.url === target.url && !invalidated, "Task document changed before operation");
    const result = await operation({ state: s, client, browserCDP, target });
    verifyProcess(s);
    const version = await json(endpoint(s.port) + "/json/version");
    check(
      version.webSocketDebuggerUrl === s.browserSocket,
      "Browser generation changed during operation",
    );
    const { target: after, cdp: afterClient } = await page(s);
    afterClient.close();
    const document = (await client.send("Page.getFrameTree")).frameTree.frame;
    check(
      !invalidated &&
        before.id === document.id &&
        before.loaderId === document.loaderId &&
        before.url === document.url &&
        target.url === after.url &&
        target.webSocketDebuggerUrl === after.webSocketDebuggerUrl,
      "Task document navigated during operation",
    );
    const current = readRoute(statePath);
    for (const key of [
      "task",
      "targetId",
      "pid",
      "birth",
      "profileIdentity",
      "browserSocket",
      "origin",
      "cdpWindowId",
    ])
      check(current[key] === s[key], "Task binding changed during operation");
    return result;
  } finally {
    client?.close();
    browserCDP.close();
  }
}
export async function bindBackground(statePath, task, targetId, expectedURL) {
  const s = readRoute(statePath);
  check(s.task === task && !s.nativePending, "Task mismatch or native acquisition pending");
  const u = allowedURL(expectedURL, new URL(expectedURL).origin);
  const { cdp } = await browser(s);
  try {
    const candidate = { ...s, targetId, origin: u.origin, url: u.href };
    const { target, cdp: pc } = await page(candidate);
    pc.close();
    check(target.url === u.href, "Explicit tab URL does not match expected URL");
    const { windowId } = await cdp.send("Browser.getWindowForTarget", { targetId });
    if (windowId !== s.cdpWindowId) delete candidate.nativeWindowId;
    writeRoute(statePath, { ...candidate, cdpWindowId: windowId });
    return { task, targetId, background: true };
  } finally {
    cdp.close();
  }
}
// Challenge the selected tab's native title rather than equating CDP and macOS IDs.
// Restore in finally; the nonce never enters the saved binding or captured evidence.
async function mapWindow(s, browserCDP) {
  const { target, cdp } = await page(s);
  const marker = "QA_ROUTE_" + randomUUID();
  let oldTitle;
  try {
    await browserCDP.send("Target.activateTarget", { targetId: target.id });
    const result = await cdp.send("Runtime.evaluate", {
      expression: "document.title",
      returnByValue: true,
    });
    oldTitle = result.result.value;
    check(typeof oldTitle === "string", "Unable to read task page title");
    const result2 = await cdp.send("Runtime.evaluate", {
      expression: `document.title=${JSON.stringify(marker)}`,
      returnByValue: true,
    });
    check(!result2.exceptionDetails, "Unable to map task page title");
    await browserCDP.send("Target.activateTarget", { targetId: target.id });
    let row;
    for (let i = 0; i < 15; i++) {
      const rows = windows();
      const matches = rows.filter(
        (r) => r["app-pid"] === s.pid && r["window-title"].includes(marker),
      );
      if (matches.length) {
        row = selectWindow(rows, s.pid, marker);
        break;
      }
      await pause(100);
    }
    check(row, "Task tab could not be mapped to a native Chrome window");
    const { windowId } = await browserCDP.send("Browser.getWindowForTarget", {
      targetId: s.targetId,
    });
    return { nativeWindowId: row["window-id"], cdpWindowId: windowId, url: target.url };
  } finally {
    try {
      if (oldTitle !== undefined) {
        const result = await cdp.send("Runtime.evaluate", {
          expression: `document.title===${JSON.stringify(marker)} ? (document.title=${JSON.stringify(oldTitle)}) : document.title`,
          returnByValue: true,
        });
        check(!result.exceptionDetails, "Failed to restore task title");
      }
    } finally {
      cdp.close();
    }
  }
}
function assertWindow(s, mapped) {
  check(
    mapped.nativeWindowId === s.nativeWindowId && mapped.cdpWindowId === s.cdpWindowId,
    "Saved tab moved to another window; explicitly rebind it",
  );
}
export async function focusRoute(statePath, expectedTask) {
  const s = readRoute(statePath);
  check(s.task === expectedTask, "Task slug does not match saved binding");
  check(s.targetId && s.nativeWindowId, "Bind an explicit target before focusing");
  const { cdp } = await browser(s);
  try {
    if (s.nativePending) {
      await restoreNativeTitle(s);
      delete s.nativePending;
      writeRoute(statePath, s);
    }
    const mapped = await mapWindow(s, cdp);
    assertWindow(s, mapped);
    verifyProcess(s);
    requireExplicitWorkspace(s);
    // Recover placement if the user moved the owned window; never move siblings.
    run("aerospace", [
      "move-node-to-workspace",
      "--window-id",
      String(s.nativeWindowId),
      s.workspace,
    ]);
    const monitor = placeWorkspace(s);
    await cdp.send("Target.activateTarget", { targetId: s.targetId });
    run("aerospace", ["workspace", s.workspace]);
    run("aerospace", ["focus", "--window-id", String(s.nativeWindowId)]);
    let current;
    for (let i = 0; i < 30; i++) {
      current = windows(true);
      if (
        current.length === 1 &&
        current[0]["window-id"] === s.nativeWindowId &&
        current[0]["app-pid"] === s.pid &&
        current[0].workspace === s.workspace &&
        current[0]["monitor-id"] === monitor["monitor-id"]
      )
        break;
      await pause(100);
    }
    check(
      current.length === 1 &&
        current[0]["window-id"] === s.nativeWindowId &&
        current[0]["app-pid"] === s.pid &&
        current[0].workspace === s.workspace &&
        current[0]["monitor-id"] === monitor["monitor-id"],
      "Native foreground or monitor verification failed: " +
        JSON.stringify({
          expected: {
            window: s.nativeWindowId,
            workspace: s.workspace,
            monitor: monitor["monitor-id"],
          },
          actual: current.map((r) => ({
            window: r["window-id"],
            workspace: r.workspace,
            monitor: r["monitor-id"],
          })),
        }),
    );
    const { cdp: pc } = await page(s);
    try {
      const { result } = await pc.send("Runtime.evaluate", {
        expression:
          "({visible:document.visibilityState,focused:document.hasFocus(),url:location.href})",
        returnByValue: true,
      });
      check(
        result.value?.visible === "visible" && result.value?.focused === true,
        "Saved tab did not acquire foreground focus",
      );
      allowedURL(result.value.url, s.origin);
      writeRoute(statePath, { ...s, monitorName: monitor["monitor-name"] });
      return {
        task: s.task,
        workspace: s.workspace,
        monitorName: monitor["monitor-name"],
        nativeWindowId: s.nativeWindowId,
        targetId: s.targetId,
        port: s.port,
        url: result.value.url,
        verified: true,
      };
    } finally {
      pc.close();
    }
  } finally {
    cdp.close();
  }
}
export function assertNativeTitle(marker, observedTitle) {
  check(
    typeof observedTitle === "string" && observedTitle.includes(marker),
    "Computer Use selected a different window; native input is blocked",
  );
}
async function restoreNativeTitle(s) {
  if (!s.nativePending) return;
  verifyProcess(s);
  let cdp;
  try {
    ({ cdp } = await page(s));
  } catch (error) {
    if (error.message.startsWith("Saved tab is gone")) return;
    throw error;
  }
  try {
    const { marker, original } = s.nativePending;
    await cdp.send("Runtime.evaluate", {
      expression: `document.title===${JSON.stringify(marker)} ? (document.title=${JSON.stringify(original)}) : document.title`,
      returnByValue: true,
    });
  } finally {
    cdp.close();
  }
}
export async function prepareNative(statePath, task) {
  check(!readRoute(statePath).viewportPolicy, "Reset the viewport policy before native input");
  await focusRoute(statePath, task);
  const s = readRoute(statePath);
  const { cdp } = await page(s);
  try {
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: "document.title",
      returnByValue: true,
    });
    check(typeof result.value === "string", "Cannot challenge native window title");
    const marker = "QA_NATIVE_" + randomUUID();
    // Persist the restoration data before the title mutation.
    writeRoute(statePath, { ...s, nativePending: { marker, original: result.value } });
    const response = await cdp.send("Runtime.evaluate", {
      expression: `document.title=${JSON.stringify(marker)}`,
      returnByValue: true,
    });
    check(!response.exceptionDetails, "Unable to challenge native window");
    return { task, expectedNativeTitle: marker, workspace: s.workspace };
  } finally {
    cdp.close();
  }
}
export async function confirmNative(statePath, task, observedTitle) {
  const s = readRoute(statePath);
  check(s.task === task && s.nativePending, "No pending native acquisition for this task");
  try {
    verifyProcess(s);
    assertNativeTitle(s.nativePending.marker, observedTitle);
    const current = windows(true);
    check(
      current.length === 1 &&
        current[0]["window-id"] === s.nativeWindowId &&
        current[0]["app-pid"] === s.pid &&
        current[0].workspace === s.workspace,
      "Native focus changed during acquisition; input is blocked",
    );
    const { cdp } = await page(s);
    try {
      const { result } = await cdp.send("Runtime.evaluate", {
        expression: 'document.hasFocus() && document.visibilityState === "visible"',
        returnByValue: true,
      });
      check(result.value === true, "Task tab lost focus during acquisition; input is blocked");
    } finally {
      cdp.close();
    }
    return { task, nativeAcquisitionVerified: true };
  } finally {
    await restoreNativeTitle(s);
    const cleared = { ...s };
    delete cleared.nativePending;
    writeRoute(statePath, cleared);
  }
}
export async function bindRoute(statePath, task, targetId, expectedURL) {
  const s = readRoute(statePath);
  check(s.task === task, "Task slug does not match saved browser");
  const u = allowedURL(expectedURL, new URL(expectedURL).origin);
  const { cdp } = await browser(s);
  try {
    // Restore the challenged old tab before replacing its binding.
    if (s.nativePending) {
      await restoreNativeTitle(s);
      delete s.nativePending;
      writeRoute(statePath, s);
    }
    const candidate = { ...s, targetId, origin: u.origin };
    const { target, cdp: pc } = await page(candidate);
    pc.close();
    check(target.url === u.href, "Explicit tab URL does not match expected URL");
    const mapped = await mapWindow(candidate, cdp);
    const occupied = windows().filter(
      (r) => r.workspace === s.workspace && r["window-id"] !== mapped.nativeWindowId,
    );
    check(
      s.requestedWorkspace !== undefined || !occupied.length,
      "Task workspace already contains another window",
    );
    requireExplicitWorkspace(s);
    run("aerospace", [
      "move-node-to-workspace",
      "--window-id",
      String(mapped.nativeWindowId),
      s.workspace,
    ]);
    writeRoute(statePath, { ...candidate, ...mapped });
  } finally {
    cdp.close();
  }
  return focusRoute(statePath, task);
}
export async function startRoute(statePath, task, port, url, requestedWorkspace) {
  const repo = realpathSync(process.cwd());
  const binding = workspaceBinding(task, repo, requestedWorkspace);
  requireExplicitWorkspace(binding);
  allowedURL(url, new URL(url).origin, true);
  endpoint(port);
  check(!existsSync(statePath), "State already exists; recover or stop the saved browser");
  check(listener(port).length === 0, "CDP port already occupied");
  windows();
  const executable = realpathSync(join(APP, "Contents/MacOS/Google Chrome for Testing"));
  check(executable.startsWith("/nix/store/"), "Expected Nix-owned Chrome for Testing");
  check(
    run("/usr/libexec/PlistBuddy", [
      "-c",
      "Print :CFBundleIdentifier",
      join(APP, "Contents/Info.plist"),
    ]) === BUNDLE,
    "Wrong application bundle",
  );
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  const directory = join(dirname(statePath), "browser-" + randomUUID());
  mkdirSync(directory, { mode: 0o700 });
  const profile = join(directory, "profile");
  mkdirSync(profile, { mode: 0o700 });
  const log = openSync(join(directory, "chrome.log"), "wx", 0o600);
  // Reserve before spawning so concurrent starts cannot leave an unrecorded browser.
  writeRoute(
    statePath,
    {
      version: 1,
      task,
      repo,
      runtimeIdentity: runtimeIdentity(),
      ...binding,
      phase: "launching",
      executable,
      profile,
      port,
    },
    true,
  );
  const child = spawn(
    executable,
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--disable-sync",
      "--disable-extensions",
      "--use-mock-keychain",
      "--password-store=basic",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      url,
    ],
    { detached: true, stdio: ["ignore", log, log] },
  );
  closeSync(log);
  child.on("error", () => {});
  child.unref();
  check(child.pid, "Chrome did not start");
  const launched = {
    version: 1,
    task,
    repo,
    runtimeIdentity: runtimeIdentity(),
    ...binding,
    executable,
    pid: child.pid,
    profile,
    profileIdentity: profileIdentity(profile),
    port,
    ownedLaunch: true,
    phase: "launching",
  };
  writeRoute(statePath, launched);
  let s;
  try {
    s = { ...launched, birth: birth(child.pid), phase: "ready" };
    writeRoute(statePath, s);
  } catch (error) {
    // The live ChildProcess handle is still ours if metadata collection fails.
    child.kill("SIGTERM");
    throw error;
  }
  for (let i = 0; i < 40; i++) {
    try {
      const { url: browserSocket, cdp } = await browser(s);
      cdp.close();
      writeRoute(statePath, { ...s, browserSocket });
      const pages = await json(endpoint(port) + "/json/list");
      const matches = pages.filter((p) => p.type === "page" && p.url === new URL(url).href);
      if (matches.length === 1) return bindRoute(statePath, task, matches[0].id, url);
    } catch (e) {
      if (i === 39) throw e;
    }
    await pause(100);
  }
  throw new Error(
    "Browser started but initial tab was not ready; retain state for exact-owned stop",
  );
}
export async function attachRoute(statePath, task, pid, port, profile, owner, requestedWorkspace) {
  check(
    !existsSync(statePath) && owner,
    "A new private state and named lifecycle owner are required",
  );
  const repo = realpathSync(process.cwd());
  const s = {
    version: 1,
    task,
    repo,
    runtimeIdentity: runtimeIdentity(),
    ...workspaceBinding(task, repo, requestedWorkspace),
    executable: realpathSync(join(APP, "Contents/MacOS/Google Chrome for Testing")),
    pid,
    birth: birth(pid),
    profile: realpathSync(profile),
    profileIdentity: profileIdentity(profile),
    port,
    ownedLaunch: false,
    owner,
  };
  requireExplicitWorkspace(s);
  const { url, cdp } = await browser(s);
  cdp.close();
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  writeRoute(statePath, { ...s, browserSocket: url }, true);
  return { attached: true, task, workspace: s.workspace };
}
export async function stopRoute(statePath, task) {
  const s = readRoute(statePath, false);
  check(s.task === task && s.ownedLaunch, "Only this task owner can stop this browser");
  if (!alive(s.pid)) {
    check(
      !listener(s.port).length,
      "Process exited but endpoint was reused; preserve foreign browser",
    );
    return { stopped: true };
  }
  verifyProcess(s, false);
  let cdp;
  try {
    ({ cdp } = await browser(s));
    await cdp.send("Browser.close");
  } catch {
    // CDP may never have started, or may already have disconnected during close.
    // SIGTERM only the freshly reverified process; a foreign listener is preserved.
    if (alive(s.pid)) {
      verifyProcess(s, false);
      process.kill(s.pid, "SIGTERM");
    }
  } finally {
    cdp?.close();
  }
  for (let i = 0; i < 300; i++) {
    if (!alive(s.pid)) {
      check(
        !listener(s.port).length,
        "Owned browser exited but port was reused; foreign listener preserved",
      );
      return { stopped: true };
    }
    await pause(100);
  }
  throw new Error("Browser shutdown unconfirmed; retain state and stop automatic relaunches");
}
export async function main(args) {
  const [command, ...rest] = args;
  if (!command || command === "--help") {
    console.log(
      "qa-route.mjs start --state <private-file> --task <slug> --port <dedicated-port> --url <loopback-url> [--workspace <existing-name>]\nqa-route.mjs attach --state <new-file> --task <slug> --pid <pid> --port <port> --profile <private-profile> --owner <lifecycle-owner> [--workspace <existing-name>]\nqa-route.mjs bind --state <file> --task <slug> --target <id> --url <exact-loopback-url>\nqa-route.mjs native-prepare --state <file> --task <slug>\nqa-route.mjs native-confirm --state <file> --task <slug> --observed-title <fresh-native-title>\nqa-route.mjs bind-background --state <file> --task <slug> --target <id> --url <exact-approved-url>\nqa-route.mjs diagnostics|viewport-reset|window-restore --state <file> --task <slug>\nqa-route.mjs screenshot --state <file> --task <slug> --path <new-private-png> [--width <css-pixels> --height <css-pixels>]\nqa-route.mjs viewport|window-resize --state <file> --task <slug> --width <css-pixels> --height <css-pixels>\nqa-route.mjs focus|targets|stop --state <file> --task <slug>\nRun from the owning repository. Start owns launch/shutdown; bind changes only the saved tab. Focus does not launch or recreate missing tabs.",
    );
    return;
  }
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    check(rest[i]?.startsWith("--") && rest[i + 1], "Expected named flag/value pairs");
    check(!Object.hasOwn(flags, rest[i]), "Duplicate flag");
    flags[rest[i]] = rest[i + 1];
  }
  const options = {
    start: ["--port", "--url", "--workspace"],
    attach: ["--pid", "--port", "--profile", "--owner", "--workspace"],
    bind: ["--target", "--url"],
    "bind-background": ["--target", "--url"],
    diagnostics: [],
    screenshot: ["--path", "--width", "--height"],
    viewport: ["--width", "--height"],
    "viewport-reset": [],
    "window-resize": ["--width", "--height"],
    "window-restore": [],
    focus: [],
    "native-prepare": [],
    "native-confirm": ["--observed-title"],
    targets: [],
    stop: [],
  };
  check(Object.hasOwn(options, command), "Unknown command");
  check(
    Object.keys(flags).every((k) => ["--state", "--task", ...options[command]].includes(k)),
    "Unknown option",
  );
  check(flags["--state"] && flags["--task"], "Explicit state and task are required");
  const statePath = resolve(flags["--state"]);
  const task = flags["--task"];
  if (command === "start")
    return startRoute(
      statePath,
      task,
      Number(flags["--port"]),
      flags["--url"],
      flags["--workspace"],
    );
  if (command === "attach")
    return attachRoute(
      statePath,
      task,
      Number(flags["--pid"]),
      Number(flags["--port"]),
      flags["--profile"],
      flags["--owner"],
      flags["--workspace"],
    );
  if (command === "bind-background")
    return bindBackground(statePath, task, flags["--target"], flags["--url"]);
  if (
    [
      "diagnostics",
      "screenshot",
      "viewport",
      "viewport-reset",
      "window-resize",
      "window-restore",
    ].includes(command)
  ) {
    const { backgroundCommand } = await import("./background.mjs");
    return backgroundCommand(command, statePath, task, flags);
  }
  if (command === "bind") return bindRoute(statePath, task, flags["--target"], flags["--url"]);
  if (command === "native-prepare") return prepareNative(statePath, task);
  if (command === "native-confirm")
    return confirmNative(statePath, task, flags["--observed-title"]);
  if (command === "focus") return focusRoute(statePath, task);
  if (command === "stop") return stopRoute(statePath, task);
  if (command === "targets") {
    const s = readRoute(statePath);
    check(s.task === task, "Task mismatch");
    const { cdp } = await browser(s);
    cdp.close();
    return (await json(endpoint(s.port) + "/json/list"))
      .filter((t) => t.type === "page")
      .map((t) => ({ targetId: t.id, url: t.url }));
  }
  throw new Error("Unknown command");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2))
    .then((result) => {
      if (result) console.log(JSON.stringify(result));
    })
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
}
