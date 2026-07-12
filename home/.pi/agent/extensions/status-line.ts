import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const setStatus = (ctx: ExtensionContext, label: string) => {
    ctx.ui.setStatus("session", ctx.ui.theme.fg("dim", label));
  };

  pi.on("session_start", async (_event, ctx) => {
    setStatus(ctx, "● ready");
  });

  pi.on("turn_start", async (_event, ctx) => {
    setStatus(ctx, "● working");
  });

  pi.on("agent_settled", async (_event, ctx) => {
    setStatus(ctx, "● ready");
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus("session", undefined);
  });
}
