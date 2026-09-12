import assert from "node:assert/strict";
import { test } from "node:test";
import { resumeResultText, summarizeChild } from "./child-summary.ts";
import type { ChildRecord } from "./orchestrator.ts";

function record(): ChildRecord {
  return {
    id: "child-id",
    rootId: "root",
    parentId: "parent",
    parentSessionId: "session",
    semanticName: "child\n✗ forged\x1b]52;c;NAME-CONTROL\x07\u202ename",
    herdrName: "child",
    role: "worker\u2066role\u2069\r\nkind",
    task: "saved task",
    cwd: "/tmp",
    depth: 1,
    generation: 1,
    workspaceId: "workspace",
    herdrSession: "herdr-session",
    tabId: "tab\nspoof",
    paneId: "pane\x1b]52;c;PANE-CONTROL\x07id",
    completionMarkerPath: "/tmp/completion",
    launchLoadout: {
      version: 1,
      role: "worker",
      model: "model\nvariant",
      thinking: "high\u202elow",
      tools: [],
      skills: [],
      spawnTargets: [],
      cwd: "/tmp",
      environment: {},
    },
    workScope: "scope\nforged",
    state: "working",
    createdAt: 1,
    updatedAt: 1,
  };
}

test("summarizes untrusted child metadata as one safe line without mutation", () => {
  const child = record();
  const saved = structuredClone(child);
  const summary = summarizeChild(child);

  assert.equal(
    summary,
    "○ child ✗ forgedname [workerrole kind] working scope=scope forged model=model variant thinking=highlow tab spoof/paneid",
  );
  for (const unsafe of ["\r", "\n", "\u202a", "\u202e", "\u2066", "\u2069", "\x1b]52;"]) {
    assert.equal(summary.includes(unsafe), false);
  }
  assert.deepEqual(child, saved);
});

test("resume result text distinguishes focus from terminal reconciliation", () => {
  const child = record();
  child.semanticName = "authentication";
  child.paneId = "w1:p9";

  assert.equal(resumeResultText({ action: "focused", child }), "Focused authentication in w1:p9");
  child.state = "completed";
  assert.equal(
    resumeResultText({ action: "reconciled", child }),
    "Already completed: authentication",
  );
});
