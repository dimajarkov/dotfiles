import { sanitizeMetadata } from "../lib/terminal-safety.ts";
import type { ChildRecord, ResumeResult } from "./orchestrator.ts";

function stateSymbol(state: ChildRecord["state"]): string {
  if (state === "completed") return "✓";
  if (state === "failed" || state === "crashed") return "✗";
  if (state === "blocked") return "!";
  if (state === "cancelled") return "×";
  return "○";
}

export function summarizeChild(child: ChildRecord): string {
  const tabId = sanitizeMetadata(child.tabId);
  const paneId = sanitizeMetadata(child.paneId);
  const location = tabId && paneId ? `${tabId}/${paneId}` : "starting";
  const scope = child.workScope ? ` scope=${sanitizeMetadata(child.workScope)}` : " unscoped";
  const resolvedModel = child.model ?? child.launchLoadout?.model;
  const resolvedThinking = child.thinking ?? child.launchLoadout?.thinking;
  const model = resolvedModel ? ` model=${sanitizeMetadata(resolvedModel)}` : "";
  const thinking = resolvedThinking ? ` thinking=${sanitizeMetadata(resolvedThinking)}` : "";
  return `${stateSymbol(child.state)} ${sanitizeMetadata(child.semanticName)} [${sanitizeMetadata(child.role)}] ${sanitizeMetadata(child.state)}${scope}${model}${thinking} ${location}`;
}

export function resumeResultText({ action, child }: ResumeResult): string {
  return action === "focused"
    ? `Focused ${sanitizeMetadata(child.semanticName)} in ${sanitizeMetadata(child.paneId)}`
    : `Already ${sanitizeMetadata(child.state)}: ${sanitizeMetadata(child.semanticName)}`;
}
