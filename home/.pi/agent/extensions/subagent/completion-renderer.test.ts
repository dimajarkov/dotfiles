import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth, type MarkdownTheme } from "@earendil-works/pi-tui";
import {
  completionOutput,
  renderCompletionMessage,
  type CompletionRenderTheme,
} from "./completion-renderer.ts";

const style = (code: number) => (text: string) => `\x1b[${code}m${text}\x1b[0m`;
const markdownTheme: MarkdownTheme = {
  heading: style(31),
  link: style(32),
  linkUrl: style(33),
  code: style(34),
  codeBlock: style(35),
  codeBlockBorder: style(36),
  quote: style(37),
  quoteBorder: style(91),
  hr: style(92),
  listBullet: style(93),
  bold: style(94),
  italic: style(95),
  strikethrough: style(96),
  underline: style(97),
  highlightCode: (code) => code.split("\n").map(style(35)),
};
const theme: CompletionRenderTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

test("removes only the completion status line from the markdown payload", () => {
  assert.equal(
    completionOutput("Subagent scout completed.\n\n# Findings\n\n- one"),
    "# Findings\n\n- one",
  );
  assert.equal(completionOutput("# A heading\n\n- one"), "# A heading\n\n- one");
  assert.equal(completionOutput("Subagent finished"), "Subagent finished");
});

test("renders completion output through the native Markdown component", () => {
  const component = renderCompletionMessage(
    {
      content:
        "Subagent scout completed.\n\n# Findings\n\n- **bold** item\n- `inline`\n\n```ts\nconst answer = 42;\n```\n\n> quoted",
      details: { semanticName: "scout", role: "researcher", state: "completed" },
    },
    { expanded: true, outputPad: 1 },
    theme,
    markdownTheme,
  );
  const lines = component.render(60);
  const plain = lines.map(stripTerminalSequences).join("\n");

  assert.match(plain, /✓ scout \[researcher\]/);
  assert.match(plain, /Findings/);
  assert.doesNotMatch(plain, /# Findings/);
  assert.match(plain, /bold item/);
  assert.match(plain, /inline/);
  assert.match(plain, /const answer = 42;/);
  assert.match(plain, /quoted/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 60));
  assert.ok(lines.some((line) => line.includes("\x1b[31m")));
  assert.ok(lines.some((line) => line.includes("\x1b[35m")));
});

test("collapses completion output with the native expand hint", () => {
  const component = renderCompletionMessage(
    {
      content: "Subagent scout completed.\n\n# Findings\n\n- one\n- two",
      details: { semanticName: "scout", role: "researcher", state: "completed" },
    },
    { expanded: false, outputPad: 1 },
    theme,
    markdownTheme,
    "⌘+O",
  );
  const plain = component.render(60).map(stripTerminalSequences).join("\n");

  assert.match(plain, /✓ scout \[researcher\]/);
  assert.match(plain, /# Findings · 4 lines/);
  assert.match(plain, /Press ⌘\+O for full output/);
  assert.doesNotMatch(plain, /- one/);
});
