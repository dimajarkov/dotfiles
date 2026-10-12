import { StringDecoder } from "node:string_decoder";
import { createServer } from "node:net";
import { chmodSync, lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createClient, canonicalCheckout } from "../../.local/share/hunk-turn-review/client.mjs";
import { openAppServer } from "./transport.mjs";

function sameIdentity(a, b) {
  return (
    a?.kind === b.kind &&
    a.nativeId === b.nativeId &&
    a.checkout === b.checkout &&
    a.sessionPath === b.sessionPath
  );
}
/** @param {{endpoint:string,threadId:string,checkout:string,socket:string,state:string,initialThread?:any,layout?:{session:string,socket:string,paneId:string},epoch?:string,warn?:(message:string)=>void}} options */
export async function startCodexAdapter({
  endpoint,
  threadId,
  checkout,
  socket,
  state,
  initialThread = undefined,
  layout = undefined,
  epoch: providedEpoch = undefined,
  warn = (message) => {
    process.stderr.write(`Hunk turn review: ${message}\n`);
  },
}) {
  const dir = lstatSync(state);
  if (
    !dir.isDirectory() ||
    dir.isSymbolicLink() ||
    dir.uid !== process.getuid?.() ||
    dir.mode & 0o077
  )
    throw new Error("Codex receiver requires private state");
  const rpc = await openAppServer(endpoint),
    client = createClient({ socket });
  let failedServer, observedSession, observedEpoch;
  const report = warn,
    reported = new Set();
  warn = (message) => {
    if (reported.has(message)) return;
    reported.add(message);
    if (reported.size > 100) reported.delete(reported.values().next().value);
    report(message);
    if (observedSession)
      void client
        .request("session.warn", { sessionId: observedSession, epoch: observedEpoch, message })
        .catch(() => {});
  };
  try {
    const pages = async function* (method, params = {}) {
      let cursor = null;
      const seen = new Set();
      do {
        const page = await rpc.request(method, { ...params, cursor, limit: 100 });
        if (!Array.isArray(page.data) || page.nextCursor === undefined)
          throw new Error("Native paginated contract unavailable");
        yield page.data;
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error("Native pagination cursor repeated");
        seen.add(cursor);
      } while (cursor);
    };
    let originalLoaded = false;
    for await (const data of pages("thread/loaded/list")) {
      if (data.includes(threadId)) {
        originalLoaded = true;
        break;
      }
    }
    if (!originalLoaded) {
      rpc.close();
      throw new Error("Original native Codex thread is not loaded; refusing replacement resume");
    }
    let initial;
    try {
      // Observing an already loaded original thread must not resume it or apply configuration.
      initial = (await rpc.request("thread/read", { threadId, includeTurns: false })).thread;
    } catch (error) {
      if (!initialThread) {
        rpc.close();
        throw error;
      }
      initial = initialThread;
      warn(
        "Native thread has no persisted rollout yet; using original caller metadata until native history is available",
      );
    }
    const nativeCwd = realpathSync(checkout);
    checkout = canonicalCheckout(checkout);
    if (
      initial.id !== threadId ||
      realpathSync(initial.cwd) !== nativeCwd ||
      canonicalCheckout(initial.cwd) !== checkout ||
      initial.status.type === "notLoaded"
    ) {
      rpc.close();
      throw new Error("Exact original loaded native Codex thread/checkout is unavailable");
    }
    const identity = {
      kind: "codex",
      nativeId: threadId,
      sessionPath: initial.path ?? undefined,
      checkout,
    };
    const epoch = providedEpoch ?? randomUUID(),
      receiverSocket = join(realpathSync(state), `codex-${epoch.slice(0, 8)}.sock`);
    let valid = true,
      requestId,
      nativeTurnId,
      prearmed = false,
      sessionId,
      events = Promise.resolve();
    const verify = async () => {
      if (!valid) throw new Error("Original Codex adapter was invalidated");
      const thread = (await rpc.request("thread/read", { threadId, includeTurns: false })).thread;
      if (
        thread.id !== identity.nativeId ||
        thread.path !== initial.path ||
        realpathSync(thread.cwd) !== nativeCwd ||
        canonicalCheckout(thread.cwd) !== identity.checkout ||
        thread.status.type === "notLoaded"
      )
        throw new Error("Original native Codex identity/checkout was replaced or unloaded");
      return thread;
    };
    const reconcile = async (batchId) => {
      await verify();
      for (const method of ["thread/queue/list", "thread/items/list"]) {
        let cursor = null;
        const seen = new Set();
        do {
          const page = await rpc.request(method, { threadId, cursor, limit: 100 });
          if (!Array.isArray(page.data) || page.nextCursor === undefined)
            throw new Error("Native paginated queue/history contract is unavailable");
          if (
            page.data.some((e) =>
              method === "thread/queue/list"
                ? e.clientUserMessageId === batchId
                : e.item?.type === "userMessage" && e.item.clientId === batchId,
            )
          )
            return { state: "queued", evidence: method };
          cursor = page.nextCursor;
          if (cursor && seen.has(cursor)) throw new Error("Native pagination cursor repeated");
          seen.add(cursor);
        } while (cursor);
      }
      return {
        state: "absent",
        evidence: "Complete paginated native queue and history checked on original connection",
      };
    };
    const nativeCommand = async (method, p) => {
      if (!valid || p.epoch !== epoch || !sameIdentity(p.identity, identity))
        return {
          state: "blocked",
          ready: false,
          reason: "Original native identity/checkout/runtime epoch mismatch",
        };
      if (method === "hook.inspect") return { valid: true, endpoint };
      if (method === "hook.prompt") {
        await userPrompt({ requestId: p.requestId });
        return { armed: true };
      }
      if (method === "hook.end") {
        setTimeout(() => void close(), 0);
        return { closed: true };
      }
      const thread = await verify();
      if (method === "admission.reconcile") return reconcile(p.batchId);
      if (method === "admission.check")
        return {
          ready: thread.status.type === "idle",
          reason:
            thread.status.type === "idle" ? undefined : "Original Codex thread is busy or blocked",
        };
      if (method !== "admission.enqueue") throw new Error("Unsupported original-process command");
      if (thread.status.type !== "idle")
        return { state: "pending", reason: "Original Codex is not idle" };
      const prior = await reconcile(p.batchId);
      if (prior.state === "queued") return prior;
      if (p.batch?.id !== p.batchId || typeof p.prompt !== "string")
        return { state: "blocked", reason: "Invalid immutable batch" };
      const final = await verify();
      if (final.status.type !== "idle")
        return { state: "pending", reason: "Original Codex became busy" };
      // Exact connection and UUID, never CLI queue defaults; stable ID is evidence, not deduplication.
      requestId = p.batchId;
      prearmed = true;
      const result = await rpc.request("thread/queue/add", {
        threadId,
        input: [{ type: "text", text: p.prompt, text_elements: [] }],
        clientUserMessageId: p.batchId,
      });
      if (result.queuedSubmission?.clientUserMessageId !== p.batchId)
        throw new Error("Native queue returned no exact batch receipt");
      return { state: "queued", queuedSubmissionId: result.queuedSubmission.id };
    };
    const server = createServer((c) => {
      c.setTimeout(15000, () => c.destroy());
      c.on("error", () => {});
      let buffer = "",
        used = false;
      const decoder = new StringDecoder("utf8");
      c.on("data", (chunk) => {
        if (used) return;
        buffer += decoder.write(chunk);
        if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) {
          c.destroy();
          return;
        }
        if (!buffer.includes("\n")) return;
        used = true;
        let r;
        try {
          r = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        } catch {
          c.destroy();
          return;
        }
        if (r.version !== 1) {
          c.destroy();
          return;
        }
        // Any failure after a queue request remains uncertain at the durable runtime.
        nativeCommand(r.method, r.params).then(
          (result) => c.end(JSON.stringify({ version: 1, id: r.id, result }) + "\n"),
          (error) => {
            warn(String(error));
            c.destroy();
          },
        );
      });
    });
    failedServer = server;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(receiverSocket, () => resolve(undefined));
    });
    chmodSync(receiverSocket, 0o600);
    const attached = await client.request("session.attach", {
      identity,
      epoch,
      receiver: { socket: receiverSocket },
      layout:
        layout ??
        (process.env.HERDR_SESSION && process.env.HERDR_SOCKET_PATH && process.env.HERDR_PANE_ID
          ? {
              session: process.env.HERDR_SESSION,
              socket: process.env.HERDR_SOCKET_PATH,
              paneId: process.env.HERDR_PANE_ID,
            }
          : undefined),
    });
    sessionId = attached.sessionId;
    observedSession = sessionId;
    observedEpoch = epoch;
    requestId = attached.active?.requestId;
    const operation = (method, params = {}) =>
      client.request(method, { sessionId, epoch, ...params });
    const userPrompt = async ({ requestId: id }) => {
      if (!valid || !id)
        throw new Error("Stable native user request identity is required before tools");
      nativeTurnId = id;
      // Feedback's baseline was durably armed before native queue admission. The
      // hook runs before native user-message persistence; wait for that stable
      // client identity before binding this interval, without a nested core call.
      if (prearmed) return;
      await operation("request.begin", { requestId: id });
      requestId = id;
    };
    const bind = async (turnId, item) => {
      if (!prearmed || turnId !== nativeTurnId || item?.type !== "userMessage") return;
      const id = item.clientId === requestId ? requestId : turnId;
      if (id !== requestId) {
        await operation("request.bind", { expectedRequestId: requestId, requestId: id });
        requestId = id;
      }
      prearmed = false;
    };
    const finish = async (id, outcome) => {
      if (!id || requestId !== id) return;
      await operation("request.complete", { requestId: id, outcome });
      requestId = undefined;
      nativeTurnId = undefined;
      prearmed = false;
      setTimeout(() => void operation("session.idle").catch((e) => warn(String(e))), 0);
    };
    rpc.onNotification((method, p) => {
      if (p?.threadId !== threadId) return;
      events = events
        .then(async () => {
          if (!valid) return;
          if (method === "thread/status/changed") {
            if (p.status.type === "idle")
              setTimeout(() => void operation("session.idle").catch((e) => warn(String(e))), 0);
            if (p.status.type === "notLoaded") setTimeout(() => void close(), 0);
          } else if (method === "turn/started") {
            if (!requestId) {
              requestId = p.turn.id;
              warn(
                "Native turn began without awaited UserPromptSubmit baseline; interval capture is unavailable for this turn",
              );
            }
          } else if (method === "turn/completed") {
            if (prearmed) return; // Poll persisted stable client identity before final publication.
            if (nativeTurnId && nativeTurnId !== p.turn.id) return;
            await finish(
              requestId,
              p.turn.status === "completed"
                ? "completed"
                : p.turn.status === "interrupted"
                  ? "interrupted"
                  : "failed",
            );
          } else if (method === "item/started") {
            await bind(p.turnId, p.item);
          } else if (method.startsWith("item/") && method.endsWith("/completed"))
            await operation("request.reconcile");
        })
        .catch((e) => warn(String(e)));
    });
    let polling = false;
    const poll = setInterval(() => {
      if (!valid || !requestId || polling) return;
      polling = true;
      events = events
        .then(async () => {
          const id = requestId;
          // Lazy first-session persistence can prevent subscription before the first turn.
          // Reconcile by stable turn/client identity, never prompt text or Stop events.
          for await (const data of pages("thread/turns/list", { threadId, itemsView: "full" })) {
            const turn = data.find(
              (t) =>
                t.id === nativeTurnId ||
                t.id === id ||
                t.items?.some((i) => i.type === "userMessage" && i.clientId === id),
            );
            if (turn) {
              await bind(
                turn.id,
                turn.items?.find((i) => i.type === "userMessage"),
              );
              if (!prearmed && turn.status !== "inProgress")
                await finish(
                  requestId,
                  turn.status === "completed"
                    ? "completed"
                    : turn.status === "interrupted"
                      ? "interrupted"
                      : "failed",
                );
              break;
            }
          }
        })
        .catch((error) => {
          if (valid && !/no rollout found/i.test(String(error))) warn(String(error));
        })
        .finally(() => {
          polling = false;
        });
    }, 250);
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      valid = false;
      clearInterval(poll);
      await events;
      await operation("session.detach").catch((e) => warn(String(e)));
      await new Promise((resolve) => server.close(resolve));
      rpc.close();
    };
    rpc.onClose((error) => {
      if (!closing) {
        warn(String(error));
        void close();
      }
    });
    failedServer = undefined;
    return {
      sessionId,
      epoch,
      identity,
      userPrompt,
      async stop() {
        await operation("request.reconcile");
      },
      close,
    };
  } catch (error) {
    rpc.close();
    if (failedServer) await new Promise((resolve) => failedServer.close(resolve));
    throw error;
  }
}
