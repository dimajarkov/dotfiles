import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { ChildRecord } from "./orchestrator.ts";

type PromptChild = Pick<ChildRecord, "semanticName" | "role" | "state" | "task">;
type Theme = Pick<ExtensionContext["ui"]["theme"], "fg" | "bold">;

export interface DetailContent {
  title: string;
  label: string;
  render: (width: number) => string[];
}

/** Display untrusted prompt text literally, never as terminal commands or Markdown. */
export function promptText(value: string): string {
  return stripTerminalSequences(value)
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u2028\u2029]/gu, "\n")
    .replace(/\t/gu, "    ")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, (character) => (character === "\n" ? "\n" : ""))
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, "");
}

/** A read-only, height-bounded viewer shared by mouse and command entry points. */
export class SubagentPromptView implements Component {
  private offset = 0;
  private pageSize = 1;
  private lines: string[] = [];
  private cachedWidth = -1;
  private height = 1;

  private readonly child: PromptChild;
  private readonly path: string;
  private readonly theme: Theme;
  private readonly terminalRows: () => number;
  private readonly requestRender: () => void;
  private readonly close: () => void;
  private readonly content?: DetailContent;
  private readonly switchHint: string;

  constructor(
    child: PromptChild,
    path: string,
    theme: Theme,
    terminalRows: () => number,
    requestRender: () => void,
    close: () => void,
    content?: DetailContent,
    switchHint = "",
  ) {
    this.child = child;
    this.path = path;
    this.theme = theme;
    this.terminalRows = terminalRows;
    this.requestRender = requestRender;
    this.close = close;
    this.content = content;
    this.switchHint = switchHint;
  }

  invalidate(): void {
    this.cachedWidth = -1;
  }

  private scroll(offset: number): void {
    this.offset = Math.max(0, Math.min(offset, this.lines.length - this.pageSize));
    this.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.close();
    } else if (matchesKey(data, "up") || data === "k") {
      this.scroll(this.offset - 1);
    } else if (matchesKey(data, "down") || data === "j") {
      this.scroll(this.offset + 1);
    } else if (matchesKey(data, "pageUp")) {
      this.scroll(this.offset - this.pageSize);
    } else if (matchesKey(data, "pageDown") || data === " ") {
      this.scroll(this.offset + this.pageSize);
    } else if (matchesKey(data, "home")) {
      this.scroll(0);
    } else if (matchesKey(data, "end")) {
      this.scroll(this.lines.length);
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel") {
      this.scroll(this.offset + (event.wheelDelta ?? 0));
      return { handled: true };
    }
    if (event.type === "click" && event.button === "left" && event.y === this.height - 1) {
      this.close();
      return { handled: true };
    }
    return undefined;
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const atEnd = this.lines.length > 0 && this.offset + this.pageSize >= this.lines.length;
    this.height = Math.max(1, Math.floor(this.terminalRows() * 0.9));
    const inner = Math.max(1, width - 4);
    if (this.cachedWidth !== inner) {
      this.lines = this.content
        ? this.content.render(inner)
        : promptText(this.child.task)
            .split("\n")
            .flatMap((line) =>
              wrapTextWithAnsi(line, inner).map((part) => truncateToWidth(part, inner, "")),
            );
      if (this.lines.length === 0) this.lines = [""];
      this.cachedWidth = inner;
    }
    const th = this.theme;
    const border = (text: string) => th.fg("borderMuted", text);
    const row = (text: string) => {
      const content = truncateToWidth(` ${text}`, Math.max(0, width - 2), "");
      return truncateToWidth(
        border("│") +
          content +
          " ".repeat(Math.max(0, width - 2 - visibleWidth(content))) +
          border("│"),
        width,
        "",
      );
    };
    const title = truncateToWidth(
      ` ${this.content?.title ?? "Prompt"} · ${promptText(this.child.semanticName).replace(/\n/g, " ")} `,
      Math.max(0, width - 2),
      "…",
    );
    const header = [
      truncateToWidth(
        border("╭") +
          th.fg("accent", th.bold(title)) +
          border("─".repeat(Math.max(0, width - 2 - visibleWidth(title)))) +
          border("╮"),
        width,
        "",
      ),
    ];
    if (this.height >= 9) {
      header.push(row(th.fg("muted", promptText(this.path).replace(/\n/g, " "))));
      header.push(
        row(
          th.fg("dim", `${promptText(this.child.role).replace(/\n/g, " ")} · ${this.child.state}`),
        ),
      );
      header.push(row(th.fg("accent", this.content?.label ?? "Initial delegation prompt")));
      header.push(row(""));
    }
    this.pageSize = Math.max(1, this.height - header.length - 1);
    this.offset = Math.max(
      0,
      Math.min(atEnd ? this.lines.length : this.offset, this.lines.length - this.pageSize),
    );
    const body = this.lines
      .slice(this.offset, this.offset + this.pageSize)
      .map((line) => row(th.fg("text", line)));
    if (this.height <= 2) return body.slice(0, this.height);
    const range = `${this.offset + 1}-${Math.min(this.lines.length, this.offset + this.pageSize)}/${this.lines.length}`;
    const navigation = this.switchHint ? ` · ${this.switchHint}` : "";
    const hint =
      width >= 75
        ? ` ${range} · ↑↓/PgUp/PgDn scroll${navigation} · Esc close `
        : ` ${range}${width >= 45 ? navigation : ""} · Esc close `;
    const footer = truncateToWidth(hint, Math.max(0, width - 2), "");
    this.height = header.length + body.length + 1;
    return [
      ...header,
      ...body,
      border("╰") +
        th.fg("dim", footer) +
        border("─".repeat(Math.max(0, width - 2 - visibleWidth(footer)))) +
        border("╯"),
    ].map((line) => truncateToWidth(line, width, ""));
  }
}
