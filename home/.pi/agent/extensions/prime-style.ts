import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  CustomEditor,
  getLanguageFromPath,
  highlightCode,
  renderDiff,
  type ExtensionAPI,
  type ExtensionContext,
  type ReadonlyFooterDataProvider,
  type Theme,
  type ToolDefinition,
  type ToolRenderContext,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";

export const BUILTIN_TOOL_NAMES = ["read", "write", "edit", "bash", "grep", "find", "ls"] as const;
export const WORKING_FRAMES = ["◇", "◈", "◆", "◈"] as const;
const WORKING_INTERVAL_MS = 250;
const LIVE_TAIL_ROWS = 5;
const EDITOR_BASE_PADDING = 3;
const EDITOR_SURFACE_PADDING = 2;
const PROMPT_PREFIX_WIDTH = 2;
const START_HINTS = [
  'Try "refactor @<filepath>"',
  'Try "fix bugs in @<filepath>"',
  'Try "add tests for @<filepath>"',
  'Try "explain how @<filepath> works"',
  'Try "improve performance in @<filepath>"',
] as const;

type BuiltinName = (typeof BUILTIN_TOOL_NAMES)[number];
type AppTheme = ExtensionContext["ui"]["theme"];
type Keybindings = ConstructorParameters<typeof CustomEditor>[2];
type ToolResult = AgentToolResult<unknown>;

type PrimeRowState = {
  row?: PrimeToolRow;
  result?: ToolResult;
  isError?: boolean;
};

export function sanitizeInline(value: unknown): string {
  if (typeof value !== "string") return "";
  return stripTerminalSequences(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeMultiline(value: unknown): string {
  if (typeof value !== "string") return "";
  return stripTerminalSequences(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function textOutput(result: ToolResult | undefined): string {
  return (
    result?.content
      .filter((block): block is { type: "text"; text: string } =>
        block.type === "text" && typeof block.text === "string",
      )
      .map((block) => block.text)
      .join("\n") ?? ""
  );
}

function contentLines(text: string): string[] {
  return safeMultiline(text)
    .split("\n")
    .filter((line) => line.trim() && !/^\[.*\]$/.test(line.trim()));
}

function logicalLineCount(text: string): number {
  if (!text) return 0;
  return text.endsWith("\n") ? text.slice(0, -1).split("\n").length : text.split("\n").length;
}

function formatDuration(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function pathValue(args: Record<string, unknown>): string {
  return sanitizeInline(args.path ?? args.file_path) || ".";
}

function scopeValue(args: Record<string, unknown>): string {
  const scope = pathValue(args);
  const glob = sanitizeInline(args.glob);
  return glob ? `${scope} (${glob})` : scope;
}

function diffCounts(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { added, removed };
}

export function meaningfulCommand(command: unknown): string {
  const raw = safeMultiline(command)
    .replace(/[A-Za-z0-9+/]{80,}={0,2}/g, "<blob>")
    .replace(/\b([A-Za-z_]\w*(?:token|key|secret|password)\w*)\s*=\s*(?:["'][^"']*["']|\S+)/gi, "$1=<redacted>")
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "<redacted>");
  const candidates = raw
    .split(/\n|\s*(?:&&|;)\s*/)
    .map((line) => line.replace(/^\s*(?:cd\s+[^&;|]+\s*)?/, "").trim())
    .map((line) => line.match(/\bdo\s+(.+)$/)?.[1] ?? line)
    .filter((line) => line && !/^(?:#|set\s|export\s|source\s|\.\s|do$|done$|then$|fi$|exit\b)/.test(line));
  const scored = candidates.map((line, index) => ({
    line,
    score:
      -index +
      (/\b(?:rm|mv|cp|git|npm|pnpm|bun|pytest|vitest|write|edit)\b/.test(line) ? 50 : 0) +
      (/^(?:printf|echo)\b/.test(line) ? 20 : 0) -
      (/^sleep\b/.test(line) ? 20 : 0),
  }));
  const selected = scored.sort((left, right) => right.score - left.score)[0]?.line ?? sanitizeInline(raw);
  return truncateToWidth(selected, 64, "…");
}

function grepMatchCount(output: string): number {
  const matches = contentLines(output).filter((line) => /:\d+[:\-]/.test(line));
  if (matches.length > 0) return matches.length;
  return /no matches found/i.test(output) ? 0 : contentLines(output).length;
}

function itemCount(output: string, emptyPattern: RegExp): number {
  return emptyPattern.test(output) ? 0 : contentLines(output).length;
}

function successFields(name: BuiltinName, args: Record<string, unknown>, result: ToolResult): string[] {
  const output = textOutput(result);
  switch (name) {
    case "read": {
      const offset = typeof args.offset === "number" ? args.offset : 1;
      const limit = typeof args.limit === "number" ? args.limit : contentLines(output).length;
      const end = Math.max(offset, offset + Math.max(0, limit) - 1);
      return [pathValue(args), `lines ${offset}-${end}`];
    }
    case "write":
      return [pathValue(args), `${logicalLineCount(typeof args.content === "string" ? args.content : "")} lines`];
    case "edit": {
      const counts = diffCounts(String((result.details as { diff?: unknown } | undefined)?.diff ?? ""));
      return [pathValue(args), `+${counts.added} -${counts.removed}`];
    }
    case "bash":
      return [meaningfulCommand(args.command) || "command", "exit 0"];
    case "grep":
      return [sanitizeInline(args.pattern) || "pattern", scopeValue(args), `${grepMatchCount(output)} matches`];
    case "find":
      return [sanitizeInline(args.pattern) || "glob", pathValue(args), `${itemCount(output, /no files found/i)} paths`];
    case "ls":
      return [pathValue(args), `${itemCount(output, /empty directory/i)} entries`];
  }
}

function failureFields(name: BuiltinName, args: Record<string, unknown>, result: ToolResult): string[] {
  const output = textOutput(result);
  if (name === "bash") {
    const code = output.match(/exited with code\s+(\d+)/i)?.[1];
    const status = /aborted/i.test(output) ? "aborted" : code ? `exit ${code}` : "failed";
    return [meaningfulCommand(args.command) || "command", status];
  }
  return [pathValue(args), /aborted/i.test(output) ? "aborted" : "failed"];
}

function rowLine(theme: Theme, marker: string, name: BuiltinName, fields: string[], width: number): string {
  const separator = theme.fg("dim", " · ");
  const markerColor = marker === "✓" ? "success" : marker === "✗" ? "error" : marker === "◇" ? "muted" : "accent";
  let line = `${theme.fg(markerColor, marker)} ${theme.fg("toolTitle", theme.bold(name))}`;
  for (const field of fields.filter(Boolean)) {
    const available = width - visibleWidth(line) - visibleWidth(" · ");
    if (available <= 0) break;
    const fitted = truncateToWidth(theme.fg("muted", sanitizeInline(field)), available, "…");
    if (!fitted) break;
    line += separator + fitted;
    if (visibleWidth(fitted) < visibleWidth(sanitizeInline(field))) break;
  }
  return truncateToWidth(line, Math.max(1, width), "");
}

class PrimeToolRow implements Component {
  private args: Record<string, unknown> = {};
  private result?: ToolResult;
  private isError = false;
  private executionStarted = false;
  private theme?: Theme;

  constructor(
    private readonly name: BuiltinName,
    private readonly toolCallId: string,
    private readonly activity: ActivityController,
  ) {}

  update(
    args: Record<string, unknown>,
    result: ToolResult | undefined,
    isError: boolean,
    executionStarted: boolean,
    theme: Theme,
  ): void {
    this.args = args;
    this.result = result;
    this.isError = isError;
    this.executionStarted = executionStarted;
    this.theme = theme;
  }

  render(width: number): string[] {
    const theme = this.theme;
    if (!theme || width <= 0) return [];
    let marker = "◇";
    let fields: string[] = [];
    if (this.result) {
      marker = this.isError ? "✗" : "✓";
      fields = this.isError
        ? failureFields(this.name, this.args, this.result)
        : successFields(this.name, this.args, this.result);
      const duration = formatDuration(this.activity.duration(this.toolCallId));
      if (duration) fields.push(duration);
    } else if (this.executionStarted) {
      marker = WORKING_FRAMES[this.activity.frame % WORKING_FRAMES.length] ?? "◇";
      fields = this.name === "bash"
        ? [meaningfulCommand(this.args.command) || "command"]
        : [pathValue(this.args)];
    } else {
      fields = this.name === "bash"
        ? [meaningfulCommand(this.args.command) || "queued"]
        : [pathValue(this.args)];
    }
    return [rowLine(theme, marker, this.name, fields, width)];
  }

  invalidate(): void {}
}

function wrappedRows(text: string, width: number, theme: Theme, color: "toolOutput" | "error", tail?: number): string[] {
  const safeWidth = Math.max(1, width);
  const styled = safeMultiline(text)
    .split("\n")
    .map((line) => theme.fg(color, line || " "))
    .join("\n");
  const rows = wrapTextWithAnsi(styled, safeWidth).map((line) => truncateToWidth(line, safeWidth, ""));
  if (tail === undefined) return rows;
  return rows.filter((line) => stripTerminalSequences(line).trim()).slice(-tail);
}

class PrimeToolDetail implements Component {
  constructor(
    private readonly name: BuiltinName,
    private readonly args: Record<string, unknown>,
    private readonly result: ToolResult | undefined,
    private readonly options: ToolRenderResultOptions,
    private readonly isError: boolean,
    private readonly executionStarted: boolean,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    if (width <= 0) return [];
    const output = textOutput(this.result);
    if (this.options.expanded) {
      let detail = output;
      if (this.name === "write") detail = typeof this.args.content === "string" ? this.args.content : output;
      if (this.name === "edit") detail = String((this.result?.details as { diff?: unknown } | undefined)?.diff ?? output);
      if (this.name === "read" || this.name === "write") {
        const path = pathValue(this.args);
        const language = getLanguageFromPath(path);
        if (language && detail) {
          const highlighted = highlightCode(safeMultiline(detail), language, this.theme);
          return highlighted.flatMap((line) => wrappedRows(line, width, this.theme, "toolOutput"));
        }
      }
      return detail ? ["", ...wrappedRows(detail, width, this.theme, this.isError ? "error" : "toolOutput")] : [];
    }
    if (this.isError && output) {
      return ["", ...wrappedRows(output, width, this.theme, "error", LIVE_TAIL_ROWS)];
    }
    if (this.name === "bash" && this.executionStarted && this.options.isPartial && output) {
      return ["", ...wrappedRows(output, width, this.theme, "toolOutput", LIVE_TAIL_ROWS)];
    }
    if (this.name === "edit" && this.executionStarted && !this.result) {
      const edits = Array.isArray(this.args.edits) ? this.args.edits : [];
      const preview = edits.flatMap((edit) => {
        const record = edit as { oldText?: unknown; newText?: unknown };
        return [
          ...safeMultiline(record.oldText).split("\n").map((line) => `-${line}`),
          ...safeMultiline(record.newText).split("\n").map((line) => `+${line}`),
        ];
      }).join("\n");
      return preview ? ["", ...wrappedRows(preview, width, this.theme, "toolOutput", 8)] : [];
    }
    return [];
  }

  invalidate(): void {}
}

export class ActivityController {
  frame = 0;
  private interval?: ReturnType<typeof setInterval>;
  private agentStartedAt?: number;
  private phase = "Working";
  private activeTools = 0;
  private readonly timings = new Map<string, { startedAt: number; endedAt?: number }>();
  private readonly invalidators = new Map<string, () => void>();
  private ctx?: ExtensionContext;

  startAgent(ctx: ExtensionContext): void {
    this.stopTimer();
    this.ctx = ctx;
    this.agentStartedAt = Date.now();
    this.phase = "Working";
    this.frame = 0;
    this.updateWorking();
    this.interval = setInterval(() => {
      this.frame = (this.frame + 1) % WORKING_FRAMES.length;
      this.updateWorking();
      for (const invalidate of this.invalidators.values()) invalidate();
    }, WORKING_INTERVAL_MS);
    this.interval.unref?.();
  }

  observeMessage(event: { type?: unknown }): void {
    const type = typeof event.type === "string" ? event.type : "";
    if (type.includes("thinking")) this.phase = "Thinking";
    else if (type.includes("text")) this.phase = "Writing";
  }

  startTool(id: string, invalidate?: () => void): void {
    this.timings.set(id, { startedAt: Date.now() });
    if (invalidate) this.invalidators.set(id, invalidate);
    this.activeTools += 1;
    this.phase = "Executing";
    this.updateWorking();
  }

  attach(id: string, invalidate: () => void): void {
    this.invalidators.set(id, invalidate);
    if (!this.timings.has(id)) this.timings.set(id, { startedAt: Date.now() });
  }

  endTool(id: string): void {
    const timing = this.timings.get(id);
    if (timing && timing.endedAt === undefined) timing.endedAt = Date.now();
    this.invalidators.delete(id);
    this.activeTools = Math.max(0, this.activeTools - 1);
    this.phase = this.activeTools > 0 ? "Executing" : "Waiting";
    this.updateWorking();
  }

  duration(id: string): number | undefined {
    const timing = this.timings.get(id);
    if (!timing) return undefined;
    return (timing.endedAt ?? Date.now()) - timing.startedAt;
  }

  settle(): void {
    this.stopTimer();
    this.invalidators.clear();
    this.activeTools = 0;
    this.ctx?.ui.setWorkingMessage();
    this.agentStartedAt = undefined;
  }

  dispose(): void {
    this.settle();
    this.timings.clear();
    this.ctx = undefined;
  }

  private updateWorking(): void {
    if (!this.ctx || this.agentStartedAt === undefined) return;
    const seconds = Math.floor((Date.now() - this.agentStartedAt) / 1000);
    this.ctx.ui.setWorkingMessage(`${this.phase} · ${seconds}s`);
  }

  private stopTimer(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }
}

function getRow(state: PrimeRowState, name: BuiltinName, context: ToolRenderContext, activity: ActivityController): PrimeToolRow {
  state.row ??= new PrimeToolRow(name, context.toolCallId, activity);
  if (context.executionStarted && !state.result) activity.attach(context.toolCallId, context.invalidate);
  return state.row;
}

export function decorateBuiltin(
  name: BuiltinName,
  definition: ToolDefinition,
  activity: ActivityController,
): ToolDefinition {
  return {
    ...definition,
    renderShell: "self",
    renderCall(args, theme, context) {
      const state = context.state as PrimeRowState;
      const row = getRow(state, name, context, activity);
      row.update(args as Record<string, unknown>, state.result, state.isError ?? false, context.executionStarted, theme);
      return row;
    },
    renderResult(result, options, theme, context) {
      const state = context.state as PrimeRowState;
      state.result = result as ToolResult;
      state.isError = context.isError;
      const row = getRow(state, name, context, activity);
      row.update(context.args as Record<string, unknown>, state.result, context.isError, context.executionStarted, theme);
      return new PrimeToolDetail(
        name,
        context.args as Record<string, unknown>,
        state.result,
        options,
        context.isError,
        context.executionStarted,
        theme,
      );
    },
  };
}

function builtinFactories(cwd: string): Record<BuiltinName, ToolDefinition> {
  return {
    read: createReadToolDefinition(cwd),
    write: createWriteToolDefinition(cwd),
    edit: createEditToolDefinition(cwd),
    bash: createBashToolDefinition(cwd),
    grep: createGrepToolDefinition(cwd),
    find: createFindToolDefinition(cwd),
    ls: createLsToolDefinition(cwd),
  };
}

export function eligibleBuiltins(tools: ReturnType<ExtensionAPI["getAllTools"]>): BuiltinName[] {
  return BUILTIN_TOOL_NAMES.filter((name) =>
    tools.some((tool) => tool.name === name && tool.sourceInfo.source === "builtin"),
  );
}

function fitLine(line: string, width: number): string {
  const fitted = truncateToWidth(line, width, "");
  return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
}

function withBackground(theme: AppTheme, line: string): string {
  return line.split("\x1b[0m").map((segment) => theme.bg("userMessageBg", segment)).join("\x1b[0m");
}

function isEditorBorder(line: string, width: number): boolean {
  const plain = stripTerminalSequences(line);
  const compact = plain.replace(/ /g, "");
  return (visibleWidth(plain) >= width && /^─+$/.test(compact)) || (plain.includes("───") && /[↑↓]/.test(plain));
}

class PrimeEditor extends CustomEditor {
  constructor(
    tui: TUI,
    editorTheme: EditorTheme,
    keybindings: Keybindings,
    private readonly getAppTheme: () => AppTheme,
    private readonly placeholder: string,
  ) {
    super(tui, editorTheme, keybindings, { paddingX: EDITOR_BASE_PADDING });
  }

  override setPaddingX(_padding: number): void {
    super.setPaddingX(EDITOR_BASE_PADDING);
  }

  override render(width: number): string[] {
    const raw = super.render(width);
    if (width < EDITOR_SURFACE_PADDING * 2 + PROMPT_PREFIX_WIDTH + 2 || raw.length < 3) return raw;
    const bottom = raw.findIndex((line, index) => index > 0 && isEditorBorder(line, width));
    if (bottom < 0) return raw;
    const theme = this.getAppTheme();
    const contentWidth = Math.max(1, width - EDITOR_SURFACE_PADDING * 2);
    const inputWidth = Math.max(1, contentWidth - PROMPT_PREFIX_WIDTH);
    const output = [withBackground(theme, " ".repeat(width))];
    raw.slice(1, bottom).forEach((line, index) => {
      const body = index === 0 && this.getText().length === 0
        ? this.renderPlaceholder(inputWidth)
        : sliceByColumn(line, EDITOR_BASE_PADDING, inputWidth);
      const prefix = index === 0 ? " >  " : " ".repeat(EDITOR_SURFACE_PADDING + PROMPT_PREFIX_WIDTH);
      output.push(withBackground(theme, fitLine(`${prefix}${body}${" ".repeat(EDITOR_SURFACE_PADDING)}`, width)));
    });
    output.push(withBackground(theme, " ".repeat(width)));
    for (const line of raw.slice(bottom + 1)) output.push(fitLine(line, width));
    return output;
  }

  private renderPlaceholder(width: number): string {
    const placeholder = truncateToWidth(this.placeholder, Math.max(0, width - 1), "");
    const cursor = `${this.focused ? CURSOR_MARKER : ""}\x1b[7m \x1b[27m`;
    const styled = cursor + this.getAppTheme().fg("dim", placeholder);
    return styled + " ".repeat(Math.max(0, width - visibleWidth(styled)));
  }
}

function formatCwd(cwd: string): string {
  const home = resolve(homedir());
  const resolved = resolve(cwd);
  const relativeToHome = relative(home, resolved);
  const inside = relativeToHome === "" || (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
  if (!inside) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return count < 10_000 ? `${(count / 1000).toFixed(1)}k` : `${Math.round(count / 1000)}k`;
  return count < 10_000_000 ? `${(count / 1_000_000).toFixed(1)}M` : `${Math.round(count / 1_000_000)}M`;
}

function sessionCost(ctx: ExtensionContext): number {
  let total = 0;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) {
      total += entry.message.usage?.cost.total ?? 0;
    } else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
      total += entry.usage.cost.total;
    }
  }
  return total;
}

function subscription(provider: string | undefined): boolean {
  return provider === "openai-codex" || provider === "github-copilot" || provider === "kimi-coding";
}

export function fitFooterFields(fields: string[], width: number, theme: Theme): string {
  if (width <= 0) return "";
  const separator = theme.fg("dim", " · ");
  let line = "";
  for (const field of fields.filter(Boolean)) {
    const clean = sanitizeInline(field);
    const available = width - visibleWidth(line) - (line ? 3 : 0);
    if (available <= 0) break;
    const fitted = truncateToWidth(theme.fg("muted", clean), available, "…");
    if (!fitted) break;
    line += (line ? separator : "") + fitted;
    if (visibleWidth(fitted) < visibleWidth(clean)) break;
  }
  return truncateToWidth(line, width, "");
}

class PrimeFooter implements Component {
  private unsubscribe?: () => void;
  constructor(
    private readonly pi: ExtensionAPI,
    private readonly ctx: ExtensionContext,
    private readonly theme: Theme,
    private readonly data: ReadonlyFooterDataProvider,
    requestRender: () => void,
  ) {
    this.unsubscribe = data.onBranchChange(requestRender);
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const cwd = formatCwd(this.ctx.sessionManager.getCwd());
    const branch = this.data.getGitBranch();
    const first = fitFooterFields([cwd, branch ? `⎇ ${branch}` : ""], width, this.theme);
    const model = this.ctx.model;
    const usage = this.ctx.getContextUsage();
    const contextWindow = usage?.contextWindow ?? model?.contextWindow ?? 0;
    const contextPercent = usage?.percent === null || usage?.percent === undefined ? "?" : `${usage.percent.toFixed(1)}%`;
    const statuses = [...this.data.getExtensionStatuses().entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, value]) => sanitizeInline(value));
    const cost = `$${sessionCost(this.ctx).toFixed(3)}${subscription(model?.provider) ? " (sub)" : ""}`;
    const second = fitFooterFields(
      [model?.id ?? "no-model", this.pi.getThinkingLevel(), ...statuses, cost, `${formatTokens(contextWindow)} (${contextPercent})`],
      width,
      this.theme,
    );
    return [first, second];
  }

  invalidate(): void {}
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}

export default function primeStyle(pi: ExtensionAPI): void {
  const activity = new ActivityController();
  let requestRender: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    if (ctx.ui.getTheme("prime")) ctx.ui.setTheme("prime");
    ctx.ui.setWorkingIndicator({
      frames: WORKING_FRAMES.map((frame, index) =>
        ctx.ui.theme.fg(index === 2 ? "accent" : index === 0 ? "dim" : "muted", frame),
      ),
      intervalMs: WORKING_INTERVAL_MS,
    });
    const placeholder = START_HINTS[Math.floor(Math.random() * START_HINTS.length)] ?? START_HINTS[0];
    ctx.ui.setEditorComponent((tui, editorTheme, keybindings) =>
      new PrimeEditor(tui, editorTheme, keybindings, () => ctx.ui.theme, placeholder),
    );
    ctx.ui.setFooter((tui, theme, footerData) => {
      requestRender = () => tui.requestRender();
      return new PrimeFooter(pi, ctx, theme, footerData, requestRender);
    });

    const activeTools = pi.getActiveTools();
    const eligible = eligibleBuiltins(pi.getAllTools());
    const definitions = builtinFactories(ctx.cwd);
    for (const name of eligible) pi.registerTool(decorateBuiltin(name, definitions[name], activity));
    pi.setActiveTools(activeTools);
  });

  pi.on("agent_start", (_event, ctx) => activity.startAgent(ctx));
  pi.on("message_update", (event) => activity.observeMessage(event.assistantMessageEvent as { type?: unknown }));
  pi.on("tool_execution_start", (event) => activity.startTool(event.toolCallId));
  pi.on("tool_execution_end", (event) => activity.endTool(event.toolCallId));
  pi.on("agent_settled", () => activity.settle());

  const refresh = () => requestRender?.();
  pi.on("model_select", refresh);
  pi.on("thinking_level_select", refresh);
  pi.on("message_end", refresh);
  pi.on("session_compact", refresh);
  pi.on("session_info_changed", refresh);

  pi.on("session_shutdown", (_event, ctx) => {
    activity.dispose();
    requestRender = undefined;
    ctx.ui.setFooter(undefined);
    ctx.ui.setEditorComponent(undefined);
    ctx.ui.setWorkingMessage();
    ctx.ui.setWorkingIndicator();
  });
}
