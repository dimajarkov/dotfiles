import { test, expect } from "bun:test";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { fixture } from "./runtime.test.js";
import { openAppServer } from "../../../../.codex/hunk-turn-review/transport.mjs";
import { startCodexAdapter } from "../../../../.codex/hunk-turn-review/adapter.mjs";

test("isolated Herdr and original native Codex app-server open one sibling and admit feedback", async () => {
  const f = await fixture({ pluginId: "htr.codex", entrypoint: "review" }),
    session = `htr-codex-${process.pid}`;
  const xdg = join(f.dir, "xdg"),
    codexHome = join(f.dir, "codex"),
    plugin = join(f.dir, "plugin"),
    hook = join(f.dir, "hook.mjs");
  await mkdir(join(xdg, "herdr"), { recursive: true, mode: 0o700 });
  await mkdir(codexHome, { mode: 0o700 });
  await mkdir(plugin);
  const config = join(xdg, "herdr/config.toml");
  await writeFile(config, 'onboarding = false\n[shell]\ncommand = "/bin/zsh"\n');
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: xdg,
    HERDR_CONFIG_PATH: config,
    HERDR_ENV: "1",
    HERDR_SESSION: session,
  };
  const server = spawn("herdr", ["--session", session, "server"], {
    cwd: f.checkout,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const cli = (args: string[]) =>
    JSON.parse(
      execFileSync("herdr", [...args, "--session", session], {
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  const wait = async (get: () => any) => {
    const end = Date.now() + 12000;
    let error;
    while (Date.now() < end) {
      try {
        const v = await get();
        if (v) return v;
      } catch (e) {
        error = e;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw error ?? new Error("Owned Codex/Herdr fixture did not settle");
  };
  const endpoint = `unix://${join(f.dir, "codex.sock")}`;
  const provider = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      "event: response.completed\ndata: " +
        JSON.stringify({
          type: "response.completed",
          response: {
            id: "htr-local",
            status: "completed",
            output: [
              {
                id: "htr-message",
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "local native response", annotations: [] }],
              },
            ],
            usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          },
        }) +
        "\n\n",
    );
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  let rpc: any, adapter: any;
  try {
    await wait(() => cli(["api", "snapshot"]));
    const originalArgv = [
      process.env.HTR_CODEX_BINARY ??
        join(process.env.HOME!, ".codex/packages/app-server-daemon/current/codex"),
      "app-server",
      "--listen",
      endpoint,
    ];
    await writeFile(
      join(plugin, "herdr-plugin.toml"),
      'id = "htr.codex"\nname = "Owned Codex backend fixture"\nversion = "1.0.0"\nmin_herdr_version = "0.9.1"\nplatforms = ["macos", "linux"]\n[[panes]]\nid = "review"\ntitle = "Review fixture"\ncommand = ["/usr/bin/tail", "-f", "/dev/null"]\n[[panes]]\nid = "original"\ntitle = "Original Codex fixture"\ncommand = ' +
        JSON.stringify(originalArgv) +
        "\n",
    );
    cli(["plugin", "link", plugin]);
    const workspace = cli(["workspace", "create", "--cwd", f.checkout, "--no-focus"]);
    const root = workspace.result.root_pane.pane_id;
    const opened = cli([
      "plugin",
      "pane",
      "open",
      "--plugin",
      "htr.codex",
      "--entrypoint",
      "original",
      "--placement",
      "split",
      "--direction",
      "right",
      "--target-pane",
      root,
      "--cwd",
      f.checkout,
      "--no-focus",
      ...Object.entries({
        CODEX_HOME: codexHome,
        TMPDIR: f.dir,
        HUNK_TURN_REVIEW_SOCKET: f.socket,
        HUNK_TURN_REVIEW_STATE: join(f.dir, "state"),
      }).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
    ]);
    const nativePane = opened.result.plugin_pane.pane.pane_id;
    cli(["pane", "close", root]);
    await writeFile(
      hook,
      `import {handleHook} from ${JSON.stringify(join(import.meta.dir, "../../../../.codex/hunk-turn-review/hook.mjs"))};import {writeFileSync} from "node:fs";let text="";for await(const c of process.stdin)text+=c;const e=JSON.parse(text);await handleHook(e);writeFileSync("tracked.txt","native Codex "+e.turn_id+"\\n");`,
    );
    const sessionHook = join(f.dir, "session-hook.mjs");
    await writeFile(
      sessionHook,
      `import {writeFileSync} from "node:fs";import {spawnSync} from "node:child_process";let input="";for await(const c of process.stdin)input+=c;writeFileSync(${JSON.stringify(join(f.dir, "session-hook.json"))},input);const result=spawnSync("bash",[${JSON.stringify(join(process.env.HOME!, ".codex/herdr-agent-state.sh"))},"session"],{input,env:process.env,stdio:["pipe","inherit","inherit"]});process.exit(result.status??1);`,
    );
    const commands = {
      SessionStart: `node ${sessionHook}`,
      UserPromptSubmit: `node ${hook}`,
    };
    await writeFile(
      join(codexHome, "hooks.json"),
      JSON.stringify({
        hooks: Object.fromEntries(
          Object.entries(commands).map(([name, command]) => [
            name,
            [{ hooks: [{ type: "command", command, timeout: 10 }] }],
          ]),
        ),
      }),
    );
    rpc = await wait(() => openAppServer(endpoint));
    const discovered = await rpc.request("hooks/list", { cwds: [f.checkout] });
    const hookState = Object.fromEntries(
      discovered.data[0].hooks.map((h: any) => [
        h.key,
        { enabled: true, trusted_hash: h.currentHash },
      ]),
    );
    const started = await rpc.request("thread/start", {
      cwd: f.checkout,
      model: "local",
      modelProvider: "htr",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      baseInstructions: "Return a short response, never use tools.",
      config: {
        hooks: { state: hookState },
        model_reasoning_effort: "minimal",
        model_providers: {
          htr: {
            name: "local fixture",
            wire_api: "responses",
            requires_openai_auth: false,
            base_url: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
          },
        },
      },
    });
    const namedSocket = join(xdg, "herdr/sessions", session, "herdr.sock");
    adapter = await startCodexAdapter({
      endpoint,
      threadId: started.thread.id,
      checkout: f.checkout,
      socket: f.socket,
      state: join(f.dir, "state"),
      initialThread: started.thread,
      layout: { session, socket: namedSocket, paneId: nativePane },
    });
    const call = (method: string, params = {}) =>
      f.client.request(method, { sessionId: adapter.sessionId, ...params });
    const before = cli(["api", "snapshot"]).result.snapshot;
    await rpc.request("turn/start", {
      threadId: started.thread.id,
      input: [{ type: "text", text: "Local backend workflow fixture", text_elements: [] }],
    });
    // SessionStart metadata crosses the actual Herdr process boundary. Arm the
    // scenario only once its original native identity is publicly observable.
    await wait(() =>
      cli(["api", "snapshot"]).result.snapshot.agents.find(
        (a: any) =>
          a.pane_id === nativePane &&
          a.agent === "codex" &&
          a.agent_session?.kind === "id" &&
          a.agent_session.value === started.thread.id &&
          a.cwd === f.checkout &&
          a.foreground_cwd === f.checkout,
      ),
    ).catch((error) => {
      throw new Error(
        `${error.message}: ${JSON.stringify(cli(["api", "snapshot"]).result.snapshot.agents)} hook=${require("node:fs").existsSync(join(f.dir, "session-hook.json")) ? require("node:fs").readFileSync(join(f.dir, "session-hook.json"), "utf8") : "not-run"}`,
      );
    });
    const review = await wait(async () => {
      try {
        return await call("review.get");
      } catch {
        return undefined;
      }
    });
    const status = await call("review.status");
    expect({ layout: status.layoutState, warnings: status.warnings }).toMatchObject({
      layout: { state: "open" },
    });
    const after = cli(["api", "snapshot"]).result.snapshot;
    expect(after.focused_pane_id).toBe(before.focused_pane_id);
    expect(
      cli(["pane", "neighbor", "--pane", nativePane, "--direction", "right"]).result.neighbor
        .neighbor_pane_id,
    ).toBe(status.layoutState.paneId);
    const note = await call("note.save", {
        reviewId: review.id,
        note: { text: "Clarify the result without editing" },
      }),
      batch = await call("batch.create", { noteIds: [note.id] });
    expect((await call("batch.submit", { batchId: batch.id })).state).toBe("queued");
    await wait(async () => {
      const r = await call("review.get", { selection: "latest" });
      return r.requestId === batch.id && r.outcome === "completed";
    });
    expect(cli(["api", "snapshot"]).result.snapshot.panes).toHaveLength(2);
  } finally {
    await adapter?.close();
    rpc?.close();
    try {
      cli(["session", "stop", session, "--json"]);
    } catch {}
    server.kill("SIGTERM");
    provider.closeAllConnections();
    await new Promise<void>((r) => provider.close(() => r()));
    await f.close();
  }
}, 25000);
