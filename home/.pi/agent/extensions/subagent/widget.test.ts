import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  buildSubagentTree,
  getSubagentWidgetLayout,
  getSubagentWidgetRowAtLine,
  renderSubagentWidget,
  renderSubagentWidgetLayout,
  type TreeRow,
} from "./widget.ts";
import type { ChildRecord } from "./orchestrator.ts";

type WidgetTheme = Parameters<typeof renderSubagentWidget>[2];
const theme: WidgetTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

function child(
  id: string,
  parentId: string,
  state: ChildRecord["state"],
  overrides: Partial<ChildRecord> = {},
): ChildRecord {
  return {
    id,
    rootId: "root",
    parentId,
    parentSessionId: "session",
    semanticName: id,
    herdrName: id,
    role: "worker",
    task: `Task for ${id}`,
    cwd: "/tmp",
    depth: parentId === "root" ? 1 : 2,
    generation: 1,
    workspaceId: "workspace",
    herdrSession: "herdr-session",
    completionMarkerPath: "/tmp/completion",
    state,
    createdAt: 1,
    updatedAt: 1,
    launchLoadout: {
      version: 1,
      role: "worker",
      tools: [],
      skills: [],
      spawnTargets: [],
      cwd: "/tmp",
      environment: {},
    },
    ...overrides,
  };
}

function names(rows: readonly TreeRow[]): string[] {
  return rows.map((row) => row.child.id);
}

test("builds a reachable tree, retains active descendant context, and drops unrelated records", () => {
  const records = [
    child("ordinary", "root", "working"),
    child("ordinary-done", "ordinary", "completed", { updatedAt: 5 }),
    child("context", "root", "completed"),
    child("blocked", "context", "blocked"),
    child("context-done", "context", "completed"),
    child("orphan", "missing-parent", "blocked"),
    child("cycle-a", "cycle-b", "working"),
    child("cycle-b", "cycle-a", "working"),
  ];

  const rows = buildSubagentTree(records, "root");
  assert.deepEqual(names(rows), [
    "context",
    "blocked",
    "context-done",
    "ordinary",
    "ordinary-done",
  ]);
  assert.deepEqual(
    rows.map((row) => row.depth),
    [0, 1, 1, 0, 1],
  );
  assert.deepEqual(
    rows.map((row) => row.prefix),
    ["├─ ", "│  ├─ ", "│  └─ ", "└─ ", "   └─ "],
  );
  assert.deepEqual(
    rows.map((row) => row.path),
    [
      "root/context",
      "root/context/blocked",
      "root/context/context-done",
      "root/ordinary",
      "root/ordinary/ordinary-done",
    ],
  );
  assert.deepEqual(
    rows.map((row) => row.displayPath),
    [
      "context",
      "context / blocked",
      "context / context-done",
      "ordinary",
      "ordinary / ordinary-done",
    ],
  );
  assert.ok(!names(rows).includes("orphan"));
  assert.ok(!names(rows).includes("cycle-a"));
  assert.ok(!names(rows).includes("cycle-b"));
});

test("active-only mode keeps completed context but excludes completed-only branches", () => {
  const rows = buildSubagentTree(
    [
      child("context", "root", "completed"),
      child("live", "context", "working"),
      child("finished", "context", "completed"),
      child("finished-root", "root", "completed"),
    ],
    "root",
    { activeOnly: true },
  );
  assert.deepEqual(names(rows), ["context", "live"]);
  assert.equal(rows[0]?.child.state, "completed");
  assert.equal(rows[0]?.depth, 0);
});

test("blocked and active subtrees are prioritized without detaching descendants", () => {
  const records = [
    child("old", "root", "completed", { updatedAt: 1 }),
    child("new", "root", "completed", { updatedAt: 20 }),
    child("busy", "root", "working"),
    child("blocked-parent", "root", "completed"),
    child("blocked-leaf", "blocked-parent", "blocked"),
  ];
  const rows = buildSubagentTree(records, "root");
  assert.deepEqual(names(rows), ["blocked-parent", "blocked-leaf", "busy", "new", "old"]);
  assert.equal(rows[1]?.path, "root/blocked-parent/blocked-leaf");
  assert.equal(rows[1]?.prefix, "│  └─ ");
});

test("layout keeps parent context under the cap and exposes output hit bounds", () => {
  const records = [
    child("done", "root", "completed", { result: "exact final response" }),
    child("active", "root", "working"),
    child("done-child", "done", "completed", { result: "child response" }),
    child("blocked", "root", "blocked"),
  ];
  const rows = buildSubagentTree(records, "root");
  const layout = getSubagentWidgetLayout(rows, 80);
  assert.deepEqual(
    layout.visibleRows.map((row) => row.child.id),
    names(rows),
  );
  const output = layout.rows.find((target) => target.row.child.id === "done");
  assert.ok(output);
  assert.equal(output.outputStart! >= 0, true);
  assert.equal(getSubagentWidgetRowAtLine(layout, output.y), output.row);
  assert.equal(getSubagentWidgetRowAtLine(layout, 0), undefined);

  const renderedLayout = renderSubagentWidgetLayout(rows, 80, theme);
  assert.deepEqual(renderedLayout.targets, layout.rows);
  const lines = renderSubagentWidget(rows, 80, theme).map(stripTerminalSequences);
  assert.deepEqual(renderedLayout.lines.map(stripTerminalSequences), lines);
  assert.equal(
    lines[output.y]!.slice(output.outputStart!, output.outputStart! + "[output]".length),
    "[output]",
  );
  assert.match(lines[output.y]!, /done \(worker\).*● done \[output\]/);
});

test("keeps an active sibling visible ahead of completed descendant history", () => {
  const rows = buildSubagentTree(
    [
      child("active-a", "root", "working"),
      child("a-history-1", "active-a", "completed"),
      child("a-history-2", "active-a", "completed"),
      child("a-history-3", "active-a", "completed"),
      child("a-history-4", "active-a", "completed"),
      child("active-b", "root", "working"),
    ],
    "root",
  );
  const layout = getSubagentWidgetLayout(rows, 80, theme);
  assert.deepEqual(
    layout.visibleRows.map((row) => row.child.id),
    ["active-a", "a-history-1", "a-history-2", "a-history-3", "active-b"],
  );
  assert.deepEqual(
    layout.hiddenRows.map((row) => row.child.id),
    ["a-history-4"],
  );
  assert.equal(layout.activeCount, 2);
  assert.equal(layout.doneCount, 4);
  assert.equal(layout.hiddenBlockedCount, 0);
  assert.equal(layout.lines?.length, 8);
  const rendered = renderSubagentWidget(rows, 80, theme).map(stripTerminalSequences);
  assert.match(rendered.join("\n"), /active-b \(worker\).*● working/);
  assert.match(rendered.join("\n"), /\+1 more · \/subagents/);
});

test("completed history remains visible, reports active and done counts, and offers the footer hint", () => {
  const rows = buildSubagentTree(
    [
      child("working", "root", "working"),
      child("blocked", "root", "blocked"),
      child("finished", "root", "completed", { result: "FINAL" }),
    ],
    "root",
  );
  const lines = renderSubagentWidget(rows, 64, theme);
  assert.equal(lines.length, 5);
  assert.match(lines[0]!, /2 active · 1 done/);
  assert.match(lines[1]!, /blocked \(worker\).*! blocked/);
  assert.match(lines[3]!, /finished \(worker\).*● done \[output\]/);
  assert.match(lines[4]!, /click prompt · \/subagents/);
  assert.ok(lines.every((line) => visibleWidth(line) === 64));
});

test("caps older completed rows and reports hidden blocked rows accurately", () => {
  const history = Array.from({ length: 8 }, (_, index) =>
    child(`done-${index}`, "root", "completed", {
      updatedAt: index,
      result: `result-${index}`,
    }),
  );
  const historyRows = buildSubagentTree(history, "root");
  const historyLayout = getSubagentWidgetLayout(historyRows, 80);
  assert.deepEqual(
    historyLayout.visibleRows.map((row) => row.child.id),
    ["done-7", "done-6", "done-5", "done-4", "done-3"],
  );
  assert.equal(historyLayout.hiddenRows.length, 3);
  assert.equal(historyLayout.hiddenBlockedCount, 0);

  const blockedChain = Array.from({ length: 7 }, (_, index) =>
    child(`blocked-${index}`, index === 0 ? "root" : `blocked-${index - 1}`, "blocked"),
  );
  const blockedRows = buildSubagentTree(blockedChain, "root");
  const blockedLayout = getSubagentWidgetLayout(blockedRows, 80);
  assert.deepEqual(
    blockedLayout.visibleRows.map((row) => row.child.id),
    ["blocked-0", "blocked-1", "blocked-2", "blocked-3", "blocked-4"],
  );
  assert.equal(blockedLayout.hiddenRows.length, 2);
  assert.equal(blockedLayout.hiddenBlockedCount, 2);
  const rendered = renderSubagentWidget(blockedRows, 80, theme).map(stripTerminalSequences);
  assert.match(rendered.join("\n"), /\+2 more · 2 blocked · \/subagents/);
});

test("empty and zero-width renders reserve no space", () => {
  assert.deepEqual(renderSubagentWidget([], 80, theme), []);
  assert.deepEqual(renderSubagentWidget([], 0, theme), []);
  assert.deepEqual(
    renderSubagentWidget(buildSubagentTree([child("one", "root", "working")], "root"), 0, theme),
    [],
  );
});

test("sanitizes Unicode and terminal input while staying within every narrow width", () => {
  const styledTheme: WidgetTheme = {
    fg: (color, text) => `\x1b[${color === "warning" ? 33 : 36}m${text}\x1b[39m`,
    bold: (text) => `\x1b[1m${text}\x1b[22m`,
  };
  const rows = buildSubagentTree(
    [
      child("weird", "root", "completed", {
        semanticName: "研究👩‍💻 cafe\u0301\u202einvisible\n\t\x1b[2Jinjected",
        role: "\x1b]8;;https://example.com\x07reviewer\x1b]8;;\x07\u2066role\u2069\r\nkind",
        result: "done",
      }),
    ],
    "root",
  );

  for (let width = 1; width <= 160; width += 1) {
    const lines = renderSubagentWidget(rows, width, styledTheme);
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
      assert.doesNotMatch(line, /[\r\n\t]/);
      assert.ok(!line.includes("\x1b[2J") && !line.includes("\x1b]8;"));
      assert.doesNotMatch(line, /[\u202a-\u202e\u2066-\u2069]/u);
      if (width >= 4) assert.equal(visibleWidth(line), width);
    }
  }
  const plain = renderSubagentWidget(rows, 120, styledTheme).map(stripTerminalSequences).join("\n");
  assert.match(plain, /研究👩‍💻 caféinvisible injected \(reviewerrole kind\)/);
  assert.match(plain, /● done \[output\]/);
});

test("does not mutate the supplied records", () => {
  const records = [
    child("first", "root", "working"),
    child("second", "root", "blocked"),
    child("finished", "root", "completed", { updatedAt: 100 }),
  ];
  const before = structuredClone(records);
  buildSubagentTree(records, "root");
  assert.deepEqual(records, before);
});
