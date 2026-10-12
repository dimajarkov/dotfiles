import { StringDecoder } from "node:string_decoder";
import { spawn } from "node:child_process";
import { realpathSync, lstatSync, openSync, constants, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createClient, canonicalCheckout } from "../../.local/share/hunk-turn-review/client.mjs";

export async function handleHook(event, environment = process.env) {
  if (environment.HERDR_ENV !== "1") return;
  const socket = environment.HUNK_TURN_REVIEW_SOCKET,
    state = environment.HUNK_TURN_REVIEW_STATE,
    endpoint = environment.HUNK_TURN_REVIEW_CODEX_ENDPOINT;
  if (!socket || !state || !event.session_id || !event.cwd)
    throw new Error(
      "Installed runtime and native hook identity are required; coding continues without automatic review",
    );
  const client = createClient({ socket });
  let status;
  try {
    status = await client.request("session.find", {
      kind: "codex",
      nativeId: event.session_id,
      checkout: event.cwd,
      ...(event.transcript_path ? { sessionPath: event.transcript_path } : {}),
    });
  } catch {}
  if (event.hook_event_name === "SessionStart") {
    if (!endpoint)
      throw new Error(
        "Exact original app-server endpoint is missing; feedback remains fail-closed",
      );
    if (status?.receiver) {
      try {
        const inspected = await createClient({
          socket: status.receiver.socket,
          timeoutMs: 2000,
        }).request("hook.inspect", { identity: status.identity, epoch: status.epoch });
        if (!inspected.valid || inspected.endpoint !== endpoint)
          throw new Error(
            "Existing original receiver belongs to a different native endpoint; refusing replacement binding",
          );
        return;
      } catch (error) {
        if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error;
      }
    }
    const root = lstatSync(state);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      root.uid !== process.getuid?.() ||
      root.mode & 0o077
    )
      throw new Error("Observer state must be owner-private");
    const epoch = randomUUID(),
      identity = {
        kind: "codex",
        nativeId: event.session_id,
        sessionPath: event.transcript_path ?? undefined,
        checkout: canonicalCheckout(event.cwd),
      };
    await client.request("session.attach", { identity, epoch });
    const log = openSync(
      join(state, `codex-observer-${epoch}.log`),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const child = spawn(
        process.execPath,
        [
          join(dirname(fileURLToPath(import.meta.url)), "observer.mjs"),
          JSON.stringify({
            endpoint,
            threadId: identity.nativeId,
            checkout: event.cwd,
            socket,
            state,
            epoch,
            initialThread: {
              id: identity.nativeId,
              cwd: event.cwd,
              path: identity.sessionPath ?? null,
              status: { type: "idle" },
            },
          }),
        ],
        { env: environment, detached: true, stdio: ["ignore", log, log] },
      );
      child.unref();
    } finally {
      closeSync(log);
    }
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const attached = await client.request("session.find", {
        kind: "codex",
        nativeId: identity.nativeId,
        checkout: identity.checkout,
        ...(identity.sessionPath ? { sessionPath: identity.sessionPath } : {}),
      });
      if (attached.receiver && attached.epoch === epoch) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(
      `Original observer did not become ready; inspect private observer log codex-observer-${epoch}.log`,
    );
  }
  if (!status) throw new Error("Original native session observer is unavailable");
  if (event.hook_event_name === "UserPromptSubmit") {
    if (!event.turn_id)
      throw new Error("Native turn ID is missing; no prompt-string identity inference");
    // The native hook is awaited before tools. Stop is intentionally never a final publication.
    if (status.receiver)
      await createClient({ socket: status.receiver.socket }).request("hook.prompt", {
        identity: status.identity,
        epoch: status.epoch,
        requestId: event.turn_id,
      });
    else
      await client.request("request.begin", {
        sessionId: status.sessionId,
        epoch: status.epoch,
        requestId: event.turn_id,
      });
  } else if (event.hook_event_name === "SessionEnd") {
    await client.request("session.detach", { sessionId: status.sessionId, epoch: status.epoch });
    if (status.receiver)
      await createClient({ socket: status.receiver.socket }).request("hook.end", {
        identity: status.identity,
        epoch: status.epoch,
      });
  } else {
    const reconciliation = await client.request("request.reconcile", {
      sessionId: status.sessionId,
      epoch: status.epoch,
      warningConsumer: "codex-hook",
    });
    if (reconciliation.warnings?.length)
      return { systemMessage: reconciliation.warnings.join("\n") };
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input = "";
  const decoder = new StringDecoder("utf8");
  try {
    for await (const chunk of process.stdin) {
      input += decoder.write(chunk);
      if (Buffer.byteLength(input) > 1024 * 1024) throw new Error("Oversized native hook payload");
    }
    const response = await handleHook(JSON.parse(input));
    if (response?.systemMessage)
      process.stdout.write(JSON.stringify({ systemMessage: response.systemMessage }) + "\n");
  } catch (error) {
    const warning = `Hunk turn review unavailable: ${String(error)}`;
    process.stderr.write(warning + "\n");
    process.stdout.write(JSON.stringify({ systemMessage: warning }) + "\n");
  }
}
