import { test, expect } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { createClient } from "../home/.local/share/hunk-turn-review/client.mjs";
import { openAppServer } from "../home/.codex/hunk-turn-review/transport.mjs";
import { startCodexAdapter } from "../home/.codex/hunk-turn-review/adapter.mjs";

const root = join(import.meta.dir, "..");
const binary = process.env.HTR_CODEX_BINARY ?? "/opt/homebrew/bin/codex";

test("original native Codex keeps one review binding across authentic hook and thread metadata", async () => {
  const dir = await mkdtemp("/private/tmp/htr-compat-");
  const checkout = join(dir, "repo"),
    state = join(dir, "state");
  const codexHome = join(dir, "codex"),
    socket = join(state, "r.sock");
  const endpoint = `unix://${join(dir, "codex.sock")}`;
  await mkdir(checkout);
  await mkdir(codexHome, { mode: 0o700 });
  execFileSync("git", ["init", "-q", checkout]);
  await writeFile(join(checkout, "tracked.txt"), "pre-existing edit\n");
  const runtime = spawn(
    "node",
    [
      join(root, "home/.local/share/hunk-turn-review/dist/src/runtime.js"),
      "--state",
      state,
      "--socket",
      socket,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const client = createClient({ socket, timeoutMs: 3000 });
  let runtimeLog = "",
    nativeLog = "";
  runtime.stderr.on("data", (d) => (runtimeLog += d.toString()));
  const wait = async (get: () => Promise<any>) => {
    const end = Date.now() + 10000;
    let error;
    while (Date.now() < end) {
      try {
        const value = await get();
        if (value) return value;
      } catch (e) {
        error = e;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(
      `Isolated compatibility state did not settle: ${String(error)} ${runtimeLog} ${nativeLog.slice(-1000)}`,
    );
  };
  const hookLog = join(dir, "hooks.jsonl"),
    hook = join(dir, "hook.mjs");
  await writeFile(
    hook,
    `import {handleHook} from ${JSON.stringify(join(root, "home/.codex/hunk-turn-review/hook.mjs"))};
import {appendFileSync,writeFileSync,existsSync} from "node:fs";
let input="";for await(const c of process.stdin)input+=c;const event=JSON.parse(input);
let error;try {await handleHook(event);
if(event.hook_event_name==="UserPromptSubmit")writeFileSync("tracked.txt","native edit\\n");
if(event.hook_event_name==="Stop"&&!existsSync(${JSON.stringify(join(dir, "continued"))})){writeFileSync(${JSON.stringify(join(dir, "continued"))},"yes");writeFileSync("tracked.txt","native continuation\\n");process.stdout.write(JSON.stringify({decision:"block",reason:"Continue once in the isolated fixture"})+"\\n");}
}catch(e){error=String(e);}
appendFileSync(${JSON.stringify(hookLog)},JSON.stringify({event:event.hook_event_name,nativeId:event.session_id,path:event.transcript_path,turnId:event.turn_id,error})+"\\n");`,
  );
  await writeFile(
    join(codexHome, "hooks.json"),
    JSON.stringify({
      hooks: Object.fromEntries(
        ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"].map((name) => [
          name,
          [{ hooks: [{ type: "command", command: `node ${hook}`, timeout: 10 }] }],
        ]),
      ),
    }),
  );
  let providerCalls = 0,
    hold = false;
  const provider = createServer((_req, res) => {
    providerCalls++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (hold) return;
    res.end(
      "event: response.completed\ndata: " +
        JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp-local",
            status: "completed",
            output: [
              {
                id: "msg-local",
                type: "message",
                role: "assistant",
                status: "completed",
                content: [
                  { type: "output_text", text: "local deterministic response", annotations: [] },
                ],
              },
            ],
            usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          },
        }) +
        "\n\n",
    );
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("No local provider");
  const native = spawn(binary, ["app-server", "--listen", endpoint], {
    cwd: checkout,
    detached: true,
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      CODEX_HOME: codexHome,
      XDG_CONFIG_HOME: dir,
      HERDR_ENV: "1",
      HUNK_TURN_REVIEW_SOCKET: socket,
      HUNK_TURN_REVIEW_STATE: state,
      HUNK_TURN_REVIEW_CODEX_ENDPOINT: endpoint,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  native.stderr.on("data", (d) => (nativeLog += d.toString()));
  let rpc: any;
  const evidence: any = {};
  const killListener = () => {
    try {
      process.kill(-native.pid!, "SIGKILL");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
    }
  };
  try {
    await wait(async () => {
      await client
        .request("session.find", { kind: "codex", nativeId: "not-created", checkout })
        .catch((e) => {
          if (e.code !== "REFUSED") throw e;
        });
      return true;
    });
    rpc = await wait(() => openAppServer(endpoint));
    const discovered = await rpc.request("hooks/list", { cwds: [checkout] });
    const hookState = Object.fromEntries(
      discovered.data[0].hooks.map((h: any) => [
        h.key,
        { enabled: true, trusted_hash: h.currentHash },
      ]),
    );
    const { thread } = await rpc.request("thread/start", {
      cwd: checkout,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      model: "htr-local",
      modelProvider: "htr",
      baseInstructions: "Return a short response; never call tools.",
      config: {
        hooks: { state: hookState },
        model_providers: {
          htr: {
            name: "local fixture",
            base_url: `http://127.0.0.1:${address.port}/v1`,
            wire_api: "responses",
            requires_openai_auth: false,
          },
        },
        model_reasoning_effort: "minimal",
      },
    });
    evidence.started = { id: thread.id, path: thread.path, status: thread.status };
    evidence.version = thread.cliVersion;
    const readBeforeWork = (
      await rpc.request("thread/read", { threadId: thread.id, includeTurns: false })
    ).thread;
    evidence.readBeforeWork = {
      id: readBeforeWork.id,
      path: readBeforeWork.path,
      status: readBeforeWork.status,
    };
    expect(readBeforeWork.path).toBe(thread.path);
    await rpc.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "Local native request", text_elements: [] }],
      clientUserMessageId: "local-user",
    });
    evidence.hooks = await wait(async () =>
      (await readFile(hookLog, "utf8"))
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s)),
    );
    const original = { kind: "codex", nativeId: thread.id, checkout };
    for (const path of new Set([
      undefined,
      thread.path,
      ...evidence.hooks.map((h: any) => h.path),
    ])) {
      try {
        const s = await client.request("session.find", { ...original, sessionPath: path });
        (evidence.bindings ??= []).push({
          queryPath: path,
          sessionId: s.sessionId,
          identity: s.identity,
          epoch: s.epoch,
          receiver: s.receiver,
        });
      } catch (e) {
        (evidence.bindings ??= []).push({ queryPath: path, error: String(e) });
      }
    }
    const session = await client.request("session.find", original);
    expect(session.receiver).toBeDefined();
    expect(session.identity.sessionPath).toBe(thread.path);
    expect(evidence.bindings.every((binding: any) => binding.sessionId === session.sessionId)).toBe(
      true,
    );
    const call = (method: string, params = {}) =>
      client.request(method, { sessionId: session.sessionId, epoch: session.epoch, ...params });
    const review = await wait(async () => {
      try {
        return await call("review.get");
      } catch {
        return undefined;
      }
    });
    expect(review.outcome).toBe("completed");
    expect(providerCalls).toBe(2);
    expect(Buffer.from(review.changes[0].before.content, "base64").toString()).toBe(
      "pre-existing edit\n",
    );
    expect(Buffer.from(review.changes[0].after.content, "base64").toString()).toBe(
      "native continuation\n",
    );
    expect((await client.request("session.find", original)).sessionId).toBe(session.sessionId);
    await expect(
      client.request("session.find", {
        ...original,
        sessionPath: join(dir, "foreign-rollout.jsonl"),
      }),
    ).rejects.toThrow("missing or ambiguous");
    const receiver = createClient({ socket: session.receiver.socket });
    for (const params of [
      {
        identity: { ...session.identity, nativeId: "replacement-native-id" },
        epoch: session.epoch,
      },
      { identity: { ...session.identity, checkout: dir }, epoch: session.epoch },
      {
        identity: { ...session.identity, sessionPath: join(dir, "foreign-rollout.jsonl") },
        epoch: session.epoch,
      },
      { identity: session.identity, epoch: "replacement-epoch" },
    ])
      expect((await receiver.request("admission.check", params)).state).toBe("blocked");
    evidence.stage = "feedback admission";
    const note = await call("note.save", {
      reviewId: review.id,
      note: { text: "Explain this in an isolated handoff" },
    });
    const batch = await call("batch.create", { noteIds: [note.id] });
    expect((await call("batch.submit", { batchId: batch.id })).state).toBe("queued");
    expect((await call("batch.reconcile", { batchId: batch.id })).state).toBe("queued");
    evidence.stage = "feedback completion";
    await wait(async () => {
      const latest = await call("review.get", { selection: "latest" });
      evidence.latest = { requestId: latest.requestId, outcome: latest.outcome };
      return latest.requestId === batch.id && latest.outcome === "completed";
    });
    const nativeUserIds: string[] = [];
    let cursor: string | null = null;
    let historyPages = 0;
    do {
      const page: {
        data: { item: { type: string; clientId: string } }[];
        nextCursor: string | null;
      } = await rpc.request("thread/items/list", {
        threadId: thread.id,
        cursor,
        limit: 1,
      });
      historyPages++;
      if (historyPages > 20) throw new Error("Unbounded isolated native history pagination");
      for (const entry of page.data)
        if (entry.item.type === "userMessage") nativeUserIds.push(entry.item.clientId);
      cursor = page.nextCursor;
    } while (cursor);
    expect(historyPages).toBeGreaterThan(1);
    expect(nativeUserIds.sort()).toEqual(["local-user", batch.id].sort());
    evidence.stage = "interruption begin";
    hold = true;
    await rpc.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "Local interruption request", text_elements: [] }],
    });
    await wait(async () => {
      const s = await call("review.status");
      evidence.lastStatus = { active: s.active, receiver: s.receiver, warnings: s.warnings };
      return s.active;
    });
    evidence.stage = "original server exit";
    if (binary === "/opt/homebrew/bin/codex") {
      const exited = new Promise<void>((resolve) => native.once("exit", () => resolve()));
      native.kill("SIGKILL");
      await exited;
      const loaded = await rpc.request("thread/loaded/list", { limit: 100 });
      expect(loaded.data).toContain(thread.id);
      const stillOriginal = (
        await rpc.request("thread/read", { threadId: thread.id, includeTurns: false })
      ).thread;
      expect(stillOriginal.id).toBe(thread.id);
      expect(stillOriginal.status.type).toBe("active");
      expect((await client.request("session.find", original)).sessionId).toBe(session.sessionId);
      evidence.wrapperExitLeavesListenerLoaded = true;
    }
    killListener();
    await wait(async () => {
      const s = await call("review.status");
      evidence.lastStatus = { active: s.active, receiver: s.receiver, warnings: s.warnings };
      return !s.receiver && !s.active;
    });
    expect((await call("review.get", { selection: "latest" })).outcome).toBe("interrupted");
    evidence.hooks = (await readFile(hookLog, "utf8"))
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
    expect(evidence.hooks.filter((h: any) => h.error)).toEqual([]);
    expect(evidence.hooks.filter((h: any) => h.event === "SessionStart")).toHaveLength(1);
    expect(evidence.hooks.filter((h: any) => h.event === "UserPromptSubmit")).toHaveLength(3);
    expect(evidence.hooks.every((h: any) => h.path === thread.path)).toBe(true);
    console.info(
      "Isolated native compatibility:",
      JSON.stringify({
        version: evidence.version,
        wrapperExitLeavesListenerLoaded: evidence.wrapperExitLeavesListenerLoaded ?? false,
        oneBinding: true,
        feedbackCompleted: true,
        listenerExitInterrupted: true,
      }),
    );
  } catch (e) {
    evidence.hooks = (await readFile(hookLog, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((s) => JSON.parse(s));
    console.error("Isolated public native evidence:", JSON.stringify(evidence));
    throw e;
  } finally {
    rpc?.close();
    killListener();
    provider.closeAllConnections();
    await new Promise<void>((r) => provider.close(() => r()));
    await new Promise<void>((r) => {
      runtime.once("exit", () => r());
      runtime.kill("SIGTERM");
    });
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

test("unknown native transcript metadata stays unknown and replacement listeners cannot acquire the original binding", async () => {
  const dir = await mkdtemp("/private/tmp/htr-compat-unknown-");
  const checkout = join(dir, "repo"),
    state = join(dir, "state"),
    codexHome = join(dir, "codex");
  const socket = join(state, "r.sock"),
    endpoint = `unix://${join(dir, "codex.sock")}`;
  await mkdir(checkout);
  await mkdir(codexHome, { mode: 0o700 });
  execFileSync("git", ["init", "-q", checkout]);
  const runtime = spawn(
    "node",
    [
      join(root, "home/.local/share/hunk-turn-review/dist/src/runtime.js"),
      "--state",
      state,
      "--socket",
      socket,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  await new Promise<void>((resolve, reject) => {
    runtime.stdout.once("data", () => resolve());
    runtime.once("exit", (code) => reject(new Error(`Isolated runtime exited ${code}`)));
    runtime.stderr.once("data", (d) => reject(new Error(d.toString())));
  });
  const client = createClient({ socket });
  const launch = () =>
    spawn(binary, ["app-server", "--listen", endpoint], {
      cwd: checkout,
      detached: true,
      env: { PATH: process.env.PATH, HOME: dir, CODEX_HOME: codexHome, XDG_CONFIG_HOME: dir },
      stdio: ["ignore", "ignore", "pipe"],
    });
  let native = launch(),
    rpc: any,
    adapter: any;
  const killListener = () => {
    try {
      process.kill(-native.pid!, "SIGKILL");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
    }
  };
  const connectOriginal = async () => {
    const deadline = Date.now() + 5000;
    let error;
    while (Date.now() < deadline) {
      try {
        return await openAppServer(endpoint);
      } catch (e) {
        error = e;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw error;
  };
  const start = (connection: any) =>
    connection.request("thread/start", {
      cwd: checkout,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      model: "htr-local",
      modelProvider: "htr",
      config: {
        model_providers: {
          htr: {
            name: "isolated metadata fixture",
            base_url: "http://127.0.0.1:9/v1",
            wire_api: "responses",
            requires_openai_auth: false,
          },
        },
      },
    });
  try {
    rpc = await connectOriginal();
    const { thread } = await start(rpc);
    expect(thread.path).toBeNull();
    adapter = await startCodexAdapter({
      endpoint,
      threadId: thread.id,
      checkout,
      socket,
      state,
      initialThread: thread,
      warn: () => {},
    });
    expect(adapter.identity.sessionPath).toBeUndefined();
    const session = await client.request("session.find", {
      kind: "codex",
      nativeId: thread.id,
      checkout,
    });
    expect(session.identity.sessionPath).toBeUndefined();
    expect(
      (await rpc.request("thread/read", { threadId: thread.id, includeTurns: false })).thread.path,
    ).toBeNull();
    const receiver = createClient({ socket: session.receiver.socket });
    expect(
      (
        await receiver.request("admission.check", {
          identity: session.identity,
          epoch: session.epoch,
        })
      ).ready,
    ).toBe(true);
    killListener();
    await adapter.close();
    await expect(rpc.request("thread/loaded/list", {})).rejects.toThrow();
    // A separate test driver opens the same private pathname after replacement.
    // The original observer must never reconnect or resume its old UUID there.
    native = launch();
    const replacement = await connectOriginal();
    const { thread: newThread } = await start(replacement);
    expect(newThread.id).not.toBe(thread.id);
    await expect(
      startCodexAdapter({
        endpoint,
        threadId: thread.id,
        checkout,
        socket,
        state,
        initialThread: thread,
        warn: () => {},
      }),
    ).rejects.toThrow("not loaded; refusing replacement resume");
    const retained = await client.request("session.find", {
      kind: "codex",
      nativeId: thread.id,
      checkout,
    });
    expect(retained.sessionId).toBe(session.sessionId);
    expect(retained.epoch).toBe(session.epoch);
    expect(retained.receiver).toBeUndefined();
    expect(retained.identity.sessionPath).toBeUndefined();
    replacement.close();
  } finally {
    rpc?.close();
    killListener();
    await adapter?.close();
    await new Promise<void>((resolve) => {
      runtime.once("exit", () => resolve());
      runtime.kill("SIGTERM");
    });
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);
