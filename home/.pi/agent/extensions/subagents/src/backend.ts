/**
 * Backend contracts for the subagent manager.
 *
 * `SubagentBackend` is the lifecycle-independent orchestration seam. Existing
 * Pi, Claude, and Codex implementations retain `ScopedSubagentBackend` and
 * are wrapped by the compatibility adapter in lifecycle.ts.
 */

import type { Effect, Scope, Stream } from "effect";
import { Context } from "effect";
import type { ManagedSubagent } from "./lifecycle.ts";
import type {
  BackendName,
  SendError,
  SpawnError,
  SpawnTask,
  SubagentEvent,
  SubagentMeta,
} from "./domain.ts";

export interface BackendCapabilities {
  /** Can send() steer a live run (vs. only starting a fresh run when idle). */
  readonly steering: boolean;
  readonly modelSelection: boolean;
  readonly reasoningEffort: boolean;
}

/**
 * A live compatibility session. The manager's controller is the single
 * consumer of `events`; it folds them into the read-model snapshot.
 */
export interface SubagentSession {
  /** Current metadata snapshot. Updates also arrive as MetaChanged events. */
  readonly meta: Effect.Effect<SubagentMeta>;
  /**
   * All activity, normalized. Ends when the session's scope closes. Every
   * run started within the session terminates with a RunSettled event.
   */
  readonly events: Stream.Stream<SubagentEvent>;
  /**
   * Steer the active run, or start a fresh run when idle (v1 `manager.send`
   * semantics — the "is a run active" decision is backend-native state).
   */
  send(text: string): Effect.Effect<void, SendError>;
  /**
   * Interrupt the active run. Resolves once the backend acknowledges; the
   * corresponding RunSettled(Interrupted) arrives on `events`. Callers bound
   * this with a timeout and fall back to closing the session scope.
   */
  readonly interrupt: Effect.Effect<void>;
}

/** Existing headless backend contract, retained behind the scoped adapter. */
export interface ScopedSubagentBackend {
  readonly name: BackendName;
  readonly capabilities: BackendCapabilities;
  /** Probe availability (binary on PATH, SDK importable, credentials). */
  readonly available: Effect.Effect<boolean>;
  /** Spawn a legacy session whose resources belong to the provided scope. */
  spawn(
    task: SpawnTask,
  ): Effect.Effect<SubagentSession, SpawnError, Scope.Scope>;
}

/**
 * Backend boundary consumed by orchestration. Implementations own conversation
 * and execution lifetimes independently; manager teardown calls `stop`.
 */
export interface SubagentBackend {
  readonly name: BackendName;
  readonly capabilities: BackendCapabilities;
  readonly available: Effect.Effect<boolean>;
  spawn(task: SpawnTask): Effect.Effect<ManagedSubagent, SpawnError>;
}

/** Registry of all wired backends, keyed by name. */
export class BackendRegistry extends Context.Service<
  BackendRegistry,
  ReadonlyMap<BackendName, SubagentBackend>
>()("subagents/BackendRegistry") {}
