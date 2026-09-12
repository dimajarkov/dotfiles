import { Text } from "@earendil-works/pi-tui";
import { sanitizeMetadata, sanitizeOutput, sanitizeRenderedOutput } from "./output-content.ts";

export interface SubagentToolRenderTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

class SafeToolText extends Text {
  override render(width: number): string[] {
    return super.render(width).map(sanitizeRenderedOutput);
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

export function renderSubagentToolCall(args: unknown, theme: SubagentToolRenderTheme): Text {
  const params = record(args);
  const action = sanitizeMetadata(params.action) || "…";
  const name = sanitizeMetadata(params.name);
  const agent = sanitizeMetadata(params.agent);
  const target = name ? ` ${name}` : "";
  const role = agent ? ` [${agent}]` : "";
  return new SafeToolText(
    `${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", action)}${theme.fg("muted", `${target}${role}`)}`,
    0,
    0,
  );
}

export function renderSubagentToolResult(result: unknown, theme: SubagentToolRenderTheme): Text {
  const value = record(result);
  const content = Array.isArray(value.content) ? value.content : [];
  const first = record(content[0]);
  const text = first.type === "text" && typeof first.text === "string" ? first.text : "";
  return new SafeToolText(theme.fg("toolOutput", sanitizeOutput(text)), 0, 0);
}
