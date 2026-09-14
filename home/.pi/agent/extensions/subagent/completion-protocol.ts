import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hasPendingCompletions } from "./completion-delivery.ts";

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

function atomicWrite(path: string, value: JsonObject): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
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
  let lastOutcome: {
    stopReason: string;
    entryId: string;
    sessionPath: string;
  } | undefined;
  pi.events.on("herdr:blocked", (event) => {
    if (isObject(event) && typeof event.active === "boolean") blocked = event.active;
  });

  pi.on("agent_end", async (event, ctx) => {
    const finalAssistant = [...event.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    const entryId = ctx.sessionManager.getLeafId();
    const sessionPath = ctx.sessionManager.getSessionFile();
    lastOutcome = finalAssistant?.stopReason && entryId && sessionPath
      ? { stopReason: finalAssistant.stopReason, entryId, sessionPath }
      : undefined;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!lastOutcome || lastOutcome.stopReason === "aborted") return;
    if (blocked || ctx.hasPendingMessages() || hasPendingCompletions(ctx.sessionManager.getBranch())) return;

    const records = registryRecords(registry);
    const child = records.find((record) => record.id === childId);
    if (!child || child.generation !== generation) return;
    if (
      records.some(
        (record) =>
          record.parentId === childId &&
          (
            !TERMINAL_STATES.has(String(record.state)) ||
            typeof record.deliveredAt !== "number" ||
            (record.surfaceState !== "closed" && record.surfaceState !== "released")
          ),
      )
    ) {
      return;
    }

    atomicWrite(markerPath, {
      version: 1,
      childId,
      generation,
      stopReason: lastOutcome.stopReason,
      entryId: lastOutcome.entryId,
      sessionPath: lastOutcome.sessionPath,
    });
    ctx.shutdown();
  });
}

export default registerChildCompletionProtocol;
