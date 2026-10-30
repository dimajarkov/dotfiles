import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNativeTitle,
  chooseMonitor,
  selectWindow,
  workspaceName,
  workspaceBinding,
  validateWorkspaceBinding,
  workspacePlacement,
  startRoute,
  main,
} from "../home/.agents/skills/browser-routing/scripts/qa-route.mjs";
const monitor = (name) => ({ "monitor-name": name });
test("external display wins over remembered laptop; disconnection falls back to laptop", () => {
  assert.equal(
    chooseMonitor(
      [monitor("Built-in Retina Display"), monitor("LEN S24e-10")],
      "Built-in Retina Display",
    )["monitor-name"],
    "LEN S24e-10",
  );
  assert.equal(
    chooseMonitor([monitor("Built-in Retina Display")], "LEN S24e-10")["monitor-name"],
    "Built-in Retina Display",
  );
});
test("existing external monitor stays selected when a second is connected", () => {
  assert.equal(
    chooseMonitor([monitor("LEN S24e-10"), monitor("LS49C95xU")], "LEN S24e-10")["monitor-name"],
    "LEN S24e-10",
  );
});
test("identical page titles in other browser processes cannot redirect mapping", () => {
  const row = (pid) => ({
    "app-pid": pid,
    "app-bundle-id": "com.google.chrome.for.testing",
    "window-title": "QA_ROUTE_nonce",
  });
  const owned = row(10);
  assert.equal(selectWindow([row(20), owned], 10, "QA_ROUTE_nonce"), owned);
  assert.throws(() => selectWindow([owned, { ...owned }], 10, "QA_ROUTE_nonce"), /ambiguous/);
  assert.throws(() => selectWindow([row(20)], 10, "QA_ROUTE_nonce"), /missing/);
});
test("workspace identity separates repositories and tasks and survives handoff", () => {
  assert.equal(workspaceName("scope-1", "/repo-a"), workspaceName("scope-1", "/repo-a"));
  assert.notEqual(workspaceName("scope-1", "/repo-a"), workspaceName("scope-1", "/repo-b"));
  assert.notEqual(workspaceName("scope-1", "/repo-a"), workspaceName("scope-2", "/repo-a"));
  assert.throws(() => workspaceName("scope with space", "/repo"), /slug/);
});
test("remote targets are rejected before creating browser state or launching", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-route-rejected-"));
  const state = join(dir, "state.json");
  try {
    await assert.rejects(startRoute(state, "test", 19481, "https://example.com/"), /loopback/);
    assert.equal(existsSync(state), false);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
test("misspelled options fail before affecting the desktop", async () => {
  await assert.rejects(
    main(["focus", "--state", "/missing", "--task", "test", "--taget", "abc"]),
    /Unknown option/,
  );
});

test("native acquisition rejects another window even when ordinary titles are identical", () => {
  assert.throws(
    () => assertNativeTitle("QA_NATIVE_owned", "QA routing fixture"),
    /different window/,
  );
  assert.throws(() => assertNativeTitle("QA_NATIVE_owned", "QA_NATIVE_other"), /different window/);
  assert.doesNotThrow(() =>
    assertNativeTitle("QA_NATIVE_owned", "QA_NATIVE_owned - Google Chrome for Testing"),
  );
});

test("explicit workspace persists without weakening default binding validation", () => {
  const base = { task: "proof", repo: "/repo" };
  const saved = { ...base, ...workspaceBinding(base.task, base.repo, "warrior-v2") };
  validateWorkspaceBinding(saved);
  assert.equal(saved.workspace, "warrior-v2");
  assert.throws(() => validateWorkspaceBinding({ ...saved, workspace: "other" }), /changed/);
  assert.throws(() => validateWorkspaceBinding({ ...saved, task: "other" }), /changed/);
  assert.throws(() => validateWorkspaceBinding({ ...saved, repo: "/other" }), /changed/);
  assert.throws(() => validateWorkspaceBinding({ ...saved, workspace: "other", requestedWorkspace: "other" }), /changed/);
  assert.throws(() => validateWorkspaceBinding({ ...saved, requestedWorkspace: undefined }), /changed/);
  assert.throws(() => workspaceBinding("proof", "/repo", "--all"), /Explicit/);
  assert.throws(() => workspaceBinding("proof", "/repo", "two words"), /Explicit/);
  validateWorkspaceBinding({ ...base, ...workspaceBinding(base.task, base.repo) });
});
test("explicit placement preserves existing monitor and sibling windows", () => {
  const s = { task: "proof", repo: "/repo", nativeWindowId: 1, ...workspaceBinding("proof", "/repo", "warrior-v2") };
  const rows = [{ workspace: "warrior-v2", "window-id": 1, "monitor-id": 2 }, { workspace: "warrior-v2", "window-id": 9, "monitor-id": 2 }];
  const monitors = [{ "monitor-id": 2, "monitor-name": "Built-in" }, { "monitor-id": 3, "monitor-name": "LS49C95xU" }];
  const before = JSON.stringify({ rows, monitors });
  assert.deepEqual(workspacePlacement(s, rows, monitors), { monitor: monitors[0], moveWorkspace: false });
  assert.equal(JSON.stringify({ rows, monitors }), before);
  assert.throws(() => workspacePlacement(s, rows.slice(1), monitors), /Owned/);
  assert.throws(() => workspacePlacement(s, rows, monitors.slice(1)), /unavailable/);
});
test("default workspace still rejects siblings and selects preferred monitor", () => {
  const s = { task: "proof", repo: "/repo", nativeWindowId: 1, ...workspaceBinding("proof", "/repo") };
  const monitors = [{ "monitor-id": 2, "monitor-name": "Built-in" }, { "monitor-id": 3, "monitor-name": "LS49C95xU" }];
  assert.equal(workspacePlacement(s, [], monitors).moveWorkspace, true);
  assert.equal(workspacePlacement(s, [], monitors).monitor, monitors[1]);
  assert.throws(() => workspacePlacement(s, [{ workspace: s.workspace, "window-id": 9 }], monitors), /another window/);
});
