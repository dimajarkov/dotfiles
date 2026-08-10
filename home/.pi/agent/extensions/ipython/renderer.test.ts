import assert from "node:assert/strict";
import test from "node:test";
import {
  initTheme,
  Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  IpythonCellComponent,
  IpythonRendererTracker,
  renderIpythonResult,
} from "./renderer.js";

const colorNames: ThemeColor[] = [
  "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim", "text",
  "thinkingText", "userMessageText", "customMessageText", "customMessageLabel", "toolTitle", "toolOutput",
  "mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder",
  "mdHr", "mdListBullet", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "syntaxComment", "syntaxKeyword",
  "syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation",
  "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "thinkingMax", "bashMode",
];
const colors = Object.fromEntries(colorNames.map((name) => [name, "#999999"])) as Record<ThemeColor, string>;
const backgrounds = {
  selectedBg: "#222222",
  userMessageBg: "#222222",
  customMessageBg: "#222222",
  toolPendingBg: "#222222",
  toolSuccessBg: "#222222",
  toolErrorBg: "#222222",
};

initTheme("dark", false);
const theme = new Theme(colors, backgrounds, "truecolor");

function component(expanded: boolean): IpythonCellComponent {
  const tracker = new IpythonRendererTracker();
  tracker.activate("cell-1");
  return new IpythonCellComponent({
    code: "from pathlib import Path\np = Path('README.md')\ntext = p.read_text()\nprint(text[:20])",
    details: {
      status: "ok",
      durationMs: 12,
      stdout: "first line\nsecond line",
    },
    expanded,
    running: false,
    toolCallId: "cell-1",
    tracker,
    theme,
  });
}

test("collapsed cells match the Prime-style summary", () => {
  const rendered = component(false).render(120).join("\n");
  const plain = rendered.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(plain, /✓ python/);
  assert.match(plain, /text = p\.read_text\(\)/);
  assert.match(plain, /↑ 4 ↓ 2 lines/);
  assert.match(plain, /12ms/);
  assert.match(plain, /to expand/);
});

test("expanded cells show source and output", () => {
  const rendered = component(true).render(100).join("\n");
  const plain = rendered.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(plain, /p = Path\('README\.md'\)/);
  assert.match(plain, /first line/);
  assert.match(plain, /second line/);
});

test("every rendered line stays within narrow terminal widths", () => {
  for (const width of [16, 20, 30, 40, 60]) {
    const lines = component(true).render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `width ${width}`);
  }
});

test("host-side tool failures render as errors instead of successful empty cells", () => {
  const tracker = new IpythonRendererTracker();
  tracker.activate("failed-cell");
  const rendered = renderIpythonResult(
    { content: [{ type: "text", text: "Kernel failed to start" }] },
    { expanded: true, isPartial: false },
    theme,
    {
      args: { code: "print('never ran')" },
      toolCallId: "failed-cell",
      invalidate: () => undefined,
      lastComponent: undefined,
      executionStarted: true,
      isPartial: false,
      expanded: true,
      isError: true,
    },
    tracker,
  ).render(100).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(rendered, /✗ python/);
  assert.match(rendered, /Kernel failed to start/);
  assert.doesNotMatch(rendered, /no output/);
});

test("bash Python heredocs use Prime's composite language label", () => {
  const tracker = new IpythonRendererTracker();
  tracker.activate("bash-python-cell");
  const rendered = new IpythonCellComponent({
    code: "%%bash\npython - <<'PY'\nfrom pathlib import Path\ntext = Path('README.md').read_text()\nprint(text[:20])\nPY",
    details: { status: "ok", durationMs: 8, stdout: "preview" },
    expanded: false,
    running: false,
    toolCallId: "bash-python-cell",
    tracker,
    theme,
  }).render(120).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(rendered, /✓ bash · python/);
});

test("expanded edit cells render the native diff", () => {
  const tracker = new IpythonRendererTracker();
  tracker.activate("edit-cell");
  const rendered = new IpythonCellComponent({
    code: "await edit(path, old, new)",
    details: {
      status: "ok",
      durationMs: 5,
      output: "Edited src/app.py",
      diffs: [{ path: "src/app.py", oldStr: "return 1", newStr: "return 2", startLine: 42 }],
    },
    expanded: true,
    running: false,
    toolCallId: "edit-cell",
    tracker,
    theme,
  }).render(100).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(rendered, /src\/app\.py:42/);
  assert.match(rendered, /42.*return 1/);
  assert.match(rendered, /return 1/);
  assert.match(rendered, /return 2/);
  assert.doesNotMatch(rendered, /no output/);
});

test("image attachments render compact metadata without base64", () => {
  const tracker = new IpythonRendererTracker();
  tracker.activate("image-cell");
  const rendered = new IpythonCellComponent({
    code: "await attach_image('/tmp/screenshot.png')",
    details: {
      status: "ok",
      durationMs: 7,
      attachments: [{ mimeType: "image/png", path: "/tmp/screenshot.png", bytes: 2048 }],
    },
    expanded: true,
    running: false,
    toolCallId: "image-cell",
    tracker,
    theme,
  }).render(120).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(rendered, /1 image/);
  assert.match(rendered, /image \/tmp\/screenshot\.png · image\/png · 2\.0 KB/);
  assert.doesNotMatch(rendered, /no output/);
});
