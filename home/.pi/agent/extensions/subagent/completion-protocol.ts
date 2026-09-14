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

export interface SettlementDescendantEvidence {
  id: string;
  generation: number;
  state: string;
  deliveredAt: number;
  surfaceState: "closed" | "released";
}

export interface CompletionSettlementEvidence {
  version: 1;
  blocked: false;
  admittedMessages: 0;
  pendingMessages: false;
  pendingCompletions: false;
  descendants: SettlementDescendantEvidence[];
}

export type CompletionSettlement =
  | {
      version: 1;
      childId: string;
      generation: number;
      phase: "running";
      sessionPath: string;
      frontierEntryId?: string;
      pendingControls?: number;
    }
  | (CompletionMarker & {
      phase: "candidate";
      settlementEvidence?: CompletionSettlementEvidence;
    });

export interface ChildControlRequest {
  version: 1;
  childId: string;
  generation: number;
  nonce: string;
  action: "message" | "cancel";
  receiptPath: string;
  message?: string;
}

export interface ChildControlReceipt {
  version: 1;
  childId: string;
  generation: number;
  nonce: string;
  action: "message" | "cancel";
  status: "accepted" | "settling";
  sessionPath: string;
  frontierEntryId?: string;
}

const CHILD_CONTROL_PREFIX = "/_herdr-subagent-control ";
const CHILD_CONTROL_MESSAGE_TYPE = "herdr-subagent-control";

// The deployment package supplies this synchronous native-queue capability.
// Upstream void sendMessage is intentionally not a compatibility fallback.
type NativeAdmissionAPI = ExtensionAPI & {
  enqueueMessage?: (
    message: Parameters<ExtensionAPI["sendMessage"]>[0],
    options?: { deliverAs?: "steer" | "followUp" },
  ) => { status: "queued" };
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isSettlementDescendantEvidence(value: unknown): value is SettlementDescendantEvidence {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    Number.isSafeInteger(value.generation) &&
    typeof value.state === "string" &&
    Number.isSafeInteger(value.deliveredAt) &&
    value.deliveredAt >= 0 &&
    (value.surfaceState === "closed" || value.surfaceState === "released")
  );
}

function isCompletionSettlementEvidence(value: unknown): value is CompletionSettlementEvidence {
  return (
    isObject(value) &&
    value.version === 1 &&
    value.blocked === false &&
    value.admittedMessages === 0 &&
    value.pendingMessages === false &&
    value.pendingCompletions === false &&
    Array.isArray(value.descendants) &&
    value.descendants.every(isSettlementDescendantEvidence)
  );
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
      (parsed.frontierEntryId === undefined || typeof parsed.frontierEntryId === "string") &&
      (parsed.pendingControls === undefined ||
        (Number.isSafeInteger(parsed.pendingControls) && parsed.pendingControls >= 0))
    ) {
      return parsed as unknown as CompletionSettlement;
    }
    if (
      parsed.phase === "candidate" &&
      typeof parsed.stopReason === "string" &&
      typeof parsed.entryId === "string" &&
      (parsed.settlementEvidence === undefined ||
        isCompletionSettlementEvidence(parsed.settlementEvidence))
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

export function childControlReceiptPath(markerPath: string): string {
  return `${markerPath}.control`;
}

export function childControlPrompt(request: ChildControlRequest): string {
  return `${CHILD_CONTROL_PREFIX}${Buffer.from(JSON.stringify(request)).toString("base64url")}`;
}

function childControlRequestFromValue(value: unknown): ChildControlRequest | undefined {
  if (
    !isObject(value) ||
    value.version !== 1 ||
    typeof value.childId !== "string" ||
    !Number.isSafeInteger(value.generation) ||
    typeof value.nonce !== "string" ||
    !/^[a-f\d-]{36}$/u.test(value.nonce) ||
    (value.action !== "message" && value.action !== "cancel") ||
    typeof value.receiptPath !== "string" ||
    (value.action === "message" && typeof value.message !== "string") ||
    (value.action === "cancel" && value.message !== undefined)
  ) {
    return undefined;
  }
  return value as unknown as ChildControlRequest;
}

export function childControlRequestFromPrompt(text: string): ChildControlRequest | undefined {
  if (!text.startsWith(CHILD_CONTROL_PREFIX)) return undefined;
  try {
    return childControlRequestFromValue(
      JSON.parse(
        Buffer.from(text.slice(CHILD_CONTROL_PREFIX.length), "base64url").toString("utf8"),
      ),
    );
  } catch {
    return undefined;
  }
}

export function childControlReceiptAt(markerPath: string): ChildControlReceipt | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(childControlReceiptPath(markerPath), "utf8"));
    if (
      !isObject(parsed) ||
      parsed.version !== 1 ||
      typeof parsed.childId !== "string" ||
      !Number.isSafeInteger(parsed.generation) ||
      typeof parsed.nonce !== "string" ||
      (parsed.action !== "message" && parsed.action !== "cancel") ||
      (parsed.status !== "accepted" && parsed.status !== "settling") ||
      typeof parsed.sessionPath !== "string" ||
      (parsed.frontierEntryId !== undefined && typeof parsed.frontierEntryId !== "string")
    ) {
      return undefined;
    }
    return parsed as unknown as ChildControlReceipt;
  } catch {
    return undefined;
  }
}

export function finalAssistantResult(
  sessionPath: string,
  targetEntryId?: string,
): {
  entryId: string;
  text: string;
  stopReason?: string;
  errorMessage?: string;
} {
  let sessionText: string;
  try {
    sessionText = readFileSync(sessionPath, "utf8");
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") {
      throw new Error(`Child session has no assistant result: ${sessionPath}`);
    }
    throw error;
  }
  const lines = sessionText.split("\n").filter(Boolean);
  const entries = new Map<string, JsonObject>();
  let leaf: JsonObject | undefined;
  for (const line of lines) {
    const parsed: unknown = JSON.parse(line);
    if (!isObject(parsed) || parsed.type === "session" || typeof parsed.id !== "string") continue;
    entries.set(parsed.id, parsed);
    leaf = parsed;
  }
  if (targetEntryId !== undefined) leaf = entries.get(targetEntryId);

  while (leaf) {
    if (leaf.type === "message" && isObject(leaf.message) && leaf.message.role === "assistant") {
      const message = leaf.message;
      const content = Array.isArray(message.content) ? message.content : [];
      return {
        entryId: leaf.id as string,
        text: content
          .filter((part): part is JsonObject => isObject(part) && part.type === "text")
          .map((part) => (typeof part.text === "string" ? part.text : ""))
          .join(""),
        stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
        errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
      };
    }
    if (targetEntryId !== undefined) break;
    leaf = typeof leaf.parentId === "string" ? entries.get(leaf.parentId) : undefined;
  }
  throw new Error(
    targetEntryId === undefined
      ? `Child session has no assistant result: ${sessionPath}`
      : `Child session has no assistant result ${targetEntryId}: ${sessionPath}`,
  );
}

export function promoteCompletionSettlement(
  markerPath: string,
  expected: {
    childId: string;
    generation: number;
    sessionPath: string;
    startedAfterEntryId?: string;
  },
  allowExistingResult = false,
): CompletionMarker | undefined {
  const settlement = completionSettlementAt(markerPath);
  if (
    settlement?.childId !== expected.childId ||
    settlement.generation !== expected.generation ||
    settlement.phase !== "candidate" ||
    settlement.sessionPath !== expected.sessionPath ||
    !isConcludedStopReason(settlement.stopReason) ||
    !isCompletionSettlementEvidence(settlement.settlementEvidence)
  ) {
    return undefined;
  }
  const result = finalAssistantResult(expected.sessionPath);
  if (
    result.entryId !== settlement.entryId ||
    result.stopReason !== settlement.stopReason ||
    (!allowExistingResult && result.entryId === expected.startedAfterEntryId)
  ) {
    return undefined;
  }
  const marker: CompletionMarker = {
    version: 1,
    childId: settlement.childId,
    generation: settlement.generation,
    stopReason: settlement.stopReason,
    entryId: settlement.entryId,
    sessionPath: settlement.sessionPath,
  };
  atomicWriteText(markerPath, `${JSON.stringify(marker)}\n`);
  return marker;
}

function descendantRecords(records: JsonObject[], parentId: string): JsonObject[] {
  const descendants: JsonObject[] = [];
  const ancestorIds = new Set([parentId]);
  const seenRecords = new Set<JsonObject>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (
        seenRecords.has(record) ||
        typeof record.parentId !== "string" ||
        !ancestorIds.has(record.parentId)
      ) {
        continue;
      }
      seenRecords.add(record);
      descendants.push(record);
      if (typeof record.id === "string" && !ancestorIds.has(record.id)) {
        ancestorIds.add(record.id);
        changed = true;
      }
    }
  }
  return descendants;
}

function registryRecords(directory: string): JsonObject[] {
  let entries: string[];
  try {
    entries = readdirSync(directory).filter((entry) => entry.endsWith(".json"));
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(directory, entry), "utf8"));
      return isObject(parsed) ? [parsed] : [];
    } catch {
      return [];
    }
  });
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
  const acceptedNonces = new Set<string>();
  const admittedMessages: Array<{
    nonce: string;
    message: string;
    accepted: boolean;
    frontierEntryId?: string;
  }> = [];
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

  pi.on("message_start", async (event, ctx) => {
    const message = isObject(event) && isObject(event.message) ? event.message : undefined;
    if (message?.role !== "custom" || message.customType !== CHILD_CONTROL_MESSAGE_TYPE) return;
    const request = childControlRequestFromValue(message.details);
    if (
      !request ||
      typeof message.content !== "string" ||
      message.content !== (request.message ?? "")
    ) {
      ctx.abort();
      return;
    }
    const admissionIndex = admittedMessages.findIndex(
      (admission) => admission.nonce === request.nonce,
    );
    if (admissionIndex === -1) {
      ctx.abort();
      return;
    }
    const admission = admittedMessages[admissionIndex];
    if (!admission) return;

    // A custom message is the private control itself. Pi emits its
    // message_start when it drains the steer/follow-up queue, and this
    // awaited handler consumes only the matching nonce; unrelated user
    // messages cannot claim the reservation.
    try {
      await withRegistryLock(`${markerPath}.lock`, () => {
        const records = registryRecords(registry);
        const child = records.find((record) => record.id === childId);
        const sessionPath = ctx.sessionManager.getSessionFile();
        if (
          !child ||
          child.generation !== generation ||
          TERMINAL_STATES.has(String(child.state)) ||
          !sessionPath ||
          request.childId !== childId ||
          request.generation !== generation ||
          request.receiptPath !== childControlReceiptPath(markerPath) ||
          request.action !== "message" ||
          request.message !== admission.message ||
          !admission.accepted ||
          !admittedMessages.includes(admission)
        ) {
          throw new Error("Private control admission state changed before consumption");
        }
        // The provider's preceding response is persisted before Pi drains its
        // queue. It is the frontier for this turn, not proof of its completion.
        // Keep the reservation while waiting for the lock: parent preflight
        // must also see that durable pending-control count during contention.
        let frontierEntryId = admission.frontierEntryId;
        try {
          frontierEntryId = finalAssistantResult(sessionPath).entryId;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !error.message.startsWith("Child session has no assistant result:")
          )
            throw error;
        }
        lastOutcome = undefined;
        writeCompletionSettlement(markerPath, {
          version: 1,
          childId,
          generation,
          phase: "running",
          sessionPath,
          frontierEntryId,
          pendingControls: admittedMessages.length - 1,
        });
        admittedMessages.splice(admittedMessages.indexOf(admission), 1);
        // Consumption must not overwrite a newer request's receipt. Acceptance
        // was already published by input; this event advances only the frontier.
      });
    } catch {
      // A consumed private message must not be treated as admitted without a
      // durable receipt. Abort this run on any consumption failure; the input
      // hook handles protocol envelopes before they can enter this path.
      ctx.abort();
    }
  });

  pi.on("input", async (event, ctx) => {
    if (!event.text.startsWith(CHILD_CONTROL_PREFIX)) return;
    try {
      const request = childControlRequestFromPrompt(event.text);
      if (!request) return { action: "handled" };
      const sessionPath = ctx.sessionManager.getSessionFile();
      if (
        request.childId !== childId ||
        request.generation !== generation ||
        request.receiptPath !== childControlReceiptPath(markerPath) ||
        !sessionPath
      ) {
        return { action: "handled" };
      }

      // Admission happens in the input hook, not message_start. The latter is
      // emitted only after the active provider turn yields, so using it as the
      // acceptance point makes a parent control time out while a provider is
      // blocked. Keep the durable receipt and settlement transition under the
      // same lock used by completion publication.
      await withRegistryLock(`${markerPath}.lock`, () => {
        const records = registryRecords(registry);
        const child = records.find((record) => record.id === childId);
        const marker = completionMarkerAt(markerPath);
        const settlement = completionSettlementAt(markerPath);
        const priorReceipt = childControlReceiptAt(markerPath);
        if (
          acceptedNonces.has(request.nonce) ||
          (priorReceipt?.childId === childId &&
            priorReceipt.generation === generation &&
            priorReceipt.nonce === request.nonce &&
            priorReceipt.sessionPath === sessionPath)
        ) {
          return undefined;
        }
        const runningFrontier =
          settlement?.childId === childId &&
          settlement.generation === generation &&
          settlement.phase === "running" &&
          settlement.sessionPath === sessionPath
            ? settlement.frontierEntryId
            : typeof child?.startedAfterEntryId === "string"
              ? child.startedAfterEntryId
              : undefined;
        let frontierEntryId = runningFrontier;
        let settling =
          !child ||
          child.generation !== generation ||
          TERMINAL_STATES.has(String(child.state)) ||
          (marker?.childId === childId &&
            marker.generation === generation &&
            marker.sessionPath === sessionPath) ||
          (settlement?.childId === childId &&
            settlement.generation === generation &&
            settlement.phase === "candidate" &&
            settlement.sessionPath === sessionPath);

        if (!settling) {
          try {
            const result = finalAssistantResult(sessionPath);
            frontierEntryId = result.entryId;
            if (
              admittedMessages.length === 0 &&
              result.entryId !== runningFrontier &&
              isConcludedStopReason(result.stopReason)
            ) {
              const outcome = {
                stopReason: result.stopReason,
                entryId: result.entryId,
                sessionPath,
              };
              writeCompletionSettlement(markerPath, {
                version: 1,
                childId,
                generation,
                phase: "candidate",
                ...outcome,
              });
              lastOutcome = outcome;
              settling = true;
            }
          } catch (error) {
            // A session without an assistant result is normal before the first
            // model turn. Every other read/parse/write failure rejects the
            // private envelope instead of admitting it as a model prompt.
            if (
              !(error instanceof Error) ||
              !error.message.startsWith("Child session has no assistant result:")
            ) {
              return undefined;
            }
          }
        }

        const receipt: ChildControlReceipt = {
          version: 1,
          childId,
          generation,
          nonce: request.nonce,
          action: request.action,
          status: settling ? "settling" : "accepted",
          sessionPath,
          frontierEntryId,
        };
        if (settling) {
          atomicWriteText(request.receiptPath, `${JSON.stringify(receipt)}\n`);
          return { status: "settling" as const };
        }

        lastOutcome = undefined;
        writeCompletionSettlement(markerPath, {
          version: 1,
          childId,
          generation,
          phase: "running",
          sessionPath,
          frontierEntryId,
          pendingControls: admittedMessages.length,
        });
        if (request.action === "cancel") {
          // Publish before aborting, without yielding between the two. A
          // receipt-write failure must never interrupt the active provider.
          atomicWriteText(request.receiptPath, `${JSON.stringify(receipt)}\n`);
          acceptedNonces.add(request.nonce);
          ctx.abort();
          return;
        }

        // Exercise the receipt's actual filesystem boundary before enqueueing.
        // Preparing is deliberately not a ChildControlReceipt: readers must
        // never interpret it as acceptance if queueing or publication fails.
        atomicWriteText(
          request.receiptPath,
          `${JSON.stringify({ ...receipt, status: "preparing" })}\n`,
        );
        const admission = {
          nonce: request.nonce,
          message: request.message ?? "",
          accepted: false,
          frontierEntryId,
        };
        admittedMessages.push(admission);
        let dispatchReturned = false;
        try {
          writeCompletionSettlement(markerPath, {
            version: 1,
            childId,
            generation,
            phase: "running",
            sessionPath,
            frontierEntryId,
            pendingControls: admittedMessages.length,
          });
          // The patched public wrapper returns only after native insertion and
          // propagates rejection synchronously. Older runtimes fail closed.
          const nativePi = pi as NativeAdmissionAPI;
          if (typeof nativePi.enqueueMessage !== "function") {
            throw new Error("Pi runtime lacks synchronous native message admission");
          }
          const queued = nativePi.enqueueMessage(
            {
              customType: CHILD_CONTROL_MESSAGE_TYPE,
              content: admission.message,
              display: false,
              details: request,
            },
            event.streamingBehavior === undefined
              ? undefined
              : { deliverAs: event.streamingBehavior },
          );
          dispatchReturned = true;
          if (queued?.status !== "queued") {
            throw new Error("Pi runtime did not acknowledge native message admission");
          }
          atomicWriteText(request.receiptPath, `${JSON.stringify(receipt)}\n`);
          admission.accepted = true;
          acceptedNonces.add(request.nonce);
        } catch (error) {
          // Once dispatch returned, the private message may already be queued.
          // Keep its unauthorized reservation and durable settlement guard:
          // consumption will abort, and the preceding response cannot become a
          // successful completion. A synchronous native rejection queued nothing.
          if (!dispatchReturned) admittedMessages.splice(admittedMessages.indexOf(admission), 1);
          writeCompletionSettlement(markerPath, {
            version: 1,
            childId,
            generation,
            phase: "running",
            sessionPath,
            frontierEntryId,
            pendingControls: admittedMessages.length,
          });
          throw error;
        }
      });
      return { action: "handled" };
    } catch {
      // The prefix is private protocol input. Never let malformed state or an
      // unwritable receipt fall through to Pi's original-text admission path.
      return { action: "handled" };
    }
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
      // A private control is represented by a nonce-bearing custom message,
      // so unrelated direct input cannot consume its admission claim.
      if (admittedMessages.length > 0) return;
      if (settlement?.phase === "candidate") return;
      const frontierEntryId =
        typeof child.startedAfterEntryId === "string" ? child.startedAfterEntryId : undefined;
      lastOutcome = undefined;
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
      const settlement = completionSettlementAt(markerPath);
      if (
        admittedMessages.length > 0 ||
        (settlement?.childId === childId &&
          settlement.generation === generation &&
          settlement.sessionPath === outcome.sessionPath &&
          (settlement.phase === "candidate"
            ? settlement.entryId !== outcome.entryId
            : settlement.frontierEntryId === outcome.entryId))
      ) {
        lastOutcome = undefined;
        return;
      }
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
      admittedMessages.length > 0 ||
      ctx.hasPendingMessages() ||
      hasPendingCompletions(ctx.sessionManager.getBranch())
    )
      return;

    const published = await withRegistryLock(`${markerPath}.lock`, () => {
      if (
        lastOutcome !== outcome ||
        blocked ||
        admittedMessages.length > 0 ||
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
      const descendants = descendantRecords(records, childId);
      if (
        descendants.some(
          (record) =>
            typeof record.id !== "string" ||
            !Number.isSafeInteger(record.generation) ||
            typeof record.state !== "string" ||
            !TERMINAL_STATES.has(record.state) ||
            !Number.isSafeInteger(record.deliveredAt) ||
            record.deliveredAt < 0 ||
            (record.surfaceState !== "closed" && record.surfaceState !== "released"),
        )
      ) {
        return false;
      }

      // Persist the result of every agent_settled precondition before publishing
      // the marker. Recovery may promote only this evidence, never an agent_end
      // candidate whose in-memory queues and blocked state were lost in a crash.
      const settlementEvidence: CompletionSettlementEvidence = {
        version: 1,
        blocked: false,
        admittedMessages: 0,
        pendingMessages: false,
        pendingCompletions: false,
        descendants: descendants.map((record) => ({
          id: record.id as string,
          generation: record.generation as number,
          state: record.state as string,
          deliveredAt: record.deliveredAt as number,
          surfaceState: record.surfaceState as "closed" | "released",
        })),
      };
      writeCompletionSettlement(markerPath, {
        version: 1,
        childId,
        generation,
        phase: "candidate",
        ...outcome,
        settlementEvidence,
      });

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
