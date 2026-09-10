import {
  Container,
  Markdown,
  Spacer,
  Text,
  type Component,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";

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
  semanticName?: string;
  role?: string;
  state?: string;
}

function completionDetails(details: unknown): CompletionDetails | undefined {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
  return details as CompletionDetails;
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
  const label = details?.semanticName ?? "subagent";
  const role = details?.role ? ` [${details.role}]` : "";
  const failed = details?.state === "failed" || details?.state === "crashed";
  const content = typeof message.content === "string" ? message.content : "Subagent finished";
  const output = completionOutput(content);
  const container = new Container();

  container.addChild(
    new Text(
      `${theme.fg(failed ? "error" : "success", failed ? "✗" : "✓")} ${theme.fg("toolTitle", theme.bold(label))}${theme.fg("muted", role)}`,
      options.outputPad,
      0,
    ),
  );
  if (!options.expanded) {
    const lines = output ? output.split(/\r?\n/) : [];
    const preview = lines.find((line) => line.trim())?.trim() || "(no output)";
    const lineCount = lines.length || 1;
    const suffix = lineCount === 1 ? "" : ` · ${lineCount} lines`;

    container.addChild(new Text(theme.fg("dim", `  ⎿  ${preview}${suffix}`), options.outputPad, 0));
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
    new Markdown(output || "(no output)", options.outputPad, 0, markdownTheme, {
      color: (text: string) => theme.fg("toolOutput", text),
    }),
  );
  return container;
}
