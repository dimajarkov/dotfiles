import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, matchesKey } from "@earendil-works/pi-tui";
import { SubagentPromptView, promptText } from "./prompt-view.ts";
import { renderOutputContent } from "./output-content.ts";
import type { TreeRow } from "./widget.ts";

const overlay = {
  overlay: true,
  overlayOptions: { width: "90%" as const, maxHeight: "90%" as const, margin: 0 },
};
const singleLine = (text: string) => promptText(text).replace(/\n/g, " ");
const displayPath = (row: TreeRow) => row.displayPath;

function outputLines(row: TreeRow, width: number): string[] {
  const lines = renderOutputContent(
    row.child.result ?? "No final response has been saved for this agent yet.",
    row.child.cwd,
    width,
  );
  if (row.child.error === undefined) return lines;
  return [
    ...lines,
    "",
    ...renderOutputContent(`Failure: ${row.child.error}`, row.child.cwd, width),
  ];
}

/** Read-only inspection never focuses, resumes, or sends input to a child pane. */
export class SubagentInspector {
  private opened = false;
  private close?: () => void;

  dispose(): void {
    this.close?.();
    this.close = undefined;
  }

  async show(
    ctx: ExtensionContext,
    rows: readonly TreeRow[],
    mode: "prompt" | "output" = "prompt",
    query = "",
    target?: TreeRow,
  ): Promise<void> {
    if (this.opened) return;
    if (ctx.mode !== "tui") {
      ctx.ui.notify(
        rows.length
          ? rows
              .map(
                (row) =>
                  `${row.prefix}${row.child.semanticName} [${row.child.role}] ${row.child.state}`,
              )
              .join("\n")
          : "No subagents",
        "info",
      );
      return;
    }
    const matches = query.trim()
      ? rows.filter(
          (row) =>
            row.child.semanticName === query.trim() ||
            row.child.id === query.trim() ||
            row.path === query.trim() ||
            displayPath(row) === query.trim(),
        )
      : rows;
    if (!matches.length) {
      ctx.ui.notify(query.trim() ? `No subagent matches ${query.trim()}` : "No subagents", "info");
      return;
    }
    this.opened = true;
    try {
      const selection = target
        ? { row: target, mode }
        : query.trim() && matches.length === 1
          ? { row: matches[0], mode }
          : await this.pick(ctx, matches, mode);
      if (!selection) return;
      const { row } = selection;
      let showing = selection.mode;
      // Switch between original task and saved conclusion without touching agent lifecycle.
      for (;;) {
        const next = await ctx.ui.custom<"prompt" | "output" | undefined>(
          (tui, theme, _keys, done) => {
            this.close = () => done(undefined);
            const content =
              showing === "output"
                ? {
                    title: "Output",
                    label:
                      row.child.result === undefined
                        ? `Final response not available${row.child.error ? " · failure details below" : ""}`
                        : `Saved final response${row.child.error ? " · failure details below" : ""} · links open with system defaults`,
                    render: (width: number) => outputLines(row, width),
                  }
                : undefined;
            const view = new SubagentPromptView(
              row.child,
              displayPath(row),
              theme,
              () => tui.terminal.rows,
              () => tui.requestRender(),
              () => done(undefined),
              content,
              "p prompt · o output",
            );
            return {
              render: (width) => view.render(width),
              invalidate: () => view.invalidate(),
              handleMouse: (event) => view.handleMouse(event),
              handleInput: (data) => {
                if (data === "o" && showing !== "output") done("output");
                else if (data === "p" && showing !== "prompt") done("prompt");
                else view.handleInput(data);
              },
            };
          },
          overlay,
        );
        if (!next) break;
        showing = next;
      }
    } finally {
      this.close = undefined;
      this.opened = false;
    }
  }

  private async pick(
    ctx: ExtensionContext,
    rows: readonly TreeRow[],
    mode: "prompt" | "output",
  ): Promise<{ row: TreeRow; mode: "prompt" | "output" } | undefined> {
    const choice = await ctx.ui.custom<{ id: string; mode: "prompt" | "output" } | undefined>(
      (tui, theme, _keys, done) => {
        this.close = () => done(undefined);
        let list: SelectList;
        let count = 0;
        const container = new Container();
        return {
          render: (width) => {
            const maxVisible = Math.max(1, Math.floor(tui.terminal.rows * 0.9) - 5);
            if (count !== maxVisible) {
              const selectedId = list?.getSelectedItem()?.value;
              list = new SelectList(
                rows.map((row) => ({
                  value: row.child.id,
                  label: `${row.prefix}${singleLine(row.child.semanticName)} [${singleLine(row.child.role)}] ${row.child.state === "completed" ? "● done" : row.child.state}`,
                  description: singleLine(displayPath(row)),
                })),
                maxVisible,
                {
                  selectedPrefix: (text) => theme.fg("accent", text),
                  selectedText: (text) => theme.fg("accent", text),
                  description: (text) => theme.fg("dim", text),
                  scrollInfo: (text) => theme.fg("dim", text),
                  noMatch: (text) => theme.fg("warning", text),
                },
              );
              list.setSelectedIndex(
                Math.max(
                  0,
                  rows.findIndex((row) => row.child.id === selectedId),
                ),
              );
              list.onSelect = (item) => done({ id: item.value, mode });
              list.onCancel = () => done(undefined);
              count = maxVisible;
            }
            container.clear();
            container.addChild(
              new Text(theme.fg("accent", theme.bold("Subagents · select to inspect")), 0, 0),
            );
            container.addChild(list);
            container.addChild(
              new Text(theme.fg("dim", "↑↓ choose · Enter prompt · o output · Esc close"), 0, 0),
            );
            return container.render(width);
          },
          invalidate: () => container.invalidate(),
          handleMouse: (event) => container.handleMouse(event),
          handleInput: (data) => {
            if (matchesKey(data, "escape")) done(undefined);
            else if (data === "o" && list?.getSelectedItem())
              done({ id: list.getSelectedItem()!.value, mode: "output" });
            else list?.handleInput(data);
            tui.requestRender();
          },
        };
      },
      overlay,
    );
    const row = rows.find((row) => row.child.id === choice?.id);
    return row && choice ? { row, mode: choice.mode } : undefined;
  }
}
