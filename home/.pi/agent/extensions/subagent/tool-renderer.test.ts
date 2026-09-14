import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
  renderSubagentToolCall,
  renderSubagentToolResult,
  type SubagentToolRenderTheme,
} from "./tool-renderer.ts";

const ESC = String.fromCharCode(27);
const terminalClipboardPattern = new RegExp(`${ESC}\\]52;`, "u");
const greenPattern = new RegExp(`${ESC}\\[32m`, "u");

const theme: SubagentToolRenderTheme = {
  fg: (_color, text) => `\x1b[32m${text}\x1b[0m`,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
};

function visibleText(rendered: string): string {
  return rendered
    .split("\n")
    .map((line) => stripTerminalSequences(line).trimEnd())
    .join("\n");
}

test("tool call rendering sanitizes streaming metadata without mutating arguments", () => {
  const args = {
    action: "spawn\x1b]52;c;ACTION-CONTROL\x07\nnext",
    name: "child\x1b]52;c;NAME-CONTROL\x07\nname",
    agent: "worker\x1b]8;;command:unsafe\x1b\\role\x1b]8;;\x1b\\",
  };
  const saved = structuredClone(args);
  const rendered = renderSubagentToolCall(args, theme).render(160).join("\n");

  assert.equal(visibleText(rendered), "subagent spawn next child name [workerrole]");
  assert.doesNotMatch(
    rendered,
    new RegExp(
      `ACTION-CONTROL|NAME-CONTROL|command:unsafe|${terminalClipboardPattern.source}`,
      "u",
    ),
  );
  assert.match(rendered, greenPattern);
  assert.deepEqual(args, saved);

  const partial = renderSubagentToolCall({ name: "partial\x1b]52;c;PARTIAL\x07" }, theme)
    .render(80)
    .join("\n");
  assert.equal(visibleText(partial), "subagent … partial");
  assert.doesNotMatch(partial, new RegExp(`PARTIAL|${terminalClipboardPattern.source}`, "u"));
});

test("tool result rendering sanitizes summaries and errors without mutating results", () => {
  const result = {
    content: [
      {
        type: "text",
        text: "✗ child [worker]\nError at output\x1b]52;c;RESULT-CONTROL\x07 after",
      },
    ],
    details: { preserved: "\x1b]52;c;SAVED-CONTROL\x07" },
  };
  const saved = structuredClone(result);
  const rendered = renderSubagentToolResult(result, theme).render(160).join("\n");

  assert.match(visibleText(rendered), /✗ child \[worker\]\nError at output after/u);
  assert.doesNotMatch(
    rendered,
    new RegExp(`RESULT-CONTROL|SAVED-CONTROL|${terminalClipboardPattern.source}`, "u"),
  );
  assert.match(rendered, greenPattern);
  assert.deepEqual(result, saved);
});
