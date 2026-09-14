import {
  Container,
  Markdown,
  Spacer,
  Text,
  type Component,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import {
  sanitizeMetadata,
  sanitizeOutput,
  sanitizeRenderedOutput,
} from "../lib/terminal-safety.ts";

class SafeCompletionContainer extends Container {
  override render(width: number): string[] {
    return super.render(width).map(sanitizeRenderedOutput);
  }
}

export interface CompletionRenderMessage {
  content: unknown;
  details?: unknown;
}

export interface CompletionRenderOptions {
  expanded: boolean;
  outputPad: number;
}

export interface CompletionRenderTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

interface CompletionDetails {
  structured: boolean;
  semanticName?: string;
  role?: string;
  state?: string;
  result?: string;
  error?: string;
  recoveryError?: string;
}

function completionDetails(details: unknown): CompletionDetails | undefined {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
  const value = details as Record<string, unknown>;
  return {
    structured:
      value.completionDataVersion === 1 ||
      typeof value.result === "string" ||
      typeof value.error === "string" ||
      typeof value.recoveryError === "string",
    semanticName: typeof value.semanticName === "string" ? value.semanticName : undefined,
    role: typeof value.role === "string" ? value.role : undefined,
    state: typeof value.state === "string" ? value.state : undefined,
    result: typeof value.result === "string" ? value.result : undefined,
    error: typeof value.error === "string" ? value.error : undefined,
    recoveryError: typeof value.recoveryError === "string" ? value.recoveryError : undefined,
  };
}

export function completionOutput(content: string): string {
  const separator = content.indexOf("\n\n");
  return content.startsWith("Subagent ") && separator >= 0 ? content.slice(separator + 2) : content;
}

export function renderCompletionMessage(
  message: CompletionRenderMessage,
  options: CompletionRenderOptions,
  theme: CompletionRenderTheme,
  markdownTheme: MarkdownTheme,
  expandKey = "Ctrl+O",
): Component {
  const details = completionDetails(message.details);
  const label = sanitizeMetadata(details?.semanticName ?? "subagent");
  const role = details?.role ? ` [${sanitizeMetadata(details.role)}]` : "";
  const failed = details?.state === "failed" || details?.state === "crashed";
  const content = typeof message.content === "string" ? message.content : "Subagent finished";
  const output = details?.structured ? details.result : completionOutput(content);
  const error = details?.error === undefined ? undefined : sanitizeOutput(details.error);
  const recoveryError =
    details?.recoveryError === undefined ? undefined : sanitizeOutput(details.recoveryError);
  const safeOutput = sanitizeOutput(output ?? "");
  const container = new SafeCompletionContainer();

  container.addChild(
    new Text(
      `${theme.fg(failed ? "error" : "success", failed ? "✗" : "✓")} ${theme.fg("toolTitle", theme.bold(label))}${theme.fg("muted", role)}`,
      options.outputPad,
      0,
    ),
  );
  if (!options.expanded) {
    const lines = safeOutput ? safeOutput.split(/\r?\n/) : [];
    const preview = lines.find((line) => line.trim())?.trim() || "(no output)";
    const lineCount = lines.length || 1;
    const suffix = lineCount === 1 ? "" : ` · ${lineCount} lines`;

    container.addChild(new Text(theme.fg("dim", `  ⎿  ${preview}${suffix}`), options.outputPad, 0));
    if (error) {
      container.addChild(new Text(theme.fg("error", `  Failure: ${error}`), options.outputPad, 0));
    }
    if (recoveryError) {
      container.addChild(
        new Text(theme.fg("warning", `  Recovery: ${recoveryError}`), options.outputPad, 0),
      );
    }
    if (lineCount > 1) {
      container.addChild(
        new Text(
          theme.fg("accent", `  Press ${expandKey || "Ctrl+O"} for full output`),
          options.outputPad,
          0,
        ),
      );
    }
    return container;
  }

  container.addChild(new Spacer(1));
  container.addChild(
    new Markdown(safeOutput || "(no output)", options.outputPad, 0, markdownTheme, {
      color: (text: string) => theme.fg("toolOutput", text),
    }),
  );
  if (error) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("error", `Failure: ${error}`), options.outputPad, 0));
  }
  if (recoveryError) {
    container.addChild(new Spacer(1));
    container.addChild(
      new Text(theme.fg("warning", `Recovery: ${recoveryError}`), options.outputPad, 0),
    );
  }
  return container;
}
