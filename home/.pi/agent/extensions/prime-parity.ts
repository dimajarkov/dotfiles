import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

const HARNESS_VERSION = 1;
const MAX_ENTRIES_IN_PROMPT = 24;
const MAX_PROMPT_CHARS = 16_000;
const REVIEW_CONVERSATION_CHARS = 40_000;
const REFINEMENT_CONVERSATION_CHARS = 80_000;
const DEFAULT_TURN_INTERVAL = 25;
const DEFAULT_COOLDOWN_MS = 20 * 60 * 1_000;
const MAX_HARNESS_ENTRIES = 200;
const REFINEMENT_CUSTOM_ENTRY = "prime-parity.refinement";

export type HarnessKind = "prompt" | "memory" | "skill" | "subagent";
export interface HarnessEntry {
  id: string;
  kind: HarnessKind;
  title: string;
  content: string;
  createdAt: string;
  sourceSessionId: string;
}
export interface HarnessFile {
  version: number;
  entries: HarnessEntry[];
}
interface RefinementRequest {
  pending?: boolean;
  instructions?: string | null;
  global?: boolean;
}
export interface AutoRefinementConfig {
  enabled: boolean;
  turnInterval: number;
  compact: boolean;
  cooldownMs: number;
}
interface ReviewResult {
  shouldRefine: boolean;
  rationale: string;
  instructions?: string;
}
type TriggerReason = "turn_interval" | "compact";
type EditAction = "create" | "update" | "delete";
interface HarnessEdit {
  action: EditAction;
  id?: string;
  kind?: HarnessKind;
  title?: string;
  content?: string;
}
interface RefinementProposal {
  edits: HarnessEdit[];
  rationale?: string;
}
interface ApprovedReview {
  result: ReviewResult;
  reason: TriggerReason;
  turns: number;
  evidence: EvidenceIdentity;
}
interface EvidenceIdentity {
  sessionId: string;
  leafId: string | null;
  generation: number;
}
interface ControllerState {
  assistantTurnsSinceReview: number;
  lastReviewTimestamp: number;
  reviewInFlight: boolean;
  refinementInFlight: boolean;
  pendingIntervalReview: boolean;
  pendingCompactionReview: boolean;
  pendingApprovedReview?: ApprovedReview;
  generation: number;
  invalidated: boolean;
}
export interface PrimeParityDependencies {
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelScheduled?: (handle: unknown) => void;
  agentDirectory?: () => string;
  config?: Partial<AutoRefinementConfig>;
}

const REVIEW_SYSTEM_PROMPT = `You are an automatic continual harness refinement review gate.
Decide whether this checkpoint contains concrete evidence worth preserving for future turns in this session.
Prefer no refinement over speculative memory.
Reject one-off noise, unsupported hypotheses, transient tool output, and facts already represented in the harness.
Return exactly one JSON object with this shape and no markdown:
{"shouldRefine":true|false,"rationale":"concrete trajectory evidence","instructions":"optional focused instructions for the refinement pass"}`;

const REFINEMENT_SYSTEM_PROMPT = `You are a continual harness curator.
Improve only the editable prompt, memory, skill, and subagent entries using the supplied trajectory evidence.
Make the smallest evidence-backed Create, Update, or Delete edits.
Session-local scope is the default. Global scope is allowed only when the explicit request selected it.
Never preserve secrets, credentials, raw large logs, transient outputs, or speculative claims.
Return exactly one JSON object and no markdown:
{"rationale":"why these edits are justified","edits":[{"action":"create|update|delete","id":"required for update/delete","kind":"prompt|memory|skill|subagent","title":"required for create/update","content":"required for create/update"}]}
Return {"rationale":"insufficient evidence","edits":[]} when the evidence is insufficient.`;

function defaultAgentDir(): string {
  return process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function requestPath(ctx: ExtensionContext, directory: string): string {
  return join(directory, "refinement-requests", `${ctx.sessionManager.getSessionId()}.json`);
}

function localHarnessPath(ctx: ExtensionContext, directory: string): string {
  return join(directory, "session-artifacts", ctx.sessionManager.getSessionId(), "continual-harness.json");
}

function globalHarnessPath(directory: string): string {
  return join(directory, "continual-harness.json");
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // rename removes the temporary path; cleanup is only for failed writes.
    }
  }
}

export function loadHarness(path: string): HarnessFile {
  const value = readJson<Partial<HarnessFile>>(path);
  if (!value || !Array.isArray(value.entries)) return { version: HARNESS_VERSION, entries: [] };
  const entries = value.entries.filter((entry): entry is HarnessEntry =>
    Boolean(
      entry &&
        typeof entry === "object" &&
        typeof entry.id === "string" &&
        typeof entry.kind === "string" &&
        ["prompt", "memory", "skill", "subagent"].includes(entry.kind) &&
        typeof entry.title === "string" &&
        typeof entry.content === "string" &&
        typeof entry.createdAt === "string" &&
        typeof entry.sourceSessionId === "string",
    ),
  );
  return { version: HARNESS_VERSION, entries };
}

function finiteNumber(value: unknown, fallback: number, minimum: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(minimum, value) : fallback;
}

export function normalizeAutoRefinementConfig(value: unknown): AutoRefinementConfig {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : true,
    turnInterval: finiteNumber(record.turnInterval, DEFAULT_TURN_INTERVAL, 1),
    compact: typeof record.compact === "boolean" ? record.compact : true,
    cooldownMs: finiteNumber(record.cooldownMs, DEFAULT_COOLDOWN_MS, 0),
  };
}

function loadConfig(directory: string, override?: Partial<AutoRefinementConfig>): AutoRefinementConfig {
  const file = readJson<{ autoRefinement?: unknown }>(join(directory, "prime-parity.json"));
  const base = normalizeAutoRefinementConfig(file?.autoRefinement);
  const environment: Partial<AutoRefinementConfig> = {};
  const interval = Number(process.env.PI_AUTO_REFINEMENT_TURN_INTERVAL);
  const cooldown = Number(process.env.PI_AUTO_REFINEMENT_COOLDOWN_MS);
  if (process.env.PI_AUTO_REFINEMENT_TURN_INTERVAL !== undefined && Number.isFinite(interval)) environment.turnInterval = interval;
  if (process.env.PI_AUTO_REFINEMENT_COOLDOWN_MS !== undefined && Number.isFinite(cooldown)) environment.cooldownMs = cooldown;
  if (process.env.PI_AUTO_REFINEMENT_ENABLED === "0") environment.enabled = false;
  if (process.env.PI_AUTO_REFINEMENT_ENABLED === "1") environment.enabled = true;
  return normalizeAutoRefinementConfig({ ...base, ...environment, ...override });
}

function redactSensitive(text: string): string {
  return text
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/gi, "<redacted-private-key>")
    .replace(/\bAuthorization\s*:\s*(?:Bearer|Basic)\s+[^\s,;]+/gi, "Authorization: <redacted>")
    .replace(/(["']?(?:token|api[_-]?key|secret|password|access[_-]?key)["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi, "$1<redacted>")
    .replace(/\b(?:sk-[A-Za-z0-9_-]+|AKIA[A-Z0-9]{16})\b/g, "<redacted>");
}

function sanitizeStructured(value: unknown, key?: string): unknown {
  if (key && /^(?:token|api[_-]?key|secret|password|authorization|access[_-]?key)$/i.test(key)) return "<redacted>";
  if (typeof value === "string") return redactSensitive(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeStructured(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, item]) => [name, sanitizeStructured(item, name)]));
  }
  return value;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "[non-text content omitted]";
  return content.map((block) => {
    if (!block || typeof block !== "object") return "[unknown content omitted]";
    const item = block as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string") return item.text;
    if (item.type === "image") return `[image ${typeof item.mimeType === "string" ? item.mimeType : "unknown"} omitted]`;
    if (item.type === "thinking") return "[assistant thinking omitted]";
    if (item.type === "toolCall") {
      const name = typeof item.name === "string" ? item.name : "unknown";
      return `[tool call ${name}] ${stableJson(sanitizeStructured(item.arguments ?? {}))}`;
    }
    return `[${typeof item.type === "string" ? item.type : "unknown"} content omitted]`;
  }).join("\n");
}

function serializeEntry(entry: SessionEntry): string {
  switch (entry.type) {
    case "message": {
      const message = entry.message as unknown as Record<string, unknown>;
      const role = typeof message.role === "string" ? message.role : "unknown";
      const error = role === "toolResult" && message.isError === true ? " error=true" : "";
      const tool = role === "toolResult" && typeof message.toolName === "string" ? ` tool=${message.toolName}` : "";
      return `[message role=${role}${tool}${error}]\n${contentText(message.content)}`;
    }
    case "compaction":
      return `[compaction summary]\n${entry.summary}`;
    case "branch_summary":
      return `[branch summary]\n${entry.summary}`;
    case "custom_message":
      return `[custom message type=${entry.customType}]\n${contentText(entry.content)}`;
    case "custom":
      return `[custom state type=${entry.customType} omitted]`;
    case "model_change":
      return `[model change ${entry.provider}/${entry.modelId}]`;
    case "thinking_level_change":
      return `[thinking level ${entry.thinkingLevel}]`;
    case "label":
      return `[label ${entry.label ?? "removed"}]`;
    case "session_info":
      return `[session info${entry.name ? ` name=${entry.name}` : ""}]`;
  }
}

export function serializeTrajectory(entries: readonly SessionEntry[]): string {
  return redactSensitive(entries.map(serializeEntry).join("\n\n"));
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const attempts = [text.trim()];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fence) attempts.push(fence.trim());
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === "{") depth += 1;
      else if (character === "}" && --depth === 0) {
        attempts.push(text.slice(start, index + 1));
        break;
      }
    }
  }
  for (const attempt of attempts) {
    try {
      const value = JSON.parse(attempt) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // Try the next defensively extracted object.
    }
  }
  return undefined;
}

function responseText(response: { content?: unknown }): string {
  return Array.isArray(response.content)
    ? response.content.flatMap((block) => {
      if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
        const text = (block as { text?: unknown }).text;
        return typeof text === "string" ? [text] : [];
      }
      return [];
    }).join("\n")
    : "";
}

function parseReview(response: { content?: unknown; stopReason?: unknown }): ReviewResult | undefined {
  if (response.stopReason === "error" || response.stopReason === "aborted" || response.stopReason === "length") return undefined;
  const value = parseJsonObject(responseText(response));
  if (!value || typeof value.shouldRefine !== "boolean" || typeof value.rationale !== "string") return undefined;
  const rationale = redactSensitive(value.rationale.trim()).slice(0, 4_000);
  if (!rationale) return undefined;
  const instructions = typeof value.instructions === "string"
    ? redactSensitive(value.instructions.trim()).slice(0, 4_000)
    : undefined;
  return { shouldRefine: value.shouldRefine, rationale, ...(instructions ? { instructions } : {}) };
}

function parseProposal(response: { content?: unknown; stopReason?: unknown }): RefinementProposal | undefined {
  if (response.stopReason === "error" || response.stopReason === "aborted" || response.stopReason === "length") return undefined;
  const value = parseJsonObject(responseText(response));
  if (!value || !Array.isArray(value.edits)) return undefined;
  const edits: HarnessEdit[] = [];
  for (const raw of value.edits) {
    if (!raw || typeof raw !== "object") return undefined;
    const item = raw as Record<string, unknown>;
    if (item.action !== "create" && item.action !== "update" && item.action !== "delete") return undefined;
    const edit: HarnessEdit = { action: item.action };
    if (typeof item.id === "string") edit.id = item.id;
    if (["prompt", "memory", "skill", "subagent"].includes(String(item.kind))) edit.kind = item.kind as HarnessKind;
    if (typeof item.title === "string") edit.title = redactSensitive(item.title.trim()).slice(0, 160);
    if (typeof item.content === "string") edit.content = redactSensitive(item.content.trim()).slice(0, 4_000);
    if (edit.action === "create" && (!edit.kind || !edit.title || !edit.content)) return undefined;
    if (edit.action === "update" && (!edit.id || (!edit.title && !edit.content && !edit.kind))) return undefined;
    if (edit.action === "delete" && !edit.id) return undefined;
    edits.push(edit);
  }
  return {
    edits,
    rationale: typeof value.rationale === "string" ? redactSensitive(value.rationale.trim()).slice(0, 4_000) : undefined,
  };
}

function harnessOverview(global: HarnessFile, local: HarnessFile): string {
  const describe = (scope: string, entries: HarnessEntry[]) => entries.length === 0
    ? `${scope}: 0 entries`
    : `${scope}: ${entries.length} entries\n${entries.slice(-24).map((entry) => `- ${entry.kind} ${entry.id}: ${entry.title}`).join("\n")}`;
  return `${describe("global", global.entries)}\n${describe("session-local", local.entries)}`;
}

function harnessState(global: HarnessFile, local: HarnessFile): string {
  return JSON.stringify({ global: global.entries, local: local.entries }, null, 2);
}

function refinementHistory(ctx: ExtensionContext): string {
  const entries = ctx.sessionManager.getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType === REFINEMENT_CUSTOM_ENTRY)
    .slice(-20)
    .map((entry) => JSON.stringify((entry as { data?: unknown }).data));
  return entries.length > 0 ? entries.join("\n") : "No prior refinement history.";
}

function harnessPrompt(ctx: ExtensionContext, directory: string): string {
  const entries = [
    ...loadHarness(globalHarnessPath(directory)).entries,
    ...loadHarness(localHarnessPath(ctx, directory)).entries,
  ].slice(-MAX_ENTRIES_IN_PROMPT);
  if (entries.length === 0) return "";
  const lines = [
    "## Continual harness",
    "These are small, reviewable lessons retained from prior work. Apply them only when relevant and do not treat them as immutable instructions.",
  ];
  for (const entry of entries) lines.push(`### ${entry.kind}: ${entry.title}\n${entry.content}`);
  return lines.join("\n\n").slice(0, MAX_PROMPT_CHARS);
}

function readRequest(ctx: ExtensionContext, directory: string): RefinementRequest | undefined {
  const path = requestPath(ctx, directory);
  if (!existsSync(path)) return undefined;
  return readJson<RefinementRequest>(path);
}

function clearRequest(ctx: ExtensionContext, directory: string): void {
  try {
    writeJsonAtomic(requestPath(ctx, directory), { pending: false });
  } catch {
    // Cleanup failure must not interrupt the user's turn.
  }
}

async function applyProposal(
  proposal: RefinementProposal,
  ctx: ExtensionContext,
  directory: string,
  global: boolean,
): Promise<HarnessEntry[] | undefined> {
  const path = global ? globalHarnessPath(directory) : localHarnessPath(ctx, directory);
  const release = await acquireFileLock(path);
  try {
  const harness = loadHarness(path);
  const next = [...harness.entries];
  const changed: HarnessEntry[] = [];
  for (const edit of proposal.edits) {
    if (edit.action === "create") {
      const entry: HarnessEntry = {
        id: randomUUID(),
        kind: edit.kind!,
        title: edit.title!,
        content: edit.content!,
        createdAt: new Date().toISOString(),
        sourceSessionId: ctx.sessionManager.getSessionId(),
      };
      next.push(entry);
      changed.push(entry);
      continue;
    }
    const index = next.findIndex((entry) => entry.id === edit.id);
    if (index < 0) return undefined;
    if (edit.action === "delete") {
      changed.push(next[index]);
      next.splice(index, 1);
      continue;
    }
    const updated = {
      ...next[index],
      ...(edit.kind ? { kind: edit.kind } : {}),
      ...(edit.title ? { title: edit.title } : {}),
      ...(edit.content ? { content: edit.content } : {}),
    };
    next[index] = updated;
    changed.push(updated);
  }
  if (proposal.edits.length === 0) return [];
  harness.entries = next.slice(-MAX_HARNESS_ENTRIES);
  writeJsonAtomic(path, harness);
  return changed;
  } finally {
    release();
  }
}

async function acquireFileLock(path: string): Promise<() => void> {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const descriptor = openSync(lock, "wx", 0o600);
      writeFileSync(descriptor, `${process.pid}\n`);
      return () => {
        closeSync(descriptor);
        try { unlinkSync(lock); } catch { /* another cleanup already removed it */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = Number(readFileSync(lock, "utf8").trim());
        if (Number.isInteger(owner) && owner > 0) process.kill(owner, 0);
        else if (attempt >= 10) unlinkSync(lock);
      } catch (ownerError) {
        if ((ownerError as NodeJS.ErrnoException).code === "ESRCH" || attempt >= 10) {
          try { unlinkSync(lock); } catch { /* another process recovered it */ }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for harness lock: ${lock}`);
}

export class ContinualRefinementController {
  readonly state: ControllerState = {
    assistantTurnsSinceReview: 0,
    lastReviewTimestamp: 0,
    reviewInFlight: false,
    refinementInFlight: false,
    pendingIntervalReview: false,
    pendingCompactionReview: false,
    generation: 0,
    invalidated: false,
  };
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancelScheduled: (handle: unknown) => void;
  private readonly getAgentDir: () => string;
  private readonly configOverride?: Partial<AutoRefinementConfig>;
  private scheduled?: unknown;
  private abortController = new AbortController();
  private drainPromise?: Promise<void>;
  private drainRequested = false;
  private fullDrainRequested = false;
  private lastContext?: ExtensionContext;

  constructor(private readonly pi: ExtensionAPI, dependencies: PrimeParityDependencies = {}) {
    this.now = dependencies.now ?? Date.now;
    this.schedule = dependencies.schedule ?? ((callback, delay) => {
      const timer = setTimeout(callback, delay);
      timer.unref?.();
      return timer;
    });
    this.cancelScheduled = dependencies.cancelScheduled ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.getAgentDir = dependencies.agentDirectory ?? defaultAgentDir;
    this.configOverride = dependencies.config;
  }

  private config(): AutoRefinementConfig {
    return loadConfig(this.getAgentDir(), this.configOverride);
  }

  private evidence(ctx: ExtensionContext): EvidenceIdentity {
    return {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId(),
      generation: this.state.generation,
    };
  }

  private isCurrent(ctx: ExtensionContext, evidence: EvidenceIdentity): boolean {
    return !this.state.invalidated &&
      evidence.generation === this.state.generation &&
      evidence.sessionId === ctx.sessionManager.getSessionId() &&
      evidence.leafId === ctx.sessionManager.getLeafId();
  }

  assistantMessageEnded(message: unknown): void {
    const config = this.config();
    if (!config.enabled || !message || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    if (record.role !== "assistant" || record.stopReason === "error" || record.stopReason === "aborted" || record.stopReason === "pending") return;
    this.state.assistantTurnsSinceReview += 1;
    if (this.state.assistantTurnsSinceReview >= config.turnInterval) {
      this.state.pendingIntervalReview = true;
      if (this.lastContext) this.requestDrain(this.lastContext, 0);
    }
  }

  compactionCompleted(ctx: ExtensionContext): void {
    if (!this.config().compact || !this.config().enabled) return;
    this.state.pendingCompactionReview = true;
    this.lastContext = ctx;
    this.requestDrain(ctx, 0);
  }

  private requestDrain(ctx: ExtensionContext, delayMs: number): void {
    this.lastContext = ctx;
    if (this.scheduled !== undefined) return;
    this.scheduled = this.schedule(() => {
      this.scheduled = undefined;
      if (!ctx.isIdle()) return;
      void this.drain(ctx);
    }, delayMs);
  }

  async turnEnded(ctx: ExtensionContext): Promise<void> {
    if (readRequest(ctx, this.getAgentDir())?.pending) await this.drain(ctx, true);
  }

  async settled(ctx: ExtensionContext): Promise<void> {
    this.lastContext = ctx;
    if (this.scheduled !== undefined) {
      this.cancelScheduled(this.scheduled);
      this.scheduled = undefined;
    }
    await this.drain(ctx);
  }

  private async complete(ctx: ExtensionContext, systemPrompt: string, userPrompt: string, maxTokens: number) {
    if (!ctx.model) throw new Error("No curator model is selected");
    return ctx.modelRegistry.complete(
      ctx.model,
      {
        systemPrompt,
        messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: this.now() }],
      },
      {
        maxTokens: Math.min(typeof ctx.model.maxTokens === "number" ? ctx.model.maxTokens : maxTokens, maxTokens),
        cacheRetention: "none",
        signal: this.abortController.signal,
      },
    );
  }

  private async runManual(ctx: ExtensionContext, request: RefinementRequest): Promise<boolean> {
    clearRequest(ctx, this.getAgentDir());
    const evidence = this.evidence(ctx);
    const turns = this.state.assistantTurnsSinceReview;
    const instructions = typeof request.instructions === "string" ? request.instructions.trim() : "";
    const result = await this.runRefinement(ctx, evidence, {
      rationale: instructions || "Explicit manual refinement request.",
      ...(instructions ? { instructions } : {}),
    }, request.global === true, "manual");
    if (result) this.consumeTurns(turns, this.config());
    return result;
  }

  private consumeTurns(turns: number, config: AutoRefinementConfig): void {
    this.state.assistantTurnsSinceReview = Math.max(0, this.state.assistantTurnsSinceReview - turns);
    this.state.pendingIntervalReview = this.state.pendingIntervalReview ||
      this.state.assistantTurnsSinceReview >= config.turnInterval;
  }

  private reviewReason(config: AutoRefinementConfig): TriggerReason | undefined {
    if (this.state.pendingCompactionReview) return "compact";
    if (this.state.pendingIntervalReview && this.state.assistantTurnsSinceReview >= config.turnInterval) return "turn_interval";
    return undefined;
  }

  private scheduleCooldown(ctx: ExtensionContext, config: AutoRefinementConfig): void {
    const remaining = Math.max(0, config.cooldownMs - (this.now() - this.state.lastReviewTimestamp));
    this.requestDrain(ctx, remaining);
  }

  async drain(ctx: ExtensionContext, manualOnly = false): Promise<void> {
    this.lastContext = ctx;
    this.drainRequested = true;
    if (!manualOnly) this.fullDrainRequested = true;
    if (!this.drainPromise) {
      this.drainPromise = (async () => {
        while (this.drainRequested) {
          this.drainRequested = false;
          const runManualOnly = !this.fullDrainRequested;
          this.fullDrainRequested = false;
          await this.drainUnlocked(this.lastContext ?? ctx, runManualOnly);
        }
      })().finally(() => {
        this.drainPromise = undefined;
      });
    }
    return this.drainPromise;
  }

  private async drainUnlocked(ctx: ExtensionContext, manualOnly: boolean): Promise<void> {
    if (this.state.invalidated || this.state.reviewInFlight || this.state.refinementInFlight) return;
    const request = readRequest(ctx, this.getAgentDir());
    if (request?.pending) {
      try {
        await this.runManual(ctx, request);
      } catch (error) {
        ctx.ui.notify(`Continual refinement skipped: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
      return;
    }
    if (manualOnly) return;

    const config = this.config();
    if (!config.enabled) return;
    if (this.state.pendingApprovedReview) {
      const approved = this.state.pendingApprovedReview;
      if (!this.isCurrent(ctx, approved.evidence)) {
        this.state.pendingApprovedReview = undefined;
        return;
      }
      if (this.state.lastReviewTimestamp > 0 && this.now() - this.state.lastReviewTimestamp < config.cooldownMs) {
        this.scheduleCooldown(ctx, config);
        return;
      }
      const success = await this.runRefinement(ctx, approved.evidence, approved.result, false, approved.reason);
      this.state.lastReviewTimestamp = this.now();
      if (success) {
        this.state.pendingApprovedReview = undefined;
        this.consumeTurns(approved.turns, config);
      } else {
        this.scheduleCooldown(ctx, config);
      }
      return;
    }

    const reason = this.reviewReason(config);
    if (!reason) return;
    if (this.state.lastReviewTimestamp > 0 && this.now() - this.state.lastReviewTimestamp < config.cooldownMs) {
      this.scheduleCooldown(ctx, config);
      return;
    }
    const turns = this.state.assistantTurnsSinceReview;
    const evidence = this.evidence(ctx);
    if (reason === "compact") this.state.pendingCompactionReview = false;
    else this.state.pendingIntervalReview = false;
    this.state.reviewInFlight = true;
    let review: ReviewResult | undefined;
    try {
      const directory = this.getAgentDir();
      const global = loadHarness(globalHarnessPath(directory));
      const local = loadHarness(localHarnessPath(ctx, directory));
      const conversation = serializeTrajectory(ctx.sessionManager.buildContextEntries()).slice(-REVIEW_CONVERSATION_CHARS);
      const prompt = `Trigger reason: ${reason}\nEligible assistant turns since the previous completed review: ${turns}\n\nCurrent harness overview:\n${harnessOverview(global, local)}\n\nAvailable refinement history:\n${refinementHistory(ctx)}\n\nFinal ${REVIEW_CONVERSATION_CHARS} characters of the serialized conversation:\n<conversation>\n${conversation}\n</conversation>\n\nPrefer no refinement over speculative memory. Automatic refinement is session-local by default.`;
      const response = await this.complete(ctx, REVIEW_SYSTEM_PROMPT, prompt, 4_096);
      if (this.isCurrent(ctx, evidence)) review = parseReview(response);
    } catch (error) {
      ctx.ui.notify(`Automatic refinement review skipped: ${error instanceof Error ? error.message : String(error)}`, "warning");
    } finally {
      this.state.reviewInFlight = false;
    }
    if (!this.isCurrent(ctx, evidence)) return;
    this.state.lastReviewTimestamp = this.now();
    if (!review) {
      if (reason === "compact") this.state.pendingCompactionReview = true;
      else this.state.pendingIntervalReview = true;
      this.scheduleCooldown(ctx, config);
      return;
    }
    if (!review.shouldRefine) {
      if (reason === "compact" && turns >= config.turnInterval) {
        this.state.pendingIntervalReview = true;
      } else {
        this.consumeTurns(turns, config);
      }
      if (this.state.pendingIntervalReview || this.state.pendingCompactionReview) this.scheduleCooldown(ctx, config);
      return;
    }
    this.state.pendingApprovedReview = { result: review, reason, turns, evidence };
    const success = await this.runRefinement(ctx, evidence, review, false, reason);
    this.state.lastReviewTimestamp = this.now();
    if (success) {
      this.state.pendingApprovedReview = undefined;
      this.consumeTurns(turns, config);
    } else {
      this.scheduleCooldown(ctx, config);
    }
  }

  private async runRefinement(
    ctx: ExtensionContext,
    evidence: EvidenceIdentity,
    review: { rationale: string; instructions?: string },
    global: boolean,
    source: TriggerReason | "manual",
  ): Promise<boolean> {
    if (!this.isCurrent(ctx, evidence)) return false;
    this.state.refinementInFlight = true;
    try {
      const directory = this.getAgentDir();
      const globalHarness = loadHarness(globalHarnessPath(directory));
      const localHarness = loadHarness(localHarnessPath(ctx, directory));
      const conversation = serializeTrajectory(ctx.sessionManager.buildContextEntries()).slice(-REFINEMENT_CONVERSATION_CHARS);
      const prompt = `Current harness state:\n${harnessState(globalHarness, localHarness)}\n\nRefinement history:\n${refinementHistory(ctx)}\n\nFinal ${REFINEMENT_CONVERSATION_CHARS} characters of the serialized conversation:\n<conversation>\n${conversation}\n</conversation>\n\nReview rationale:\n${review.rationale}\n\nReviewer or explicit instructions:\n${review.instructions || "None."}\n\nTarget scope: ${global ? "global, explicitly requested" : "session-local"}.\nReturn no edits when the evidence is insufficient.`;
      const response = await this.complete(ctx, REFINEMENT_SYSTEM_PROMPT, prompt, 32_000);
      if (!this.isCurrent(ctx, evidence)) return false;
      const proposal = parseProposal(response);
      if (!proposal) return false;
      const changed = await applyProposal(proposal, ctx, directory, global);
      if (!changed) return false;
      if (changed.length === 0) {
        ctx.ui.notify("No evidence-backed refinement was found", "info");
        return true;
      }
      const history = {
        source,
        global,
        rationale: proposal.rationale || review.rationale,
        edits: proposal.edits.map((edit) => ({ action: edit.action, id: edit.id, kind: edit.kind, title: edit.title })),
        timestamp: new Date(this.now()).toISOString(),
      };
      this.pi.appendEntry(REFINEMENT_CUSTOM_ENTRY, history);
      ctx.ui.notify(`Continual refinement applied ${changed.length} edit${changed.length === 1 ? "" : "s"} ${global ? "globally" : "for this session"}`, "info");
      return true;
    } catch (error) {
      ctx.ui.notify(`Continual refinement skipped: ${error instanceof Error ? error.message : String(error)}`, "warning");
      return false;
    } finally {
      this.state.refinementInFlight = false;
    }
  }

  branchChanged(): void {
    this.invalidate();
    this.state.invalidated = false;
  }

  invalidate(): void {
    this.state.invalidated = true;
    this.state.generation += 1;
    this.state.pendingIntervalReview = false;
    this.state.pendingCompactionReview = false;
    this.state.pendingApprovedReview = undefined;
    this.state.assistantTurnsSinceReview = 0;
    this.abortController.abort();
    this.abortController = new AbortController();
    if (this.scheduled !== undefined) {
      this.cancelScheduled(this.scheduled);
      this.scheduled = undefined;
    }
  }

  startSession(): void {
    this.state.invalidated = false;
    this.state.generation += 1;
    this.state.assistantTurnsSinceReview = 0;
    this.state.pendingIntervalReview = false;
    this.state.pendingCompactionReview = false;
    this.state.pendingApprovedReview = undefined;
    this.state.lastReviewTimestamp = 0;
  }

  status(): ControllerState {
    return { ...this.state };
  }
}

export function createPrimeParityExtension(dependencies: PrimeParityDependencies = {}) {
  return function primeParityExtension(pi: ExtensionAPI) {
    const controller = new ContinualRefinementController(pi, dependencies);

    pi.on("before_agent_start", (event, ctx) => {
      const prompt = harnessPrompt(ctx, dependencies.agentDirectory?.() ?? defaultAgentDir());
      if (!prompt) return;
      return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
    });
    pi.on("message_end", (event) => controller.assistantMessageEnded(event.message));
    pi.on("turn_end", async (_event, ctx) => controller.turnEnded(ctx));
    pi.on("agent_settled", async (_event, ctx) => controller.settled(ctx));
    pi.on("session_compact", (event, ctx) => {
      if (event.compactionEntry) controller.compactionCompleted(ctx);
    });
    pi.on("session_tree", () => controller.branchChanged());
    pi.on("session_shutdown", () => controller.invalidate());
    pi.on("session_start", () => controller.startSession());

    pi.registerCommand("refine", {
      description: "Queue continual harness refinement for the end of this turn",
      handler: async (args, ctx) => {
        const global = /(?:^|\s)--global(?:\s|$)/.test(args);
        const instructions = args.replace(/(?:^|\s)--global(?:\s|$)/g, " ").trim() || null;
        writeJsonAtomic(requestPath(ctx, dependencies.agentDirectory?.() ?? defaultAgentDir()), { pending: true, instructions, global });
        ctx.ui.notify("Refinement queued for the end of this turn", "info");
      },
    });

    pi.registerCommand("refine-status", {
      description: "Show continual harness refinement status",
      handler: async (_args, ctx) => {
        const directory = dependencies.agentDirectory?.() ?? defaultAgentDir();
        const request = readRequest(ctx, directory);
        const globalCount = loadHarness(globalHarnessPath(directory)).entries.length;
        const localCount = loadHarness(localHarnessPath(ctx, directory)).entries.length;
        const state = controller.status();
        ctx.ui.notify(
          `Refinement ${request?.pending ? "pending" : state.reviewInFlight || state.refinementInFlight ? "in flight" : "idle"}\nGlobal entries: ${globalCount}\nSession entries: ${localCount}\nEligible turns: ${state.assistantTurnsSinceReview}`,
          "info",
        );
      },
    });

    return controller;
  };
}

export default createPrimeParityExtension();
