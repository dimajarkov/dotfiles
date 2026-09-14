#!/usr/bin/env node
// Live Pi/Herdr regression with an offline scripted model and test-owned surfaces only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configureE2ERuntime } from "./e2e-runtime.mjs";

assert.equal(process.env.HERDR_ENV, "1", "Run inside Herdr");
const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(process.env.SUBAGENT_E2E_SOURCE ?? here);
const workspace = process.env.HERDR_WORKSPACE_ID;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const herdr = (...args) =>
  JSON.parse(execFileSync("herdr", args, { encoding: "utf8", timeout: 75_000 }));
async function until(check, description, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await pause(100);
  }
  throw new Error(`Timeout: ${description}`);
}
const entries = (path) =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
const records = (directory) => {
  const registry = join(directory, "herdr-subagents");
  return existsSync(registry)
    ? readdirSync(registry, { recursive: true })
        .filter((file) => file.endsWith(".json"))
        .map((file) => JSON.parse(readFileSync(join(registry, file), "utf8")))
        .filter((record) => record.semanticName === "probe")
    : [];
};
const evidence = mkdtempSync(join(tmpdir(), "subagent-lifecycle-e2e-"));
console.log(`Evidence: ${evidence}`);
for (const action of (
  process.env.LIFECYCLE_CASES ?? "message,cancel,crash,publisher-bare,publisher-attested"
).split(",")) {
  const directory = join(evidence, action);
  mkdirSync(join(directory, "extensions"), { recursive: true });
  const verifyRuntime = configureE2ERuntime(directory);
  const publisherCrash = action.startsWith("publisher-");
  if (publisherCrash) writeFileSync(join(directory, "publisher-crash-mode"), action);
  mkdirSync(join(directory, "agents"));
  symlinkSync(source, join(directory, "extensions", "subagent"));
  symlinkSync(join(source, "..", "lib"), join(directory, "extensions", "lib"));
  symlinkSync(
    join(homedir(), ".pi", "agent", "extensions", "herdr-agent-state.ts"),
    join(directory, "extensions", "herdr-agent-state.ts"),
  );
  symlinkSync(
    join(here, "test-fixtures", "lifecycle-provider.ts"),
    join(directory, "extensions", "lifecycle-provider.ts"),
  );
  writeFileSync(
    join(directory, "agents", "scout.md"),
    "---\nname: scout\ndescription: Offline test scout\ntools: read\nmodel: lifecycle-test/fixture\nthinking: off\n---\nReply with the deterministic test result.\n",
  );
  writeFileSync(
    join(directory, "settings.json"),
    JSON.stringify({ quietStartup: true, tuiMode: "fullscreen", defaultProjectTrust: "never" }),
  );
  const before = herdr("pane", "list", "--workspace", workspace).result.panes;
  const created = herdr(
    "tab",
    "create",
    "--workspace",
    workspace,
    "--cwd",
    directory,
    "--label",
    `TEST lifecycle ${action}`,
    "--env",
    `PI_CODING_AGENT_DIR=${directory}`,
    "--no-focus",
  ).result;
  const rootTab = created.tab.tab_id;
  const pane = created.root_pane.pane_id;
  const name = `lc-${action}-${Date.now().toString(36)}`;
  const ownedTabs = new Set([rootTab]);
  try {
    await pause(500);
    const start = (session) =>
      herdr(
        "agent",
        "start",
        name,
        "--kind",
        "pi",
        "--pane",
        pane,
        "--timeout",
        "60000",
        "--",
        "--model",
        "lifecycle-test/fixture",
        "--thinking",
        "off",
        ...(session ? ["--session", session] : []),
      );
    const started = start();
    const session = started.result.agent.agent_session.value;
    herdr("agent", "prompt", name, action);
    const barrier = await until(
      () =>
        existsSync(join(directory, "barrier.json")) &&
        JSON.parse(readFileSync(join(directory, "barrier.json"), "utf8")),
      "completion while parent tool is active",
    );
    ownedTabs.add(barrier.child.tabId);
    if (action === "crash") {
      await until(
        () => !herdr("agent", "list").result.agents.some((agent) => agent.name === name),
        "test process exit",
      );
      start(session);
    } else if (!publisherCrash) {
      await until(
        () =>
          entries(session).some(
            (entry) =>
              entry.type === "message" &&
              entry.message?.role === "toolResult" &&
              entry.message?.toolName === "subagent" &&
              entry.message?.content?.some(
                (part) =>
                  part.type === "text" &&
                  (part.text.startsWith("Message sent") ||
                    part.text.startsWith("Already completed")),
              ),
          ),
        `${action} tool returns while completion is queued`,
        8_000,
      );
    }
    const generation = action === "message" ? 2 : 1;
    await until(() => {
      const child = records(directory)[0];
      if (child?.tabId) ownedTabs.add(child.tabId);
      return (
        child?.generation === generation &&
        child.state === (action === "publisher-bare" ? "crashed" : "completed") &&
        child.surfaceState === "closed"
      );
    }, "child completion and cleanup");
    await until(
      () =>
        entries(session).filter(
          (entry) =>
            entry.type === "custom_message" && entry.customType === "herdr-subagent-completion",
        ).length === generation,
      "completion consumed exactly once per generation",
    );
    herdr("agent", "wait", name, "--until", "idle", "--until", "done", "--timeout", "10000");
    herdr(
      "agent",
      "prompt",
      name,
      "Verify steering remains usable",
      "--wait",
      "--timeout",
      "10000",
    );
    const child = records(directory)[0];
    assert.equal(child.sessionPath, barrier.child.sessionPath);
    if (publisherCrash) {
      const crash = JSON.parse(readFileSync(join(directory, "publisher-crash.json"), "utf8"));
      assert.equal(crash.settlement.phase, "candidate");
      assert.equal(crash.markerExists, false, "publisher died before marker publication");
      assert.equal(
        existsSync(child.completionMarkerPath),
        action === "publisher-attested",
        "only attested recovery may publish a completion marker",
      );
      assert.equal(Boolean(crash.settlement.settlementEvidence), action === "publisher-attested");
      assert.equal(
        child.result,
        "\n  SCOUT_RESULT_1 \n\n",
        "recover exact concatenated persisted fragments",
      );
      if (action === "publisher-bare")
        assert.match(child.error, /full settlement could not be proven/);
      else assert.equal(child.error, undefined);
    } else assert.match(readFileSync(child.sessionPath, "utf8"), /SCOUT_RESULT_1/);
    const log = entries(session);
    const consumed = log.filter(
      (entry) =>
        entry.type === "custom_message" && entry.customType === "herdr-subagent-completion",
    );
    assert.equal(consumed.length, generation);
    assert.equal(new Set(consumed.map((entry) => entry.details.runId)).size, generation);
    assert.equal(
      log.filter(
        (entry) =>
          entry.type === "custom" && entry.customType === "herdr-subagent-completion-outbox",
      ).length,
      generation,
    );
    assert.ok(
      !log.some((entry) => entry.message?.role === "toolResult" && entry.message.isError),
      "No tool errors",
    );
    const after = herdr("pane", "list", "--workspace", workspace).result.panes;
    for (const old of before)
      assert.ok(
        after.some((current) => current.pane_id === old.pane_id),
        `Preserved ${old.pane_id}`,
      );
    // The human may change workspace/focus during a live run. Only test-owned
    // surfaces taking focus is a failure, not an unrelated user focus change.
    assert.ok(
      after.every((current) => !ownedTabs.has(current.tab_id) || !current.focused),
      "Test surfaces must not take focus",
    );
    writeFileSync(
      join(directory, "PASS.json"),
      JSON.stringify(
        { action, session, child, consumed: consumed.map((entry) => entry.details.runId) },
        null,
        2,
      ),
    );
    verifyRuntime([session, ...records(directory).map((record) => record.sessionPath)]);
    console.log(`PASS ${action}: live control, durable results, cleanup, focus, parent usability`);
  } catch (error) {
    try {
      writeFileSync(
        join(directory, "failure-screen.json"),
        JSON.stringify(
          herdr("pane", "read", pane, "--source", "recent-unwrapped", "--lines", "100"),
        ),
      );
    } catch {
      /* Surface may already be gone. */
    }
    throw error;
  } finally {
    for (const child of records(directory)) if (child.tabId) ownedTabs.add(child.tabId);
    const liveTabs = new Set(
      herdr("tab", "list", "--workspace", workspace).result.tabs.map((tab) => tab.tab_id),
    );
    for (const tab of ownedTabs) if (liveTabs.has(tab)) herdr("tab", "close", tab);
  }
}
