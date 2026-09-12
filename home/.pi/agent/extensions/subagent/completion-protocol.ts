import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { atomicWriteText } from "./atomic-file.ts";
import { hasPendingCompletions } from "./completion-delivery.ts";
import { withRegistryLock } from "./registry-lock.ts";

interface JsonObject {
  [key: string]: unknown;
}

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "crashed", "stale"]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function registryRecords(directory: string): JsonObject[] {
  try {
    return readdirSync(directory)
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => JSON.parse(readFileSync(join(directory, entry), "utf8")) as unknown)
      .filter(isObject);
  } catch {
    return [];
  }
}

export function registerChildCompletionProtocol(
  pi: ExtensionAPI,
  environment: Record<string, string | undefined> = process.env,
): void {
  const childId = environment.HERDR_SUBAGENT_AGENT_ID;
  const generation = positiveInteger(environment.HERDR_SUBAGENT_GENERATION);
  const registry = environment.HERDR_SUBAGENT_REGISTRY;
  const markerPath = environment.HERDR_SUBAGENT_COMPLETION_MARKER;
  if (!childId || generation === undefined || !registry || !markerPath) return;

  let blocked = false;
  let lastOutcome:
    | {
        stopReason: string;
        entryId: string;
        sessionPath: string;
      }
    | undefined;
  pi.events.on("herdr:blocked", (event) => {
    if (isObject(event) && typeof event.active === "boolean") blocked = event.active;
  });

  pi.on("agent_end", async (event, ctx) => {
    const finalAssistant = [...event.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    const entryId = ctx.sessionManager.getLeafId();
    const sessionPath = ctx.sessionManager.getSessionFile();
    lastOutcome =
      finalAssistant?.stopReason && entryId && sessionPath
        ? { stopReason: finalAssistant.stopReason, entryId, sessionPath }
        : undefined;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const outcome = lastOutcome;
    if (!outcome || outcome.stopReason === "aborted") return;
    if (
      blocked ||
      ctx.hasPendingMessages() ||
      hasPendingCompletions(ctx.sessionManager.getBranch())
    )
      return;

    const published = await withRegistryLock(`${markerPath}.lock`, () => {
      if (
        lastOutcome !== outcome ||
        blocked ||
        ctx.hasPendingMessages() ||
        hasPendingCompletions(ctx.sessionManager.getBranch())
      ) {
        return false;
      }

      const records = registryRecords(registry);
      const child = records.find((record) => record.id === childId);
      if (
        !child ||
        child.generation !== generation ||
        child.state === "cancelled" ||
        child.startedAfterEntryId === outcome.entryId
      ) {
        return false;
      }
      if (
        records.some(
          (record) =>
            record.parentId === childId &&
            (!TERMINAL_STATES.has(String(record.state)) ||
              typeof record.deliveredAt !== "number" ||
              (record.surfaceState !== "closed" && record.surfaceState !== "released")),
        )
      ) {
        return false;
      }

      const completion = {
        version: 1,
        childId,
        generation,
        stopReason: outcome.stopReason,
        entryId: outcome.entryId,
        sessionPath: outcome.sessionPath,
      };
      atomicWriteText(markerPath, `${JSON.stringify(completion)}\n`);
      return true;
    });
    if (published) ctx.shutdown();
  });
}

export default registerChildCompletionProtocol;
