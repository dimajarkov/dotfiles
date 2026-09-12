import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

const WIDGET_KEY = "fullscreen-navigation";
// Pi's fullscreen factory currently leaves this at 1 and does not expose it in settings.
const FULLSCREEN_WHEEL_SCROLL_LINES = 2;
const HOOK_STATE = Symbol.for("pi.fullscreen-navigation.viewport-hook");

type AppTheme = ExtensionContext["ui"]["theme"];
type ViewportInputResult = { consume?: boolean } | undefined;
type ViewportInputHandler = (data: string) => ViewportInputResult;

type FullscreenTui = TUI & {
  readonly isFollowingOutput: boolean;
  scrollToBottom(): void;
};

type ViewportHookState = {
  owner: JumpToBottomComponent;
  original: ViewportInputHandler;
  originalWheelScrollLines: unknown;
};

type HookableTui = FullscreenTui & {
  [HOOK_STATE]?: ViewportHookState;
  handleViewportInput?: ViewportInputHandler;
  currentLayout?: { lines?: readonly string[] };
};

type MouseEvent = {
  button: number;
  x: number;
  y: number;
  release: boolean;
};

function isFullscreenTui(tui: TUI | undefined): tui is HookableTui {
  return Boolean(
    tui &&
      tui.mode === "fullscreen" &&
      typeof Reflect.get(tui, "isFollowingOutput") === "boolean" &&
      typeof Reflect.get(tui, "scrollToBottom") === "function",
  );
}

function parseMouseEvent(data: string): MouseEvent | undefined {
  // oxlint-disable-next-line no-control-regex -- Parse the terminal's literal CSI mouse report.
  const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
  if (!match) return undefined;

  return {
    button: Number.parseInt(match[1]!, 10),
    x: Number.parseInt(match[2]!, 10) - 1,
    y: Number.parseInt(match[3]!, 10) - 1,
    release: match[4] === "m",
  };
}

class JumpToBottomComponent implements Component {
  private disposed = false;
  private hovered = false;
  private pressed = false;
  private followingOutput = true;
  private newMessageCount = 0;
  private buttonLeft = 0;
  private buttonWidth = 0;
  private renderedButton = "";

  private readonly tui: TUI;
  private readonly theme: AppTheme;

  constructor(tui: TUI, theme: AppTheme) {
    this.tui = tui;
    this.theme = theme;
  }

  render(width: number): string[] {
    this.installViewportHook();
    if (!isFullscreenTui(this.tui) || this.tui.isFollowingOutput) {
      this.followingOutput = true;
      this.newMessageCount = 0;
      this.hovered = false;
      this.pressed = false;
      return [];
    }

    if (this.followingOutput) this.newMessageCount = 0;
    this.followingOutput = false;

    const messageLabel =
      this.newMessageCount > 0
        ? `${this.newMessageCount} new message${this.newMessageCount === 1 ? "" : "s"}`
        : "Jump to bottom";
    const candidates = [
      `${messageLabel} (click) ↓`,
      `${messageLabel} ↓`,
      messageLabel,
      "↓",
    ];
    const available = Math.max(1, width - 2);
    const label = candidates.find((candidate) => candidate.length <= available) ?? "↓";
    const padded = width >= label.length + 2 ? ` ${label} ` : label.slice(0, width);
    this.buttonWidth = Math.min(width, padded.length);
    this.buttonLeft = Math.max(0, Math.floor((width - this.buttonWidth) / 2));
    const rightPadding = Math.max(0, width - this.buttonLeft - this.buttonWidth);
    const background = this.hovered ? "selectedBg" : "userMessageBg";
    const button = this.theme.bg(background, this.theme.fg("text", padded));

    this.renderedButton = button;
    return [
      `${" ".repeat(this.buttonLeft)}${button}${" ".repeat(rightPadding)}`,
    ];
  }

  invalidate(): void {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (!isFullscreenTui(this.tui)) return;

    const state = Reflect.get(this.tui, HOOK_STATE) as
      | ViewportHookState
      | undefined;
    if (state?.owner !== this) return;
    Reflect.set(this.tui, "handleViewportInput", state.original);
    Reflect.set(
      this.tui,
      "wheelScrollLines",
      state.originalWheelScrollLines,
    );
    Reflect.set(this.tui, HOOK_STATE, undefined);
  }

  recordAssistantMessage(): void {
    if (!isFullscreenTui(this.tui) || this.tui.isFollowingOutput) return;
    if (this.followingOutput) {
      this.followingOutput = false;
      this.newMessageCount = 0;
    }
    this.newMessageCount += 1;
    this.tui.requestRender();
  }

  jumpToBottom(): boolean {
    if (!isFullscreenTui(this.tui)) return false;
    this.followingOutput = true;
    this.newMessageCount = 0;
    this.hovered = false;
    this.pressed = false;
    this.tui.scrollToBottom();
    return true;
  }

  /**
   * Pi handles fullscreen mouse reports before extension input listeners.
   * Hook the guarded viewport method so the dock widget can own only its hitbox
   * while every other mouse and keyboard event keeps Pi's native behavior.
   */
  private installViewportHook(): void {
    if (this.disposed || !isFullscreenTui(this.tui)) return;
    const existing = Reflect.get(this.tui, HOOK_STATE) as
      | ViewportHookState
      | undefined;
    if (existing?.owner === this) return;
    if (existing) return;

    const prototype = Object.getPrototypeOf(this.tui) as object | null;
    const original = prototype
      ? (Reflect.get(prototype, "handleViewportInput", this.tui) as unknown)
      : undefined;
    if (typeof original !== "function") return;

    const originalWheelScrollLines = Reflect.get(
      this.tui,
      "wheelScrollLines",
    );
    Reflect.set(
      this.tui,
      "wheelScrollLines",
      FULLSCREEN_WHEEL_SCROLL_LINES,
    );

    // oxlint-disable-next-line no-this-alias -- Preserve component and dynamic TUI receivers.
    const component = this;
    const originalHandler = original as ViewportInputHandler;
    const wrapped = function (
      this: HookableTui,
      data: string,
    ): ViewportInputResult {
      return component.handleViewportInput(data, () =>
        Reflect.apply(originalHandler, this, [data]),
      );
    };
    Reflect.set(this.tui, HOOK_STATE, {
      owner: this,
      original: originalHandler,
      originalWheelScrollLines,
    } satisfies ViewportHookState);
    Reflect.set(this.tui, "handleViewportInput", wrapped);
  }

  private handleViewportInput(
    data: string,
    fallback: () => ViewportInputResult,
  ): ViewportInputResult {
    const event = parseMouseEvent(data);
    if (!event || (event.button & 64) !== 0) return fallback();

    const inside = this.containsPoint(event.x, event.y);
    const moving = (event.button & 32) !== 0;
    if (moving) {
      this.setHovered(inside);
      return inside || this.pressed ? { consume: true } : fallback();
    }

    if (!event.release && (event.button & 3) === 0) {
      if (!inside) {
        this.setHovered(false);
        return fallback();
      }
      this.pressed = true;
      this.setHovered(true);
      return { consume: true };
    }

    if (event.release) {
      const wasPressed = this.pressed;
      this.pressed = false;
      this.setHovered(inside);
      if (wasPressed && inside) this.jumpToBottom();
      if (wasPressed || inside) return { consume: true };
    }

    return fallback();
  }

  private containsPoint(x: number, y: number): boolean {
    if (!isFullscreenTui(this.tui) || this.tui.isFollowingOutput) return false;
    const layout = Reflect.get(this.tui, "currentLayout") as
      | { lines?: readonly string[] }
      | undefined;
    const lines = layout?.lines;
    if (!lines || !this.renderedButton || !lines[y]?.includes(this.renderedButton)) {
      return false;
    }
    return x >= this.buttonLeft && x < this.buttonLeft + this.buttonWidth;
  }

  private setHovered(hovered: boolean): void {
    if (this.hovered === hovered) return;
    this.hovered = hovered;
    this.tui.requestRender();
  }
}

export default function registerFullscreenNavigation(pi: ExtensionAPI): void {
  let component: JumpToBottomComponent | undefined;

  pi.registerCommand("bottom", {
    description:
      "Jump to the bottom of the fullscreen transcript and follow new output",
    handler: async (_args, ctx) => {
      if (ctx.mode === "tui" && component?.jumpToBottom()) return;

      ctx.ui.notify(
        "Bottom navigation is available only in fullscreen TUI mode",
        "warning",
      );
    },
  });

  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") component?.recordAssistantMessage();
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setWidget(WIDGET_KEY, (capturedTui, theme) => {
      component = new JumpToBottomComponent(capturedTui, theme);
      return component;
    });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    component?.dispose();
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    component = undefined;
  });
}
