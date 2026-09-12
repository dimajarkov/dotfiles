import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ChildRecord } from "./orchestrator.ts";

/** A child together with its rendered position in the subagent tree. */
export interface TreeRow {
  readonly child: ChildRecord;
  /** The complete branch prefix, including indentation for ancestor branches. */
  readonly prefix: string;
  readonly depth: number;
  /** Slash-separated IDs from the requested parent through this row. */
  readonly path: string;
  /** Readable semantic-name ancestry for inspection views. */
  readonly displayPath: string;
}

type WidgetTheme = Pick<ExtensionContext["ui"]["theme"], "fg" | "bold">;

const MAX_VISIBLE_AGENTS = 5;
const OUTPUT_LABEL = "[output]";
const ACTIVE_STATES = new Set<ChildRecord["state"]>(["starting", "working", "blocked"]);

type TreeCandidate = {
  child: ChildRecord;
  path: string[];
  displayPath: string[];
  depth: number;
  children: TreeCandidate[];
  include: boolean;
  containsActive: boolean;
  containsBlocked: boolean;
  newestUpdate: number;
};

function isActive(child: ChildRecord): boolean {
  return ACTIVE_STATES.has(child.state);
}

function replaceControlCharacters(value: string): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
    })
    .join("");
}

function singleLine(value: string): string {
  return replaceControlCharacters(stripTerminalSequences(value)).replace(/\s+/gu, " ").trim();
}

function safePrefix(value: string): string {
  return replaceControlCharacters(stripTerminalSequences(value));
}

/**
 * Build the reachable subagent tree rooted at `parentId`.
 *
 * Active-only mode can retain completed ancestors as context when they lead to
 * an active descendant. The widget uses the default full-history mode, with
 * active and blocked subtrees ahead of completed history. Orphaned records and
 * cycles disconnected from `parentId` are never traversed.
 */
export function buildSubagentTree(
  children: readonly ChildRecord[],
  parentId: string,
  options?: { activeOnly?: boolean },
): TreeRow[] {
  const activeOnly = options?.activeOnly ?? false;
  const recordsById = new Map<string, ChildRecord>();
  for (const child of children) {
    // A duplicate ID cannot be selected unambiguously. Keep the first registry
    // record and ignore later malformed duplicates deterministically.
    if (!recordsById.has(child.id)) recordsById.set(child.id, child);
  }

  const childrenByParent = new Map<string, ChildRecord[]>();
  for (const child of recordsById.values()) {
    const siblings = childrenByParent.get(child.parentId);
    if (siblings) siblings.push(child);
    else childrenByParent.set(child.parentId, [child]);
  }

  function evaluateChildren(
    currentParentId: string,
    path: string[],
    displayPath: string[],
    lineage: ReadonlySet<string>,
    depth: number,
  ): TreeCandidate[] {
    const candidates: TreeCandidate[] = [];
    for (const child of childrenByParent.get(currentParentId) ?? []) {
      // This protects against malformed reachable cycles, while cycles whose
      // records are not rooted at parentId are never traversed at all.
      if (lineage.has(child.id)) continue;

      const childPath = [...path, child.id];
      const childDisplayPath = [...displayPath, singleLine(child.semanticName)];
      const childLineage = new Set(lineage);
      childLineage.add(child.id);
      const descendants = evaluateChildren(
        child.id,
        childPath,
        childDisplayPath,
        childLineage,
        depth + 1,
      );
      const containsActive =
        isActive(child) || descendants.some((descendant) => descendant.containsActive);
      const containsBlocked =
        child.state === "blocked" || descendants.some((descendant) => descendant.containsBlocked);
      const newestUpdate = Math.max(
        child.updatedAt,
        ...descendants.map((descendant) => descendant.newestUpdate),
      );
      const include =
        !activeOnly || isActive(child) || descendants.some((descendant) => descendant.include);

      candidates.push({
        child,
        path: childPath,
        displayPath: childDisplayPath,
        depth,
        children: descendants,
        include,
        containsActive,
        containsBlocked,
        newestUpdate,
      });
    }

    // Stable priority order keeps every subtree together: blocked first, then
    // other active branches, then terminal history. Newer history precedes
    // older history, so the cap naturally leaves old completed rows behind the
    // /subagents view instead of hiding current work.
    return candidates
      .map((candidate, index) => ({ candidate, index }))
      .sort((left, right) => {
        const leftPriority = left.candidate.containsBlocked
          ? 2
          : left.candidate.containsActive
            ? 1
            : 0;
        const rightPriority = right.candidate.containsBlocked
          ? 2
          : right.candidate.containsActive
            ? 1
            : 0;
        return (
          rightPriority - leftPriority ||
          (leftPriority === 0 && right.candidate.newestUpdate !== left.candidate.newestUpdate
            ? right.candidate.newestUpdate - left.candidate.newestUpdate
            : left.index - right.index)
        );
      })
      .map(({ candidate }) => candidate);
  }

  const roots = evaluateChildren(parentId, [parentId], [], new Set([parentId]), 0);
  const rows: TreeRow[] = [];

  function flatten(candidates: readonly TreeCandidate[], ancestorIsLast: readonly boolean[]): void {
    const included = candidates.filter((candidate) => candidate.include);
    for (let index = 0; index < included.length; index += 1) {
      const candidate = included[index]!;
      const isLast = index === included.length - 1;
      const indentation = ancestorIsLast.map((last) => (last ? "   " : "│  ")).join("");
      const connector = isLast ? "└─ " : "├─ ";
      rows.push({
        child: candidate.child,
        prefix: indentation + connector,
        depth: candidate.depth,
        path: candidate.path.join("/"),
        displayPath: candidate.displayPath.join(" / "),
      });
      flatten(candidate.children, [...ancestorIsLast, isLast]);
    }
  }

  flatten(roots, []);
  return rows;
}

export interface SubagentWidgetRowTarget {
  readonly row: TreeRow;
  /** Line number and x coordinates are relative to the widget's top-left. */
  readonly y: number;
  /** Inclusive start of the visible `[output]` label, when rendered. */
  readonly outputStart?: number;
}

export interface SubagentWidgetLayout {
  readonly rows: readonly SubagentWidgetRowTarget[];
  readonly visibleRows: readonly TreeRow[];
  readonly hiddenRows: readonly TreeRow[];
  readonly activeCount: number;
  readonly doneCount: number;
  readonly hiddenBlockedCount: number;
  /** Relative line numbers, retained for callers that only need row lookup. */
  readonly rowLineIndexes: readonly number[];
  readonly footerLineIndex: number | undefined;
  /** Present when a theme was supplied to getSubagentWidgetLayout. */
  readonly lines?: readonly string[];
}

function pathParent(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

function selectVisibleRowIndexes(rows: readonly TreeRow[]): number[] {
  const visible: number[] = [];
  const selectedIndexes = new Set<number>();
  const selectedPaths = new Set<string>();
  const indexesByPath = new Map<string, number>();
  for (let index = 0; index < rows.length; index += 1) {
    // A duplicate path cannot be selected unambiguously. Keep the first row so
    // the bounded renderer remains deterministic for malformed input.
    if (!indexesByPath.has(rows[index]!.path)) indexesByPath.set(rows[index]!.path, index);
  }

  // Reserve space for active work and the completed ancestors needed to show
  // it in context. Without this pass, a long completed branch can consume the
  // cap before a later active sibling is reached in pre-order.
  const priorityIndexes = new Set<number>();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (!isActive(row.child)) continue;
    priorityIndexes.add(index);
    let ancestorPath = pathParent(row.path);
    while (row.depth > 0 && ancestorPath) {
      const ancestorIndex = indexesByPath.get(ancestorPath);
      if (ancestorIndex === undefined) break;
      priorityIndexes.add(ancestorIndex);
      ancestorPath = pathParent(ancestorPath);
    }
  }

  const select = (index: number): void => {
    if (selectedIndexes.size >= MAX_VISIBLE_AGENTS || selectedIndexes.has(index)) return;
    const row = rows[index]!;
    // Tree rows from buildSubagentTree are pre-order. The guard also makes the
    // renderer safe if a caller accidentally supplies a child without context.
    if (row.depth > 0 && !selectedPaths.has(pathParent(row.path))) return;
    selectedIndexes.add(index);
    selectedPaths.add(row.path);
  };

  // Keep all reachable active/blocked work ahead of terminal history, while
  // emitting selected rows in their original pre-order for genuine hierarchy.
  for (let index = 0; index < rows.length; index += 1) {
    if (priorityIndexes.has(index)) select(index);
  }
  for (let index = 0; index < rows.length; index += 1) {
    if (!priorityIndexes.has(index)) select(index);
  }
  for (let index = 0; index < rows.length; index += 1) {
    if (selectedIndexes.has(index)) visible.push(index);
  }
  return visible;
}

function statusText(state: ChildRecord["state"]): string {
  return state === "completed" ? "● done" : `${stateSymbol(state)} ${state}`;
}

function stateSymbol(state: ChildRecord["state"]): string {
  if (state === "completed" || state === "working") return "●";
  if (state === "failed" || state === "crashed") return "✗";
  if (state === "blocked") return "!";
  if (state === "cancelled") return "×";
  return "○";
}

function stateColor(state: ChildRecord["state"]): string {
  if (state === "completed") return "success";
  if (state === "blocked") return "warning";
  if (state === "working") return "accent";
  if (state === "failed" || state === "crashed") return "error";
  if (state === "starting") return "muted";
  return "dim";
}

function fitLine(text: string, width: number): string {
  if (width <= 0) return "";
  const truncated = truncateToWidth(text, width, "");
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function framedText(text: string, innerWidth: number, theme: WidgetTheme): string {
  const border = (value: string) => theme.fg("borderMuted", value);
  const content = fitLine(` ${text} `, innerWidth);
  return border("│") + content + border("│");
}

function renderFooter(innerWidth: number, theme: WidgetTheme): string {
  const border = (value: string) => theme.fg("borderMuted", value);
  const hint = theme.fg("dim", "click prompt · /subagents");
  const paddedHint = ` ${hint} `;
  const hintWidth = visibleWidth(paddedHint);
  if (hintWidth >= innerWidth) {
    return border("╰") + fitLine(hint, innerWidth) + border("╯");
  }
  const remaining = innerWidth - hintWidth;
  const before = Math.floor(remaining / 2);
  const after = remaining - before;
  return (
    border("╰") + border("─".repeat(before)) + paddedHint + border("─".repeat(after)) + border("╯")
  );
}

function renderHeader(
  activeCount: number,
  doneCount: number,
  innerWidth: number,
  theme: WidgetTheme,
): string {
  const border = (value: string) => theme.fg("borderMuted", value);
  const title = border("─ ") + theme.fg("accent", theme.bold("Subagents")) + border(" ");
  const summary =
    doneCount > 0 ? `${activeCount} active · ${doneCount} done` : `${activeCount} active`;
  const count = theme.fg("dim", ` ${summary} `) + border("─");
  const titleWidth = visibleWidth(title);
  const countWidth = visibleWidth(count);

  if (titleWidth + countWidth <= innerWidth) {
    return title + border("─".repeat(innerWidth - titleWidth - countWidth)) + count;
  }
  if (countWidth <= innerWidth) {
    const shortenedTitle = truncateToWidth(title, innerWidth - countWidth, "");
    const fillWidth = innerWidth - visibleWidth(shortenedTitle) - countWidth;
    return shortenedTitle + border("─".repeat(Math.max(0, fillWidth))) + count;
  }
  return truncateToWidth(count, innerWidth, "");
}

function rowBodyWidth(width: number): number {
  return Math.max(0, width - 4);
}

function outputStart(row: TreeRow, width: number): number | undefined {
  if (row.child.state !== "completed") return undefined;
  const contentWidth = rowBodyWidth(width);
  const outputWidth = visibleWidth(OUTPUT_LABEL);
  if (contentWidth < outputWidth) return undefined;
  const end = 2 + contentWidth;
  return end - outputWidth;
}

function renderRow(
  target: SubagentWidgetRowTarget,
  innerWidth: number,
  theme: WidgetTheme,
): string {
  const border = (value: string) => theme.fg("borderMuted", value);
  const { row } = target;
  const child = row.child;
  const contentWidth = Math.max(0, innerWidth - 2);
  const plainStatus = statusText(child.state);
  const status = theme.fg(stateColor(child.state), plainStatus);
  const statusWidth = visibleWidth(plainStatus);
  const output = theme.fg("accent", OUTPUT_LABEL);
  const outputWidth = visibleWidth(OUTPUT_LABEL);
  const canShowOutput = child.state === "completed" && contentWidth >= outputWidth;
  const showStatusWithOutput = canShowOutput && contentWidth >= statusWidth + 1 + outputWidth;
  const trailingWidth = canShowOutput
    ? showStatusWithOutput
      ? statusWidth + 1 + outputWidth
      : outputWidth
    : statusWidth;
  const trailing = canShowOutput ? (showStatusWithOutput ? `${status} ${output}` : output) : status;

  const prefix = theme.fg("borderMuted", safePrefix(row.prefix));
  const name = theme.fg(
    isActive(child) ? "text" : "muted",
    theme.bold(singleLine(child.semanticName)),
  );
  const role = theme.fg("dim", ` (${singleLine(child.role)})`);
  const label = prefix + name + role;
  let content: string;
  if (contentWidth <= 0 || trailingWidth >= contentWidth) {
    content = truncateToWidth(trailing, contentWidth, "");
  } else {
    const labelWidth = contentWidth - trailingWidth - 1;
    const shortenedLabel = truncateToWidth(label, Math.max(0, labelWidth), "…");
    const spacing = Math.max(0, contentWidth - visibleWidth(shortenedLabel) - trailingWidth);
    content = shortenedLabel + " ".repeat(spacing) + trailing;
  }

  const padded = fitLine(` ${content} `, innerWidth);
  return border("│") + padded + border("│");
}

function overflowText(hiddenCount: number, hiddenBlockedCount: number): string {
  const blocked = hiddenBlockedCount > 0 ? ` · ${hiddenBlockedCount} blocked` : "";
  return `+${hiddenCount} more${blocked} · /subagents`;
}

function renderWidgetLines(
  layout: SubagentWidgetLayout,
  width: number,
  theme: WidgetTheme,
): string[] {
  if (width <= 0 || (layout.rows.length === 0 && layout.hiddenRows.length === 0)) return [];
  const border = (text: string) => theme.fg("borderMuted", text);
  const normalizedWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (normalizedWidth < 4) {
    return [
      truncateToWidth(theme.fg("accent", `Subagents (${layout.activeCount})`), normalizedWidth, ""),
    ];
  }

  const innerWidth = normalizedWidth - 2;
  const lines = [
    border("╭") +
      fitLine(renderHeader(layout.activeCount, layout.doneCount, innerWidth, theme), innerWidth) +
      border("╮"),
  ];
  for (const target of layout.rows) lines.push(renderRow(target, innerWidth, theme));

  if (layout.hiddenRows.length > 0) {
    lines.push(
      framedText(
        overflowText(layout.hiddenRows.length, layout.hiddenBlockedCount),
        innerWidth,
        theme,
      ),
    );
  }
  lines.push(renderFooter(innerWidth, theme));
  return lines;
}

/**
 * Return the bounded layout shared by rendering and mouse hit maps.
 * Coordinates are relative to the widget's top-left; outputStart is inclusive
 * and the `[output]` hit region is eight columns wide.
 * Supplying a theme also includes the exact rendered `lines`.
 */
export function getSubagentWidgetLayout(
  rows: readonly TreeRow[],
  width: number,
  theme?: WidgetTheme,
): SubagentWidgetLayout {
  const normalizedWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const activeIds = new Set<string>();
  const doneIds = new Set<string>();
  for (const row of rows) {
    if (isActive(row.child)) activeIds.add(row.child.id);
    if (row.child.state === "completed") doneIds.add(row.child.id);
  }
  const activeCount = activeIds.size;
  const doneCount = doneIds.size;

  // Widths below four cannot show a frame or a selectable tree row without
  // producing misleading geometry, so the whole tree is hidden there.
  if (normalizedWidth < 4) {
    const layout: SubagentWidgetLayout = {
      rows: [],
      visibleRows: [],
      hiddenRows: [...rows],
      activeCount,
      doneCount,
      hiddenBlockedCount: rows.filter((row) => row.child.state === "blocked").length,
      rowLineIndexes: [],
      footerLineIndex: undefined,
    };
    return theme ? { ...layout, lines: renderWidgetLines(layout, normalizedWidth, theme) } : layout;
  }

  const visibleIndexes = selectVisibleRowIndexes(rows);
  const visibleIndexSet = new Set(visibleIndexes);
  const visibleRows = visibleIndexes.map((index) => rows[index]!);
  const hiddenRows = rows.filter((_, index) => !visibleIndexSet.has(index));
  const rowLineIndexes = visibleRows.map((_, index) => index + 1);
  const rowTargets = visibleRows.map((row, index) => {
    const start = outputStart(row, normalizedWidth);
    return {
      row,
      y: index + 1,
      ...(start === undefined ? {} : { outputStart: start }),
    };
  });
  const overflowLine = hiddenRows.length > 0 ? 1 + visibleRows.length : undefined;
  const footerLineIndex = overflowLine ?? 1 + visibleRows.length;
  const layout: SubagentWidgetLayout = {
    rows: rowTargets,
    visibleRows,
    hiddenRows,
    activeCount,
    doneCount,
    hiddenBlockedCount: hiddenRows.filter((row) => row.child.state === "blocked").length,
    rowLineIndexes,
    footerLineIndex,
  };
  return theme ? { ...layout, lines: renderWidgetLines(layout, normalizedWidth, theme) } : layout;
}

/** Resolve a relative widget line to the row rendered on it. */
export function getSubagentWidgetRowAtLine(
  layout: SubagentWidgetLayout,
  line: number,
): TreeRow | undefined {
  return layout.rows.find((target) => target.y === line)?.row;
}

export interface RenderSubagentWidgetLayout {
  readonly lines: string[];
  readonly targets: SubagentWidgetRowTarget[];
}

/** Render the widget and expose the exact row/output hit map used by the lines. */
export function renderSubagentWidgetLayout(
  rows: readonly TreeRow[],
  width: number,
  theme: WidgetTheme,
): RenderSubagentWidgetLayout {
  if (width <= 0 || rows.length === 0) return { lines: [], targets: [] };
  const layout = getSubagentWidgetLayout(rows, width, theme);
  return { lines: [...(layout.lines ?? [])], targets: [...layout.rows] };
}

export function renderSubagentWidget(
  rows: readonly TreeRow[],
  width: number,
  theme: WidgetTheme,
): string[] {
  return [...renderSubagentWidgetLayout(rows, width, theme).lines];
}
