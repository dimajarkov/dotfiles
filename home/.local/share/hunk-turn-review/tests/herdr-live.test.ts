import { test, expect } from "bun:test";
import { spawn, execFileSync } from "node:child_process";
import { join } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { fixture } from "./runtime.test.js";

test("isolated named Herdr opens the configured argv review beside the original without focus", async () => {
  const f = await fixture({ pluginId: "htr.fixture", entrypoint: "review" });
  const session = "htr-backend-" + process.pid;
  const xdg = join(f.dir, "xdg");
  await mkdir(join(xdg, "herdr"), { recursive: true, mode: 0o700 });
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
  const cli = (args: string[]) => {
    const output = execFileSync("herdr", [...args, "--session", session], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return output.trim() ? JSON.parse(output) : {};
  };
  const wait = async (get: () => any) => {
    const end = Date.now() + 8000;
    let last;
    while (Date.now() < end) {
      try {
        const v = await get();
        if (v) return v;
      } catch (e) {
        last = e;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw last ?? new Error("Herdr fixture timed out");
  };
  try {
    await wait(() => cli(["api", "snapshot"]));
    const plugin = join(f.dir, "plugin");
    await mkdir(plugin);
    await writeFile(
      join(plugin, "herdr-plugin.toml"),
      'id = "htr.fixture"\nname = "Hunk test fixture"\nversion = "1.0.0"\nmin_herdr_version = "0.9.1"\nplatforms = ["macos", "linux"]\n[[panes]]\nid = "review"\ntitle = "Review fixture"\ncommand = ["/usr/bin/tail", "-f", "/dev/null"]\nplacement = "split"\n',
    );
    cli(["plugin", "link", plugin]);
    const created = cli([
      "workspace",
      "create",
      "--cwd",
      f.checkout,
      "--label",
      "htr-owned",
      "--no-focus",
    ]);
    const original = created.result.root_pane.pane_id;
    const piDriver = join(f.dir, "pi-layout.ts"),
      piSessions = join(f.dir, "pi-sessions");
    await mkdir(piSessions);
    await writeFile(
      piDriver,
      `import {createAssistantMessageEventStream} from "@earendil-works/pi-ai";
      export default function(pi){pi.registerProvider("htr-fixture",{baseUrl:"http://127.0.0.1:1",apiKey:"fixture",api:"htr-fixture",models:[{id:"local",name:"Local",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:1000}],streamSimple(model){
        const stream=createAssistantMessageEventStream(),message={role:"assistant",content:[{type:"text",text:"local layout fixture"}],api:"htr-fixture",provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:"stop",timestamp:Date.now()};
        setTimeout(()=>{stream.push({type:"start",partial:message});stream.push({type:"done",reason:"stop",message});stream.end();},0);return stream;
      }});}`,
    );
    const originalArgv = [
      "pi",
      "-ne",
      "-ns",
      "--no-mcp",
      "--offline",
      "--no-approve",
      "--provider",
      "htr-fixture",
      "--model",
      "local",
      "--thinking",
      "off",
      "--session-dir",
      piSessions,
      "--session-id",
      f.identity.nativeId,
      "-e",
      join(process.env.HOME!, ".pi/agent/extensions/herdr-agent-state.ts"),
      "-e",
      piDriver,
      "persist the isolated native layout fixture",
    ];
    await writeFile(
      join(plugin, "herdr-plugin.toml"),
      'id = "htr.fixture"\nname = "Hunk test fixture"\nversion = "1.0.0"\nmin_herdr_version = "0.9.1"\nplatforms = ["macos", "linux"]\n[[panes]]\nid = "review"\ntitle = "Review fixture"\ncommand = ["/usr/bin/tail", "-f", "/dev/null"]\nplacement = "split"\n[[panes]]\nid = "original"\ntitle = "Original native Pi fixture"\ncommand = ' +
        JSON.stringify(originalArgv) +
        "\n",
    );
    cli(["plugin", "link", plugin]);
    const originalOpened = cli([
      "plugin",
      "pane",
      "open",
      "--plugin",
      "htr.fixture",
      "--entrypoint",
      "original",
      "--placement",
      "split",
      "--direction",
      "right",
      "--target-pane",
      original,
      "--cwd",
      f.checkout,
      "--env",
      `HERDR_SESSION=${session}`,
      "--no-focus",
    ]);
    const nativePane = originalOpened.result.plugin_pane.pane.pane_id;
    cli(["pane", "close", original]);
    await wait(() =>
      cli(["api", "snapshot"]).result.snapshot.agents.some(
        (a: any) => a.pane_id === nativePane && a.agent === "pi",
      ),
    );
    let snapshot: any;
    try {
      snapshot = await wait(() => {
        const s = cli(["api", "snapshot"]).result.snapshot;
        return s.agents.some((a: any) => a.pane_id === nativePane && a.agent_session?.value)
          ? s
          : undefined;
      });
    } catch (e) {
      throw new Error(
        String(e) +
          " " +
          JSON.stringify(cli(["api", "snapshot"]).result.snapshot.agents) +
          " " +
          execFileSync(
            "herdr",
            ["pane", "read", nativePane, "--lines", "50", "--session", session],
            { env, encoding: "utf8" },
          ),
      );
    }
    const ref = snapshot.agents.find((a: any) => a.pane_id === nativePane).agent_session;
    if (ref.kind === "path")
      expect(
        await wait(async () => {
          try {
            return JSON.parse((await readFile(ref.value, "utf8")).split("\n")[0]).id;
          } catch {
            return undefined;
          }
        }),
      ).toBe(f.identity.nativeId);
    else expect(ref.value).toBe(f.identity.nativeId);
    const attached = await f.client.request("session.attach", {
      identity: { ...f.identity, ...(ref.kind === "path" ? { sessionPath: ref.value } : {}) },
      epoch: f.epoch,
      layout: {
        session,
        socket: join(xdg, "herdr/sessions", session, "herdr.sock"),
        paneId: nativePane,
      },
    });
    const call = (method: string, params = {}) =>
      f.client.request(method, { sessionId: attached.sessionId, epoch: f.epoch, ...params });
    await call("request.begin", { requestId: "live-layout" });
    await writeFile(join(f.checkout, "tracked.txt"), "live Herdr change\n");
    await call("request.reconcile");
    const status = await call("review.status");
    expect({ layoutState: status.layoutState, warnings: status.warnings }).toMatchObject({
      layoutState: { state: "open" },
    });
    const after = cli(["api", "snapshot"]).result.snapshot;
    expect(after.focused_pane_id).toBe(snapshot.focused_pane_id);
    expect(
      cli(["pane", "neighbor", "--pane", nativePane, "--direction", "right"]).result.neighbor
        .neighbor_pane_id,
    ).toBe(status.layoutState.paneId);
    await call("request.complete", { requestId: "live-layout", outcome: "completed" });
    expect((await call("review.get")).outcome).toBe("completed");
  } finally {
    try {
      cli(["session", "stop", session, "--json"]);
    } catch {}
    server.kill("SIGTERM");
    await f.close();
  }
}, 20000);
