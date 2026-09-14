#!/usr/bin/env node
// Live Pi/Herdr regression for cancellation while a child provider request is active.
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
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configureE2ERuntime } from "./e2e-runtime.mjs";

assert.equal(process.env.HERDR_ENV, "1", "Run inside Herdr");
const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(process.env.SUBAGENT_E2E_SOURCE ?? here);
const workspace = process.env.HERDR_WORKSPACE_ID;
assert.ok(workspace, "Explicit workspace is required");
const directory = mkdtempSync(join(tmpdir(), "subagent-active-cancel-e2e-"));
console.log(`Evidence: ${directory}`);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
function herdr(...args) {
  try {
    const output = execFileSync("herdr", args, {
      encoding: "utf8",
      timeout: 75_000,
      stdio: "pipe",
    });
    return JSON.parse(output).result;
  } catch (error) {
    let code;
    try {
      code = JSON.parse(error.stderr.toString()).error?.code;
    } catch {
      /* Preserve original error. */
    }
    error.herdrCode = code;
    throw error;
  }
}
async function until(check, description, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await pause(50);
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
const records = () => {
  const registry = join(directory, "herdr-subagents");
  return existsSync(registry)
    ? readdirSync(registry, { recursive: true })
        .filter((file) => file.endsWith(".json"))
        .map((file) => JSON.parse(readFileSync(join(registry, file), "utf8")))
        .filter((record) => record.semanticName === "probe")
    : [];
};

mkdirSync(join(directory, "extensions"));
const verifyRuntime = configureE2ERuntime(directory);
mkdirSync(join(directory, "agents"));
symlinkSync(source, join(directory, "extensions", "subagent"));
symlinkSync(join(source, "..", "lib"), join(directory, "extensions", "lib"));
symlinkSync(
  join(homedir(), ".pi", "agent", "extensions", "herdr-agent-state.ts"),
  join(directory, "extensions", "herdr-agent-state.ts"),
);
symlinkSync(
  join(here, "test-fixtures", "active-cancel-provider.ts"),
  join(directory, "extensions", "active-cancel-provider.ts"),
);
writeFileSync(
  join(directory, "agents", "probe.md"),
  "---\nname: probe\ndescription: Active cancellation fixture\ntools: read\nmodel: active-cancel-test/fixture\nthinking: off\n---\nWait for the parent to cancel this active provider request.\n",
);
writeFileSync(
  join(directory, "settings.json"),
  JSON.stringify({ quietStartup: true, tuiMode: "fullscreen", defaultProjectTrust: "never" }),
);
const made = herdr(
  "tab",
  "create",
  "--workspace",
  workspace,
  "--cwd",
  directory,
  "--label",
  "TEST active cancellation",
  "--env",
  `PI_CODING_AGENT_DIR=${directory}`,
  "--no-focus",
);
const rootTab = made.tab.tab_id;
const rootPane = made.root_pane.pane_id;
const rootName = `active-cancel-root-${Date.now().toString(36)}`;
try {
  await pause(500);
  const started = herdr(
    "agent",
    "start",
    rootName,
    "--kind",
    "pi",
    "--pane",
    rootPane,
    "--timeout",
    "60000",
    "--",
    "--model",
    "active-cancel-test/fixture",
    "--thinking",
    "off",
  );
  const rootSession = started.agent.agent_session.value;
  herdr("agent", "prompt", rootName, "ROOT_READY", "--wait", "--timeout", "10000");
  await until(() => existsSync(rootSession), "root session persistence");

  herdr("agent", "prompt", rootName, "START_ACTIVE_CANCEL", "--wait", "--timeout", "10000");
  const barrier = await until(() => {
    const path = join(directory, "active-provider-barrier.json");
    return existsSync(path) && JSON.parse(readFileSync(path, "utf8"));
  }, "active child provider barrier");
  assert.equal(barrier.active, true);

  herdr("agent", "prompt", rootName, "CANCEL_ACTIVE_CHILD", "--wait", "--timeout", "30000");
  await until(
    () =>
      entries(rootSession).some(
        (entry) =>
          entry.type === "message" &&
          entry.message?.role === "assistant" &&
          entry.message.content?.some(
            (part) => part.type === "text" && part.text === "PARENT_CANCEL_DONE",
          ),
      ),
    "parent cancellation result",
    40_000,
  );
  const child = await until(
    () => {
      const record = records()[0];
      return record?.state === "cancelled" && record.surfaceState === "closed" && record;
    },
    "active child cancellation and cleanup",
    40_000,
  );
  assert.equal(existsSync(join(directory, "active-provider-aborted.json")), true);
  const aborted = JSON.parse(readFileSync(join(directory, "active-provider-aborted.json"), "utf8"));
  assert.equal(
    aborted.receipt?.action,
    "cancel",
    "cancellation must be child-owned, not a raw interrupt fallback",
  );
  assert.equal(
    aborted.receipt?.status,
    "cancelled",
    "the blocked provider must abort only after publishing its terminal cancellation claim",
  );
  assert.equal(
    Number(readFileSync(join(directory, "active-provider-child-calls"), "utf8")),
    1,
    "cancellation must not start another provider turn",
  );
  assert.equal(
    existsSync(child.completionMarkerPath),
    false,
    "aborted provider must not publish completion",
  );
  assert.ok(!entries(rootSession).some((entry) => entry.message?.isError), "parent remains usable");
  verifyRuntime([rootSession, ...records().map((record) => record.sessionPath)]);
  console.log(
    "PASS active provider cancellation: child acknowledged and aborted the blocked provider without another turn",
  );
} finally {
  try {
    const tabs = herdr("tab", "list", "--workspace", workspace).tabs;
    if (tabs.some((tab) => tab.tab_id === rootTab)) herdr("tab", "close", rootTab);
  } catch {
    // Preserve the assertion that caused the fixture to fail.
  }
}
