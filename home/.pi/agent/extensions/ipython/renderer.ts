import {
  generateDiffString,
  highlightCode,
  keyHint,
  renderDiff,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Component,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { previewIpythonCode } from "./code-preview.js";
import { parseIpythonBashCell } from "./ipython-cell-code.js";

export interface IpythonErrorDetails {
  ename: string;
  evalue: string;
  traceback: string[];
}

export interface IpythonToolDetails {
  durationMs?: number;
  status?: "ok" | "error" | "aborted" | "starting";
  outputLines?: number;
  /** Chronologically ordered stdout, stderr, display data, result, and traceback. */
  output?: string;
  stdout?: string;
  stderr?: string;
  display?: string;
  result?: string;
  outputFile?: string;
  truncationNotice?: string;
  kernelRestarted?: boolean;
  restoredNames?: string[];
  restoreFailures?: Array<{ name: string; reason: string }>;
  error?: IpythonErrorDetails;
  diffs?: Array<{ path: string; oldStr: string; newStr: string; startLine?: number }>;
  attachments?: Array<{ mimeType: string; path?: string; bytes: number }>;
}

export interface IpythonToolArgs {
  code: string;
}

const OUTPUT_INDENT = "  ";
const SGR_PATTERN = /\x1b\[([0-9;]*)m/g;

function closeOpenSgr(line: string): string {
  let foregroundOpen = false;
  let backgroundOpen = false;
  for (const match of line.matchAll(SGR_PATTERN)) {
    const params = match[1] === "" ? ["0"] : (match[1]?.split(";") ?? []);
    for (let index = 0; index < params.length; index++) {
      const code = Number(params[index]);
      if (code === 0) {
        foregroundOpen = false;
        backgroundOpen = false;
      } else if (code === 38 || code === 48) {
        if (code === 38) foregroundOpen = true;
        else backgroundOpen = true;
        const mode = Number(params[index + 1]);
        index += mode === 2 ? 4 : mode === 5 ? 2 : 1;
      } else if (code === 39) {
        foregroundOpen = false;
      } else if (code === 49) {
        backgroundOpen = false;
      } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
        foregroundOpen = true;
      } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
        backgroundOpen = true;
      }
    }
  }
  return foregroundOpen || backgroundOpen ? `${line}\x1b[0m` : line;
}

function formatDuration(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined) return undefined;
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function nonEmptyLineCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\r?\n/).length;
}

function outputText(details: IpythonToolDetails): string {
  const diffs = details.diffs ?? [];
  const isEditConfirmation = (value: string | undefined): boolean => {
    if (!value?.trim() || diffs.length === 0) return false;
    const stripped = value.trim();
    return diffs.some((diff) => stripped === `Edited ${diff.path}`);
  };
  if (details.output !== undefined) return isEditConfirmation(details.output) ? "" : details.output;
  return [details.stdout, details.stderr, details.display, details.result]
    .filter((value): value is string => typeof value === "string" && value.length > 0 && !isEditConfirmation(value))
    .join("\n");
}

function languageFor(code: string): "bash" | "python" | "bash · python" {
  const bash = parseIpythonBashCell(code.trimEnd());
  if (!bash) return "python";
  return previewIpythonCode(code).language === "python" ? "bash · python" : "bash";
}

function marker(details: IpythonToolDetails, running: boolean, theme: Theme): string {
  if (running || details.status === "starting") return theme.fg("bashMode", "◆");
  if (details.status === "error") return theme.fg("error", "✗");
  if (details.status === "aborted") return theme.fg("warning", "✗");
  return theme.fg("success", "✓");
}

function highlightedPreview(code: string, theme: Theme): string {
  const preview = previewIpythonCode(code);
  if (!preview.text) return theme.fg("muted", "waiting for code");
  const highlighted = highlightCode(preview.text, preview.language)[0];
  return highlighted ?? theme.fg(preview.language === "bash" ? "bashMode" : "mdCodeBlock", preview.text);
}

export class IpythonRendererTracker {
  private latestToolCallId?: string;
  private readonly invalidators = new Map<string, () => void>();

  activate(toolCallId: string): void {
    if (this.latestToolCallId === toolCallId) return;
    this.latestToolCallId = toolCallId;
    for (const invalidate of this.invalidators.values()) invalidate();
  }

  register(toolCallId: string, invalidate: () => void): void {
    this.invalidators.set(toolCallId, invalidate);
  }

  isLatest(toolCallId: string): boolean {
    return this.latestToolCallId === toolCallId;
  }

  clear(): void {
    this.latestToolCallId = undefined;
    this.invalidators.clear();
  }
}

interface CellState {
  code: string;
  details: IpythonToolDetails;
  expanded: boolean;
  running: boolean;
  toolCallId: string;
  tracker: IpythonRendererTracker;
  theme: Theme;
}

export class IpythonCellComponent implements Component {
  private state: CellState;

  constructor(state: CellState) {
    this.state = state;
  }

  update(state: CellState): void {
    this.state = state;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const lines = [truncateToWidth(` ${this.summary()}`, safeWidth, "")];
    if (!this.state.expanded) return lines;
    this.renderCode(lines, safeWidth);
    this.renderOutput(lines, safeWidth);
    return lines.map((line) => truncateToWidth(line, safeWidth, ""));
  }

  private summary(): string {
    const { code, details, running, theme } = this.state;
    const language = languageFor(code);
    const parts = [
      `${marker(details, running, theme)} ${theme.fg("muted", language)}`,
      highlightedPreview(code, theme),
    ];

    const bash = parseIpythonBashCell(code);
    const inputCount = (bash?.body ?? code)
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0).length;
    const outputCount = details.outputLines ?? nonEmptyLineCount(outputText(details));
    const counts: string[] = [];
    if (inputCount > 0) counts.push(`↑ ${inputCount}`);
    if (outputCount > 0) counts.push(`↓ ${outputCount}`);
    if (counts.length > 0) parts.push(theme.fg("muted", `${counts.join(" ")} lines`));
    const attachmentCount = details.attachments?.length ?? 0;
    if (attachmentCount > 0) {
      parts.push(theme.fg("muted", `${attachmentCount} image${attachmentCount === 1 ? "" : "s"}`));
    }

    const duration = formatDuration(details.durationMs);
    if (duration) parts.push(theme.fg("muted", duration));
    if (details.error?.ename) parts.push(theme.fg("error", details.error.ename));
    if (running) parts.push(theme.fg("muted", "running"));
    if (this.state.tracker.isLatest(this.state.toolCallId)) {
      parts.push(keyHint("app.tools.expand", this.state.expanded ? "to collapse" : "to expand"));
    }
    return parts.join(theme.fg("dim", " · "));
  }

  private renderCode(lines: string[], width: number): void {
    lines.push("");
    const code = this.state.code.trimEnd();
    if (!code) {
      this.addWrapped(lines, OUTPUT_INDENT, this.state.theme.fg("muted", "waiting for code"), width);
      return;
    }
    const language = parseIpythonBashCell(code) ? "bash" : "python";
    const highlighted = highlightCode(code, language);
    const rawLines = code.split("\n");
    for (let index = 0; index < rawLines.length; index++) {
      const prefix = this.state.theme.fg("dim", index === 0 ? "› " : "  ");
      const text = highlighted[index] ?? this.state.theme.fg(language === "bash" ? "bashMode" : "mdCodeBlock", rawLines[index] ?? "");
      this.addWrapped(lines, prefix, text || " ", width);
    }
  }

  private renderOutput(lines: string[], width: number): void {
    const { details, theme } = this.state;
    const hasOutput = Boolean(
      outputText(details).trim() || details.error || details.truncationNotice || details.diffs?.length || details.attachments?.length,
    );
    lines.push("");
    if (!hasOutput) {
      this.addWrapped(lines, OUTPUT_INDENT, theme.fg("muted", "no output"), width);
      return;
    }
    if (details.output !== undefined) {
      if (details.output) this.renderText(lines, details.output, "toolOutput", width);
    } else {
      if (details.stdout) this.renderText(lines, details.stdout, "toolOutput", width);
      if (details.stderr) this.renderText(lines, details.stderr, "muted", width);
      if (details.display) this.renderText(lines, details.display, "toolOutput", width);
      if (details.result) this.renderText(lines, details.result, "toolOutput", width);
      if (details.error) {
        const traceback = details.error.traceback.length > 0
          ? details.error.traceback.join("\n")
          : `${details.error.ename}: ${details.error.evalue}`;
        this.renderText(lines, traceback, "muted", width);
      }
    }
    if (details.diffs?.length) this.renderDiffs(lines, details.diffs, width);
    if (details.attachments?.length) this.renderAttachments(lines, details.attachments, width);
    if (details.truncationNotice) this.renderText(lines, details.truncationNotice, "warning", width);
  }

  private renderDiffs(
    lines: string[],
    diffs: NonNullable<IpythonToolDetails["diffs"]>,
    width: number,
  ): void {
    for (const diff of diffs) {
      const prefix = "\n".repeat(Math.max(0, (diff.startLine ?? 1) - 1));
      const generated = generateDiffString(`${prefix}${diff.oldStr}`, `${prefix}${diff.newStr}`, 4);
      const rendered = renderDiff(generated.diff, { filePath: diff.path });
      this.renderText(lines, `${diff.path}${diff.startLine ? `:${diff.startLine}` : ""}\n${rendered}`, "toolOutput", width);
    }
  }

  private renderAttachments(
    lines: string[],
    attachments: NonNullable<IpythonToolDetails["attachments"]>,
    width: number,
  ): void {
    for (const attachment of attachments) {
      const size = attachment.bytes < 1024
        ? `${attachment.bytes} B`
        : `${(attachment.bytes / 1024).toFixed(1)} KB`;
      const path = attachment.path ?? "notebook image";
      this.renderText(lines, `image ${path} · ${attachment.mimeType} · ${size}`, "muted", width);
    }
  }

  private renderText(
    lines: string[],
    text: string,
    color: "toolOutput" | "muted" | "warning",
    width: number,
  ): void {
    for (const line of text.split("\n")) {
      this.addWrapped(lines, OUTPUT_INDENT, this.state.theme.fg(color, line || " "), width);
    }
  }

  private addWrapped(lines: string[], prefix: string, text: string, width: number): void {
    const available = Math.max(1, width - 1 - visibleWidth(prefix));
    const wrapped = wrapTextWithAnsi(text, available);
    for (const [index, line] of (wrapped.length > 0 ? wrapped : [""]).entries()) {
      const linePrefix = index === 0 ? prefix : " ".repeat(visibleWidth(prefix));
      lines.push(truncateToWidth(` ${linePrefix}${closeOpenSgr(line)}`, width, ""));
    }
  }
}

function emptyComponent(): Component {
  return new Container();
}

interface IpythonRenderContext {
  args: IpythonToolArgs;
  toolCallId: string;
  invalidate: () => void;
  lastComponent: Component | undefined;
  executionStarted: boolean;
  isPartial: boolean;
  expanded: boolean;
  isError: boolean;
}

function updateCell(
  context: IpythonRenderContext,
  state: CellState,
): Component {
  const existing = context.lastComponent;
  if (existing instanceof IpythonCellComponent) {
    existing.update(state);
    return existing;
  }
  return new IpythonCellComponent(state);
}

export function renderIpythonCall(
  args: IpythonToolArgs,
  theme: Theme,
  context: IpythonRenderContext,
  tracker: IpythonRendererTracker,
): Component {
  tracker.register(context.toolCallId, context.invalidate);
  if (!context.isPartial) return emptyComponent();
  return updateCell(context, {
    code: args.code ?? "",
    details: { status: context.executionStarted ? "ok" : "starting" },
    expanded: context.expanded,
    running: context.executionStarted,
    toolCallId: context.toolCallId,
    tracker,
    theme,
  });
}

export function renderIpythonResult(
  result: { details?: unknown; content?: Array<{ type?: string; text?: string }> },
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  context: IpythonRenderContext,
  tracker: IpythonRendererTracker,
): Component {
  tracker.register(context.toolCallId, context.invalidate);
  if (options.isPartial) return emptyComponent();
  const details = { ...((result.details as IpythonToolDetails | undefined) ?? {}) };
  if (context.isError) {
    details.status = "error";
    if (!details.stdout && !details.stderr && !details.display && !details.result) {
      details.stderr = result.content
        ?.filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text ?? "")
        .join("\n") || "IPython tool execution failed";
    }
  }
  return updateCell(context, {
    code: context.args.code ?? "",
    details,
    expanded: options.expanded,
    running: false,
    toolCallId: context.toolCallId,
    tracker,
    theme,
  });
}
