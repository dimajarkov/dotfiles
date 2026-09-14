import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { promptText, SubagentPromptView } from "./prompt-view.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const task = Array.from(
  { length: 120 },
  (_, i) => `Line ${i + 1}: literal **markdown** and code`,
).join("\n");
const child = { semanticName: "worker", role: "worker", state: "working" as const, task };

function fixture(prompt = task) {
  let rows = 32;
  let closed = 0;
  let renders = 0;
  const view = new SubagentPromptView(
    { ...child, task: prompt },
    "worker / scout",
    theme,
    () => rows,
    () => {
      renders++;
    },
    () => {
      closed++;
    },
  );
  return {
    view,
    resize: (height: number) => {
      rows = height;
    },
    closed: () => closed,
    renders: () => renders,
  };
}

test("full prompt is reachable, with literal formatting and bounded keyboard paging", () => {
  const { view, renders, closed } = fixture();
  let lines = view.render(80);
  assert.match(lines.join("\n"), /Initial delegation prompt/);
  assert.match(lines.join("\n"), /Line 1: literal \*\*markdown\*\*/);
  assert.doesNotMatch(lines.join("\n"), /Line 120:/);
  view.handleInput("\x1b[6~");
  lines = view.render(80);
  assert.doesNotMatch(lines.join("\n"), /Line 1:/);
  view.handleInput("\x1b[F");
  assert.match(view.render(80).join("\n"), /Line 120:/);
  view.handleInput("\x1b[H");
  assert.match(view.render(80).join("\n"), /Line 1:/);
  assert.equal(closed(), 0);
  assert.ok(renders() >= 3);
  view.handleInput("\x1b");
  assert.equal(closed(), 1);
});

test("wheel scrolls prompt without falling through, footer closes the viewer", () => {
  const { view, closed } = fixture("Short prompt");
  const lines = view.render(80);
  const event = {
    type: "wheel" as const,
    button: "none" as const,
    x: 2,
    y: 2,
    screenX: 2,
    screenY: 2,
    width: 80,
    height: lines.length,
    shift: false,
    alt: false,
    ctrl: false,
    wheelDelta: 4,
  };
  assert.equal(view.handleMouse(event)?.handled, true);
  view.handleMouse({ ...event, type: "click", button: "left", y: lines.length - 1 });
  assert.equal(closed(), 1);
});

test("resizes while scrolled, clamps ranges and never overflows even tiny terminals", () => {
  const { view, resize } = fixture("研究👩‍💻 café " + task);
  view.render(80);
  view.handleInput("\x1b[F");
  for (const height of [1, 2, 3, 6, 8, 12, 32]) {
    resize(height);
    for (let width = 1; width <= 120; width++) {
      const lines = view.render(width);
      assert.ok(lines.length <= Math.max(1, Math.floor(height * 0.9)), `height ${height}`);
      assert.ok(
        lines.every((line) => visibleWidth(line) <= width),
        `width ${width}`,
      );
    }
  }
});

test("keeps the conclusion in view when a bottom-scrolled modal rewraps", () => {
  const { view, resize } = fixture(task + "\nFINAL-MARKER");
  view.render(100);
  view.handleInput("\x1b[F");
  resize(12);
  assert.match(view.render(50).join("\n"), /FINAL-MARKER/);
  resize(32);
  assert.match(view.render(100).join("\n"), /FINAL-MARKER/);
});

test("sanitizes escape sequences and controls without dropping multiline prompt text", () => {
  assert.equal(
    promptText("Start\r\n\t**literal**\x1b[2J\x1b]52;c;data\x07\x00\u202eEnd"),
    "Start\n    **literal**End",
  );
  const { view } = fixture("FIRST\n\nLAST");
  const lines = view.render(80);
  assert.equal(
    lines.findIndex((line) => line.includes("LAST")) -
      lines.findIndex((line) => line.includes("FIRST")),
    2,
  );
});
