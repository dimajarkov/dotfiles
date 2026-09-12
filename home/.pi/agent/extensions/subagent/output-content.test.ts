import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { renderOutputContent } from "./output-content.ts";

const OSC8_OPEN = "\x1b]8;;";
const OSC8_CLOSE = "\x1b\\";
const OSC8_END = "\x1b]8;;\x1b\\";

function plain(lines: string[]): string {
  return lines.map(stripTerminalSequences).join("\n");
}

test("keeps the complete final response as literal, untruncated output", () => {
  const output = Array.from(
    { length: 2_200 },
    (_, index) => `line ${index + 1}: **literal markdown** and code`,
  ).join("\n");

  const lines = renderOutputContent(output, "/tmp/child", 80);

  assert.equal(lines.length, 2_200);
  assert.equal(plain(lines), output);
  assert.match(plain(lines), /line 2200: \*\*literal markdown\*\*/);
});

test("makes safe markdown links, URLs, and local paths clickable", () => {
  const output = [
    "[docs](https://example.com/a?q=1)",
    "https://example.com/plain.",
    "[encoded](./report%20notes.md)",
    "`./assets/final report-研究.md`",
    "`./assets/literal%20name.md`",
    "`/tmp/child/output #1.txt`",
    '"/tmp/child/quoted report.txt"',
    "file://server/share/report.txt",
  ].join("\n");

  const lines = renderOutputContent(output, "/tmp/child", 120);
  const rendered = lines.join("\n");

  assert.ok(rendered.includes(`${OSC8_OPEN}https://example.com/a?q=1${OSC8_CLOSE}docs`));
  assert.ok(
    rendered.includes(
      `${OSC8_OPEN}https://example.com/plain${OSC8_CLOSE}https://example.com/plain`,
    ),
  );
  assert.ok(
    rendered.includes(`${OSC8_OPEN}file:///tmp/child/report%20notes.md${OSC8_CLOSE}encoded`),
  );
  assert.ok(
    rendered.includes(
      `${OSC8_OPEN}file:///tmp/child/assets/final%20report-%E7%A0%94%E7%A9%B6.md${OSC8_CLOSE}` +
        "./assets/final report-研究.md",
    ),
  );
  assert.ok(
    rendered.includes(
      `${OSC8_OPEN}file:///tmp/child/assets/literal%2520name.md${OSC8_CLOSE}` +
        "./assets/literal%20name.md",
    ),
  );
  assert.ok(
    rendered.includes(
      `${OSC8_OPEN}file:///tmp/child/output%20%231.txt${OSC8_CLOSE}/tmp/child/output #1.txt`,
    ),
  );
  assert.ok(
    rendered.includes(
      `"${OSC8_OPEN}file:///tmp/child/quoted%20report.txt${OSC8_CLOSE}/tmp/child/quoted report.txt${OSC8_END}"`,
    ),
  );
  assert.ok(!rendered.includes(`${OSC8_OPEN}file://server/`));
  assert.equal(plain(lines), output);
  assert.ok(rendered.includes(OSC8_OPEN));
});

test("local Markdown links open assets rather than treating anchors as filename text", () => {
  const text = "[source](./index.ts#L42) [special](./report%23draft%3F.md?download=1#heading)";
  const lines = renderOutputContent(text, "/tmp/child", 160);
  assert.equal(plain(lines), text);
  assert.ok(lines.join("\n").includes(`${OSC8_OPEN}file:///tmp/child/index.ts${OSC8_CLOSE}source`));
  assert.ok(
    lines
      .join("\n")
      .includes(`${OSC8_OPEN}file:///tmp/child/report%23draft%3F.md${OSC8_CLOSE}special`),
  );
});

test("local line references open files while preserving exact labels", () => {
  const output = [
    "src/review.ts:42",
    "/tmp/child/absolute.ts:9:3",
    '"./quoted file.ts:12"',
    "`./backtick file.ts:13:4`",
    "[source](./markdown file.ts:14:5)",
    "[query](./query.ts:16?download=1#heading)",
    "file:///tmp/child/url.ts:15:6",
    "https://example.com/page:42",
  ].join("\n");
  const lines = renderOutputContent(output, "/tmp/child", 160);
  const rendered = lines.join("\n");

  assert.equal(plain(lines), output);
  assert.ok(rendered.includes(`${OSC8_OPEN}file:///tmp/child/src/review.ts${OSC8_CLOSE}src/review.ts:42`));
  assert.ok(rendered.includes(`${OSC8_OPEN}file:///tmp/child/absolute.ts${OSC8_CLOSE}/tmp/child/absolute.ts:9:3`));
  assert.ok(rendered.includes(`${OSC8_OPEN}file:///tmp/child/quoted%20file.ts${OSC8_CLOSE}./quoted file.ts:12`));
  assert.ok(rendered.includes(`${OSC8_OPEN}file:///tmp/child/backtick%20file.ts${OSC8_CLOSE}./backtick file.ts:13:4`));
  assert.ok(rendered.includes(`${OSC8_OPEN}file:///tmp/child/markdown%20file.ts${OSC8_CLOSE}source`));
  assert.ok(rendered.includes(`${OSC8_OPEN}file:///tmp/child/query.ts${OSC8_CLOSE}query`));
  assert.ok(rendered.includes(`${OSC8_OPEN}file:///tmp/child/url.ts${OSC8_CLOSE}file:///tmp/child/url.ts:15:6`));
  assert.ok(rendered.includes(`${OSC8_OPEN}https://example.com/page:42${OSC8_CLOSE}https://example.com/page:42`));
});

test("reopens OSC 8 links on every wrapped line", () => {
  const output = "https://example.com/a-long-path-that-must-be-clickable-after-scrolling";
  const lines = renderOutputContent(output, "/tmp/child", 12);

  assert.ok(lines.length > 1);
  assert.ok(lines.every((line) => line.includes(OSC8_OPEN) && line.includes(OSC8_CLOSE)));
  assert.equal(lines.map(stripTerminalSequences).join(""), output);
});

test("does not activate unsafe schemes or terminal escape content", () => {
  const output = [
    "before\x1b]52;c;secret\x07middle\x1b[31mred\x1b[0m",
    "[unsafe](javascript:alert(1))",
    "[command](command:rm -rf /)",
    "javascript:https://unsafe.example",
  ].join("\n");

  const lines = renderOutputContent(output, "/tmp/child", 100);
  const rendered = lines.join("\n");
  const visible = plain(lines);

  assert.equal(
    visible,
    "beforemiddlered\n[unsafe](javascript:alert(1))\n[command](command:rm -rf /)\njavascript:https://unsafe.example",
  );
  assert.ok(!rendered.includes("\x1b]52;"));
  assert.ok(!rendered.includes("\x1b[31m"));
  assert.ok(!rendered.includes(`${OSC8_OPEN}javascript:`));
  assert.ok(!rendered.includes(`${OSC8_OPEN}command:`));
  assert.ok(!rendered.includes(`${OSC8_OPEN}https://unsafe.example`));
  assert.match(visible, /\[unsafe\]\(javascript:alert\(1\)\)/u);
  assert.match(visible, /\[command\]\(command:rm -rf \/\)/u);
});

test("wraps Unicode and linked content to the requested width", () => {
  const output = "研究👩‍💻 café `./assets/日本語 file.txt` https://example.com/長いパス";

  for (const width of [1, 2, 3, 5, 8, 13, 20, 40]) {
    const lines = renderOutputContent(output, "/tmp/child", width);
    assert.ok(lines.length > 0);
    assert.ok(
      lines.every((line) => visibleWidth(line) <= width),
      `line exceeded width ${width}: ${JSON.stringify(lines)}`,
    );
  }

  const rendered = renderOutputContent(output, "/tmp/child", 40).join("\n");
  assert.match(rendered, /研究👩‍💻/u);
  assert.match(rendered, /café/u);
  assert.match(rendered, /file\.txt/u);
  assert.match(rendered, /https:\/\/example\.com\/長いパス/u);
});
