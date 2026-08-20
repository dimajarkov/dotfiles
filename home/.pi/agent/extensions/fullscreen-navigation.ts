import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

const WIDGET_KEY = "fullscreen-navigation";

type FullscreenTui = TUI & {
  scrollToBottom(): void;
};

function scrollToBottom(tui: TUI | undefined): boolean {
  if (!tui || tui.mode !== "fullscreen" || !("scrollToBottom" in tui)) {
    return false;
  }

  const scroll = Reflect.get(tui, "scrollToBottom") as unknown;
  if (typeof scroll !== "function") return false;

  Reflect.apply(scroll, tui as FullscreenTui, []);
  return true;
}

function invisibleWidget(): Component {
  return {
    invalidate() {},
    render() {
      return [];
    },
  };
}

export default function registerFullscreenNavigation(pi: ExtensionAPI): void {
  let tui: TUI | undefined;

  pi.registerCommand("bottom", {
    description: "Jump to the bottom of the fullscreen transcript and follow new output",
    handler: async (_args, ctx) => {
      if (ctx.mode === "tui" && scrollToBottom(tui)) return;

      ctx.ui.notify(
        "Bottom navigation is available only in fullscreen TUI mode",
        "warning",
      );
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setWidget(WIDGET_KEY, (capturedTui) => {
      tui = capturedTui;
      return invisibleWidget();
    });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    tui = undefined;
  });
}
