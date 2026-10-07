import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

const MCP_COMMAND = "/mcp";

/**
 * Legacy terminals encode Ctrl+M as carriage return, which is also Enter.
 * Pi negotiates Kitty or modifyOtherKeys input when available, so only treat
 * those unambiguous encodings as the MCP shortcut.
 */
export function isEnhancedCtrlM(data: string): boolean {
  return data !== "\r" && data !== "\n" && matchesKey(data, "ctrl+m");
}

export default function mcpShortcut(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.onTerminalInput((data) => {
      if (!isEnhancedCtrlM(data)) return;
      if (!ctx.isIdle()) {
        ctx.ui.notify("MCP panel unavailable while Pi is processing.", "warning");
        return { consume: true };
      }

      const draft = ctx.ui.getEditorText();
      ctx.ui.setEditorText(MCP_COMMAND);
      setTimeout(() => ctx.ui.setEditorText(draft), 0);
      return { data: "\r" };
    });
  });
}
