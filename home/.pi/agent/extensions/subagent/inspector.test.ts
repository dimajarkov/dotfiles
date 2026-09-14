import assert from "node:assert/strict";
import { test } from "node:test";
import { SubagentInspector } from "./inspector.ts";
import { buildSubagentTree } from "./widget.ts";
import type { ChildRecord } from "./orchestrator.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

const terminalClipboardPattern = new RegExp(`${String.fromCharCode(27)}\\]52;`, "u");

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
  assert.match(screens[0]!, /Enter prompt · p prompt · o output/);
  assert.match(screens[1]!, /child original task/);
  assert.match(screens[2]!, /child exact conclusion/);
  assert.match(screens[3]!, /child original task/);
  assert.equal(input.length, 0);
});

test("picker Enter preserves requested mode while p and o select explicit modes", async (t) => {
  for (const scenario of [
    {
      name: "output Enter",
      requested: "output",
      key: "\r",
      expected: /parent exact conclusion/,
      hint: /Enter output/,
    },
    {
      name: "prompt key",
      requested: "output",
      key: "p",
      expected: /parent original task/,
      hint: /Enter output/,
    },
    {
      name: "output key",
      requested: "prompt",
      key: "o",
      expected: /parent exact conclusion/,
      hint: /Enter prompt/,
    },
  ] as const) {
    await t.test(scenario.name, async () => {
      const inspector = new SubagentInspector();
      const screens: string[] = [];
      const input = [scenario.key, "\x1b"];
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
              view.handleInput?.(input.shift()!);
              assert.ok(settled, "UI must settle through user input");
            }),
        },
      } as unknown as ExtensionContext;

      await inspector.show(ctx, rows, scenario.requested);
      assert.match(screens[0]!, scenario.hint);
      assert.match(screens[1]!, scenario.expected);
      assert.equal(input.length, 0);
    });
  }
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

test("failed empty output preserves the result and displays failure details", async () => {
  const inspector = new SubagentInspector();
  const failedRows = buildSubagentTree(
    [{ ...children[0]!, state: "failed", result: "", error: "provider exploded" }],
    "root",
  );
  let screen = "";
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
          const view = factory({ terminal: { rows: 32 }, requestRender() {} }, theme, {}, resolve);
          screen = view.render(100).join("\n");
          view.handleInput?.("\x1b");
        }),
    },
  } as unknown as ExtensionContext;

  await inspector.show(ctx, failedRows, "output", "", failedRows[0]);

  assert.match(screen, /Saved final response · failure details below/);
  assert.match(screen, /Failure: provider exploded/);
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

test("non-TUI tree output sanitizes child metadata without changing records", async () => {
  const inspector = new SubagentInspector();
  const unsafeChildren = [
    {
      ...children[0]!,
      semanticName: "parent\x1b]52;c;NAME-CONTROL\x07\nname",
      role: "worker\x1b]52;c;ROLE-CONTROL\x07\nrole",
    },
  ];
  const saved = structuredClone(unsafeChildren);
  const unsafeRows = buildSubagentTree(unsafeChildren, "root");
  let output = "";
  const ctx = {
    mode: "rpc",
    ui: {
      notify: (text: string) => {
        output = text;
      },
    },
  } as unknown as ExtensionContext;

  await inspector.show(ctx, unsafeRows);

  assert.equal(output, "└─ parent name [worker role] completed");
  assert.doesNotMatch(
    output,
    new RegExp(`NAME-CONTROL|ROLE-CONTROL|${terminalClipboardPattern.source}`, "u"),
  );
  assert.deepEqual(unsafeChildren, saved);
});
