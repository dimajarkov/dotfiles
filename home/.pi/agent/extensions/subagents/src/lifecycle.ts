import { randomUUID } from "node:crypto";
import { Effect, Exit, Fiber, Scope, type Stream } from "effect";
import type {
  ScopedSubagentBackend,
  SubagentBackend,
  SubagentSession,
} from "./backend.ts";
import type {
  SendError,
  SpawnTask,
  SubagentEvent,
  SubagentMeta,
} from "./domain.ts";

/** Stable conversational identity and metadata, independent of execution. */
export interface ConversationOwnership {
  readonly id: string;
  readonly meta: Effect.Effect<SubagentMeta>;
}

/** Operations that affect child execution, not its management connection. */
export interface SubagentExecution {
  send(text: string): Effect.Effect<void, SendError>;
  readonly interrupt: Effect.Effect<void>;
  /** Stop the execution owner and release resources it owns. */
  readonly stop: Effect.Effect<void>;
}

/** Normalized events consumed by the manager's controller. */
export interface SubagentManagementConnection {
  readonly events: Stream.Stream<SubagentEvent>;
}

export interface ManagedSubagent {
  readonly conversation: ConversationOwnership;
  readonly execution: SubagentExecution;
  readonly management: SubagentManagementConnection;
}

/** The manager's independently detachable event-pump attachment. */
export interface SubagentControllerAttachment {
  readonly detach: Effect.Effect<void>;
}

/** Map a legacy session onto the independently named lifecycle roles. */
export function adaptScopedSession(
  session: SubagentSession,
  scope: Scope.Closeable,
  id: string,
): ManagedSubagent {
  return {
    conversation: { id, meta: session.meta },
    execution: {
      send: (text) => session.send(text),
      interrupt: session.interrupt,
      stop: Scope.close(scope, Exit.void).pipe(Effect.ignore),
    },
    management: { events: session.events },
  };
}

/**
 * Keep today's scoped backend lifecycle behind the manager-facing contract.
 * Future backends can implement SubagentBackend directly without a Scope.
 */
export function adaptScopedBackend(
  backend: ScopedSubagentBackend,
): SubagentBackend {
  return {
    name: backend.name,
    capabilities: backend.capabilities,
    available: backend.available,
    spawn(task: SpawnTask) {
      return Effect.gen(function* () {
        const scope = yield* Scope.make();
        const session = yield* Scope.provide(backend.spawn(task), scope).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) ? Effect.void : Scope.close(scope, exit),
          ),
        );
        return adaptScopedSession(session, scope, randomUUID());
      });
    },
  };
}

/** Detach only the manager-owned controller fiber, never the child execution. */
export function attachController(
  fiber: Fiber.Fiber<void>,
): SubagentControllerAttachment {
  return { detach: Fiber.interrupt(fiber).pipe(Effect.asVoid) };
}
