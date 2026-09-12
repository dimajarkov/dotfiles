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

test("renders failed empty output and its error as separate fields", () => {
  const message = {
    content: "Subagent scout failed.\n\n\n\nFailure: provider exploded",
    details: {
      completionDataVersion: 1,
      semanticName: "scout",
      role: "researcher",
      state: "failed",
      result: "",
      error: "provider exploded",
    },
  };
  const collapsed = renderCompletionMessage(
    message,
    { expanded: false, outputPad: 1 },
    theme,
    markdownTheme,
  )
    .render(60)
    .map(stripTerminalSequences)
    .join("\n");
  const expanded = renderCompletionMessage(
    message,
    { expanded: true, outputPad: 1 },
    theme,
    markdownTheme,
  )
    .render(60)
    .map(stripTerminalSequences)
    .join("\n");

  assert.match(collapsed, /✗ scout \[researcher\]/);
  assert.match(collapsed, /Failure: provider exploded/);
  assert.match(expanded, /\(no output\)/);
  assert.match(expanded, /Failure: provider exploded/);
});

test("structured missing output renders its failure once without legacy content fallback", () => {
  const message = {
    content: "Subagent scout crashed.\n\n(no output)\n\nFailure: provider exploded",
    details: {
      completionDataVersion: 1,
      semanticName: "scout",
      role: "researcher",
      state: "crashed",
      error: "provider exploded",
    },
  };
  const collapsed = renderCompletionMessage(
    message,
    { expanded: false, outputPad: 1 },
    theme,
    markdownTheme,
  )
    .render(60)
    .map(stripTerminalSequences)
    .join("\n");
  const expanded = renderCompletionMessage(
    message,
    { expanded: true, outputPad: 1 },
    theme,
    markdownTheme,
  )
    .render(60)
    .map(stripTerminalSequences)
    .join("\n");

  assert.equal((collapsed.match(/Failure: provider exploded/gu) ?? []).length, 1);
  assert.doesNotMatch(collapsed, /Subagent scout crashed/);
  assert.match(expanded, /\(no output\)/);
  assert.equal((expanded.match(/Failure: provider exploded/gu) ?? []).length, 1);
});

test("completion rendering removes terminal controls and neutralizes unsafe links", () => {
  const result =
    "before\x1b]52;c;terminal-secret\x07after [run](command:rm -rf /) <javascript:alert(1)> [docs](https://example.com)";
  const message = {
    content: "Subagent scout completed.",
    details: {
      completionDataVersion: 1,
      semanticName: "scout",
      role: "researcher",
      state: "completed",
      result,
    },
  };

  for (const expanded of [false, true]) {
    const rendered = renderCompletionMessage(
      message,
      { expanded, outputPad: 1 },
      theme,
      markdownTheme,
    )
      .render(160)
      .join("\n");
    // oxlint-disable-next-line no-control-regex -- Assert raw terminal controls are absent.
    assert.doesNotMatch(rendered, /terminal-secret|\x1b\]52;/u);
    // oxlint-disable-next-line no-control-regex -- Assert unsafe OSC 8 links are absent.
    assert.doesNotMatch(rendered, /\x1b\]8;;(?:command|javascript):/u);
  }
  assert.equal(message.details.result, result);
});
