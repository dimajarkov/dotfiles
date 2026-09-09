#!/usr/bin/env node
// Actual Pi tool handlers, child processes, persistent sessions and Herdr topology. No inference/network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.env.HERDR_ENV, "1", "Run inside Herdr");
const here = dirname(fileURLToPath(import.meta.url));
const workspace = process.env.HERDR_WORKSPACE_ID;
assert.ok(workspace, "Explicit workspace is required");
const directory = mkdtempSync(join(tmpdir(), "subagent-scopes-e2e-"));
console.log(`Evidence: ${directory}`);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
function herdr(...args) {
  try {
    const output = execFileSync("herdr", args, { encoding: "utf8", timeout: 75_000, stdio: "pipe" });
    return JSON.parse(output).result;
  }
  catch (error) {
    let code;
    try { code = JSON.parse(error.stderr.toString()).error?.code; } catch { /* Preserve original error. */ }
    error.herdrCode = code;
    throw error;
  }
}
async function until(check, description, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await pause(50);
  }
  throw new Error(`Timeout: ${description}`);
}
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const entries = (path) => {
  const text = readFileSync(path, "utf8");
  return text.slice(0, text.lastIndexOf("\n")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
};
const registry = () => {
  const path = join(directory, "herdr-subagents");
  return existsSync(path) ? readdirSync(path, { recursive: true }).filter((file) => file.endsWith(".json")).map((file) => json(join(path, file))) : [];
};
const roots = new Set();
const ownedPanes = new Map();
const replacementPanes = new Map();
const records = () => registry().filter((record) => roots.has(record.rootId) && record.semanticName);
function refreshOwnedPanes() {
  for (const record of records()) if (record.paneId) ownedPanes.set(record.paneId, record.sessionPath);
  // Scope allocation may persist its pane before the child's startup record is saved.
  for (const record of registry()) if (roots.has(record.rootId)) {
    for (const pane of record.ownedPaneIds ?? []) if (!ownedPanes.has(pane)) ownedPanes.set(pane, undefined);
  }
  for (const [pane, session] of replacementPanes) ownedPanes.set(pane, session);
}
function noTestFocus() {
  refreshOwnedPanes();
  const panes = herdr("pane", "list", "--workspace", workspace).panes;
  assert.ok(panes.every((pane) => !ownedPanes.has(pane.pane_id) || !pane.focused), "Test surfaces must not steal human focus");
}
function getPane(id) {
  try { return herdr("pane", "get", id).pane; }
  catch (error) { if (error.herdrCode === "pane_not_found") return undefined; throw error; }
}
const find = (root, name) => records().find((record) => record.rootId === root.id && record.semanticName === name);
const call = (arguments_, expectError = false) => ({ name: "subagent", arguments: arguments_, expectError });
const gate = (key, participant, blocked = false) => ({ name: "scope_gate", arguments: { key, participant, blocked } });
const plan = (calls, result = "CHILD_FINISHED") => JSON.stringify({ scopeFixture: true, calls, result });
const spawn = (name, agent, workScope, calls = []) => call({ action: "spawn", name, agent, ...(workScope ? { workScope } : {}), task: plan(calls) });
const release = (key) => writeFileSync(join(directory, "gates", `${key}.release`), "release\n");
const ready = (key, participant) => until(() => {
  const path = join(directory, "gates", `${key}.${participant}.json`);
  return existsSync(path) && json(path);
}, `gate ${key}/${participant}`);
async function command(root, calls) {
  const marker = `ROOT_DONE_${crypto.randomUUID()}`;
  const start = entries(root.session).length;
  herdr("agent", "prompt", root.name, plan(calls, marker));
  await until(() => {
    const output = entries(root.session).slice(start).filter((entry) => entry.message?.role === "assistant")
      .flatMap((entry) => entry.message.content).filter((part) => part.type === "text").map((part) => part.text);
    assert.ok(!output.includes("FIXTURE_UNEXPECTED_TOOL_OUTCOME"), "Unexpected tool result in root session");
    return output.includes(marker);
  }, `root command ${calls.map((c) => c.arguments.action).join(",")}`, 60_000);
  noTestFocus();
}
async function root(label) {
  const made = herdr("tab", "create", "--workspace", workspace, "--cwd", directory, "--label", `TEST scopes ${label}`,
    "--env", `PI_CODING_AGENT_DIR=${directory}`, "--no-focus");
  const pane = made.root_pane.pane_id;
  ownedPanes.set(pane, undefined);
  await pause(500);
  const name = `scope-${label}-${Date.now().toString(36)}`;
  const started = herdr("agent", "start", name, "--kind", "pi", "--pane", pane, "--timeout", "60000", "--", "--model", "scope-test/root", "--thinking", "off");
  const session = started.agent.agent_session?.value ?? await until(() =>
    herdr("agent", "get", name).agent.agent_session?.value, "root session reporting");
  ownedPanes.set(pane, session);
  herdr("agent", "prompt", name, plan([], "ROOT_READY"), "--wait", "--timeout", "10000");
  await until(() => existsSync(session), "initial root session persistence");
  const id = entries(session)[0].id;
  roots.add(id);
  return { id, pane, tab: made.tab.tab_id, name, session };
}
async function completed(root, name, generation = 1) {
  return until(() => {
    const record = find(root, name);
    return record?.generation === generation && record.state === "completed" && record.surfaceState === "closed" && record.deliveredAt && record;
  }, `${name} generation ${generation} completion and cleanup`);
}

mkdirSync(join(directory, "extensions"));
mkdirSync(join(directory, "agents"));
symlinkSync(here, join(directory, "extensions", "subagent"));
symlinkSync(join(here, "..", "lib"), join(directory, "extensions", "lib"));
symlinkSync(join(homedir(), ".pi", "agent", "extensions", "herdr-agent-state.ts"), join(directory, "extensions", "herdr-agent-state.ts"));
symlinkSync(join(here, "test-fixtures", "scope-provider.ts"), join(directory, "extensions", "scope-provider.ts"));
for (const role of ["worker", "scout", "researcher", "planner", "reviewer"]) {
  const thinking = role === "worker" ? "high" : "medium";
  writeFileSync(join(directory, "agents", `${role}.md`), `---\nname: ${role}\ndescription: Offline ${role}\ntools: read, scope_gate\nmodel: scope-test/${role}\nthinking: ${thinking}\n${role === "worker" ? "spawn-targets: scout, researcher\n" : ""}---\nDeterministic fixture role.\n`);
}
writeFileSync(join(directory, "settings.json"), JSON.stringify({ quietStartup: true, tuiMode: "fullscreen", defaultProjectTrust: "never" }));
function ownedPiProcess(pane, session) {
  assert.equal(getPane(pane).agent_session?.value, session);
  const processes = herdr("pane", "process-info", "--pane", pane).process_info.foreground_processes;
  const matches = processes.filter((process) => process.argv0 === "pi" && process.name === "node");
  assert.equal(matches.length, 1, "Identify the exact test-owned Pi process before signaling it");
  return matches[0].pid;
}
async function reassignedCase(a) {
  await command(a, [spawn("reassigned", "reviewer", "reassigned", [gate("reassigned", "owner", true)])]);
  await ready("reassigned", "owner");
  const reassigned = find(a, "reassigned");
  const childPid = ownedPiProcess(reassigned.paneId, reassigned.sessionPath);
  assert.ok(!existsSync(reassigned.completionMarkerPath), "The interrupted child has no completion proof");
  assert.equal(getPane(a.pane).agent_session?.value, a.session);
  // Shut down only this fixture's parent, replace its child, then resume its saved session.
  // No registry mutation or forged session metadata is used to manufacture staleness.
  herdr("agent", "send-keys", a.name, "ctrl+c", "ctrl+c");
  await until(() => !getPane(a.pane).agent, "parent shutdown");
  try {
    process.kill(childPid, "SIGKILL");
    await until(() => !getPane(reassigned.paneId).agent, "old test agent exits");
    const replacement = herdr("agent", "start", reassigned.herdrName, "--kind", "pi", "--pane", reassigned.paneId,
      "--timeout", "60000", "--", "--model", "scope-test/root", "--thinking", "off");
    const session = replacement.agent.agent_session?.value ?? await until(() =>
      getPane(reassigned.paneId).agent_session?.value, "replacement session reporting");
    assert.notEqual(session, reassigned.sessionPath);
    replacementPanes.set(reassigned.paneId, session);
  } finally {
    herdr("agent", "start", a.name, "--kind", "pi", "--pane", a.pane, "--timeout", "60000", "--",
      "--session", a.session, "--model", "scope-test/root", "--thinking", "off");
  }
  await until(() => getPane(a.pane).agent_session?.value === a.session, "parent saved-session restart");
  await until(() => find(a, "reassigned").state === "stale", "reassigned session becomes stale");
  const staleSnapshot = find(a, "reassigned");
  await command(a, [call({ action: "message", name: "reassigned", message: plan([], "WRONG_RECIPIENT") }, true)]);
  assert.deepEqual(find(a, "reassigned"), staleSnapshot, "Rejected follow-up preserves the prior registry record");
  await command(a, [call({ action: "resume", name: "reassigned" }, true)]);
  await command(a, [{ ...spawn("reassigned-peer", "reviewer", "reassigned"), expectError: true }]);
  assert.equal(find(a, "reassigned-peer").paneId, undefined, "A reassigned anchor is rejected before allocation");
  await command(a, [call({ action: "cancel", name: "reassigned" })]);
  assert.ok(getPane(reassigned.paneId), "Cancelling a stale record must preserve the unrelated current session");
  assert.equal(find(a, "reassigned").surfaceState, "released");
  await command(a, [spawn("after-reassign", "reviewer", "reassigned", [gate("after-reassign", "peer")])]);
  await ready("after-reassign", "peer");
  assert.equal(find(a, "after-reassign").tabId, a.tab, "A new scope stage splits the current master pane");
  release("after-reassign");
  await completed(a, "after-reassign");
  herdr("agent", "send-keys", reassigned.herdrName, "ctrl+c", "ctrl+c");
  await until(() => !getPane(reassigned.paneId).agent, "replacement agent shutdown");
  await command(a, [call({ action: "cancel", name: "reassigned" })]);
  assert.ok(getPane(reassigned.paneId), "Released ownership must not be reclaimed after the replacement exits");
  await command(a, [call({ action: "message", name: "reassigned", message: plan([], "RESTORED_ORIGINAL_SESSION") })]);
  await completed(a, "reassigned", 2);
  const restored = find(a, "reassigned");
  assert.equal(restored.sessionPath, reassigned.sessionPath, "Released children reactivate their original saved session");
  assert.notEqual(restored.paneId, reassigned.paneId);
  assert.match(readFileSync(restored.sessionPath, "utf8"), /RESTORED_ORIGINAL_SESSION/);
  assert.ok(getPane(reassigned.paneId), "Saved-session reactivation preserves the released user shell");
}
function checkGeometry(paneId, count, workScope) {
  const layout = herdr("pane", "layout", "--pane", paneId).layout;
  writeFileSync(join(directory, `${count}-agent-layout.json`), JSON.stringify(layout, null, 2));
  // The master Pi pane is part of the same tab but is not a scope-owned pane.
  const ownedIds = new Set(records().filter((record) =>
    record.tabId === layout.tab_id && record.workScope === workScope && record.paneId)
    .map((record) => record.paneId));
  const relatedPanes = layout.panes.filter((pane) => ownedIds.has(pane.pane_id));
  assert.equal(relatedPanes.length, count);
  assert.ok(relatedPanes.every((pane) => pane.rect.x === layout.area.x && pane.rect.width === layout.area.width),
    `${count} related panes must use horizontal splits, preserving the full tab width`);
  assert.ok(layout.splits.every((split) => split.direction === "down"), "Every split must stack panes top-to-bottom");
  const heights = relatedPanes.map((pane) => pane.rect.height);
  assert.ok(heights.every((height) => height > 0), `${count} related panes retain visible rows`);
  // Largest-pane halving permits a 2:1 height ratio plus integer-row rounding.
  // Closing a leaf can expand its sibling; skip balance after cleanup at count three.
  if (count !== 3) {
    assert.ok(Math.max(...heights) <= 2 * Math.min(...heights) + 1, `${count} related panes are balanced`);
  }
}
async function runCases() {
  if (process.env.SCOPE_CASES === "ownership") {
    await reassignedCase(await root("ownership"));
    console.log("PASS: reassigned pane preservation");
    return;
  }
  const decoy = herdr("tab", "create", "--workspace", workspace, "--cwd", directory, "--label", "Work: shared-scope", "--no-focus");
  ownedPanes.set(decoy.root_pane.pane_id, undefined);
  const a = await root("a");
  await command(a, [call({ action: "spawn", agent: "scout", name: "missing-scope", task: "unused" }, true)]);
  assert.equal(records().length, 0, "Missing root workScope fails before allocation");
  await command(a, [
    spawn("worker-a", "worker", "shared-scope", [
      { ...spawn("escape", "scout", "wrong-scope"), expectError: true },
      { ...spawn("forbidden", "planner"), expectError: true },
      gate("start", "a"), spawn("research-a", "researcher", undefined, [gate("research", "a")]),
      gate("density-a", "a"), spawn("density-7", "scout", undefined, [gate("density-7", "7")]), gate("worker-a", "a"),
    ]),
    spawn("worker-b", "worker", "shared-scope", [
      gate("start", "b"), spawn("scout-b", "scout", undefined, [gate("scout", "b")]),
      gate("density-b", "b"), spawn("density-8", "researcher", undefined, [gate("density-8", "8")]), gate("worker-b", "b"),
    ]),
  ]);
  const [aRuntime, bRuntime] = await Promise.all([ready("start", "a"), ready("start", "b")]);
  const wa = find(a, "worker-a");
  const wb = find(a, "worker-b");
  const scopeTab = wa.tabId;
  assert.equal(scopeTab, a.tab, "Children stay in the master Pi tab");
  assert.equal(wb.tabId, scopeTab);
  assert.notEqual(scopeTab, decoy.tab.tab_id, "Matching human labels do not establish ownership");
  assert.equal(aRuntime.model, "scope-test/worker");
  assert.equal(aRuntime.thinking, "high");
  assert.equal(aRuntime.workScope, "shared-scope");
  assert.deepEqual(aRuntime.tools.slice().sort(), ["read", "scope_gate", "subagent"].sort());
  assert.equal(bRuntime.rootId, a.id);
  release("start"); // Both actual child processes begin spawning descendants at this gate.
  const [researchRuntime, scoutRuntime] = await Promise.all([ready("research", "a"), ready("scout", "b"), ready("density-a", "a"), ready("density-b", "b")]);
  for (const name of ["worker-a", "worker-b", "research-a", "scout-b"]) {
    const record = find(a, name);
    assert.equal(record.tabId, scopeTab);
    assert.equal(record.workScope, "shared-scope");
  }
  assert.equal(find(a, "escape"), undefined);
  assert.equal(find(a, "forbidden"), undefined);
  assert.equal(researchRuntime.model, "scope-test/researcher");
  assert.equal(researchRuntime.thinking, "medium");
  assert.equal(researchRuntime.workScope, "shared-scope");
  assert.ok(!researchRuntime.tools.includes("subagent"));
  assert.ok(!scoutRuntime.tools.includes("subagent"));
  checkGeometry(wa.paneId, 4, "shared-scope");
  for (const count of [5, 6, 7, 8]) {
    if (count <= 6) {
      await command(a, [spawn(`density-${count}`, "reviewer", "shared-scope", [gate(`density-${count}`, String(count))])]);
    } else release(count === 7 ? "density-a" : "density-b");
    await ready(`density-${count}`, String(count));
    checkGeometry(wa.paneId, count, "shared-scope");
  }
  await Promise.all([ready("worker-a", "a"), ready("worker-b", "b")]);
  for (const count of [5, 6, 7, 8]) {
    release(`density-${count}`);
    await completed(a, `density-${count}`);
  }
  noTestFocus();

  await command(a, [spawn("different-scope", "reviewer", "different-scope", [gate("other", "other", true)])]);
  await ready("other", "other");
  assert.equal(find(a, "different-scope").tabId, scopeTab, "Different scopes still use the master tab");
  const b = await root("b");
  await command(b, [spawn("unrelated", "reviewer", "shared-scope", [gate("unrelated", "unrelated")])]);
  await ready("unrelated", "unrelated");
  assert.equal(find(b, "unrelated").tabId, b.tab, "A separate conversation uses its own master tab");
  assert.notEqual(b.tab, scopeTab, "Separate conversations remain isolated");
  await command(a, [spawn("no-delegation", "scout", "permission-test", [{ ...spawn("illegal-child", "scout"), expectError: true }])]);
  await completed(a, "no-delegation");
  assert.equal(find(a, "illegal-child"), undefined);

  release("research");
  await completed(a, "research-a");
  checkGeometry(wa.paneId, 3, "shared-scope");
  // This shell models a human-owned pane inside the work tab. The extension must leave it alone.
  const sentinel = herdr("pane", "split", "--pane", wa.paneId, "--direction", "down", "--cwd", directory, "--no-focus").pane.pane_id;
  ownedPanes.set(sentinel, undefined);
  herdr("pane", "rename", sentinel, "TEST human-pane sentinel");
  release("worker-a");
  await completed(a, "worker-a");
  assert.ok(getPane(wb.paneId), "Sibling worker survives completion cleanup");
  assert.ok(getPane(sentinel), "Human pane survives completion cleanup");
  await command(a, [call({ action: "message", name: "worker-a", message: plan([gate("followup", "a")]) })]);
  await ready("followup", "a");
  const followed = find(a, "worker-a");
  assert.equal(followed.generation, 2);
  assert.equal(followed.sessionPath, wa.sessionPath);
  assert.equal(followed.tabId, scopeTab);
  assert.deepEqual(followed.launchLoadout, wa.launchLoadout);
  assert.notEqual(followed.paneId, wa.paneId);
  release("followup");
  await completed(a, "worker-a", 2);
  release("scout");
  await completed(a, "scout-b");
  release("worker-b");
  await completed(a, "worker-b");
  assert.ok(getPane(sentinel));
  assert.equal(herdr("tab", "get", scopeTab).tab.pane_count, 3);

  // A later stage remains usable by splitting the current master pane.
  await command(a, [call({ action: "message", name: "worker-a", message: plan([gate("sequential", "a")]) })]);
  await ready("sequential", "a");
  const sequential = find(a, "worker-a");
  assert.equal(sequential.generation, 3);
  assert.equal(sequential.sessionPath, wa.sessionPath);
  assert.ok(getPane(sentinel), "Sequential reactivation preserves the old human pane");
  assert.equal(sequential.tabId, scopeTab, "No owned anchor means splitting the current master pane, not human panes");
  // Moving an owned pane must not silently create a second managed tab or regroup human surfaces.
  herdr("pane", "move", sequential.paneId, "--new-tab", "--label", "TEST moved scope", "--no-focus");
  const movedTab = getPane(sequential.paneId).tab_id;
  assert.notEqual(movedTab, sequential.tabId);
  await command(a, [{ ...spawn("moved-peer", "reviewer", "shared-scope"), expectError: true }]);
  assert.equal(find(a, "moved-peer").state, "failed");
  assert.equal(find(a, "moved-peer").paneId, undefined, "Moved-anchor rejection happens before allocation");
  assert.match(find(a, "moved-peer").error, /owned pane moved/);
  assert.ok(getPane(sequential.paneId), "Rejection preserves the moved agent");
  release("sequential");
  await until(() => {
    const record = find(a, "worker-a");
    return record?.generation === 3 && record.state === "completed" && record.surfaceState === "released" && record.deliveredAt;
  }, "worker-a generation 3 completion and safe release after moving tabs");
  assert.ok(getPane(sequential.paneId), "Completion preserves the moved agent pane");
  await command(a, [spawn("after-move", "reviewer", "shared-scope", [gate("post-move", "peer")])]);
  await ready("post-move", "peer");
  assert.equal(find(a, "after-move").tabId, scopeTab, "A new stage reuses the master tab after the moved agent finishes");
  release("post-move");
  await completed(a, "after-move");

  await reassignedCase(a);

  await until(() => herdr("agent", "get", find(a, "different-scope").herdrName).agent.agent_status === "blocked", "blocked fixture status");
  await command(a, [call({ action: "cancel", name: "different-scope" })]);
  assert.equal(find(a, "different-scope").state, "cancelled");
  assert.equal(find(a, "different-scope").surfaceState, "closed");
  assert.ok(getPane(sentinel));
  assert.ok(getPane(decoy.root_pane.pane_id));
  release("unrelated");
  await completed(b, "unrelated");
  for (const record of records()) {
    if (record.paneId) {
      const safelyReleasedMovedPane = record.semanticName === "worker-a" && record.generation === 3;
      assert.ok(record.surfaceState === "closed" || (safelyReleasedMovedPane && record.surfaceState === "released"));
    } else assert.equal(record.state, "failed", "Only rejected spawns have no surface");
    assert.ok(record.deliveredAt);
  }
  noTestFocus();
  writeFileSync(join(directory, "PASS.json"), JSON.stringify({ roots: [a, b], records: records() }, null, 2));
  console.log("PASS: concurrent cross-parent placement, inheritance, role permissions, lineage isolation, usable geometry, sibling/user-pane preservation, saved-session reactivation, sequential stages, moved-anchor safe rejection, blocked cancellation and reassigned-occupant preservation");
}
try {
  await runCases();
} catch (error) {
  refreshOwnedPanes();
  for (const pane of ownedPanes.keys()) {
    try { writeFileSync(join(directory, `failure-${pane.replaceAll(":", "-")}.txt`), execFileSync("herdr", ["pane", "read", pane, "--source", "visible"], { encoding: "utf8", timeout: 5_000, stdio: "pipe" })); }
    catch { /* A completed test surface may already have closed. */ }
  }
  throw error;
} finally {
  refreshOwnedPanes();
  // Never infer ownership from labels, and never close an entire tab containing untracked panes.
  for (const [id, expectedSession] of ownedPanes) {
    const pane = getPane(id);
    if (!pane) continue;
    if (pane.agent && (!expectedSession || pane.agent_session?.value !== expectedSession)) {
      console.warn(`Preserving changed occupant in ${id}`);
      continue;
    }
    herdr("pane", "close", id);
  }
}
