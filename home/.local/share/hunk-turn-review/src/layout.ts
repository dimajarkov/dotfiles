import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { socketRequest } from "./rpc.js";
import { assertPrivateSocket } from "./feedback.js";
import type { Identity } from "./runtime.js";
import { canonicalCheckout } from "../client.mjs";

export interface Layout {
  session: string;
  socket: string;
  paneId: string;
}
export interface LayoutState {
  state: "intent" | "open" | "opted-out" | "unavailable" | "uncertain";
  actorId: string;
  paneId?: string;
  terminalId?: string;
  workspaceId?: string;
  message?: string;
}
export interface ReviewPlugin {
  id: string;
  entrypoint: string;
  minColumns?: number;
}
function samePath(a: string | undefined, b: string) {
  try {
    return !!a && realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}
function sameCheckout(a: string | undefined, b: string) {
  try {
    return !!a && canonicalCheckout(a) === b;
  } catch {
    return false;
  }
}
export async function ensureLayout(args: {
  layout: Layout;
  identity: Identity;
  current?: LayoutState;
  plugin?: ReviewPlugin;
  socket: string;
  sessionId: string;
  placement?: "split" | "tab";
  explicit?: boolean;
  persist: (s: LayoutState) => void;
}) {
  const { layout, identity, plugin, persist } = args;
  let current = args.current;
  if (current?.state === "opted-out" && !args.explicit) return current;
  if (!plugin)
    throw new Error(
      "No installed review entrypoint configured; full-width tab fallback available after integration",
    );
  if (!layout.session || !layout.paneId)
    throw new Error("Missing injected named Herdr session/pane");
  const socket = assertPrivateSocket(layout.socket);
  const response = await socketRequest(socket, "session.snapshot", {});
  const snapshot = response.snapshot;
  if (snapshot?.protocol !== 22)
    throw new Error("Herdr plugin pane capability requires verified protocol 22");
  if (current?.paneId) {
    // Follow a moved pane's terminal identity rather than its old workspace-qualified ID.
    const pane = snapshot.panes.find((p: any) => p.terminal_id === current?.terminalId);
    if (pane && args.placement !== "tab") {
      current = { ...current, paneId: pane.pane_id };
      persist(current);
      return current;
    }
    if (!pane && !args.explicit) {
      current = {
        ...current,
        state: "opted-out",
        message:
          "Owned review pane was closed; explicitly reopen or open the full-width review tab",
      };
      persist(current);
      return current;
    }
    current = { state: "unavailable", actorId: current.actorId, workspaceId: current.workspaceId };
  }
  if (current?.state === "intent" || current?.state === "uncertain") {
    const owned = snapshot.panes.filter((p: any) => p.tokens?.htr_actor === current?.actorId);
    if (owned.length === 1) {
      current = {
        ...current,
        state: "open",
        paneId: owned[0].pane_id,
        terminalId: owned[0].terminal_id,
      };
      persist(current);
      return current;
    }
    current = {
      ...current,
      state: "uncertain",
      message:
        "Pane creation intent has no certain receipt; inspect owned panes before explicit reopen",
    };
    persist(current);
    return current;
  }
  const originals = snapshot.agents.filter(
    (a: any) =>
      a.agent === identity.kind &&
      a.agent_session?.agent === identity.kind &&
      ((a.agent_session.kind === "id" && a.agent_session.value === identity.nativeId) ||
        (identity.kind === "pi" &&
          a.agent_session.kind === "path" &&
          samePath(a.agent_session.value, identity.sessionPath ?? ""))) &&
      sameCheckout(a.cwd, identity.checkout) &&
      sameCheckout(a.foreground_cwd, identity.checkout),
  );
  const detachedTab =
    args.placement === "tab" &&
    args.explicit &&
    originals.length === 0 &&
    current?.workspaceId &&
    snapshot.workspaces?.some((w: any) => w.workspace_id === current?.workspaceId);
  if (originals.length !== 1 && !detachedTab)
    throw new Error(
      "Original native session is missing or ambiguous in Herdr; no replacement binding",
    );
  if (args.placement !== "tab") {
    const geometry = await socketRequest(socket, "pane.layout", { pane_id: originals[0].pane_id });
    const columns = geometry.layout?.panes?.find((p: any) => p.pane_id === originals[0].pane_id)
      ?.rect?.width;
    if (!Number.isFinite(columns) || columns < 2 * (plugin.minColumns ?? 40)) {
      const message =
        "Original pane is too narrow for a usable right sibling; offer the full-width review tab without changing focus";
      persist({
        state: "unavailable",
        actorId: current?.actorId ?? randomUUID(),
        workspaceId: originals[0].workspace_id,
        message,
      });
      throw new Error(message);
    }
  }
  const list = await socketRequest(socket, "plugin.list", { plugin_id: plugin.id });
  const installed = list.plugins?.find((p: any) => p.plugin_id === plugin.id && p.enabled);
  const entry = installed?.panes?.find((p: any) => p.id === plugin.entrypoint);
  if (
    !entry ||
    !Array.isArray(entry.command) ||
    !entry.command.length ||
    entry.command.some((a: unknown) => typeof a !== "string")
  )
    throw new Error("Installed review manifest entrypoint is unavailable");
  current = {
    state: "intent",
    actorId: randomUUID(),
    workspaceId: originals[0]?.workspace_id ?? current?.workspaceId,
  };
  persist(current);
  try {
    const result = await socketRequest(socket, "plugin.pane.open", {
      plugin_id: plugin.id,
      entrypoint: plugin.entrypoint,
      placement: args.placement ?? "split",
      focus: false,
      ...(args.placement === "tab"
        ? { workspace_id: current.workspaceId }
        : { direction: "right", target_pane_id: originals[0].pane_id }),
      cwd: identity.checkout,
      env: {
        HUNK_TURN_REVIEW_SOCKET: args.socket,
        HUNK_TURN_REVIEW_SESSION_ID: args.sessionId,
        HUNK_TURN_REVIEW_ACTOR_ID: current.actorId,
      },
    });
    const pane = result.plugin_pane?.pane;
    if (!pane?.pane_id || !pane.terminal_id)
      throw new Error("Herdr returned no owned pane receipt");
    current = { ...current, state: "open", paneId: pane.pane_id, terminalId: pane.terminal_id };
    persist(current);
    await socketRequest(socket, "pane.report_metadata", {
      pane_id: pane.pane_id,
      source: "hunk-turn-review",
      tokens: { htr_actor: current.actorId },
    });
  } catch (e) {
    current = { ...current, state: current.paneId ? "open" : "uncertain", message: String(e) };
    persist(current);
  }
  return current;
}
