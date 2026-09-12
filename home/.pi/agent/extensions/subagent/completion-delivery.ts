export const COMPLETION_TYPE = "herdr-subagent-completion";
export const COMPLETION_OUTBOX_TYPE = "herdr-subagent-completion-outbox";

interface CompletionChild {
  id: string;
  generation: number;
  semanticName: string;
  role: string;
  state: string;
  workScope?: string;
  model?: string;
  thinking?: string;
  paneId?: string;
  sessionPath?: string;
  result?: string;
  error?: string;
}

interface CompletionMessage {
  customType: string;
  content: string;
  display: boolean;
  details: {
    childId: string;
    runId: string;
    semanticName: string;
    role: string;
    state: string;
    workScope?: string;
    model?: string;
    thinking?: string;
    paneId?: string;
    sessionPath?: string;
    result?: string;
    error?: string;
  };
}

interface DeliveryOptions {
  getBranch: () => readonly unknown[];
  appendEntry: (customType: string, data: unknown) => void;
  sendMessage: (message: CompletionMessage) => void;
  signal: AbortSignal;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function completionPresent(branch: readonly unknown[], runId: string): boolean {
  return branch.some((entry) =>
    isObject(entry) &&
    entry.type === "custom_message" &&
    entry.customType === COMPLETION_TYPE &&
    isObject(entry.details) &&
    entry.details.runId === runId
  );
}

function isCompletionMessage(value: unknown): value is CompletionMessage {
  if (!isObject(value) || value.customType !== COMPLETION_TYPE ||
    typeof value.content !== "string" || typeof value.display !== "boolean" || !isObject(value.details)) return false;
  const details = value.details;
  return ["childId", "runId", "semanticName", "role", "state"].every((key) => typeof details[key] === "string") &&
    ["workScope", "model", "thinking", "paneId", "sessionPath", "result", "error"].every((key) =>
      details[key] === undefined || typeof details[key] === "string");
}

function outboxMessages(branch: readonly unknown[]): CompletionMessage[] {
  return branch.flatMap((entry) => {
    if (!isObject(entry) || entry.type !== "custom" || entry.customType !== COMPLETION_OUTBOX_TYPE) return [];
    const data = entry.data;
    const message = isObject(data) && data.version === 1 ? data.message : undefined;
    if (!isCompletionMessage(message)) {
      throw new Error("Invalid persisted subagent completion outbox entry");
    }
    return [message];
  });
}

export function hasPendingCompletions(branch: readonly unknown[]): boolean {
  return outboxMessages(branch).some((message) => !completionPresent(branch, message.details.runId));
}

/** Acknowledgement means durably enqueued, not consumed by the parent's model. */
export class CompletionDelivery {
  readonly #options: DeliveryOptions;
  readonly #queued = new Set<string>();

  constructor(options: DeliveryOptions) {
    this.#options = options;
  }

  deliver(child: CompletionChild): boolean {
    const { getBranch, appendEntry, signal } = this.#options;
    const runId = `${child.id}:${child.generation}`;
    const branch = getBranch();
    if (completionPresent(branch, runId)) return true;
    if (signal.aborted) return false;

    let message = outboxMessages(branch).find((candidate) => candidate.details.runId === runId);
    if (!message) {
      const output = child.result ?? "(no output)";
      const failure = child.error === undefined ? "" : `\n\nFailure: ${child.error}`;
      message = {
        customType: COMPLETION_TYPE,
        content: `Subagent ${child.semanticName} ${child.state}.\n\n${output}${failure}`,
        display: true,
        details: {
          childId: child.id, runId, semanticName: child.semanticName, role: child.role, state: child.state,
          workScope: child.workScope, model: child.model, thinking: child.thinking,
          paneId: child.paneId, sessionPath: child.sessionPath, result: child.result, error: child.error,
        },
      };
      // Pi's follow-up queue is volatile and cannot drain during an active tool.
      // Persist first so lifecycle controls never wait on the parent consuming it.
      appendEntry(COMPLETION_OUTBOX_TYPE, { version: 1, message });
    }
    this.#enqueue(message);
    return true;
  }

  /** Call at startup, or after settling with no queued messages remaining. */
  replay(): void {
    if (this.#options.signal.aborted) return;
    this.#queued.clear();
    const branch = this.#options.getBranch();
    for (const message of outboxMessages(branch)) {
      if (!completionPresent(branch, message.details.runId)) this.#enqueue(message);
    }
  }

  #enqueue(message: CompletionMessage): void {
    if (this.#queued.has(message.details.runId)) return;
    this.#options.sendMessage(message);
    this.#queued.add(message.details.runId);
  }
}
