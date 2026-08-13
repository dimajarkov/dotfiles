import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import primeStyle, {
  ActivityController,
  BUILTIN_TOOL_NAMES,
  decorateBuiltin,
  eligibleBuiltins,
  fitFooterFields,
  meaningfulCommand,
  sanitizeInline,
} from "./prime-style.js";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import customRead from "../../../../.lavish/prime-ui-evidence/fixtures/custom-read.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
} as any;

function context(overrides: Record<string, unknown> = {}) {
  return {
    args: {},
    toolCallId: "call-1",
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd: process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial: true,
    expanded: false,
    showImages: false,
    isError: false,
    ...overrides,
  } as any;
}

function result(text: string, details?: unknown) {
  return { content: [{ type: "text", text }], details } as any;
}

test("source guard selects only exact winning built-ins", () => {
  const tools = [
    ...BUILTIN_TOOL_NAMES.map((name) => ({ name, sourceInfo: { source: "builtin" } })),
    { name: "read", sourceInfo: { source: "mcp" } },
  ] as any;
  assert.deepEqual(eligibleBuiltins(tools), ["write", "edit", "bash", "grep", "find", "ls"]);
  assert.deepEqual(
    eligibleBuiltins([
      { name: "read", sourceInfo: { source: "project" } },
      { name: "bash", sourceInfo: { source: "builtin" } },
    ] as any),
    ["bash"],
  );
});

test("decoration preserves the exact factory execution and schema objects", () => {
  const original = createReadToolDefinition(process.cwd());
  const decorated = decorateBuiltin("read", original as any, new ActivityController());
  assert.equal(decorated.execute, original.execute);
  assert.equal(decorated.parameters, original.parameters);
  assert.equal(decorated.description, original.description);
  assert.equal(decorated.promptSnippet, original.promptSnippet);
  assert.notEqual(decorated.renderCall, original.renderCall);
  assert.equal(decorated.renderShell, "self");
});

test("command previews are meaningful, one-line, bounded, and secret-safe", () => {
  const preview = meaningfulCommand("export API_TOKEN=super-secret\nset -e\ncd app && bun test; git status --short");
  assert.doesNotMatch(preview, /super-secret|API_TOKEN=/);
  assert.match(preview, /git status|bun test/);
  assert.equal(meaningfulCommand('printf "diagnostic one\\n"; exit 7'), 'printf "diagnostic one\\n"');
  assert.match(meaningfulCommand('for i in 1 2; do printf "row-%s\\n" "$i"; sleep 1; done'), /^printf /);
  assert.ok(visibleWidth(preview) <= 48);
  for (const command of [
    "curl -H 'Authorization: Bearer bearer-secret' https://example.test",
    "deploy --password password-secret --token=token-secret --api-key 'key-secret'",
    "login -p short-secret",
  ]) {
    assert.doesNotMatch(meaningfulCommand(command), /bearer-secret|password-secret|token-secret|key-secret|short-secret/);
  }
  assert.equal(sanitizeInline("x\n\x1b]0;owned\x07y\t z"), "x y z");
});

test("read success is one width-safe row and expands retained content", () => {
  const activity = new ActivityController();
  activity.startTool("call-1");
  activity.endTool("call-1");
  const definition = decorateBuiltin("read", createReadToolDefinition(process.cwd()) as any, activity);
  const state = {};
  const callContext = context({ state, args: { path: "src/界面.ts", offset: 4, limit: 2 } });
  const row = definition.renderCall!({ path: "src/界面.ts", offset: 4, limit: 2 } as any, theme, callContext);
  const finalContext = context({ state, args: callContext.args, isPartial: false });
  const detail = definition.renderResult!(result("const x = 1;\nconst y = 2;"), { expanded: false, isPartial: false }, theme, finalContext);
  const collapsed = row.render(40);
  assert.equal(collapsed.length, 1);
  assert.match(stripTerminalSequences(collapsed[0]!), /^✓ read · src\/界面\.ts · lines 4-5/);
  assert.ok(visibleWidth(collapsed[0]!) <= 40);
  assert.deepEqual(detail.render(40), []);
  const expanded = definition.renderResult!(result("const x = 1;\nconst y = 2;"), { expanded: true, isPartial: false }, theme, finalContext).render(20);
  assert.ok(expanded.length >= 2);
  assert.ok(expanded.every((line) => visibleWidth(line) <= 20));
  const syntaxTheme = {
    ...theme,
    fg: (_color: string, text: string) => `\x1b[31m${text}\x1b[39m`,
  } as any;
  const highlighted = definition.renderResult!(result("const x = 1;\nconst y = 2;"), { expanded: true, isPartial: false }, syntaxTheme, finalContext).render(20);
  assert.ok(highlighted.some((line) => line.includes("\x1b[31m")));

  const noLimitState = {};
  const noLimitArgs = { path: "notes.ts" };
  const noLimitRow = definition.renderCall!(noLimitArgs as any, theme, context({
    state: noLimitState,
    toolCallId: "call-2",
    args: noLimitArgs,
  }));
  definition.renderResult!(result("first\n\nthird"), { expanded: false, isPartial: false }, theme, context({
    state: noLimitState,
    toolCallId: "call-2",
    args: noLimitArgs,
    isPartial: false,
  }));
  assert.match(stripTerminalSequences(noLimitRow.render(80)[0]!), /lines 1-3/);
});

test("all success summaries meet the seven-tool grammar at normal width", () => {
  const cases = [
    ["read", { path: "a.ts", offset: 1, limit: 2 }, result("a\nb")],
    ["write", { path: "a.ts", content: "a\nb\n" }, result("Successfully wrote")],
    ["edit", { path: "a.ts" }, result("ok", { diff: "-a\n+b" })],
    ["bash", { command: "printf ok" }, result("ok")],
    ["grep", { pattern: "Prime", path: "src" }, result("a.ts:1: Prime\nb.ts:2: Prime")],
    ["find", { pattern: "*.ts", path: "src" }, result("a.ts\nb.ts")],
    ["ls", { path: "src" }, result("a.ts\nb.ts")],
  ] as const;
  for (const [name, args, toolResult] of cases) {
    const activity = new ActivityController();
    activity.startTool(name);
    activity.endTool(name);
    const base = { ...createReadToolDefinition(process.cwd()), name } as any;
    const definition = decorateBuiltin(name as any, base, activity);
    const state = {};
    const callContext = context({ toolCallId: name, state, args });
    const row = definition.renderCall!(args as any, theme, callContext);
    definition.renderResult!(toolResult, { expanded: false, isPartial: false }, theme, context({ toolCallId: name, state, args, isPartial: false }));
    const line = stripTerminalSequences(row.render(120)[0]!);
    assert.match(line, new RegExp(`^✓ ${name} ·`));
    if (name === "bash") assert.match(line, / · exit 0 · /);
    assert.ok(visibleWidth(line) <= 120);
  }
});

test("partial bash output stays running instead of reporting premature success", () => {
  const activity = new ActivityController();
  activity.frame = 1;
  const definition = decorateBuiltin("bash", { ...createReadToolDefinition(process.cwd()), name: "bash" } as any, activity);
  const state = {};
  const args = { command: "printf ok; sleep 5" };
  const row = definition.renderCall!(args as any, theme, context({ state, args }));
  const detail = definition.renderResult!(result("ok"), { expanded: false, isPartial: true }, theme, context({ state, args, isPartial: true }));
  assert.match(stripTerminalSequences(row.render(80)[0]!), /^◈ bash · printf ok/);
  assert.equal(detail.render(80).length, 2);
});

test("live edit previews render from call state and retain only five rows", () => {
  const activity = new ActivityController();
  const definition = decorateBuiltin("edit", { ...createReadToolDefinition(process.cwd()), name: "edit" } as any, activity);
  const state = {};
  const args = {
    path: "src/file.ts",
    edits: [{
      oldText: Array.from({ length: 8 }, (_, index) => `old-${index}`).join("\n"),
      newText: Array.from({ length: 8 }, (_, index) => `new-${index}`).join("\n"),
    }],
  };
  const row = definition.renderCall!(args as any, theme, context({ state, args, executionStarted: true }));
  const lines = row.render(20);
  assert.equal(lines.length, 7);
  assert.match(stripTerminalSequences(lines[0]!), /^◇ edit · src\/file\.ts/);
  assert.match(stripTerminalSequences(lines.at(-1)!), /^\+new-7/);
  assert.ok(lines.slice(2).every((line) => visibleWidth(line) <= 20));
});

test("successful bash collapses its live output back to one row", () => {
  const activity = new ActivityController();
  const definition = decorateBuiltin("bash", { ...createReadToolDefinition(process.cwd()), name: "bash" } as any, activity);
  const state = {};
  const args = { command: "printf ok" };
  definition.renderCall!(args as any, theme, context({ state, args }));
  const detail = definition.renderResult!(result("ok"), { expanded: false, isPartial: false }, theme, context({ state, args, isPartial: false }));
  assert.deepEqual(detail.render(40), []);
});

test("failed output retains no more than five wrapped diagnostic rows", () => {
  const activity = new ActivityController();
  const definition = decorateBuiltin("bash", { ...createReadToolDefinition(process.cwd()), name: "bash" } as any, activity);
  const state = {};
  const args = { command: "false" };
  definition.renderCall!(args as any, theme, context({ state, args }));
  const output = Array.from({ length: 12 }, (_, index) => `diagnostic-${index}-${"x".repeat(20)}`).join("\n");
  const detail = definition.renderResult!(result(`${output}\nCommand exited with code 7`), { expanded: false, isPartial: false }, theme, context({ state, args, isError: true, isPartial: false }));
  const lines = detail.render(18);
  assert.equal(lines.length, 6); // blank separator plus five wrapped tail rows
  assert.ok(lines.every((line) => visibleWidth(line) <= 18));
});

test("responsive footer fields never overflow wide Unicode widths", () => {
  for (const width of [1, 12, 24, 40, 80]) {
    const line = fitFooterFields(["模型-界面", "high", "Supabase MCP: PAT ready", "$1.234", "272k (99.9%)"], width, theme);
    assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
  }
});

test("activity owns one timer and disposes timings and invalidators", () => {
  const activity = new ActivityController();
  const calls: string[] = [];
  const ctx = { ui: { setWorkingMessage(value?: string) { calls.push(value ?? "reset"); } } } as any;
  activity.startAgent(ctx);
  const first = (activity as any).interval;
  activity.startAgent(ctx);
  assert.notEqual((activity as any).interval, first);
  activity.startTool("a", () => {});
  activity.endTool("a");
  activity.dispose();
  assert.equal((activity as any).interval, undefined);
  assert.equal((activity as any).timings.size, 0);
  assert.equal((activity as any).invalidators.size, 0);
  assert.equal(calls.at(-1), "reset");
});

test("session startup preserves custom and MCP execution and renderer ownership", async () => {
  const owners = [
    {
      source: "project",
      install(pi: any) {
        customRead(pi);
      },
      text: "CUSTOM_READ_OWNER:fixture.ts",
      rendered: "CUSTOM OWNER read fixture.ts",
    },
    {
      source: "mcp",
      install(pi: any) {
        pi.registerTool({
          name: "read",
          label: "mcp read",
          description: "MCP ownership fixture",
          parameters: {},
          async execute(_id: string, args: { path: string }) {
            return result(`MCP_READ_OWNER:${args.path}`);
          },
          renderCall(args: { path: string }, currentTheme: any) {
            return { render: () => [currentTheme.fg("warning", `MCP OWNER read ${args.path}`)], invalidate() {} };
          },
          renderResult(toolResult: any, _options: any, currentTheme: any) {
            return { render: () => [currentTheme.fg("warning", toolResult.content[0].text)], invalidate() {} };
          },
        });
      },
      text: "MCP_READ_OWNER:fixture.ts",
      rendered: "MCP OWNER read fixture.ts",
    },
  ];

  for (const owner of owners) {
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const registered: any[] = [];
    const activeTools = ["read", "bash"];
    let restoredActiveTools: string[] | undefined;
    const pi = {
      on(name: string, handler: (...args: any[]) => any) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      registerTool(tool: any) { registered.push(tool); },
      getAllTools() {
        return [
          { name: "read", sourceInfo: { source: owner.source } },
          { name: "bash", sourceInfo: { source: "builtin" } },
        ];
      },
      getActiveTools: () => [...activeTools],
      setActiveTools(tools: string[]) { restoredActiveTools = tools; },
      getThinkingLevel: () => "high",
    } as any;
    owner.install(pi);
    const original = registered[0]!;
    primeStyle(pi);
    const ctx = {
      cwd: process.cwd(),
      model: { id: "model", provider: "openai-codex", contextWindow: 1000 },
      ui: {
        theme,
        getTheme: () => theme,
        setTheme() {},
        setWorkingIndicator() {},
        setEditorComponent() {},
        setFooter() {},
      },
      sessionManager: { getCwd: () => process.cwd(), getEntries: () => [] },
      getContextUsage: () => ({ contextWindow: 1000, percent: 12.3 }),
    } as any;
    handlers.get("session_start")![0]!({}, ctx);
    assert.deepEqual(registered.map((tool) => tool.name), ["read", "bash"]);
    assert.deepEqual(restoredActiveTools, activeTools);

    const execution = await original.execute("call-1", { path: "fixture.ts" }, undefined, undefined, {} as any);
    assert.equal(execution.content[0]?.text, owner.text);
    const call = original.renderCall!({ path: "fixture.ts" } as any, theme, context({ args: { path: "fixture.ts" } }));
    assert.equal(stripTerminalSequences(call.render(80)[0]!), owner.rendered);
    const renderedResult = original.renderResult!(execution, { expanded: false, isPartial: false }, theme, context({
      args: { path: "fixture.ts" },
      isPartial: false,
    }));
    assert.equal(stripTerminalSequences(renderedResult.render(80)[0]!), owner.text);
  }
});

test("extension installs one footer, shows extension statuses, and never binds Ctrl+O or Ctrl+T", () => {
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const registered: any[] = [];
  const activeTools = ["read", "bash"];
  let restoredActiveTools: string[] | undefined;
  const pi = {
    on(name: string, handler: (...args: any[]) => any) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool(tool: any) { registered.push(tool); },
    getAllTools() {
      return [
        { name: "read", sourceInfo: { source: "project" } },
        { name: "bash", sourceInfo: { source: "builtin" } },
      ];
    },
    getActiveTools: () => [...activeTools],
    setActiveTools(tools: string[]) { restoredActiveTools = tools; },
    getThinkingLevel: () => "high",
  } as any;
  primeStyle(pi);
  assert.equal((pi as any).registerShortcut, undefined);
  let footerFactory: any;
  let footerInstalls = 0;
  const ctx = {
    cwd: process.cwd(),
    model: { id: "model", provider: "openai-codex", contextWindow: 1000 },
    ui: {
      theme,
      getTheme: () => theme,
      setTheme() {},
      setWorkingIndicator() {},
      setEditorComponent() {},
      setFooter(factory: any) { footerFactory = factory; footerInstalls += 1; },
    },
    sessionManager: { getCwd: () => process.cwd(), getEntries: () => [] },
    getContextUsage: () => ({ contextWindow: 1000, percent: 12.3 }),
  } as any;
  handlers.get("session_start")![0]!({}, ctx);
  assert.equal(footerInstalls, 1);
  assert.deepEqual(registered.map((tool) => tool.name), ["bash"]);
  assert.deepEqual(restoredActiveTools, activeTools);
  const footer = footerFactory({ requestRender() {} }, theme, {
    getGitBranch: () => "feature/prime-ui",
    getExtensionStatuses: () => new Map([["supabase", "Supabase MCP: PAT ready"]]),
    onBranchChange: () => () => {},
  });
  const rendered = footer.render(120).map(stripTerminalSequences);
  assert.equal(rendered.length, 2);
  assert.match(rendered[1]!, /Supabase MCP: PAT ready/);
});
