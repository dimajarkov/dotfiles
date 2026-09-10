import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ChildRecord } from "./orchestrator.ts";

type WidgetChild = Pick<ChildRecord, "semanticName" | "role" | "state">;
type WidgetTheme = Pick<ExtensionContext["ui"]["theme"], "fg" | "bold">;
const MAX_VISIBLE_AGENTS = 5;

function singleLine(value: string): string {
  return stripTerminalSequences(value).replace(/\s+/gu, " ").trim();
}

/** Active children only. Keep operational metadata in /subagents, not the panel. */
export function renderSubagentWidget(
  children: readonly WidgetChild[],
  width: number,
  theme: WidgetTheme,
): string[] {
  if (width <= 0 || children.length === 0) return [];
  const border = (text: string) => theme.fg("borderMuted", text);
  // Below this width a frame consumes too much of the usable name/state space.
  if (width < 4)
    return [truncateToWidth(theme.fg("accent", `Subagents (${children.length})`), width, "")];

  const innerWidth = width - 2;
  const title = truncateToWidth(
    border("─ ") + theme.fg("accent", theme.bold("Subagents")) + " ",
    innerWidth,
    "",
  );
  const count = theme.fg("dim", ` ${children.length} active `) + border("─");
  const header =
    visibleWidth(title) + visibleWidth(count) <= innerWidth
      ? title + border("─".repeat(innerWidth - visibleWidth(title) - visibleWidth(count))) + count
      : title + border("─".repeat(innerWidth - visibleWidth(title)));
  const lines = [border("╭") + header + border("╮")];
  // Never bury a child waiting for attention behind the row limit.
  const ordered = [...children].sort(
    (left, right) => Number(right.state === "blocked") - Number(left.state === "blocked"),
  );

  for (const child of ordered.slice(0, MAX_VISIBLE_AGENTS)) {
    const color =
      child.state === "blocked" ? "warning" : child.state === "starting" ? "muted" : "accent";
    const symbol = child.state === "blocked" ? "!" : child.state === "starting" ? "○" : "●";
    const status = theme.fg(color, `${symbol} ${child.state}`);
    const name = theme.fg("text", theme.bold(singleLine(child.semanticName)));
    const role = theme.fg("dim", ` (${singleLine(child.role)})`);
    const contentWidth = Math.max(0, innerWidth - 2);
    // Reserve the state first so a long name cannot hide a blocked child.
    const nameWidth = contentWidth - visibleWidth(status) - 2;
    let content: string;
    if (nameWidth >= 4) {
      const left = truncateToWidth(name + role, nameWidth, "…");
      content =
        left + " ".repeat(contentWidth - visibleWidth(left) - visibleWidth(status)) + status;
    } else {
      content = truncateToWidth(status, contentWidth, "");
    }
    const padded = truncateToWidth(` ${content} `, innerWidth, "");
    lines.push(border("│") + padded + " ".repeat(innerWidth - visibleWidth(padded)) + border("│"));
  }

  if (children.length > MAX_VISIBLE_AGENTS) {
    const overflow = truncateToWidth(
      ` +${children.length - MAX_VISIBLE_AGENTS} more · /subagents`,
      innerWidth,
      "…",
    );
    lines.push(
      border("│") +
        theme.fg("dim", overflow) +
        " ".repeat(innerWidth - visibleWidth(overflow)) +
        border("│"),
    );
  }
  lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
  return lines;
}
