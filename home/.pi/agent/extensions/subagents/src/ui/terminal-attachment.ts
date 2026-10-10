import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentReadModel } from "../manager.ts";
import {
  openSubagentPicker,
  openSubagentTakeover,
  type TakeoverOptions,
} from "./takeover.ts";

/** Terminal presentation lifecycle, kept separate from child execution. */
export interface TerminalAttachment {
  openPicker(
    ctx: ExtensionContext,
    view: SubagentReadModel,
  ): Promise<void>;
  openTakeover(
    ctx: ExtensionContext,
    view: SubagentReadModel,
    id: string,
    options?: TakeoverOptions,
  ): Promise<void>;
}

/** Existing TUI behavior; closing a view only detaches presentation. */
export const compatibilityTerminalAttachment = {
  openPicker: openSubagentPicker,
  openTakeover: openSubagentTakeover,
} satisfies TerminalAttachment;
