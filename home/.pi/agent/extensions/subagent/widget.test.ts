import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { renderSubagentWidget } from "./widget.ts";

type WidgetChildren = Parameters<typeof renderSubagentWidget>[0];
const theme: Parameters<typeof renderSubagentWidget>[2] = {
  fg: (_color, text) => text,
  bold: (text) => text,
};
const children: WidgetChildren = [
  { semanticName: "recon", role: "scout", state: "working" },
  { semanticName: "review", role: "reviewer", state: "blocked" },
  { semanticName: "research", role: "researcher", state: "starting" },
];

test("renders a compact framed panel with name, role, and right-aligned state", () => {
  const lines = renderSubagentWidget(children, 64, theme);
  assert.equal(lines.length, 5);
  assert.match(lines[0], /^╭─ Subagents ─+ 3 active ─╮$/);
  assert.match(lines[1], /^│ review \(reviewer\) +! blocked │$/);
  assert.match(lines[2], /^│ recon \(scout\) +● working │$/);
  assert.match(lines[3], /^│ research \(researcher\) +○ starting │$/);
  assert.match(lines[4], /^╰─+╯$/);
  assert.ok(lines.every((line) => visibleWidth(line) === 64));
});

test("caps rows, promotes blocked children, and does not reorder its input", () => {
  const many: WidgetChildren = Array.from({ length: 8 }, (_, index) => ({
    semanticName: `agent-${index}`,
    role: "worker",
    state: index === 7 ? "blocked" : "working",
  }));
  const before = structuredClone(many);
  const lines = renderSubagentWidget(many, 80, theme);
  assert.equal(lines.length, 8);
  assert.match(lines[1], /agent-7.*! blocked/);
  assert.match(lines[6], /\+3 more · \/subagents/);
  assert.deepEqual(many, before);
});

test("empty and zero-width renders reserve no space", () => {
  assert.deepEqual(renderSubagentWidget([], 80, theme), []);
  assert.deepEqual(renderSubagentWidget(children, 0, theme), []);
  assert.deepEqual(renderSubagentWidget(children, -1, theme), []);
});

test("long names cannot displace the state or overflow on narrow terminals", () => {
  const long: WidgetChildren = [
    { semanticName: "very-long-agent-name-".repeat(8), role: "researcher", state: "blocked" },
  ];
  const lines = renderSubagentWidget(long, 40, theme);
  assert.match(stripTerminalSequences(lines[1]), /… +! blocked │$/);
  assert.ok(lines.every((line) => visibleWidth(line) === 40));
});

test("display width handles colors, Unicode, control sequences, and every narrow width", () => {
  const styledTheme: Parameters<typeof renderSubagentWidget>[2] = {
    fg: (_color, text) => `\x1b[33m${text}\x1b[39m`,
    bold: (text) => `\x1b[1m${text}\x1b[22m`,
  };
  const unusual: WidgetChildren = [
    {
      semanticName: "研究👩‍💻 cafe\u0301\n\t\x1b[2Jinjected",
      role: "\x1b]8;;https://example.com\x07reviewer\x1b]8;;\x07\r\nrole",
      state: "blocked",
    },
  ];
  for (let width = 1; width <= 160; width += 1) {
    const lines = renderSubagentWidget(unusual, width, styledTheme);
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
      assert.doesNotMatch(line, /[\r\n\t]/);
      assert.ok(!line.includes("\x1b[2J") && !line.includes("\x1b]8;"));
      if (width >= 4) assert.equal(visibleWidth(line), width);
    }
  }
  const plain = renderSubagentWidget(unusual, 120, styledTheme)
    .map(stripTerminalSequences)
    .join("\n");
  assert.match(plain, /研究👩‍💻 café injected \(reviewer role\)/);
});

test("uses the supplied palette on every render", () => {
  const first = renderSubagentWidget(children, 64, theme);
  const colored: Parameters<typeof renderSubagentWidget>[2] = {
    fg: (color, text) => `\x1b[${color === "warning" ? 33 : 36}m${text}\x1b[39m`,
    bold: theme.bold,
  };
  const second = renderSubagentWidget(children, 64, colored);
  assert.notDeepEqual(second, first);
  assert.deepEqual(second.map(stripTerminalSequences), first);
  assert.ok(second[1].includes("\x1b[33m! blocked"));
});
