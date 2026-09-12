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

export interface CompletionMarker {
  version: 1;
  childId: string;
  generation: number;
  stopReason: string;
  entryId: string;
  sessionPath: string;
}

export type CompletionSettlement =
  | {
      version: 1;
      childId: string;
      generation: number;
      phase: "running";
      sessionPath: string;
      frontierEntryId?: string;
    }
  | (CompletionMarker & { phase: "candidate" });

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function isConcludedStopReason(stopReason: string | undefined): stopReason is string {
  return (
    stopReason !== undefined &&
    stopReason !== "aborted" &&
    stopReason !== "pending" &&
    stopReason !== "toolUse"
  );
}

export function completionSettlementPath(markerPath: string): string {
  return `${markerPath}.settlement`;
}

export function completionMarkerAt(path: string): CompletionMarker | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      !isObject(parsed) ||
      parsed.version !== 1 ||
      typeof parsed.childId !== "string" ||
      !Number.isSafeInteger(parsed.generation) ||
      typeof parsed.stopReason !== "string" ||
      typeof parsed.entryId !== "string" ||
      typeof parsed.sessionPath !== "string" ||
      !isConcludedStopReason(parsed.stopReason)
    ) {
      return undefined;
    }
    return parsed as unknown as CompletionMarker;
  } catch {
    return undefined;
  }
}

export function completionSettlementAt(markerPath: string): CompletionSettlement | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(completionSettlementPath(markerPath), "utf8"));
    if (
      !isObject(parsed) ||
      parsed.version !== 1 ||
      typeof parsed.childId !== "string" ||
      !Number.isSafeInteger(parsed.generation) ||
      typeof parsed.sessionPath !== "string"
    ) {
      return undefined;
    }
    if (
      parsed.phase === "running" &&
      (parsed.frontierEntryId === undefined || typeof parsed.frontierEntryId === "string")
    ) {
      return parsed as unknown as CompletionSettlement;
    }
    if (
      parsed.phase === "candidate" &&
      typeof parsed.stopReason === "string" &&
      typeof parsed.entryId === "string"
    ) {
      return parsed as unknown as CompletionSettlement;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function writeCompletionSettlement(
  markerPath: string,
  settlement: CompletionSettlement,
): void {
  atomicWriteText(completionSettlementPath(markerPath), `${JSON.stringify(settlement)}\n`);
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

  pi.on("before_agent_start", async (_event, ctx) => {
    await withRegistryLock(`${markerPath}.lock`, () => {
      const records = registryRecords(registry);
      const child = records.find((record) => record.id === childId);
      const sessionPath = ctx.sessionManager.getSessionFile();
      if (
        !child ||
        child.generation !== generation ||
        child.state === "cancelled" ||
        !sessionPath
      ) {
        return;
      }
      const settlement = completionSettlementAt(markerPath);
      const frontierEntryId =
        settlement?.childId === childId &&
        settlement.generation === generation &&
        settlement.phase === "candidate"
          ? settlement.entryId
          : typeof child.startedAfterEntryId === "string"
            ? child.startedAfterEntryId
            : undefined;
      writeCompletionSettlement(markerPath, {
        version: 1,
        childId,
        generation,
        phase: "running",
        sessionPath,
        frontierEntryId,
      });
    });
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
    const outcome = lastOutcome;
    if (!outcome) return;
    await withRegistryLock(`${markerPath}.lock`, () => {
      const records = registryRecords(registry);
      const child = records.find((record) => record.id === childId);
      if (!child || child.generation !== generation || child.state === "cancelled") return;
      writeCompletionSettlement(markerPath, {
        version: 1,
        childId,
        generation,
        phase: "candidate",
        ...outcome,
      });
    });
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const outcome = lastOutcome;
    if (!outcome || !isConcludedStopReason(outcome.stopReason)) return;
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
      const settlement = completionSettlementAt(markerPath);
      if (
        !child ||
        child.generation !== generation ||
        child.state === "cancelled" ||
        settlement?.childId !== childId ||
        settlement.generation !== generation ||
        settlement.phase !== "candidate" ||
        settlement.entryId !== outcome.entryId ||
        settlement.stopReason !== outcome.stopReason ||
        settlement.sessionPath !== outcome.sessionPath
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

      const completion: CompletionMarker = {
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
