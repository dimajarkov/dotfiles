import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fixture } from "./runtime.test.js";
import { openAppServer } from "../../../../.codex/hunk-turn-review/transport.mjs";

const binary =
  process.env.HTR_CODEX_BINARY ??
  join(
    process.env.HOME!,
    ".npm-global/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex",
  );
const launcher = `
  const { spawn } = require("node:child_process");
  const child = spawn(process.argv[1], process.argv.slice(2), { stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  child.once("error", (error) => { console.error(error); process.exitCode = 1; });
  child.once("close", (code, signal) => { process.exitCode = signal ? 128 : code ?? 1; });
`;

const waitForExit = async (child: ReturnType<typeof spawn>) => {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      child.off("exit", done);
      child.off("error", done);
      resolve();
    };
    child.once("exit", done);
    child.once("error", done);
    if (child.exitCode !== null || child.signalCode !== null) done();
  });
};

const killOwnedProcessGroup = (child: ReturnType<typeof spawn>) => {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
};

const waitForEndpointClosed = async (endpoint: string) => {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    try {
      const connection = await openAppServer(endpoint);
      connection.close();
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Owned native Codex endpoint remained available: ${endpoint}`);
};

test("exact isolated Codex endpoint admits stable batch identity and final native turn completion", async () => {
  const f = await fixture();
  const codexHome = join(f.dir, "codex");
  await mkdir(codexHome, { mode: 0o700 });
  const endpoint = `unix://${join(f.dir, "codex.sock")}`;
  const hook = join(f.dir, "native-hook.mjs"),
    hookLog = join(f.dir, "hook-events.jsonl");
  await writeFile(
    hook,
    `import {handleHook} from ${JSON.stringify(join(import.meta.dir, "../../../../.codex/hunk-turn-review/hook.mjs"))};
    import {appendFileSync,writeFileSync,existsSync} from "node:fs";
    let input="";for await(const c of process.stdin)input+=c;const event=JSON.parse(input);
    try{await handleHook(event);appendFileSync(${JSON.stringify(hookLog)},JSON.stringify({event:event.hook_event_name,turnId:event.turn_id})+"\\n");
      if(event.hook_event_name==="UserPromptSubmit")writeFileSync("tracked.txt","native Codex interval\\n");
      if(event.hook_event_name==="Stop" && !existsSync(${JSON.stringify(join(f.dir, "continued"))})){writeFileSync(${JSON.stringify(join(f.dir, "continued"))},"yes");writeFileSync("tracked.txt","native Codex continuation\\n");process.stdout.write(JSON.stringify({decision:"block",reason:"Continue once for the local acceptance fixture"})+"\\n");}
    }catch(error){appendFileSync(${JSON.stringify(hookLog)},JSON.stringify({error:String(error)})+"\\n");}
  `,
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
  const native = spawn(
    process.execPath,
    ["-e", launcher, binary, "app-server", "--listen", endpoint],
    {
      detached: process.platform !== "win32",
      cwd: f.checkout,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin",
        HOME: f.dir,
        XDG_CONFIG_HOME: f.dir,
        CODEX_HOME: codexHome,
        HERDR_ENV: "1",
        HUNK_TURN_REVIEW_SOCKET: f.socket,
        HUNK_TURN_REVIEW_STATE: join(f.dir, "state"),
        HUNK_TURN_REVIEW_CODEX_ENDPOINT: endpoint,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let rpc: any,
    log = "";
  native.stderr.on("data", (d) => (log += d.toString()));
  let hold = false,
    providerCalls = 0;
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
                  {
                    type: "output_text",
                    text: "local deterministic native response",
                    annotations: [],
                  },
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
  const addr = provider.address() as { port: number };
  const nativeEvents: any[] = [];
  const wait = async (phase: string, get: () => Promise<any>) => {
    const end = Date.now() + 15000;
    let lastError = "";
    while (Date.now() < end) {
      try {
        const value = await get();
        if (value) return value;
      } catch (e) {
        lastError = String(e);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(
      `Isolated Codex native ${phase} did not settle: ` +
        lastError +
        " " +
        log.slice(-3000) +
        " " +
        JSON.stringify(nativeEvents) +
        " " +
        (await readFile(hookLog, "utf8").catch(() => "")),
    );
  };
  try {
    rpc = await wait("app-server connection", () => openAppServer(endpoint));
    rpc.onNotification((m: string, p: any) => {
      if (m === "turn/started" || m === "turn/completed")
        nativeEvents.push({
          method: m,
          turnId: p.turn?.id,
          items: p.turn?.items?.map((i: any) => ({ type: i.type, clientId: i.clientId })),
        });
    });
    const discovered = await rpc.request("hooks/list", { cwds: [f.checkout] });
    const hookState = Object.fromEntries(
      discovered.data[0].hooks.map((h: any) => [
        h.key,
        { enabled: true, trusted_hash: h.currentHash },
      ]),
    );
    const started = await rpc.request("thread/start", {
      cwd: f.checkout,
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
            base_url: `http://127.0.0.1:${addr.port}/v1`,
            wire_api: "responses",
            requires_openai_auth: false,
          },
        },
        model_reasoning_effort: "minimal",
      },
    });
    const nativeId = started.thread.id;
    await rpc.request("turn/start", {
      threadId: nativeId,
      input: [{ type: "text", text: "Local native acceptance request", text_elements: [] }],
      clientUserMessageId: "stable-user-request",
    });
    const session = await wait("session binding", () =>
      f.client.request("session.find", { kind: "codex", nativeId, checkout: f.checkout }),
    );
    const call = (method: string, params = {}) =>
      f.client.request(method, { sessionId: session.sessionId, epoch: session.epoch, ...params });
    const review = await wait("initial review completion", async () => {
      try {
        return await call("review.get");
      } catch {
        return undefined;
      }
    });
    expect(review.outcome).toBe("completed");
    expect(providerCalls).toBe(2);
    expect(Buffer.from(review.changes[0].after.content, "base64").toString()).toBe(
      "native Codex continuation\n",
    );
    expect(Buffer.from(review.changes[0].before.content, "base64").toString()).toBe(
      "pre-existing edit\n",
    );
    const note = await call("note.save", {
      reviewId: review.id,
      note: { text: "Explain this in a handoff document" },
    });
    const batch = await call("batch.create", { noteIds: [note.id] });
    expect((await call("batch.submit", { batchId: batch.id })).state).toBe("queued");
    expect((await call("batch.reconcile", { batchId: batch.id })).state).toBe("queued");
    await wait("feedback history admission", async () => {
      const history = await rpc.request("thread/items/list", { threadId: nativeId, limit: 100 });
      return history.data.some(
        (e: any) => e.item.type === "userMessage" && e.item.clientId === batch.id,
      );
    });
    expect((await call("batch.reconcile", { batchId: batch.id })).state).toBe("queued");
    await wait("feedback review completion", async () => {
      const latest = await call("review.get", { selection: "latest" });
      return latest.requestId === batch.id && latest.outcome === "completed";
    });
    const hookEvents = (await readFile(hookLog, "utf8"))
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
    expect(hookEvents.filter((e) => e.event === "SessionStart")).toHaveLength(1);
    expect(hookEvents.filter((e) => e.event === "UserPromptSubmit")).toHaveLength(2);
    expect(hookEvents.filter((e) => e.error)).toEqual([]);
    await expect(call("batch.retry", { batchId: batch.id })).rejects.toThrow("already admitted");
    hold = true;
    await rpc.request("turn/start", {
      threadId: nativeId,
      input: [{ type: "text", text: "Isolated interruption request", text_elements: [] }],
    });
    await wait("interruption start", async () => {
      const s = await call("review.status");
      return s.active;
    });
    const launcherExit = waitForExit(native);
    native.kill("SIGKILL");
    await launcherExit;
    const loaded = await rpc.request("thread/loaded/list", { limit: 100 });
    expect(loaded.data).toContain(nativeId);
    const stillOriginal = (
      await rpc.request("thread/read", { threadId: nativeId, includeTurns: false })
    ).thread;
    expect(stillOriginal.id).toBe(nativeId);
    expect(stillOriginal.status.type).toBe("active");
    expect(
      (
        await f.client.request("session.find", {
          kind: "codex",
          nativeId,
          checkout: f.checkout,
        })
      ).sessionId,
    ).toBe(session.sessionId);

    killOwnedProcessGroup(native);
    await waitForEndpointClosed(endpoint);
    await expect(openAppServer(endpoint)).rejects.toThrow();
    await wait("observer detach after owned listener exit", async () => {
      const s = await call("review.status");
      return !s.receiver && !s.active;
    });
    expect((await call("review.get", { selection: "latest" })).outcome).toBe("interrupted");
    expect(
      (
        await f.client.request("session.find", {
          kind: "codex",
          nativeId,
          checkout: f.checkout,
        })
      ).sessionId,
    ).toBe(session.sessionId);
    expect((provider.address() as { port: number }).port).toBe(addr.port);
  } finally {
    rpc?.close();
    killOwnedProcessGroup(native);
    await waitForExit(native);
    await waitForEndpointClosed(endpoint);
    provider.closeAllConnections();
    await new Promise<void>((r) => provider.close(() => r()));
    await f.close();
  }
}, 30000);
