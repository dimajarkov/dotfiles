import assert from "node:assert/strict";
import { test } from "node:test";
import { SubagentInspector } from "./inspector.ts";
import { buildSubagentTree } from "./widget.ts";
import type { ChildRecord } from "./orchestrator.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

// This fixture exercises the UI boundary, not an orchestrator or a model.
const children: ChildRecord[] = ["parent", "child"].map((id, index) => ({
  id,
  rootId: "root",
  parentId: index ? "parent" : "root",
  parentSessionId: "root",
  semanticName: id,
  role: "worker",
  state: "completed",
  task: `${id} original task`,
  result: `${id} exact conclusion`,
  cwd: "/tmp",
  depth: index + 1,
  generation: 1,
  herdrName: id,
  herdrSession: "test",
  workspaceId: "test",
  completionMarkerPath: "unused",
  createdAt: index,
  updatedAt: index,
}));
const rows = buildSubagentTree(children, "root");
const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };

test("inspector navigates tree, switches exact prompt/output, closes without lifecycle calls", async () => {
  const inspector = new SubagentInspector();
  const screens: string[] = [];
  const input = ["\x1b[B", "\r", "o", "p", "\x1b"];
  const ctx = {
    mode: "tui",
    ui: {
      notify: () => assert.fail("Unexpected notification"),
      custom: async (
        factory: (
          tui: unknown,
          theme: unknown,
          keys: unknown,
          done: (value: unknown) => void,
        ) => Component,
      ) =>
        new Promise((resolve) => {
          let settled = false;
          const view = factory(
            { terminal: { rows: 32 }, requestRender() {} },
            theme,
            {},
            (value) => {
              settled = true;
              resolve(value);
            },
          );
          screens.push(view.render(100).join("\n"));
          while (!settled && input.length) {
            view.handleInput?.(input.shift()!);
            if (!settled) view.render(100);
          }
          assert.ok(settled, "UI must settle through user input");
        }),
    },
  } as unknown as ExtensionContext;
  await inspector.show(ctx, rows);
  assert.match(screens[0]!, /select to inspect/);
  assert.match(screens[1]!, /child original task/);
  assert.match(screens[2]!, /child exact conclusion/);
  assert.match(screens[3]!, /child original task/);
  assert.equal(input.length, 0);
});

test("dispose closes pending inspection and duplicate names remain selectable", async () => {
  const inspector = new SubagentInspector();
  const duplicates = buildSubagentTree(
    children.map((child) => ({ ...child, semanticName: "same" })),
    "root",
  );
  let calls = 0;
  const ctx = {
    mode: "tui",
    ui: {
      notify: () => assert.fail("Unexpected notification"),
      custom: async (
        factory: (
          tui: unknown,
          theme: unknown,
          keys: unknown,
          done: (value: unknown) => void,
        ) => Component,
      ) =>
        new Promise((resolve) => {
          calls++;
          const view = factory({ terminal: { rows: 32 }, requestRender() {} }, theme, {}, resolve);
          assert.match(view.render(100).join("\n"), /select to inspect/);
        }),
    },
  } as unknown as ExtensionContext;
  const pending = inspector.show(ctx, duplicates, "prompt", "same");
  await inspector.show(ctx, duplicates);
  assert.equal(calls, 1, "Only one inspector may be open");
  inspector.dispose();
  await pending;
});

test("non-TUI uses a text tree fallback without opening a modal", async () => {
  const inspector = new SubagentInspector();
  let output = "";
  const ctx = {
    mode: "rpc",
    ui: {
      notify: (text: string) => {
        output = text;
      },
    },
  } as unknown as ExtensionContext;
  await inspector.show(ctx, rows);
  assert.match(output, /parent/);
  assert.match(output, /child/);
  await inspector.show(ctx, []);
  assert.equal(output, "No subagents");
});
