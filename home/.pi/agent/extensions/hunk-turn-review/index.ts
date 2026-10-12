import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringDecoder } from "node:string_decoder";
import { createServer, type Server } from "node:net";
import { chmodSync, lstatSync, realpathSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

interface Client {
  request(method: string, params?: object): Promise<any>;
}
interface Identity {
  kind: "pi";
  nativeId: string;
  sessionPath: string;
  checkout: string;
}
function sessionIdentity(ctx: ExtensionContext, checkoutOf: (path: string) => string): Identity {
  const sessionPath = ctx.sessionManager.getSessionFile();
  if (!sessionPath)
    throw new Error("Persistent native Pi session is required for exact-session review");
  return {
    kind: "pi",
    nativeId: ctx.sessionManager.getSessionId(),
    sessionPath: join(realpathSync(dirname(sessionPath)), resolve(sessionPath).split("/").at(-1)!),
    checkout: checkoutOf(ctx.cwd),
  };
}
export default function hunkTurnReview(pi: ExtensionAPI) {
  let current:
    | {
        ctx: ExtensionContext;
        identity: Identity;
        epoch: string;
        sessionId: string;
        client: Client;
        server: Server;
        valid: boolean;
        requestId?: string;
        compacting: boolean;
        admitted: Set<string>;
        admitting: Set<string>;
        warned: Set<string>;
      }
    | undefined;
  let generation = 0;
  const warn = (ctx: ExtensionContext, error: unknown) => {
    const text = `Hunk turn review: ${String(error)}`;
    ctx.ui.setStatus("hunk-turn-review", text);
    if (current?.ctx === ctx) {
      if (current.warned.has(text)) return;
      current.warned.add(text);
    }
    ctx.ui.notify(text, "warning");
  };
  const eligible = (ctx: ExtensionContext) => ctx.mode === "tui" && process.env.HERDR_ENV === "1";
  const operation = async (method: string, params: object = {}) => {
    const c = current;
    if (!c?.valid) return;
    try {
      const result = await c.client.request(method, {
        sessionId: c.sessionId,
        epoch: c.epoch,
        ...params,
      });
      for (const w of result?.warnings ?? []) warn(c.ctx, w);
      return result;
    } catch (e) {
      warn(c.ctx, e);
    }
  };
  const close = async () => {
    generation++;
    const c = current;
    current = undefined;
    if (!c) return;
    c.valid = false;
    await c.client
      .request("session.detach", { sessionId: c.sessionId, epoch: c.epoch })
      .catch((e) => warn(c.ctx, e));
    await new Promise<void>((r) => c.server.close(() => r()));
  };
  pi.on("session_start", async (_event, ctx) => {
    await close();
    if (!eligible(ctx)) return;
    if (
      typeof ctx.getUserRequest !== "function" ||
      typeof ctx.getUserRequestPreparation !== "function"
    ) {
      warn(
        ctx,
        "Pi user-request lifecycle with input preparation support is required for exact response review; install both maintained Nix patches",
      );
      return;
    }
    const ownGeneration = generation;
    let failedServer: Server | undefined;
    try {
      const socket = process.env.HUNK_TURN_REVIEW_SOCKET,
        root = process.env.HUNK_TURN_REVIEW_STATE;
      if (!socket || !root)
        throw new Error("Installed runtime/socket configuration is missing; coding continues");
      const st = lstatSync(root);
      if (
        !st.isDirectory() ||
        st.isSymbolicLink() ||
        st.uid !== process.getuid?.() ||
        st.mode & 0o077
      )
        throw new Error("Receiver requires owner-private state directory");
      const epoch = randomUUID();
      const modulePath =
        process.env.HUNK_TURN_REVIEW_CLIENT ??
        join(homedir(), ".local/share/hunk-turn-review/client.mjs");
      const { createClient, canonicalCheckout } = await import(pathToFileURL(modulePath).href);
      const identity = sessionIdentity(ctx, canonicalCheckout);
      const client: Client = createClient({ socket });
      const receiverSocket = join(realpathSync(root), `pi-${epoch.slice(0, 8)}.sock`);
      const server = createServer((connection) => {
        let data = "",
          used = false;
        const decoder = new StringDecoder("utf8");
        connection.setTimeout(5000, () => connection.destroy());
        connection.on("error", () => {});
        connection.on("data", (chunk) => {
          if (used) return;
          data += decoder.write(chunk);
          if (Buffer.byteLength(data) > 16 * 1024 * 1024) {
            connection.destroy();
            return;
          }
          if (!data.includes("\n")) return;
          used = true;
          let r: any;
          try {
            r = JSON.parse(data.slice(0, data.indexOf("\n")));
          } catch {
            connection.destroy();
            return;
          }
          const reply = (result: object) =>
            connection.end(JSON.stringify({ version: 1, id: r.id, result }) + "\n");
          const c = current;
          let admissionAttempted = false;
          try {
            if (
              r.version !== 1 ||
              !c?.valid ||
              ownGeneration !== generation ||
              c.ctx !== ctx ||
              JSON.stringify(sessionIdentity(ctx, canonicalCheckout)) !==
                JSON.stringify(identity) ||
              r.params.epoch !== epoch ||
              JSON.stringify(r.params.identity) !== JSON.stringify(identity)
            )
              return reply({
                state: "blocked",
                ready: false,
                reason: "Original native session, checkout, or runtime epoch changed",
              });
            if (r.method === "admission.reconcile") {
              const persisted = ctx.sessionManager
                .getEntries()
                .some(
                  (e) =>
                    e.type === "custom_message" &&
                    e.customType === "hunk-turn-review" &&
                    typeof e.details === "object" &&
                    e.details !== null &&
                    "batchId" in e.details &&
                    e.details.batchId === r.params.batchId,
                );
              return reply(
                persisted || c.admitted.has(r.params.batchId)
                  ? {
                      state: "queued",
                      evidence: persisted ? "native-history" : "original-process-memory-queue",
                    }
                  : {
                      state: "unknown",
                      evidence:
                        "Pi has no public persisted follow-up queue; absence cannot prove non-admission after a crash",
                    },
              );
            }
            const ready =
              ctx.isIdle() &&
              !ctx.getUserRequestPreparation?.() &&
              !ctx.hasPendingMessages() &&
              !c.compacting;
            if (r.method === "admission.check")
              return reply({
                ready,
                reason: ready ? undefined : "Original Pi is busy, compacting, or settling",
              });
            if (r.method !== "admission.enqueue")
              return reply({ state: "blocked", reason: "Unsupported receiver command" });
            if (c.admitted.has(r.params.batchId)) return reply({ state: "queued" });
            if (!ready) return reply({ state: "pending", reason: "Original Pi is not idle" });
            if (r.params.batch?.id !== r.params.batchId || typeof r.params.prompt !== "string")
              return reply({ state: "blocked", reason: "Invalid immutable human batch" });
            // Revalidate immediately before synchronous native admission. There is no await in this receiver.
            if (
              !c.valid ||
              c.epoch !== epoch ||
              !ctx.isIdle() ||
              ctx.getUserRequestPreparation?.() ||
              c.compacting ||
              JSON.stringify(sessionIdentity(ctx, canonicalCheckout)) !== JSON.stringify(identity)
            )
              return reply({ state: "blocked", reason: "Original context became stale" });
            admissionAttempted = true;
            c.admitting.add(r.params.batchId);
            const receipt = pi.enqueueMessage(
              {
                customType: "hunk-turn-review",
                content: r.params.prompt,
                display: true,
                details: { batchId: r.params.batchId, identity, epoch },
              },
              { deliverAs: "followUp", correlationId: r.params.batchId },
            );
            if (receipt.status !== "queued")
              throw new Error("Native admission returned no queued receipt");
            c.admitted.add(r.params.batchId);
            c.admitting.delete(r.params.batchId);
            reply({ state: "queued" });
          } catch (e) {
            c?.admitting.delete(r.params?.batchId);
            warn(ctx, e);
            if (admissionAttempted) connection.destroy();
            else reply({ state: "blocked", reason: String(e) });
          }
        });
      });
      failedServer = server;
      await new Promise<void>((r, j) => {
        server.once("error", j);
        server.listen(receiverSocket, r);
      });
      chmodSync(receiverSocket, 0o600);
      const layout =
        process.env.HERDR_SESSION && process.env.HERDR_SOCKET_PATH && process.env.HERDR_PANE_ID
          ? {
              session: process.env.HERDR_SESSION,
              socket: process.env.HERDR_SOCKET_PATH,
              paneId: process.env.HERDR_PANE_ID,
            }
          : undefined;
      const attached = await client.request("session.attach", {
        identity,
        epoch,
        receiver: { socket: receiverSocket },
        layout,
      });
      current = {
        ctx,
        identity,
        epoch,
        sessionId: attached.sessionId,
        client,
        server,
        valid: true,
        compacting: false,
        admitted: new Set(),
        admitting: new Set(),
        warned: new Set(),
      };
      failedServer = undefined;
      ctx.ui.setStatus("hunk-turn-review", "Hunk turn review armed for external requests");
      await operation("session.idle");
    } catch (e) {
      failedServer?.close();
      warn(ctx, e);
    }
  });
  pi.on("user_request_prepare", async (event, ctx) => {
    const c = current;
    if (!c?.valid || !eligible(ctx)) return;
    const result = await operation("request.begin", { requestId: event.request.id });
    if (result?.armed) c.requestId = event.request.id;
  });
  pi.on("user_request_start", async (event, ctx) => {
    const c = current;
    if (!c?.valid || !eligible(ctx)) return;
    const members = "requests" in event.request ? event.request.requests : [event.request];
    const requestGroup =
      "requests" in event.request
        ? { mode: event.request.mode, requests: event.request.requests }
        : undefined;
    // Core prearms explicitly submitted feedback before native admission.
    // Bind that exact batch baseline using caller-owned provenance, never prompt text.
    const prearmed = members.find(
      (r) =>
        r.source === "extension" &&
        r.correlationId &&
        (c.admitting.has(r.correlationId) || c.admitted.has(r.correlationId)),
    );
    const result = prearmed
      ? await operation("request.bind", {
          expectedRequestId: prearmed.correlationId,
          requestId: event.request.id,
          requestGroup,
        })
      : event.preparationId
        ? await operation("request.bind", {
            expectedRequestId: event.preparationId,
            requestId: event.request.id,
            requestGroup,
          })
        : await operation("request.begin", { requestId: event.request.id, requestGroup });
    if (result?.armed) c.requestId = event.request.id;
  });
  const belongsToOriginalSession = (c: NonNullable<typeof current>, ctx: ExtensionContext) => {
    try {
      const sessionPath = ctx.sessionManager.getSessionFile();
      return (
        ctx.sessionManager.getSessionId() === c.identity.nativeId &&
        sessionPath !== undefined &&
        join(realpathSync(dirname(sessionPath)), resolve(sessionPath).split("/").at(-1)!) ===
          c.identity.sessionPath
      );
    } catch {
      return false;
    }
  };
  const idleWhenReady = async (c: NonNullable<typeof current>, ctx: ExtensionContext) => {
    if (
      current !== c ||
      !c.valid ||
      !belongsToOriginalSession(c, ctx) ||
      ctx.getUserRequest?.() ||
      ctx.getUserRequestPreparation?.() ||
      !ctx.isIdle() ||
      ctx.hasPendingMessages() ||
      c.compacting
    )
      return;
    await operation("session.idle");
  };
  const complete = async (
    event: {
      type: "user_request_prepare_end" | "user_request_end";
      request: { id: string };
      outcome: "completed" | "interrupted" | "failed";
    },
    ctx: ExtensionContext,
  ) => {
    const c = current;
    if (!c?.valid || !belongsToOriginalSession(c, ctx) || c.requestId !== event.request.id) return;
    const result = await operation("request.complete", {
      requestId: event.request.id,
      outcome: event.outcome,
    });
    if (!result || current !== c || !c.valid || c.requestId !== event.request.id) return;
    delete c.requestId;
    ctx.ui.setStatus(
      "hunk-turn-review",
      "Hunk review available; feedback admission is separate from resolution",
    );
    if (event.type === "user_request_prepare_end") await idleWhenReady(c, ctx);
  };
  pi.on("user_request_prepare_end", complete);
  pi.on("user_request_end", complete);
  const reconcile = async () => {
    await operation("request.reconcile");
  };
  pi.on("tool_call", reconcile);
  pi.on("tool_result", reconcile);
  pi.on("turn_end", reconcile);
  pi.on("before_agent_start", reconcile);
  pi.on("session_before_compact", () => {
    if (current) current.compacting = true;
  });
  const compacted = () => {
    const c = current;
    if (!c) return;
    c.compacting = false;
    // session_compact precedes native compaction-state cleanup.
    // Defer only the idle notification to the next event-loop iteration; the receiver rechecks native state.
    setImmediate(() => {
      if (current === c && c.valid) void operation("session.idle");
    });
  };
  pi.on("session_compact", compacted);
  pi.on("session_compact_failed", compacted);
  pi.on("agent_settled", async () => {
    // Native synchronous admission is deferred until every settled handler returns.
    // This final boundary may deliver pending feedback without steering queued human work.
    await operation("session.idle");
  });
  pi.on("session_shutdown", close);
  pi.registerCommand("hunk-review-task", {
    description:
      "Explicitly start a new cumulative Hunk review task (use discard to discard pending notes)",
    handler: async (args) => {
      await operation("task.reset", { discardPending: args.trim() === "discard" });
    },
  });
  pi.registerCommand("hunk-review-reopen", {
    description: "Explicitly reopen the owned Hunk review pane",
    handler: async () => {
      await operation("layout.reopen");
    },
  });
  pi.registerCommand("hunk-review-tab", {
    description: "Open the full-width Hunk review tab without changing focus",
    handler: async () => {
      await operation("layout.tab");
    },
  });
}
