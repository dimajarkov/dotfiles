import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import ipythonExtension from "./index.js";

function createHarness(cwd: string) {
  let tool: any;
  const handlers = new Map<string, (...args: any[]) => any>();
  const pi = {
    registerTool(definition: any) {
      tool = definition;
    },
    registerCommand() {},
    on(name: string, handler: (...args: any[]) => any) {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  ipythonExtension(pi);

  const ctx = {
    cwd,
    hasUI: false,
    model: { input: ["text", "image"] },
    ui: {
      setWorkingMessage() {},
      select: async () => undefined,
    },
    sessionManager: {
      getSessionId: () => "tool-test",
      getSessionFile: () => undefined,
    },
  };
  return { tool, handlers, ctx };
}

test("IPython-only sessions keep discovered Markdown skills visible", async () => {
  const { handlers, ctx } = createHarness(process.cwd());
  const beforeAgentStart = handlers.get("before_agent_start");
  assert.ok(beforeAgentStart);
  const result = await beforeAgentStart({
    systemPrompt: "base prompt",
    systemPromptOptions: {
      selectedTools: ["ipython"],
      skills: [
        {
          name: "harness-adapters",
          description: "Load before dispatch & recovery",
          filePath: "/firstmate/.agents/skills/harness-adapters/SKILL.md",
        },
        {
          name: "manual-only",
          description: "Not model-invocable",
          filePath: "/skills/manual/SKILL.md",
          disableModelInvocation: true,
        },
      ],
    },
  }, ctx);
  assert.match(result.systemPrompt, /<available_skills>/);
  assert.match(result.systemPrompt, /harness-adapters/);
  assert.match(result.systemPrompt, /Load before dispatch &amp; recovery/);
  assert.match(result.systemPrompt, /Use ipython Python code/);
  assert.doesNotMatch(result.systemPrompt, /manual-only/);

  const unchanged = await beforeAgentStart({
    systemPrompt: "base prompt\n<available_skills>already present</available_skills>",
    systemPromptOptions: { selectedTools: ["ipython"], skills: [] },
  }, ctx);
  assert.equal(unchanged, undefined);
});

test("tool integration preserves rich output, complete spools, errors, and late abort output", { timeout: 60_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-ipython-tool-test-"));
  const { tool, handlers, ctx } = createHarness(directory);
  let largeOutputPath: string | undefined;
  try {
    let largestUpdateBytes = 0;
    const large = await tool.execute(
      "large-result",
      { code: "'x' * 70000" },
      undefined,
      (update: { content?: Array<{ type?: string; text?: string }> }) => {
        for (const block of update.content ?? []) {
          if (block.type === "text") largestUpdateBytes = Math.max(largestUpdateBytes, Buffer.byteLength(block.text ?? ""));
        }
      },
      ctx,
    );
    const largeDetails = large.details;
    largeOutputPath = largeDetails.outputFile;
    assert.ok(largeOutputPath && existsSync(largeOutputPath));
    const complete = readFileSync(largeOutputPath, "utf8");
    assert.ok(complete.length > 70_000);
    assert.equal(complete.startsWith("'xxx"), true);
    assert.equal(complete.trimEnd().endsWith("xxx'"), true);
    assert.match(largeDetails.truncationNotice, /Full output saved to:/);
    assert.ok(Buffer.byteLength(large.content[0].text) <= 50 * 1024);
    assert.ok(largestUpdateBytes <= 50 * 1024);

    const blankLines = await tool.execute(
      "blank-lines",
      { code: "print('\\n' * 2500, end='')" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(blankLines.details.outputLines, 2500);
    assert.match(blankLines.details.truncationNotice, /2000 of 2500 lines/);
    if (blankLines.details.outputFile) rmSync(blankLines.details.outputFile, { force: true });

    const rich = await tool.execute(
      "rich-output",
      {
        code: `
from IPython.display import display
display('visible display')
display({'image/png': 'AAAA', 'text/plain': 'image preview'}, raw=True)
`,
      },
      undefined,
      undefined,
      ctx,
    );
    assert.match(rich.content[0].text, /visible display/);
    assert.match(rich.content[0].text, /image preview/);
    assert.deepEqual(rich.content[1], { type: "image", data: "AAAA", mimeType: "image/png" });

    const chronological = await tool.execute(
      "chronological-output",
      {
        code: `
import sys
from IPython.display import display
print('stdout-one')
print('stderr-one', file=sys.stderr)
display('display-one')
print('stdout-two')
'result-one'
`,
      },
      undefined,
      undefined,
      ctx,
    );
    const ordered = chronological.details.output as string;
    const positions = ["stdout-one", "stderr-one", "display-one", "stdout-two", "result-one"]
      .map((marker) => ordered.indexOf(marker));
    assert.deepEqual([...positions].sort((a, b) => a - b), positions);
    assert.ok(positions.every((position) => position >= 0));
    assert.equal(chronological.content[0].text, ordered);

    const editTarget = join(directory, "edit-target.txt");
    writeFileSync(editTarget, "alpha\r\nbeta\r\n", "utf8");
    const edited = await tool.execute(
      "builtin-edit",
      { code: `await edit(${JSON.stringify(editTarget)}, "beta", "gamma")` },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(readFileSync(editTarget, "utf8"), "alpha\r\ngamma\r\n");
    assert.deepEqual(edited.details.diffs, [{
      path: realpathSync(editTarget),
      oldStr: "beta",
      newStr: "gamma",
      startLine: 2,
    }]);

    const imageTarget = join(directory, "pixel.png");
    writeFileSync(imageTarget, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
    const attached = await tool.execute(
      "builtin-attach-image",
      { code: `await attach_image(${JSON.stringify(imageTarget)})` },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(attached.content.filter((entry: { type: string }) => entry.type === "image").length, 1);
    assert.deepEqual(attached.details.attachments, [{
      mimeType: "image/png",
      path: realpathSync(imageTarget),
      bytes: readFileSync(imageTarget).byteLength,
    }]);
    assert.equal(JSON.stringify(attached.details).includes("iVBOR"), false);

    const failed = await tool.execute(
      "python-error",
      { code: "raise RuntimeError('expected tool failure')" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(failed.details.status, "error");
    assert.equal(failed.isError, true);
    assert.equal(failed.details.error.ename, "RuntimeError");
    assert.match(failed.content[0].text, /expected tool failure/);

    const controller = new AbortController();
    const abortedPromise = tool.execute(
      "late-abort",
      {
        code: `
import time
try:
    time.sleep(10)
except KeyboardInterrupt:
    time.sleep(1.3)
    print('late-after-tool-abort')
`,
      },
      controller.signal,
      undefined,
      ctx,
    );
    setTimeout(() => controller.abort(), 200);
    const aborted = await abortedPromise;
    assert.equal(aborted.details.status, "aborted");
    assert.equal(aborted.isError, true);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const healthy = await tool.execute(
      "healthy-after-abort",
      { code: "print('healthy-after-abort')" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(healthy.details.status, "ok");
    assert.equal(healthy.details.stdout.trim(), "healthy-after-abort");
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    if (largeOutputPath) rmSync(largeOutputPath, { force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});
