import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withRegistryLock } from "./registry-lock.ts";

export interface CommandExecution {
  code: number;
  stdout: string;
  stderr: string;
}

export interface HerdrTransport {
  run(args: string[], signal?: AbortSignal): Promise<CommandExecution>;
}

export interface AgentDefinition {
  name: string;
  description: string;
  tools: string[];
  model?: string;
  thinking?: string;
  systemPromptPath?: string;
  skillPaths: string[];
  spawnTargets: string[];
}

export interface SpawnRequest {
  name: string;
  task: string;
  cwd: string;
  parentSessionId: string;
  parentSessionFile?: string;
  workScope?: string;
  agent: AgentDefinition;
}

const ACTIVE_STATES = new Set<ChildState>(["starting", "working", "blocked"]);
const CLEANUP_TERMINAL_STATES = new Set<ChildState>([
  "completed",
  "failed",
  "cancelled",
  "crashed",
  "stale",
]);
const CHILD_COMPLETION_EXTENSION = fileURLToPath(
  new URL("./completion-protocol.ts", import.meta.url),
);
const AGENT_START_TIMEOUT_MILLISECONDS = 60_000;
const PLACEMENT_LOCK_TIMEOUT_SECONDS =
  Math.ceil(AGENT_START_TIMEOUT_MILLISECONDS / 1_000) + 30;

export type ChildState =
  | "starting"
  | "working"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "crashed"
  | "stale";

export type SurfaceState = "open" | "cleanup-pending" | "closed" | "released";

export interface ResolvedContentArtifact {
  path: string;
  sha256: string;
}

export interface ResolvedLaunchLoadout {
  version: 1;
  role: string;
  model?: string;
  thinking?: string;
  tools: string[];
  systemPrompt?: ResolvedContentArtifact;
  skills: ResolvedContentArtifact[];
  spawnTargets: string[];
  cwd: string;
  environment: Record<string, string>;
}

export interface ChildRecord {
  id: string;
  rootId: string;
  parentId: string;
  workScope?: string;
  model?: string;
  thinking?: string;
  parentSessionId: string;
  parentSessionFile?: string;
  semanticName: string;
  herdrName: string;
  role: string;
  task: string;
  cwd: string;
  depth: number;
  generation: number;
  workspaceId: string;
  herdrSession: string;
  tabId?: string;
  paneId?: string;
  sessionPath?: string;
  completionMarkerPath: string;
  launchLoadout: ResolvedLaunchLoadout;
  surfaceState?: SurfaceState;
  cleanupError?: string;
  lifecycleError?: string;
  state: ChildState;
  createdAt: number;
  updatedAt: number;
  error?: string;
  result?: string;
  deliveredAt?: number;
  startedAfterEntryId?: string;
  /** Monotonically increasing registry revision used for cross-process CAS writes. */
  revision?: number;
}

interface JsonObject {
  [key: string]: unknown;
}

interface MasterIdentity {
  version: 1;
  rootId: string;
  herdrSession: string;
  workspaceId: string;
  masterPaneId: string;
  tabId: string;
  masterSessionPath?: string;
  createdAt: number;
  updatedAt: number;
}

interface PaneLayout {
  tabId: string;
  workspaceId: string;
  panes: Array<{
    paneId: string;
    width: number;
    height: number;
    area: number;
  }>;
}

const SAFE_PI_ENVIRONMENT_KEYS = [
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "PI_PACKAGE_DIR",
  "PI_OFFLINE",
  "PI_SKIP_VERSION_CHECK",
] as const;
const SAFE_PI_ENVIRONMENT_KEY_SET = new Set<string>(SAFE_PI_ENVIRONMENT_KEYS);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isContentArtifact(value: unknown): value is ResolvedContentArtifact {
  return isObject(value) && typeof value.path === "string" && typeof value.sha256 === "string";
}

function isSafePiEnvironment(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.entries(value).every(
    ([key, entry]) => SAFE_PI_ENVIRONMENT_KEY_SET.has(key) && typeof entry === "string",
  );
}

function contentArtifact(path: string): ResolvedContentArtifact {
  return {
    path,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  };
}

function safePiEnvironment(
  environment: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    SAFE_PI_ENVIRONMENT_KEYS.flatMap((key) => {
      const value = environment[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

function environmentsMatch(
  saved: Record<string, string>,
  current: Record<string, string>,
): boolean {
  const savedEntries = Object.entries(saved);
  return savedEntries.length === Object.keys(current).length &&
    savedEntries.every(([key, value]) => current[key] === value);
}

function resolveLaunchLoadout(
  request: SpawnRequest,
  environment: Record<string, string | undefined>,
): ResolvedLaunchLoadout {
  return {
    version: 1,
    role: request.agent.name,
    model: request.agent.model,
    thinking: request.agent.thinking,
    tools: [...request.agent.tools],
    systemPrompt: request.agent.systemPromptPath
      ? contentArtifact(request.agent.systemPromptPath)
      : undefined,
    skills: request.agent.skillPaths.map(contentArtifact),
    spawnTargets: [...request.agent.spawnTargets],
    cwd: request.cwd,
    environment: safePiEnvironment(environment),
  };
}

interface OrchestratorOptions {
  transport: HerdrTransport;
  stateDirectory: string;
  environment?: Record<string, string | undefined>;
  id?: () => string;
  now?: () => number;
  monitor?: boolean;
  onCompletion?: (child: ChildRecord) => Promise<boolean>;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function objectAt(value: unknown, key: string): JsonObject {
  if (!isObject(value) || !isObject(value[key])) {
    throw new Error(`Malformed Herdr response: missing object ${key}`);
  }
  return value[key];
}

function stringAt(value: unknown, key: string): string {
  if (!isObject(value) || typeof value[key] !== "string" || value[key].length === 0) {
    throw new Error(`Malformed Herdr response: missing string ${key}`);
  }
  return value[key];
}

function currentHerdrSession(
  environment: Record<string, string | undefined>,
): string {
  return environment.HERDR_SESSION ?? "default";
}

function parseDepth(value: string | undefined): number {
  if (value === undefined) return 0;
  const depth = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(depth) || depth < 0) {
    throw new Error(`Invalid HERDR_SUBAGENT_DEPTH: ${value}`);
  }
  return depth;
}

function slug(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  const safe = /^[a-z]/.test(normalized) ? normalized : `agent-${normalized}`;
  return safe || "agent";
}

function herdrName(semanticName: string, role: string, id: string): string {
  const unique = id.replace(/[^a-zA-Z0-9]/g, "").toLowerCase().slice(0, 6) || "child";
  const suffix = `-${slug(role).slice(0, 10)}-${unique}`;
  const available = Math.max(1, 32 - suffix.length);
  return `${slug(semanticName).slice(0, available)}${suffix}`.slice(0, 32);
}

function displayLabel(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 80) || "agent";
}

function paneLabel(role: string, semanticName: string): string {
  const displayRole = role === "worker" ? "Worker" : role;
  return `${displayRole}: ${displayLabel(semanticName)}`;
}

function sessionPathFromAgent(agent: JsonObject): string | undefined {
  const session = agent.agent_session;
  if (!isObject(session) || session.kind !== "path" || typeof session.value !== "string") {
    return undefined;
  }
  return session.value;
}

class CompletionNotProvenError extends Error {}
class RuntimeIdentityError extends Error {}
class SurfaceOwnershipLostError extends RuntimeIdentityError {}
class SurfaceOwnershipUnprovenError extends RuntimeIdentityError {}

function isRetiredSurface(child: ChildRecord): boolean {
  return child.surfaceState === "closed" || child.surfaceState === "released";
}

class StaleGenerationError extends Error {}
class StaleRevisionError extends Error {}

function isPositiveAgentAbsence(error: unknown): boolean {
  return error instanceof Error &&
    /(?:agent[ _]not[ _]found|unknown agent|no such agent)/i.test(error.message);
}

function isPositivePaneAbsence(error: unknown): boolean {
  return error instanceof Error &&
    /(?:pane[ _]not[ _]found|unknown pane|no such pane)/i.test(error.message);
}

function validateWorkScope(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(value)) {
    throw new Error(
      `Invalid workScope ${JSON.stringify(value)}; use a lowercase slug beginning with a letter`,
    );
  }
  return value;
}

interface CompletionMarker {
  version: 1;
  childId: string;
  generation: number;
  stopReason: string;
  entryId: string;
  sessionPath: string;
}

function completionMarkerAt(path: string): CompletionMarker | undefined {
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
      parsed.stopReason === "aborted" ||
      parsed.stopReason === "pending"
    ) {
      return undefined;
    }
    return parsed as unknown as CompletionMarker;
  } catch {
    return undefined;
  }
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolveDelay, rejectDelay) => {
    const abort = () => {
      clearTimeout(timeout);
      rejectDelay(signal?.reason ?? new Error("Monitor stopped"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolveDelay();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function finalAssistantResult(sessionPath: string): {
  entryId: string;
  text: string;
  stopReason?: string;
  errorMessage?: string;
} {
  const lines = readFileSync(sessionPath, "utf8")
    .split("\n")
    .filter(Boolean);
  const entries = new Map<string, JsonObject>();
  let leaf: JsonObject | undefined;
  for (const line of lines) {
    const parsed: unknown = JSON.parse(line);
    if (!isObject(parsed) || parsed.type === "session") continue;
    if (typeof parsed.id !== "string") continue;
    entries.set(parsed.id, parsed);
    leaf = parsed;
  }

  while (leaf) {
    if (leaf.type === "message" && isObject(leaf.message) && leaf.message.role === "assistant") {
      const message = leaf.message;
      const content = Array.isArray(message.content) ? message.content : [];
      const text = content
        .filter((part): part is JsonObject => isObject(part) && part.type === "text")
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join("");
      return {
        entryId: stringAt(leaf, "id"),
        text,
        stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
        errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
      };
    }
    leaf = typeof leaf.parentId === "string" ? entries.get(leaf.parentId) : undefined;
  }
  throw new Error(`Child session has no assistant result: ${sessionPath}`);
}

async function finalAssistantResultWithRetry(
  sessionPath: string,
  startedAfterEntryId?: string,
  signal?: AbortSignal,
): Promise<{
  entryId: string;
  text: string;
  stopReason?: string;
  errorMessage?: string;
}> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const result = finalAssistantResult(sessionPath);
      if (result.entryId === startedAfterEntryId) {
        throw new Error(`Child session has not persisted its next assistant result: ${sessionPath}`);
      }
      return result;
    } catch (error) {
      lastError = error;
      await abortableDelay(100, signal);
    }
  }
  throw lastError;
}

export class SubagentOrchestrator {
  readonly #transport: HerdrTransport;
  readonly #stateDirectory: string;
  readonly #environment: Record<string, string | undefined>;
  readonly #id: () => string;
  readonly #now: () => number;
  readonly #monitor: boolean;
  readonly #onCompletion: ((child: ChildRecord) => Promise<boolean>) | undefined;
  readonly #monitorTasks = new Map<string, Promise<void>>();
  readonly #monitorControllers = new Map<string, AbortController>();
  readonly #childOperations = new Map<string, Promise<void>>();
  #disposed = false;

  constructor(options: OrchestratorOptions) {
    this.#transport = options.transport;
    this.#stateDirectory = options.stateDirectory;
    this.#environment = options.environment ?? process.env;
    this.#id = options.id ?? (() => crypto.randomUUID());
    this.#now = options.now ?? Date.now;
    this.#monitor = options.monitor ?? true;
    this.#onCompletion = options.onCompletion;
  }

  async shutdown(): Promise<void> {
    this.#disposed = true;
    for (const controller of this.#monitorControllers.values()) controller.abort();
    await Promise.allSettled(this.#monitorTasks.values());
  }

  restart(): void {
    this.#disposed = false;
  }

  list(rootId: string): ChildRecord[] {
    return this.#loadChildren(rootId).sort((left, right) => left.createdAt - right.createdAt);
  }

  async recover(rootId: string, ownerId: string): Promise<ChildRecord[]> {
    const children = this.list(rootId).filter((child) => child.parentId === ownerId);
    for (const listedChild of children) {
      this.#assertCurrentHerdrSession(listedChild);
      await this.#stopMonitor(listedChild.id);
      await this.#withChildRegistryLock(rootId, listedChild.id, () =>
        this.#recoverChild(rootId, ownerId, listedChild.id));
    }
    return this.list(rootId);
  }

  async #recoverChild(rootId: string, ownerId: string, childId: string): Promise<void> {
    const child = this.#findChild(rootId, ownerId, childId);
    this.#assertCurrentHerdrSession(child);
    if (child.surfaceState === "cleanup-pending") {
      const interruptedCleanup = ACTIVE_STATES.has(child.state);
      await this.#cleanupSurface(child);
      if (interruptedCleanup) {
        child.state = "failed";
        child.error =
          `Recovered interrupted cleanup for generation ${child.generation}`;
        child.updatedAt = this.#now();
        this.#saveChild(child);
        await this.#deliver(child);
      }
      return;
    }
    if (
      CLEANUP_TERMINAL_STATES.has(child.state) &&
      child.deliveredAt !== undefined &&
      !isRetiredSurface(child)
    ) {
      await this.#cleanupSurface(child);
      return;
    }
    if (child.state === "completed" || child.state === "failed" || child.state === "crashed") {
      if (await this.#deliver(child)) await this.#cleanupSurface(child);
      return;
    }
    if (!ACTIVE_STATES.has(child.state)) return;

    try {
      const response = await this.#runJson(["agent", "get", child.herdrName]);
      const agent = objectAt(objectAt(response, "result"), "agent");
      const status = this.#validatedAgentStatus(child, agent);
      if (status === "working" || status === "blocked") {
        child.state = status;
        child.updatedAt = this.#now();
        this.#saveChild(child);
        if (this.#monitor) void this.#monitorChild(child);
        return;
      }
      if (status === "idle" || status === "done") {
        try {
          await this.#completeFromSession(child);
        } catch (error) {
          if (!(error instanceof CompletionNotProvenError)) throw error;
          child.updatedAt = this.#now();
          this.#saveChild(child);
          if (this.#monitor) void this.#monitorChild(child);
        }
        return;
      }
      child.state = "stale";
      child.error = `Unrecognized recovered Herdr state: ${status}`;
      child.updatedAt = this.#now();
      this.#saveChild(child);
    } catch (error) {
      if (!(error instanceof RuntimeIdentityError) && child.sessionPath) {
        try {
          await this.#completeFromSession(child);
          return;
        } catch {
          // The structured session has no result for this registered run.
        }
      }
      child.state = "stale";
      child.error = error instanceof Error ? error.message : String(error);
      child.updatedAt = this.#now();
      this.#saveChild(child);
    }
  }

  async inspect(
    rootId: string,
    ownerId: string,
    target: string,
    signal?: AbortSignal,
  ): Promise<ChildRecord> {
    return this.#withChildOperation(
      rootId,
      ownerId,
      target,
      () => this.#inspectUnlocked(rootId, ownerId, target, signal),
      { durable: false },
    );
  }

  async #inspectUnlocked(
    rootId: string,
    ownerId: string,
    target: string,
    signal?: AbortSignal,
  ): Promise<ChildRecord> {
    const observed = this.#findChild(rootId, ownerId, target);
    this.#assertCurrentHerdrSession(observed);
    if (isRetiredSurface(observed)) return observed;
    const response = await this.#runJson(["agent", "get", observed.herdrName], signal);
    const child = this.#findChild(rootId, ownerId, observed.id);
    if (
      child.generation !== observed.generation ||
      !ACTIVE_STATES.has(child.state) ||
      isRetiredSurface(child)
    ) {
      return child;
    }
    const agent = objectAt(objectAt(response, "result"), "agent");
    const status = this.#validatedAgentStatus(child, agent);
    if (status === "blocked") child.state = "blocked";
    else if (status === "working") child.state = "working";
    child.updatedAt = this.#now();
    this.#saveChild(child);
    return { ...child };
  }

  async message(
    rootId: string,
    ownerId: string,
    target: string,
    message: string,
    signal?: AbortSignal,
  ): Promise<ChildRecord> {
    return this.#withChildOperation(
      rootId,
      ownerId,
      target,
      () => this.#messageUnlocked(rootId, ownerId, target, message, signal),
      { stopMonitor: true },
    );
  }

  async #messageUnlocked(
    rootId: string,
    ownerId: string,
    target: string,
    message: string,
    signal?: AbortSignal,
  ): Promise<ChildRecord> {
    let child = this.#findChild(rootId, ownerId, target);
    this.#assertCurrentHerdrSession(child);
    await this.#stopMonitor(child.id);
    child = this.#findChild(rootId, ownerId, target);
    if (CLEANUP_TERMINAL_STATES.has(child.state) && !isRetiredSurface(child)) {
      await this.#cleanupSurface(child);
      child = this.#findChild(rootId, ownerId, target);
      if (!isRetiredSurface(child)) {
        throw new Error(
          `Cannot reactivate ${child.semanticName}: previous pane cleanup remains pending`,
        );
      }
    }
    if (isRetiredSurface(child)) {
      return this.#relaunchClosedChild(child, message, signal);
    }
    await this.#assertLiveChild(child, signal);
    if (child.sessionPath) {
      try {
        child.startedAfterEntryId = finalAssistantResult(child.sessionPath).entryId;
      } catch {
        child.startedAfterEntryId = undefined;
      }
    }
    child.state = "starting";
    child.result = undefined;
    child.error = undefined;
    child.deliveredAt = undefined;
    child.updatedAt = this.#now();
    this.#saveChild(child);
    try {
      await this.#runJson(["agent", "prompt", child.herdrName, message], signal);
    } catch (error) {
      child.state = "failed";
      child.error = errorMessage(error);
      child.deliveredAt = this.#now();
      child.updatedAt = child.deliveredAt;
      if (child.paneId) child.surfaceState = "cleanup-pending";
      this.#saveChild(child);
      try {
        await this.#assertLiveChild(child);
        await this.#runJson(["agent", "send-keys", child.herdrName, "ctrl+c", "ctrl+c"]);
      } catch (stopError) {
        child.lifecycleError = `Failed to stop rejected follow-up: ${errorMessage(stopError)}`;
        child.updatedAt = this.#now();
        this.#saveChild(child);
      }
      await this.#cleanupSurface(child);
      throw error;
    }
    child.state = "working";
    child.updatedAt = this.#now();
    this.#saveChild(child);
    if (this.#monitor) void this.#monitorChild(child);
    return { ...child };
  }

  async cancel(
    rootId: string,
    ownerId: string,
    target: string,
    signal?: AbortSignal,
  ): Promise<ChildRecord> {
    return this.#withChildOperation(
      rootId,
      ownerId,
      target,
      () => this.#cancelUnlocked(rootId, ownerId, target, signal),
      { stopMonitor: true },
    );
  }

  async #cancelUnlocked(
    rootId: string,
    ownerId: string,
    target: string,
    signal?: AbortSignal,
  ): Promise<ChildRecord> {
    let child = this.#findChild(rootId, ownerId, target);
    this.#assertCurrentHerdrSession(child);
    await this.#stopMonitor(child.id);
    child = this.#findChild(rootId, ownerId, target);
    if (ACTIVE_STATES.has(child.state)) {
      try {
        await this.#assertLiveChild(child, signal);
      } catch (error) {
        if (!(error instanceof RuntimeIdentityError) && !isPositiveAgentAbsence(error)) throw error;
        child.state = "stale";
        child.error = errorMessage(error);
        child.updatedAt = this.#now();
        this.#saveChild(child);
      }
    }
    if (child.state === "stale") {
      try {
        await this.#completeFromSession(child, signal, true, false);
      } catch (error) {
        if (!(error instanceof CompletionNotProvenError)) throw error;
        child.state = "cancelled";
        child.deliveredAt = this.#now();
        child.updatedAt = child.deliveredAt;
        if (child.paneId && !isRetiredSurface(child)) {
          child.surfaceState = "cleanup-pending";
        }
        this.#saveChild(child);
      }
      child = this.#findChild(rootId, ownerId, child.id);
    }
    if (CLEANUP_TERMINAL_STATES.has(child.state)) {
      if (!isRetiredSurface(child)) await this.#cleanupSurface(child);
      return { ...this.#findChild(rootId, ownerId, child.id) };
    }
    await this.#runJson(["agent", "send-keys", child.herdrName, "escape"], signal);
    const waited = await this.#runJson(
      [
        "agent",
        "wait",
        child.herdrName,
        "--until",
        "idle",
        "--until",
        "done",
        "--timeout",
        "30000",
      ],
      signal,
    );
    const waitedAgent = objectAt(objectAt(waited, "result"), "agent");
    const status = this.#validatedAgentStatus(child, waitedAgent);
    if (status !== "idle" && status !== "done") {
      throw new Error(`Subagent ${child.semanticName} did not settle after cancellation`);
    }
    child.state = "cancelled";
    child.result = undefined;
    child.error = undefined;
    child.deliveredAt = this.#now();
    child.updatedAt = child.deliveredAt;
    if (child.paneId && !isRetiredSurface(child)) {
      child.surfaceState = "cleanup-pending";
    }
    this.#saveChild(child);
    await this.#cleanupSurface(child);
    return { ...this.#findChild(rootId, ownerId, child.id) };
  }

  async resume(
    rootId: string,
    ownerId: string,
    target: string,
    signal?: AbortSignal,
  ): Promise<ChildRecord> {
    return this.#withChildOperation(rootId, ownerId, target, () =>
      this.#resumeUnlocked(rootId, ownerId, target, signal));
  }

  async #resumeUnlocked(
    rootId: string,
    ownerId: string,
    target: string,
    signal?: AbortSignal,
  ): Promise<ChildRecord> {
    const child = this.#findChild(rootId, ownerId, target);
    this.#assertCurrentHerdrSession(child);
    if (isRetiredSurface(child)) {
      throw new Error(
        `Subagent ${child.semanticName} surface is ${child.surfaceState}; use message to reactivate it`,
      );
    }
    await this.#assertLiveChild(child, signal);
    await this.#runJson(["agent", "focus", child.herdrName], signal);
    return { ...child };
  }

  async spawn(request: SpawnRequest, signal?: AbortSignal): Promise<ChildRecord> {
    if (this.#disposed) throw new Error("Subagent orchestrator is shut down");
    if (this.#environment.HERDR_ENV !== "1") {
      throw new Error("Herdr subagents require a Herdr-managed Pi pane");
    }

    const workspaceId = this.#environment.HERDR_WORKSPACE_ID;
    if (!workspaceId || !this.#environment.HERDR_PANE_ID) {
      throw new Error("Missing explicit Herdr workspace or pane identity");
    }

    const callerDepth = parseDepth(this.#environment.HERDR_SUBAGENT_DEPTH);
    if (callerDepth >= 3) {
      throw new Error("Maximum subagent depth of 3 reached");
    }
    if (callerDepth > 0) {
      const allowedTargets = new Set(
        (this.#environment.HERDR_SUBAGENT_SPAWN_TARGETS ?? "")
          .split(",")
          .map((target) => target.trim())
          .filter(Boolean),
      );
      if (!allowedTargets.has(request.agent.name)) {
        const role = this.#environment.HERDR_SUBAGENT_ROLE ?? "child";
        throw new Error(`${role} cannot spawn role ${request.agent.name}`);
      }
    }

    const depth = callerDepth + 1;
    const rootId = this.#environment.HERDR_SUBAGENT_ROOT_ID ?? request.parentSessionId;
    const parentId = this.#environment.HERDR_SUBAGENT_AGENT_ID ?? request.parentSessionId;
    const inheritedScope = validateWorkScope(this.#environment.HERDR_SUBAGENT_WORK_SCOPE);
    const requestedScope = validateWorkScope(request.workScope);
    if (callerDepth > 0 && inheritedScope === undefined && requestedScope !== undefined) {
      throw new Error("A legacy scope-less child cannot choose a workScope");
    }
    if (inheritedScope !== undefined && requestedScope !== undefined && requestedScope !== inheritedScope) {
      throw new Error(
        `Descendant workScope ${requestedScope} does not match inherited workScope ${inheritedScope}`,
      );
    }
    const workScope = inheritedScope ?? requestedScope;
    const child = await this.#withLineageLock(rootId, async () => {
      const master = await this.#resolveMasterIdentity(
        rootId,
        callerDepth,
        signal,
        callerDepth === 0 ? request.parentSessionFile : undefined,
      );
      const existingChildren = this.#loadChildren(rootId);
      if (
        existingChildren.some(
          (candidate) =>
            candidate.parentId === parentId && candidate.semanticName === request.name,
        )
      ) {
        throw new Error(
          `A child named ${request.name} already exists for this parent; use message to continue it`,
        );
      }
      const activeChildren = existingChildren.filter((candidate) => ACTIVE_STATES.has(candidate.state));
      if (activeChildren.length >= 8) {
        throw new Error("Maximum of 8 live subagents per lineage reached");
      }
      if (activeChildren.filter((candidate) => candidate.parentId === parentId).length >= 4) {
        throw new Error("Maximum of 4 live subagents per parent reached");
      }

      const launchLoadout = resolveLaunchLoadout(request, this.#environment);
      const id = this.#id();
      const name = this.#uniqueName(rootId, herdrName(request.name, request.agent.name, id));
      const now = this.#now();
      const reserved: ChildRecord = {
        id,
        rootId,
        parentId,
        workScope,
        model: launchLoadout.model,
        thinking: launchLoadout.thinking,
        parentSessionId: request.parentSessionId,
        parentSessionFile: request.parentSessionFile,
        semanticName: request.name,
        herdrName: name,
        role: request.agent.name,
        task: request.task,
        cwd: request.cwd,
        depth,
        generation: 1,
        workspaceId: master.workspaceId,
        herdrSession: master.herdrSession,
        completionMarkerPath: join(
          this.#registryPath(rootId),
          `${slug(id)}.generation-1.complete`,
        ),
        launchLoadout,
        state: "starting",
        createdAt: now,
        updatedAt: now,
      };
      this.#saveChild(reserved);
      return reserved;
    });

    return this.#withChildRegistryLock(child.rootId, child.id, () =>
      this.#startReservedChild(child, callerDepth, signal));
  }

  async #startReservedChild(
    child: ChildRecord,
    callerDepth: number,
    signal?: AbortSignal,
  ): Promise<ChildRecord> {
    let agentStarted = false;
    try {
      await this.#withPlacementLock(child.rootId, async () => {
        await this.#createSurface(child, callerDepth, signal, true);

        await this.#runJson([
          "pane",
          "rename",
          child.paneId,
          paneLabel(child.launchLoadout.role, child.semanticName),
        ], signal);

        const piArguments = this.#piArguments(child);
        child.sessionPath = await this.#startChildAgent([
          "agent",
          "start",
          child.herdrName,
          "--kind",
          "pi",
          "--pane",
          child.paneId,
          "--timeout",
          String(AGENT_START_TIMEOUT_MILLISECONDS),
          "--",
          ...piArguments,
        ], child, undefined, () => {
          agentStarted = true;
        }, signal);
        child.updatedAt = this.#now();
        this.#saveChild(child);
      });

      await this.#runJson(["agent", "prompt", child.herdrName, child.task], signal);
      child.state = "working";
      child.updatedAt = this.#now();
      this.#saveChild(child);

      if (this.#monitor) {
        void this.#monitorChild(child);
      }
      return { ...child };
    } catch (error) {
      const cleanupErrors: string[] = [];
      if (agentStarted) {
        try {
          await this.#assertLiveChild(child);
          await this.#runJson(["agent", "send-keys", child.herdrName, "ctrl+c", "ctrl+c"]);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
        }
      }
      if (child.paneId !== undefined) {
        await this.#cleanupSurface(child);
        if (child.cleanupError) cleanupErrors.push(child.cleanupError);
      }
      child.state = "failed";
      const primaryError = error instanceof Error ? error.message : String(error);
      child.error = cleanupErrors.length > 0
        ? `${primaryError}; cleanup failed: ${cleanupErrors.join("; ")}`
        : primaryError;
      child.deliveredAt = this.#now();
      child.updatedAt = child.deliveredAt;
      this.#saveChild(child);
      throw error;
    }
  }

  #registryPath(rootId: string): string {
    return this.#environment.HERDR_SUBAGENT_REGISTRY ?? join(this.#stateDirectory, slug(rootId));
  }

  #masterPath(rootId: string): string {
    return join(this.#registryPath(rootId), ".lineage.json");
  }

  #loadMaster(rootId: string): MasterIdentity | undefined {
    const path = this.#masterPath(rootId);
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (
        !isObject(parsed) || parsed.version !== 1 || parsed.rootId !== rootId ||
        typeof parsed.herdrSession !== "string" || typeof parsed.workspaceId !== "string" ||
        typeof parsed.masterPaneId !== "string" || typeof parsed.tabId !== "string" ||
        (parsed.masterSessionPath !== undefined && typeof parsed.masterSessionPath !== "string") ||
        !Number.isSafeInteger(parsed.createdAt) || !Number.isSafeInteger(parsed.updatedAt)
      ) {
        throw new Error(`Malformed lineage master record: ${path}`);
      }
      return parsed as unknown as MasterIdentity;
    } catch (error) {
      const code = isObject(error) && typeof error.code === "string" ? error.code : undefined;
      if (code === "ENOENT") return undefined;
      throw error;
    }
  }

  #saveMaster(master: MasterIdentity): void {
    const path = this.#masterPath(master.rootId);
    const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    mkdirSync(this.#registryPath(master.rootId), { recursive: true, mode: 0o700 });
    writeFileSync(temporaryPath, `${JSON.stringify(master, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporaryPath, path);
  }

  #masterFromPane(
    rootId: string,
    pane: JsonObject,
    existing?: MasterIdentity,
    parentSessionFile?: string,
  ): MasterIdentity {
    const paneId = stringAt(pane, "pane_id");
    const tabId = stringAt(pane, "tab_id");
    const workspaceId = stringAt(pane, "workspace_id");
    const herdrSession = currentHerdrSession(this.#environment);
    if (existing && (
      existing.rootId !== rootId ||
      existing.herdrSession !== herdrSession ||
      existing.workspaceId !== workspaceId ||
      existing.masterPaneId !== paneId ||
      existing.tabId !== tabId
    )) {
      throw new RuntimeIdentityError("Lineage master identity changed");
    }
    if (pane.agent !== "pi") {
      throw new RuntimeIdentityError("Lineage master pane is not occupied by Pi");
    }
    const observedSessionPath = sessionPathFromAgent(pane);
    if (parentSessionFile !== undefined && observedSessionPath !== undefined && parentSessionFile !== observedSessionPath) {
      throw new RuntimeIdentityError("Root parent session artifact differs from the current master pane");
    }
    const masterSessionPath = parentSessionFile ?? observedSessionPath;
    if (existing?.masterSessionPath !== undefined && existing.masterSessionPath !== masterSessionPath) {
      throw new RuntimeIdentityError("Lineage master session artifact changed");
    }
    return {
      version: 1,
      rootId,
      herdrSession,
      workspaceId,
      masterPaneId: paneId,
      tabId,
      ...(existing?.masterSessionPath || masterSessionPath
        ? { masterSessionPath: existing?.masterSessionPath ?? masterSessionPath }
        : {}),
      createdAt: existing?.createdAt ?? this.#now(),
      updatedAt: this.#now(),
    };
  }

  async #resolveMasterIdentity(
    rootId: string,
    callerDepth: number,
    signal?: AbortSignal,
    parentSessionFile?: string,
  ): Promise<MasterIdentity> {
    const persisted = this.#loadMaster(rootId);
    if (callerDepth === 0) {
      const response = await this.#runJson(["pane", "current", "--current"], signal);
      const pane = objectAt(objectAt(response, "result"), "pane");
      if (pane.pane_id !== this.#environment.HERDR_PANE_ID) {
        throw new RuntimeIdentityError("Root caller pane differs from explicit Herdr pane identity");
      }
      if (pane.workspace_id !== this.#environment.HERDR_WORKSPACE_ID) {
        throw new RuntimeIdentityError("Root caller workspace differs from explicit Herdr workspace identity");
      }
      const master = this.#masterFromPane(rootId, pane, persisted, parentSessionFile);
      if (!persisted || master.tabId !== persisted.tabId || master.updatedAt !== persisted.updatedAt) {
        this.#saveMaster(master);
      }
      return master;
    }

    const expected = {
      rootId: this.#environment.HERDR_SUBAGENT_MASTER_ROOT_ID,
      herdrSession: this.#environment.HERDR_SUBAGENT_MASTER_HERDR_SESSION,
      workspaceId: this.#environment.HERDR_SUBAGENT_MASTER_WORKSPACE_ID,
      masterPaneId: this.#environment.HERDR_SUBAGENT_MASTER_PANE_ID,
      masterTabId: this.#environment.HERDR_SUBAGENT_MASTER_TAB_ID,
      masterSessionPath: this.#environment.HERDR_SUBAGENT_MASTER_SESSION_PATH,
    };
    if (
      !expected.rootId || !expected.herdrSession || !expected.workspaceId || !expected.masterPaneId ||
      !expected.masterTabId || !expected.masterSessionPath || !persisted || !persisted.masterSessionPath
    ) {
      throw new RuntimeIdentityError(
        "Descendant cannot prove the persisted lineage master identity; reload the parent Pi agent",
      );
    }
    if (
      expected.rootId !== persisted.rootId ||
      expected.herdrSession !== persisted.herdrSession ||
      expected.workspaceId !== persisted.workspaceId ||
      expected.masterPaneId !== persisted.masterPaneId ||
      expected.masterTabId !== persisted.tabId ||
      expected.masterSessionPath !== persisted.masterSessionPath ||
      this.#environment.HERDR_WORKSPACE_ID !== persisted.workspaceId ||
      currentHerdrSession(this.#environment) !== persisted.herdrSession
    ) {
      throw new RuntimeIdentityError("Descendant lineage master identity does not match its environment");
    }
    const response = await this.#runJson(["pane", "get", persisted.masterPaneId], signal);
    const pane = objectAt(objectAt(response, "result"), "pane");
    if (pane.pane_id !== persisted.masterPaneId || pane.workspace_id !== persisted.workspaceId) {
      throw new RuntimeIdentityError("Lineage master pane identity changed");
    }
    if (pane.agent !== "pi") {
      throw new RuntimeIdentityError("Lineage master pane is not occupied by Pi");
    }
    const masterSessionPath = sessionPathFromAgent(pane);
    if (masterSessionPath === undefined || persisted.masterSessionPath !== masterSessionPath) {
      throw new RuntimeIdentityError("Lineage master session artifact changed");
    }
    const tabId = stringAt(pane, "tab_id");
    if (tabId !== persisted.tabId) {
      throw new RuntimeIdentityError("Lineage master tab identity changed");
    }
    const master = {
      ...persisted,
      updatedAt: this.#now(),
    };
    if (master.updatedAt !== persisted.updatedAt) this.#saveMaster(master);
    return master;
  }

  #masterLayout(value: JsonObject, master: MasterIdentity): PaneLayout {
    const layout = objectAt(objectAt(value, "result"), "layout");
    if (
      typeof layout.tab_id !== "string" ||
      layout.tab_id !== master.tabId ||
      typeof layout.workspace_id !== "string" ||
      layout.workspace_id !== master.workspaceId ||
      !Array.isArray(layout.panes)
    ) {
      throw new RuntimeIdentityError("Lineage master layout identity changed");
    }
    const panes = layout.panes.flatMap((entry): PaneLayout["panes"] => {
      if (!isObject(entry) || typeof entry.pane_id !== "string" || !isObject(entry.rect)) return [];
      const width = entry.rect.width;
      const height = entry.rect.height;
      if (
        typeof width !== "number" || !Number.isFinite(width) || width <= 0 ||
        typeof height !== "number" || !Number.isFinite(height) || height <= 0
      ) return [];
      return [{ paneId: entry.pane_id, width, height, area: width * height }];
    });
    if (!panes.some((pane) => pane.paneId === master.masterPaneId)) {
      throw new RuntimeIdentityError("Lineage master pane is absent from its current layout");
    }
    return { tabId: master.tabId, workspaceId: master.workspaceId, panes };
  }

  async #ownedLayoutPanes(
    child: ChildRecord,
    master: MasterIdentity,
    layout: PaneLayout,
    signal?: AbortSignal,
  ): Promise<PaneLayout["panes"]> {
    const records = this.#loadChildren(child.rootId).filter((candidate) =>
      candidate.id !== child.id &&
      candidate.paneId !== undefined &&
      candidate.workspaceId === master.workspaceId &&
      candidate.herdrSession === master.herdrSession &&
      !isRetiredSurface(candidate),
    );
    const owned: PaneLayout["panes"] = [];
    for (const owner of records) {
      try {
        const response = await this.#runJson(["pane", "get", owner.paneId!], signal);
        const observed = objectAt(objectAt(response, "result"), "pane");
        if (typeof observed.tab_id !== "string" || observed.tab_id.length === 0) {
          throw new SurfaceOwnershipUnprovenError(`Pane tab identity is unproven for ${owner.paneId}`);
        }
        if (observed.tab_id !== master.tabId) {
          throw new RuntimeIdentityError("An owned pane moved to another tab; refusing placement");
        }
        // An empty or transient pane observation is checked against the
        // foreground process as well. Unproven observations are skipped by
        // the ownership helper and cannot become placement targets.
        await this.#assertOwnedPane(owner, observed, signal);
        const pane = layout.panes.find((candidate) => candidate.paneId === owner.paneId);
        if (pane) owned.push(pane);
      } catch (error) {
        if (error instanceof SurfaceOwnershipLostError) {
          throw new RuntimeIdentityError(`An owned pane moved or was replaced; refusing placement (${error.message})`);
        }
        if (error instanceof SurfaceOwnershipUnprovenError || isPositivePaneAbsence(error)) continue;
        throw error;
      }
    }
    return owned;
  }

  async #withPlacementLock<T>(rootId: string, operation: () => Promise<T>): Promise<T> {
    const directory = this.#registryPath(rootId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return withRegistryLock(join(directory, ".lineage-placement.lock"), operation, {
      timeoutSeconds: PLACEMENT_LOCK_TIMEOUT_SECONDS,
    });
  }

  async #createSurface(
    child: ChildRecord,
    callerDepth: number,
    signal?: AbortSignal,
    placementLocked = false,
  ): Promise<void> {
    const create = async () => {
      const master = await this.#resolveMasterIdentity(child.rootId, callerDepth, signal);
      const layout = this.#masterLayout(
        await this.#runJson(["pane", "layout", "--pane", master.masterPaneId], signal),
        master,
      );
      const owned = await this.#ownedLayoutPanes(child, master, layout, signal);
      const candidates = [
        layout.panes.find((pane) => pane.paneId === master.masterPaneId)!,
        ...owned,
      ];
      const target = [...new Map(candidates.map((pane) => [pane.paneId, pane])).values()]
        .sort((left, right) => right.area - left.area)[0];
      if (!target) throw new RuntimeIdentityError("Lineage master layout has no split candidate");
      const propagatedEnvironment = this.#propagatedEnvironment(child, master);
      const created = await this.#runJson([
        "pane",
        "split",
        "--pane",
        target.paneId,
        "--direction",
        "down",
        "--ratio",
        "0.5",
        "--cwd",
        child.launchLoadout.cwd,
        ...propagatedEnvironment.flatMap((value) => ["--env", value]),
        "--no-focus",
      ], signal);
      const pane = objectAt(objectAt(created, "result"), "pane");
      const paneId = stringAt(pane, "pane_id");
      const reportedTabId = typeof pane.tab_id === "string" && pane.tab_id.length > 0
        ? pane.tab_id
        : undefined;
      const workspaceId = typeof pane.workspace_id === "string" && pane.workspace_id.length > 0
        ? pane.workspace_id
        : undefined;
      // Publish the pane before validating its identity. Any later failure can
      // then use the ordinary ownership-checked, pane-only cleanup path.
      // Record the expected lineage tab rather than an untrusted response tab,
      // so cleanup can prove that the current pane still occupies that tab.
      child.paneId = paneId;
      child.tabId = master.tabId;
      child.surfaceState = "open";
      child.updatedAt = this.#now();
      this.#saveChild(child);
      if (!reportedTabId) throw new Error("Malformed Herdr response: missing string tab_id");
      if (workspaceId !== undefined && workspaceId !== master.workspaceId) {
        throw new RuntimeIdentityError("Subagent split created in a different workspace than the master pane");
      }
      if (reportedTabId !== master.tabId) {
        throw new RuntimeIdentityError("Subagent split created in a different tab than the master Pi pane");
      }
      const verifiedLayout = this.#masterLayout(
        await this.#runJson(["pane", "layout", "--pane", master.masterPaneId], signal),
        master,
      );
      if (!verifiedLayout.panes.some((candidate) => candidate.paneId === paneId)) {
        throw new RuntimeIdentityError(`Subagent split pane is not live: ${paneId}`);
      }
    };
    if (placementLocked) await create();
    else await this.#withPlacementLock(child.rootId, create);
  }

  #assertCurrentHerdrSession(child: ChildRecord): void {
    const currentSession = currentHerdrSession(this.#environment);
    if (child.herdrSession !== currentSession) {
      const ownerSession = child.herdrSession ?? "unknown";
      throw new Error(
        `Cannot operate on ${child.semanticName}: child belongs to Herdr session ${ownerSession}, ` +
          `current session is ${currentSession}`,
      );
    }
  }

  #propagatedEnvironment(child: ChildRecord, master: MasterIdentity): string[] {
    return [
      `HERDR_SUBAGENT_DEPTH=${child.depth}`,
      `HERDR_SUBAGENT_ROOT_ID=${child.rootId}`,
      `HERDR_SUBAGENT_PARENT_ID=${child.parentId}`,
      `HERDR_SUBAGENT_AGENT_ID=${child.id}`,
      `HERDR_SUBAGENT_GENERATION=${child.generation}`,
      `HERDR_SUBAGENT_MASTER_ROOT_ID=${master.rootId}`,
      `HERDR_SUBAGENT_MASTER_HERDR_SESSION=${master.herdrSession}`,
      `HERDR_SUBAGENT_MASTER_WORKSPACE_ID=${master.workspaceId}`,
      `HERDR_SUBAGENT_MASTER_PANE_ID=${master.masterPaneId}`,
      `HERDR_SUBAGENT_MASTER_TAB_ID=${master.tabId}`,
      ...(master.masterSessionPath ? [`HERDR_SUBAGENT_MASTER_SESSION_PATH=${master.masterSessionPath}`] : []),
      ...(child.workScope ? [`HERDR_SUBAGENT_WORK_SCOPE=${child.workScope}`] : []),
      `HERDR_SUBAGENT_REGISTRY=${this.#registryPath(child.rootId)}`,
      `HERDR_SUBAGENT_COMPLETION_MARKER=${child.completionMarkerPath}`,
      `HERDR_SUBAGENT_ROLE=${child.launchLoadout.role}`,
      `HERDR_SUBAGENT_SPAWN_TARGETS=${child.launchLoadout.spawnTargets.join(",")}`,
      ...Object.entries(child.launchLoadout.environment).map(
        ([key, value]) => `${key}=${value}`,
      ),
    ];
  }

  #piArguments(child: ChildRecord, sessionPath?: string): string[] {
    const loadout = child.launchLoadout;
    const arguments_: string[] = [
      "--name",
      displayLabel(child.semanticName),
      "--extension",
      CHILD_COMPLETION_EXTENSION,
    ];
    if (loadout.model) arguments_.push("--model", loadout.model);
    if (loadout.thinking) arguments_.push("--thinking", loadout.thinking);
    arguments_.push("--tools", loadout.tools.join(","));
    if (loadout.systemPrompt) {
      arguments_.push("--append-system-prompt", loadout.systemPrompt.path);
    }
    for (const skill of loadout.skills) arguments_.push("--skill", skill.path);
    if (sessionPath) arguments_.push("--session", sessionPath);
    return arguments_;
  }

  #verifyRelaunchArtifacts(child: ChildRecord): {
    sessionPath: string;
    startedAfterEntryId: string;
  } {
    const loadout = child.launchLoadout;
    if (
      !loadout ||
      loadout.version !== 1 ||
      loadout.role !== child.role ||
      (loadout.model !== undefined && typeof loadout.model !== "string") ||
      (loadout.thinking !== undefined && typeof loadout.thinking !== "string") ||
      !isStringArray(loadout.tools) ||
      !Array.isArray(loadout.skills) ||
      !loadout.skills.every(isContentArtifact) ||
      (loadout.systemPrompt !== undefined && !isContentArtifact(loadout.systemPrompt)) ||
      !isStringArray(loadout.spawnTargets) ||
      !isSafePiEnvironment(loadout.environment) ||
      loadout.cwd !== child.cwd
    ) {
      throw new Error(`Cannot reactivate ${child.semanticName}: saved launch loadout is invalid`);
    }
    if (
      !environmentsMatch(loadout.environment, safePiEnvironment(this.#environment))
    ) {
      throw new Error(
        `Cannot reactivate ${child.semanticName}: ` +
          "saved Pi environment no longer matches the current parent environment",
      );
    }
    if (!child.sessionPath) {
      throw new Error(`Cannot reactivate ${child.semanticName}: saved session artifact is missing`);
    }
    let sessionResult: ReturnType<typeof finalAssistantResult>;
    try {
      sessionResult = finalAssistantResult(child.sessionPath);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Cannot reactivate ${child.semanticName}: saved session artifact is invalid: ${reason}`,
      );
    }
    for (const [label, artifact] of [
      ...(loadout.systemPrompt ? [["system prompt", loadout.systemPrompt] as const] : []),
      ...loadout.skills.map((skill) => ["skill", skill] as const),
    ]) {
      let sha256: string;
      try {
        sha256 = createHash("sha256").update(readFileSync(artifact.path)).digest("hex");
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Cannot reactivate ${child.semanticName}: saved ${label} artifact is missing: ${reason}`,
        );
      }
      if (sha256 !== artifact.sha256) {
        throw new Error(
          `Cannot reactivate ${child.semanticName}: saved ${label} artifact changed at ${artifact.path}`,
        );
      }
    }
    return { sessionPath: child.sessionPath, startedAfterEntryId: sessionResult.entryId };
  }

  async #relaunchClosedChild(
    child: ChildRecord,
    message: string,
    signal?: AbortSignal,
  ): Promise<ChildRecord> {
    this.#assertCurrentHerdrSession(child);
    const { sessionPath, startedAfterEntryId } = this.#verifyRelaunchArtifacts(child);
    const callerPaneId = this.#environment.HERDR_PANE_ID;
    if (!callerPaneId) {
      throw new Error(`Cannot reactivate ${child.semanticName}: missing owner Herdr pane identity`);
    }

    child.generation += 1;
    child.completionMarkerPath = join(
      this.#registryPath(child.rootId),
      `${slug(child.id)}.generation-${child.generation}.complete`,
    );
    child.startedAfterEntryId = startedAfterEntryId;
    child.state = "starting";
    child.result = undefined;
    child.error = undefined;
    child.deliveredAt = undefined;
    child.cleanupError = undefined;
    child.tabId = undefined;
    child.paneId = undefined;
    child.updatedAt = this.#now();
    this.#saveChild(child);

    let agentStarted = false;
    try {
      await this.#withPlacementLock(child.rootId, async () => {
        await this.#createSurface(child, child.depth - 1, signal, true);

        await this.#runJson([
          "pane",
          "rename",
          child.paneId,
          paneLabel(child.launchLoadout.role, child.semanticName),
        ], signal);
        child.sessionPath = await this.#startChildAgent([
          "agent",
          "start",
          child.herdrName,
          "--kind",
          "pi",
          "--pane",
          child.paneId,
          "--timeout",
          String(AGENT_START_TIMEOUT_MILLISECONDS),
          "--",
          ...this.#piArguments(child, sessionPath),
        ], child, sessionPath, () => {
          agentStarted = true;
        }, signal);
        child.updatedAt = this.#now();
        this.#saveChild(child);
      });

      await this.#runJson(["agent", "prompt", child.herdrName, message], signal);
      child.state = "working";
      child.updatedAt = this.#now();
      this.#saveChild(child);
      if (this.#monitor) void this.#monitorChild(child);
      return { ...child };
    } catch (error) {
      if (agentStarted) {
        try {
          await this.#assertLiveChild(child);
          await this.#runJson(["agent", "send-keys", child.herdrName, "ctrl+c", "ctrl+c"]);
        } catch {
          // Preserve the primary reactivation failure.
        }
      }
      if (child.paneId !== undefined) {
        await this.#cleanupSurface(child);
      }
      child.state = "failed";
      child.error = error instanceof Error ? error.message : String(error);
      child.deliveredAt = this.#now();
      child.updatedAt = child.deliveredAt;
      this.#saveChild(child);
      throw error;
    }
  }

  async #withChildOperation<T>(
    rootId: string,
    ownerId: string,
    target: string,
    operation: () => Promise<T>,
    { durable = true, stopMonitor = false }: { durable?: boolean; stopMonitor?: boolean } = {},
  ): Promise<T> {
    const childId = this.#findChild(rootId, ownerId, target).id;
    // Stop this process's monitor before taking the durable lock. A monitor
    // may be waiting on Herdr, and waiting for its lock here would otherwise
    // prevent cancellation from reaching its AbortController.
    if (stopMonitor) await this.#stopMonitor(childId);
    const previous = this.#childOperations.get(childId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => {}).then(() => gate);
    this.#childOperations.set(childId, queued);
    await previous.catch(() => {});
    try {
      return await (durable
        ? this.#withChildRegistryLock(rootId, childId, operation)
        : operation());
    } catch (error) {
      try {
        const child = this.#findChild(rootId, ownerId, childId);
        this.#assertCurrentHerdrSession(child);
        if (this.#monitor && (child.state === "working" || child.state === "blocked")) {
          void this.#monitorChild(child);
        }
      } catch {
        // Preserve the original control error if identity or registry recovery fails.
      }
      throw error;
    } finally {
      release();
      if (this.#childOperations.get(childId) === queued) {
        this.#childOperations.delete(childId);
      }
    }
  }

  async #withChildRegistryLock<T>(
    rootId: string,
    childId: string,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const directory = this.#registryPath(rootId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return withRegistryLock(join(directory, `.${slug(childId)}.lifecycle.lock`), operation);
  }

  async #withLineageLock<T>(rootId: string, operation: () => T): Promise<T> {
    const directory = this.#registryPath(rootId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return withRegistryLock(join(directory, ".allocation.lock"), operation);
  }

  #loadChildren(rootId: string): ChildRecord[] {
    const directory = this.#registryPath(rootId);
    let entries: string[];
    try {
      entries = readdirSync(directory).filter(
        (entry) => entry.endsWith(".json") && !entry.startsWith("."),
      );
    } catch (error) {
      const code = isObject(error) && typeof error.code === "string" ? error.code : undefined;
      if (code === "ENOENT") return [];
      throw error;
    }

    const children: ChildRecord[] = [];
    for (const entry of entries) {
      const path = join(directory, entry);
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!isObject(parsed) || parsed.rootId !== rootId || typeof parsed.id !== "string") {
        throw new Error(`Malformed subagent registry record: ${path}`);
      }
      children.push(parsed as unknown as ChildRecord);
    }
    return children;
  }

  #saveChild(child: ChildRecord): void {
    const directory = this.#registryPath(child.rootId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${slug(child.id)}.json`);
    let currentRevision = 0;
    try {
      const current: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!isObject(current)) throw new Error(`Malformed subagent registry record: ${path}`);
      if (typeof current.generation === "number" && current.generation > child.generation) {
        throw new StaleGenerationError(
          `Refusing to overwrite generation ${current.generation} with ${child.generation}`,
        );
      }
      if (current.revision !== undefined &&
        (!Number.isSafeInteger(current.revision) || current.revision < 0)) {
        throw new Error(`Malformed subagent registry revision: ${path}`);
      }
      currentRevision = typeof current.revision === "number" ? current.revision : 0;
    } catch (error) {
      const code = isObject(error) && typeof error.code === "string" ? error.code : undefined;
      if (code !== "ENOENT") throw error;
    }
    const expectedRevision = child.revision ?? 0;
    if (currentRevision !== expectedRevision) {
      throw new StaleRevisionError(
        `Refusing to overwrite revision ${currentRevision} with ${expectedRevision} for ${child.id}`,
      );
    }
    const next = { ...child, revision: currentRevision + 1 };
    const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporaryPath, path);
    child.revision = next.revision;
  }

  #findChild(rootId: string, ownerId: string, target: string): ChildRecord {
    const matches = this.#loadChildren(rootId).filter(
      (child) =>
        child.parentId === ownerId &&
        (child.id === target || child.semanticName === target || child.herdrName === target),
    );
    if (matches.length === 0) throw new Error(`Unknown subagent: ${target}`);
    if (matches.length > 1) throw new Error(`Ambiguous subagent name: ${target}`);
    return { ...matches[0] };
  }

  async #assertLiveChild(child: ChildRecord, signal?: AbortSignal): Promise<void> {
    const response = await this.#runJson(["agent", "get", child.herdrName], signal);
    this.#validatedAgentStatus(child, objectAt(objectAt(response, "result"), "agent"));
  }

  #validatedAgentStatus(child: ChildRecord, agent: JsonObject): string {
    const paneId = stringAt(agent, "pane_id");
    if (!child.paneId || paneId !== child.paneId) {
      throw new RuntimeIdentityError(`Herdr pane identity changed for ${child.herdrName}`);
    }
    const reportedSessionPath = sessionPathFromAgent(agent);
    if (!child.sessionPath || !reportedSessionPath || reportedSessionPath !== child.sessionPath) {
      throw new RuntimeIdentityError(`Herdr session artifact changed for ${child.herdrName}`);
    }
    return stringAt(agent, "agent_status");
  }

  #uniqueName(rootId: string, desired: string): string {
    const existing = new Set(this.#loadChildren(rootId).map((child) => child.herdrName));
    if (!existing.has(desired)) return desired;
    for (let suffix = 2; suffix < 10_000; suffix += 1) {
      const marker = `-${suffix}`;
      const candidate = `${desired.slice(0, 32 - marker.length)}${marker}`;
      if (!existing.has(candidate)) return candidate;
    }
    throw new Error(`Could not allocate a unique Herdr name for ${desired}`);
  }

  async #startAgent(args: string[], signal?: AbortSignal): Promise<JsonObject> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      signal?.throwIfAborted();
      try {
        return await this.#runJson(args, signal);
      } catch (error) {
        lastError = error;
        if (!(error instanceof Error) || !error.message.includes("agent_pane_busy")) throw error;
        await new Promise<void>((resolveDelay, rejectDelay) => {
          const abort = () => {
            clearTimeout(timeout);
            rejectDelay(signal?.reason ?? new Error("Agent startup aborted"));
          };
          const timeout = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolveDelay();
          }, 100);
          signal?.addEventListener("abort", abort, { once: true });
        });
      }
    }
    throw lastError;
  }

  #startedSessionPath(
    child: ChildRecord,
    response: JsonObject,
    expectedSessionPath?: string,
  ): string | undefined {
    const result = response.result;
    if (!isObject(result) || !isObject(result.agent)) return undefined;
    const agent = result.agent;
    if (typeof agent.pane_id !== "string") return undefined;
    if (!child.paneId || agent.pane_id !== child.paneId) {
      throw new RuntimeIdentityError(`Herdr pane identity changed for ${child.herdrName}`);
    }
    const sessionPath = sessionPathFromAgent(agent);
    if (sessionPath === undefined) return undefined;
    if (expectedSessionPath !== undefined && sessionPath !== expectedSessionPath) {
      throw new RuntimeIdentityError(
        `Herdr relaunched ${child.semanticName} with a different session artifact`,
      );
    }
    return sessionPath;
  }

  async #startChildAgent(
    args: string[],
    child: ChildRecord,
    expectedSessionPath: string | undefined,
    markStarted: () => void,
    signal?: AbortSignal,
  ): Promise<string> {
    let started: JsonObject | undefined;
    let malformedStartError: Error | undefined;
    try {
      started = await this.#startAgent(args, signal);
      markStarted();
    } catch (error) {
      if (!(error instanceof Error) ||
        error.message !== "Malformed Herdr JSON for command: herdr agent start") throw error;
      malformedStartError = error;
      markStarted();
    }

    if (started !== undefined) {
      const reportedSessionPath = this.#startedSessionPath(
        child,
        started,
        expectedSessionPath,
      );
      if (reportedSessionPath !== undefined) return reportedSessionPath;
    }

    let reconciled: JsonObject;
    try {
      reconciled = await this.#runJson(["agent", "get", child.herdrName], signal);
    } catch (error) {
      if (malformedStartError === undefined) throw error;
      throw new Error(
        `${malformedStartError.message}; startup reconciliation failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    const reconciledSessionPath = this.#startedSessionPath(
      child,
      reconciled,
      expectedSessionPath,
    );
    if (reconciledSessionPath === undefined) {
      throw new RuntimeIdentityError(
        `Herdr did not report a persistent session for ${child.herdrName}`,
      );
    }
    return reconciledSessionPath;
  }

  async #runJson(args: string[], signal?: AbortSignal): Promise<JsonObject> {
    const execution = await this.#transport.run(args, signal);
    if (execution.code !== 0) {
      throw new Error(execution.stderr.trim() || `Herdr command failed: herdr ${args.slice(0, 2).join(" ")}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(execution.stdout);
    } catch {
      throw new Error(`Malformed Herdr JSON for command: herdr ${args.slice(0, 2).join(" ")}`);
    }
    if (!isObject(parsed)) {
      throw new Error(`Herdr command returned an error: herdr ${args.slice(0, 2).join(" ")}`);
    }
    if ("error" in parsed) {
      const reportedError = parsed.error;
      const code = isObject(reportedError) && typeof reportedError.code === "string"
        ? reportedError.code
        : undefined;
      const message = isObject(reportedError) && typeof reportedError.message === "string"
        ? reportedError.message
        : undefined;
      throw new Error(
        [code, message].filter((part) => part !== undefined).join(": ") ||
          `Herdr command returned an error: herdr ${args.slice(0, 2).join(" ")}`,
      );
    }
    return parsed;
  }

  async #saveMonitoredChild(child: ChildRecord): Promise<boolean> {
    try {
      return await this.#withChildRegistryLock(child.rootId, child.id, () => {
        const current = this.#findChild(child.rootId, child.parentId, child.id);
        if (
          current.generation !== child.generation ||
          current.revision !== child.revision ||
          isRetiredSurface(current)
        ) return false;
        this.#saveChild(child);
        return true;
      });
    } catch (error) {
      if (error instanceof StaleRevisionError) return false;
      throw error;
    }
  }

  async #crashMonitoredChild(child: ChildRecord, error: string): Promise<boolean> {
    try {
      return await this.#withChildRegistryLock(child.rootId, child.id, async () => {
        const current = this.#findChild(child.rootId, child.parentId, child.id);
        if (
          current.generation !== child.generation ||
          current.revision !== child.revision ||
          !ACTIVE_STATES.has(current.state)
        ) return false;
        current.state = "crashed";
        current.error = error;
        current.updatedAt = this.#now();
        this.#saveChild(current);
        if (await this.#deliver(current)) await this.#cleanupSurface(current);
        return true;
      });
    } catch (lockError) {
      if (lockError instanceof StaleRevisionError) return false;
      throw lockError;
    }
  }

  #monitorChild(initialChild: ChildRecord): Promise<void> {
    const existing = this.#monitorTasks.get(initialChild.id);
    if (existing) return existing;
    if (this.#disposed) return Promise.resolve();
    const task = this.#runMonitor(initialChild)
      .catch(async (error) => {
        for (let attempt = 0; attempt < 10; attempt += 1) {
          try {
            const child = this.#findChild(
              initialChild.rootId,
              initialChild.parentId,
              initialChild.id,
            );
            child.lifecycleError = `Detached monitor failed: ${errorMessage(error)}`;
            child.updatedAt = this.#now();
            if (await this.#saveMonitoredChild(child)) return;
            return;
          } catch {
            await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
          }
        }
        // Detached monitor failures must never become unhandled rejections.
      })
      .finally(() => {
        if (this.#monitorTasks.get(initialChild.id) === task) {
          this.#monitorTasks.delete(initialChild.id);
        }
      });
    this.#monitorTasks.set(initialChild.id, task);
    return task;
  }

  async #stopMonitor(childId: string): Promise<void> {
    this.#monitorControllers.get(childId)?.abort();
    try {
      await this.#monitorTasks.get(childId);
    } catch {
      // Abort rejection is consumed before the next lifecycle operation starts.
    }
  }

  async #runMonitor(initialChild: ChildRecord): Promise<void> {
    const controller = new AbortController();
    this.#monitorControllers.set(initialChild.id, controller);
    const child = { ...initialChild };
    try {
      let waitUntilUnblocked = child.state === "blocked";
      while (true) {
        let reported: JsonObject;
        try {
          reported = await this.#runJson(
            [
              "agent",
              "wait",
              child.herdrName,
              ...(waitUntilUnblocked ? ["--until", "idle", "--until", "done"] : []),
              "--timeout",
              "86400000",
            ],
            controller.signal,
          );
        } catch (waitError) {
          if (this.#disposed || controller.signal.aborted) return;
          try {
            reported = await this.#runJson(["agent", "get", child.herdrName], controller.signal);
          } catch (reconcileError) {
            if (this.#disposed || controller.signal.aborted) return;
            if (isPositiveAgentAbsence(reconcileError)) {
              await this.#crashMonitoredChild(child, errorMessage(waitError));
              return;
            }
            child.state = "stale";
            child.error = `Could not reconcile failed Herdr wait: ${errorMessage(reconcileError)}`;
            child.updatedAt = this.#now();
            if (!await this.#saveMonitoredChild(child)) return;
            return;
          }
        }
        if (this.#disposed || controller.signal.aborted) return;
        const current = this.#findChild(child.rootId, child.parentId, child.id);
        if (current.generation !== child.generation) return;
        const agent = objectAt(objectAt(reported, "result"), "agent");
        let status: string;
        try {
          status = this.#validatedAgentStatus(child, agent);
        } catch (error) {
          child.state = "stale";
          child.error = errorMessage(error);
          child.updatedAt = this.#now();
          if (!await this.#saveMonitoredChild(child)) return;
          return;
        }
        if (status === "working" || status === "blocked") {
          child.state = status;
          child.updatedAt = this.#now();
          if (!await this.#saveMonitoredChild(child)) return;
          waitUntilUnblocked = status === "blocked";
          continue;
        }
        if (status !== "idle" && status !== "done") {
          child.state = "stale";
          child.error = `Unexpected settled Herdr agent status: ${status}`;
          child.updatedAt = this.#now();
          if (!await this.#saveMonitoredChild(child)) return;
          return;
        }
        await this.#monitorCompletionProof(child, controller.signal);
        return;
      }
    } catch (error) {
      if (this.#disposed || controller.signal.aborted) return;
      child.state = child.state === "cancelled" ? "cancelled" : "stale";
      child.error = errorMessage(error);
      child.updatedAt = this.#now();
      await this.#saveMonitoredChild(child);
    } finally {
      if (this.#monitorControllers.get(child.id) === controller) {
        this.#monitorControllers.delete(child.id);
      }
    }
  }

  async #monitorCompleteFromSession(
    child: ChildRecord,
    signal: AbortSignal,
  ): Promise<boolean> {
    return this.#withChildRegistryLock(child.rootId, child.id, async () => {
      const current = this.#findChild(child.rootId, child.parentId, child.id);
      if (
        current.generation !== child.generation ||
        current.revision !== child.revision ||
        !ACTIVE_STATES.has(current.state)
      ) return false;
      await this.#completeFromSession(child, signal);
      return true;
    });
  }

  async #monitorCompletionProof(child: ChildRecord, signal: AbortSignal): Promise<void> {
    while (true) {
      const current = this.#findChild(child.rootId, child.parentId, child.id);
      if (current.generation !== child.generation || !ACTIVE_STATES.has(current.state)) return;

      try {
        if (await this.#monitorCompleteFromSession(child, signal)) return;
        return;
      } catch (error) {
        if (!(error instanceof CompletionNotProvenError)) throw error;
      }
      signal.throwIfAborted();

      let reported: JsonObject;
      try {
        reported = await this.#runJson(["agent", "get", child.herdrName], signal);
      } catch (observeError) {
        if (!isPositiveAgentAbsence(observeError)) {
          child.state = "stale";
          child.error =
            `Could not observe Herdr agent while awaiting completion proof: ${errorMessage(observeError)}`;
          child.updatedAt = this.#now();
          if (!await this.#saveMonitoredChild(child)) return;
          return;
        }

        try {
          if (await this.#monitorCompleteFromSession(child, signal)) return;
          return;
        } catch (completionError) {
          if (!(completionError instanceof CompletionNotProvenError)) throw completionError;
        }
        await this.#crashMonitoredChild(
          child,
          `Herdr agent disappeared while awaiting completion proof: ${errorMessage(observeError)}`,
        );
        return;
      }
      signal.throwIfAborted();

      const latest = this.#findChild(child.rootId, child.parentId, child.id);
      if (latest.generation !== child.generation || !ACTIVE_STATES.has(latest.state)) return;
      const agent = objectAt(objectAt(reported, "result"), "agent");
      let status: string;
      try {
        status = this.#validatedAgentStatus(child, agent);
      } catch (error) {
        child.state = "stale";
        child.error = errorMessage(error);
        child.updatedAt = this.#now();
        if (!await this.#saveMonitoredChild(child)) return;
        return;
      }
      if (status === "working" || status === "blocked") {
        child.state = status;
        child.updatedAt = this.#now();
        if (!await this.#saveMonitoredChild(child)) return;
        continue;
      }
      if (status === "idle" || status === "done") {
        child.updatedAt = this.#now();
        if (!await this.#saveMonitoredChild(child)) return;
        continue;
      }
      child.state = "stale";
      child.error = `Unexpected Herdr agent status while awaiting completion proof: ${status}`;
      child.updatedAt = this.#now();
      if (!await this.#saveMonitoredChild(child)) return;
      return;
    }
  }

  async #completeFromSession(
    child: ChildRecord,
    signal?: AbortSignal,
    allowExistingResult = false,
    cleanupSurface = true,
  ): Promise<void> {
    let lastError: CompletionNotProvenError | undefined;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await this.#completeFromSessionOnce(
          child,
          signal,
          allowExistingResult,
          cleanupSurface,
        );
        return;
      } catch (error) {
        if (!(error instanceof CompletionNotProvenError)) throw error;
        lastError = error;
        if (attempt < 9) await abortableDelay(25, signal);
      }
    }
    throw lastError;
  }

  async #completeFromSessionOnce(
    child: ChildRecord,
    signal?: AbortSignal,
    allowExistingResult = false,
    cleanupSurface = true,
  ): Promise<void> {
    const marker = completionMarkerAt(child.completionMarkerPath);
    if (marker?.childId !== child.id || marker.generation !== child.generation) {
      throw new CompletionNotProvenError(
        `Child ${child.herdrName} has no valid completion marker for generation ${child.generation}`,
      );
    }
    if (!child.sessionPath) {
      throw new Error(`Herdr did not report a persistent session for ${child.herdrName}`);
    }
    if (marker.sessionPath !== child.sessionPath) {
      throw new CompletionNotProvenError(
        `Child ${child.herdrName} completion marker names a different session artifact`,
      );
    }
    const result = await finalAssistantResultWithRetry(
      child.sessionPath,
      allowExistingResult ? undefined : child.startedAfterEntryId,
      signal,
    );
    if (result.stopReason !== marker.stopReason || result.entryId !== marker.entryId) {
      throw new CompletionNotProvenError(
        `Child ${child.herdrName} completion marker does not match its session artifact`,
      );
    }
    child.result = result.text;
    child.state = result.stopReason === "aborted"
      ? "cancelled"
      : result.stopReason === "error"
        ? "failed"
        : "completed";
    child.error = result.stopReason === "error" ? result.errorMessage : undefined;
    child.updatedAt = this.#now();
    this.#saveChild(child);
    if (await this.#deliver(child) && cleanupSurface) await this.#cleanupSurface(child);
  }

  async #deliver(child: ChildRecord): Promise<boolean> {
    if (child.deliveredAt !== undefined) return true;
    if (!this.#onCompletion) return false;
    try {
      if (!(await this.#onCompletion({ ...child }))) return false;
    } catch (error) {
      child.lifecycleError = `Completion delivery failed: ${errorMessage(error)}`;
      child.updatedAt = this.#now();
      this.#saveChild(child);
      return false;
    }
    child.deliveredAt = this.#now();
    child.lifecycleError = undefined;
    child.updatedAt = child.deliveredAt;
    this.#saveChild(child);
    return true;
  }

  async #assertOwnedPane(
    identity: Pick<ChildRecord, "paneId" | "tabId" | "workspaceId" | "sessionPath">,
    pane: JsonObject,
    signal?: AbortSignal,
  ): Promise<void> {
    if (pane.pane_id !== identity.paneId) {
      if (typeof pane.pane_id === "string") {
        throw new SurfaceOwnershipLostError(`Pane identity changed for ${identity.paneId}; preserving pane`);
      }
      throw new SurfaceOwnershipUnprovenError(`Pane identity is unproven for ${identity.paneId}`);
    }
    if (typeof pane.workspace_id !== "string" ||
      (identity.tabId !== undefined && typeof pane.tab_id !== "string")) {
      throw new SurfaceOwnershipUnprovenError(`Pane identity is unproven for ${identity.paneId}`);
    }
    if (pane.workspace_id !== identity.workspaceId ||
      (identity.tabId !== undefined && pane.tab_id !== identity.tabId)) {
      throw new SurfaceOwnershipLostError(`Pane identity changed for ${identity.paneId}; preserving pane`);
    }
    const session = sessionPathFromAgent(pane);
    if ((pane.agent && pane.agent !== "pi") || (session && identity.sessionPath && session !== identity.sessionPath)) {
      throw new SurfaceOwnershipLostError(`Current occupant session changed in ${identity.paneId}; preserving pane`);
    }
    if (pane.agent || pane.agent_session) {
      if (pane.agent === "pi" && session && session === identity.sessionPath) return;
      throw new SurfaceOwnershipUnprovenError(`Current occupant session is unproven in ${identity.paneId}`);
    }
    // After an owned agent exits, only its empty foreground shell is safe to reuse or close.
    const response = await this.#runJson(["pane", "process-info", "--pane", identity.paneId!], signal);
    const info = objectAt(objectAt(response, "result"), "process_info");
    if (info.pane_id !== identity.paneId || typeof info.shell_pid !== "number" ||
      !Number.isSafeInteger(info.shell_pid) || info.shell_pid <= 0 || !Array.isArray(info.foreground_processes)) {
      throw new SurfaceOwnershipUnprovenError(`Foreground ownership is unproven in ${identity.paneId}`);
    }
    const processes = info.foreground_processes;
    if (processes.length === 1 && isObject(processes[0]) && processes[0].pid === info.shell_pid) return;
    if (processes.length > 0 && processes.every((entry) => isObject(entry) &&
      typeof entry.pid === "number" && Number.isSafeInteger(entry.pid) && entry.pid > 0 &&
      typeof entry.argv0 === "string" && entry.argv0.length > 0 && entry.argv0 !== "pi" &&
      !/(?:^|\/)node(?:js)?$/.test(entry.argv0) && entry.name !== "node")) {
      throw new SurfaceOwnershipLostError(`Another foreground command occupies ${identity.paneId}; preserving pane`);
    }
    throw new SurfaceOwnershipUnprovenError(`Foreground ownership is unproven in ${identity.paneId}`);
  }

  async #cleanupSurface(child: ChildRecord): Promise<void> {
    this.#assertCurrentHerdrSession(child);
    if (isRetiredSurface(child) || !child.paneId) return;
    const cleanup = async () => {
      child.surfaceState = "cleanup-pending";
      child.cleanupError = undefined;
      child.updatedAt = this.#now();
      this.#saveChild(child);
      try {
        const response = await this.#runJson(["pane", "get", child.paneId!]);
        await this.#assertOwnedPane(child, objectAt(objectAt(response, "result"), "pane"));
        await this.#runJson(["pane", "close", child.paneId!]);
        child.surfaceState = "closed";
      } catch (error) {
        if (isPositivePaneAbsence(error)) child.surfaceState = "closed";
        else if (error instanceof SurfaceOwnershipLostError) {
          child.surfaceState = "released";
          child.cleanupError = error.message;
        } else child.cleanupError = errorMessage(error);
      }
      child.updatedAt = this.#now();
      this.#saveChild(child);
    };
    try {
      await this.#withPlacementLock(child.rootId, cleanup);
    } catch (error) {
      child.cleanupError = errorMessage(error);
      child.updatedAt = this.#now();
      this.#saveChild(child);
    }
  }
}
