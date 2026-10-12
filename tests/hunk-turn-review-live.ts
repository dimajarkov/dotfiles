/** Native Herdr/PTY acceptance. Local model responses are fixtures, not visual approval.
 * Run with --profile <immutable profile>, or explicitly labelled --hunk-host/--pi components.
 * No installer, inherited auth, focused-pane fallback, or production hook trust is used.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  existsSync,
  appendFileSync,
  readdirSync,
  lstatSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import { createClient } from "../home/.local/share/hunk-turn-review/client.mjs";
import { openAppServer } from "../home/.codex/hunk-turn-review/transport.mjs";

const root = resolve(import.meta.dir, "..");
const options = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) options.set(process.argv[i], process.argv[i + 1]);
if (process.env.HERDR_ENV !== "1") throw new Error("HERDR_ENV=1 is required before Herdr control");
const profile = options.get("--profile");
if (profile && !existsSync(join(profile, "bin/hunk-turn-review")))
  throw new Error(`Missing immutable profile: ${profile}; no server or configuration changed`);
const host = profile
  ? readFileSync(realpathSync(join(profile, "bin/hunk-turn-review")), "utf8").match(
      /exec (\/nix\/store\/[^\s]+\/bin\/hunk)\s*\\/,
    )?.[1]
  : options.get("--hunk-host");
const pi = profile ? join(profile, "bin/pi") : options.get("--pi");
if (!host || !pi)
  throw new Error("Supply --profile, or --hunk-host and --pi for component-only proof");
const herdr = options.get("--herdr") ?? "/opt/homebrew/bin/herdr";
const codex = profile ? join(profile, "bin/codex") : "/opt/homebrew/bin/codex";
// Only the existing credential-free app-server branch is invoked.
const node = realpathSync(
  options.get("--node") ?? execFileSync("which", ["node"], { encoding: "utf8" }).trim(),
);
const homeAssets = profile ? join(profile, "share/home") : join(root, "home");
const evidence = realpathSync(mkdtempSync("/private/tmp/htrl-"));
const session = `htrl-${process.pid}`;
const checkout = join(evidence, "repo"),
  state = join(evidence, "state"),
  home = join(evidence, "home");
const xdg = join(evidence, "xdg"),
  runtimeDir = join(evidence, "runtime");
for (const directory of [
  checkout,
  state,
  home,
  xdg,
  runtimeDir,
  join(xdg, "herdr"),
  join(home, ".codex"),
  join(home, ".pi/agent/extensions"),
  join(evidence, "pi-sessions"),
])
  mkdirSync(directory, { mode: 0o700, recursive: true });
const socket = join(state, "r.sock"),
  endpoint = `unix://${join(evidence, "c.sock")}`;
const baseEnv: NodeJS.ProcessEnv = {
  PATH: `${profile ? `${profile}/bin:` : ""}${resolve(node, "..")}:/opt/homebrew/bin:/usr/bin:/bin`,
  HOME: home,
  XDG_CONFIG_HOME: xdg,
  XDG_RUNTIME_DIR: runtimeDir,
  TMPDIR: evidence,
  TERM: "xterm-256color",
  LANG: "en_US.UTF-8",
  HERDR_ENV: "1",
  HERDR_SESSION: session,
  HERDR_CONFIG_PATH: join(xdg, "herdr/config.toml"),
  CODEX_HOME: join(home, ".codex"),
  PI_CODING_AGENT_DIR: join(home, ".pi/agent"),
  HUNK_TURN_REVIEW_STATE: state,
  HUNK_TURN_REVIEW_SOCKET: socket,
  HUNK_TURN_REVIEW_CODEX_ENDPOINT: endpoint,
  HUNK_TURN_REVIEW_CLIENT: join(homeAssets, ".local/share/hunk-turn-review/client.mjs"),
  HUNK_DISABLE_UPDATE_NOTICE: "1",
};
if (profile) {
  // Native hook subprocesses initialize the system shell again. Model the
  // installer's user PATH hook in this synthetic home, after system zshenv.
  writeFileSync(join(home, ".zshenv"), `export PATH='${profile}/bin':$PATH\n`, {
    mode: 0o600,
  });
}
const record = (name: string, value: unknown) =>
  writeFileSync(join(evidence, name + ".json"), JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
const run = (binary: string, args: string[]) =>
  execFileSync(binary, args, {
    cwd: checkout,
    env: baseEnv,
    encoding: "utf8",
    timeout: 15000,
    stdio: ["ignore", "pipe", "pipe"],
  });
const cli = (...args: string[]) => {
  const output = run(herdr, [...args, "--session", session]);
  if (!output.trim()) return {};
  if (!output.trim().startsWith("{")) return { text: output };
  return JSON.parse(output);
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function wait<T>(
  phase: string,
  get: () => T | Promise<T>,
  timeout = 15000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await get();
      if (value) return value;
    } catch (error) {
      last = String(error);
    }
    await delay(100);
  }
  throw new Error(`${phase} timed out: ${String(last)}; evidence ${evidence}`);
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const children: ChildProcess[] = [];
function owned(binary: string, args: string[], name: string) {
  const child = spawn(binary, args, {
    cwd: checkout,
    env: baseEnv,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.stdout?.on("data", (data) =>
    appendFileSync(join(evidence, name + ".stdout"), data, { mode: 0o600 }),
  );
  let stderr = "";
  child.stderr?.on("data", (data) => {
    stderr += data.toString();
    writeFileSync(join(evidence, name + ".stderr"), stderr, { mode: 0o600 });
  });
  return child;
}
const client = createClient({ socket, timeoutMs: 5000 });
let server: ChildProcess | undefined,
  rpc: any,
  activePane = "",
  viewer = "",
  hunkSession = "";
let providerIndex = 0;
const held: (() => void)[] = [];
let hold = false;
const provider = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const input = JSON.parse(body);
  record(`provider-${providerIndex++}`, input);
  const flattened = JSON.stringify(
    [...input.input].reverse().find((i: any) => i.role === "user") ?? input.input,
  );
  const recent = flattened.includes("APPLY-CORRECTION")
    ? "CORRECT"
    : flattened.includes("BUSY")
      ? "BUSY"
      : "EDIT1";
  const tools = input.tools ?? [];
  const tool = tools.find((t: any) => /^(exec_command|shell_command)$/.test(t.name));
  const last = input.input?.at(-1);
  let output: any[];
  if (tool && last?.type !== "function_call_output") {
    const content = flattened.includes("FAIL-FIXTURE")
      ? "first = 99\n"
      : recent === "CORRECT"
        ? "first = 11\n"
        : recent === "BUSY"
          ? "first = 20\n"
          : "first = 10\n";
    const cmd =
      "python3 -c " +
      shellQuote(
        `from pathlib import Path; print(Path('tracked.txt').read_text()); ${flattened.includes("CLARIFY-HANDOFF") ? "" : `Path('tracked.txt').write_text(${JSON.stringify(content)})`}`,
      );
    output = [
      {
        type: "function_call",
        id: `fc_${providerIndex}`,
        call_id: `call_${providerIndex}`,
        name: tool.name,
        arguments: JSON.stringify(tool.name === "exec_command" ? { cmd } : { command: cmd }),
      },
    ];
  } else {
    if (flattened.includes("FAIL-FIXTURE")) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            type: "invalid_request_error",
            code: "invalid_request_error",
            message: "Deliberate local acceptance provider failure after an actual fixture edit",
          },
        }),
      );
      return;
    }
    if (recent === "EDIT1" && !existsSync(join(evidence, "first-response-release")))
      await wait(
        "local first-response model gate",
        () => existsSync(join(evidence, "first-response-release")),
        30000,
      );
    else await delay(5000);
    if (hold) await new Promise<void>((r) => held.push(r));
    output = [
      {
        id: `msg_${providerIndex}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: flattened.includes("CLARIFY-HANDOFF")
              ? "Clarification and handoff: the original snapshot shows first = 10. Current code was inspected. No code change requested."
              : "Local fixture response completed after inspecting current fixture code.",
            annotations: [],
          },
        ],
      },
    ];
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const emit = (event: any) =>
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  for (const [output_index, item] of output.entries()) {
    emit({
      type: "response.output_item.added",
      output_index,
      item: item.type === "function_call" ? { ...item, arguments: "" } : item,
    });
    if (item.type === "function_call") {
      emit({
        type: "response.function_call_arguments.delta",
        output_index,
        item_id: item.id,
        delta: item.arguments,
      });
      emit({
        type: "response.function_call_arguments.done",
        output_index,
        item_id: item.id,
        arguments: item.arguments,
      });
    }
    emit({ type: "response.output_item.done", output_index, item });
  }
  res.end(
    "event: response.completed\ndata: " +
      JSON.stringify({
        type: "response.completed",
        response: {
          id: `resp_${providerIndex}`,
          status: "completed",
          output,
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        },
      }) +
      "\n\n",
  );
});
function shellQuote(s: string) {
  return "'" + s.replaceAll("'", "'\\''") + "'";
}
const hunkEnv = { ...baseEnv };
async function hunk(...args: string[]) {
  return JSON.parse(
    execFileSync(host!, ["session", ...args, "--json"], {
      cwd: checkout,
      env: hunkEnv,
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}
const snapshot = () => cli("api", "snapshot").result.snapshot;
function paneText(pane: string) {
  return cli("pane", "read", pane, "--source", "recent-unwrapped", "--lines", "160");
}
function keys(pane: string, ...keysToSend: string[]) {
  cli("pane", "send-keys", pane, ...keysToSend);
}
async function render(text: string) {
  return wait(`Hunk renders ${text}`, () => JSON.stringify(paneText(viewer)).includes(text));
}
async function action(index: number) {
  keys(viewer, "ctrl+g");
  await render("Human turn-review actions");
  for (let i = 0; i < index; i++) keys(viewer, "down");
  keys(viewer, "enter");
  await delay(200);
}
async function note(text: string) {
  await hunk("navigate", hunkSession, "--file", "tracked.txt", "--new-line", "1");
  keys(viewer, "v", "c");
  await render("Draft note");
  cli("pane", "send-text", viewer, text);
  keys(viewer, "ctrl+s");
  await render("Your note");
  const notes = (await hunk("comment", "list", hunkSession, "--type", "user")).comments;
  const saved = notes.find((n: any) => n.body === text);
  check(saved?.editable && saved?.noteId, "Native editable human note missing");
  return saved;
}
async function send() {
  await action(1);
  await render("Send review to original native session?");
  keys(viewer, "enter");
}
const newPlugin = join(evidence, "plugin");
const nativePlugin = join(evidence, "native");
mkdirSync(newPlugin);
mkdirSync(nativePlugin);
let attached: any;
let codexConfig: any;
const call = (method: string, params = {}) =>
  client.request(method, { sessionId: attached.sessionId, ...params });
const selectedKind = options.get("--kind") ?? "pi";
nativeFixture: try {
  // Keep this immutable input alive across later hook launches and native resume.
  // A no-link Nix build can otherwise be collected while the fixture is running.
  if (profile) {
    const nixStore = execFileSync("which", ["nix-store"], { encoding: "utf8" }).trim();
    run(nixStore, [
      "--realise",
      profile,
      "--add-root",
      join(evidence, "profile-root"),
      "--indirect",
    ]);
    check(
      realpathSync(join(evidence, "profile-root")) === realpathSync(profile),
      "Profile root changed input",
    );
  }
  run("git", ["init", "-q"]);
  writeFileSync(join(checkout, "tracked.txt"), "first = 1\n");
  writeFileSync(join(checkout, "old.txt"), "committed baseline\n");
  run("git", ["add", "."]);
  writeFileSync(join(checkout, "tracked.txt"), "first = 2\n");
  writeFileSync(join(checkout, "old.txt"), "pre-existing unrelated edit\n");
  writeFileSync(baseEnv.HERDR_CONFIG_PATH!, 'onboarding = false\n[shell]\ncommand = "/bin/zsh"\n');
  server = owned(herdr, ["--session", session, "server"], "herdr");
  await wait("owned Herdr ready", snapshot);
  record("owned-server", {
    pid: server.pid,
    session,
    evidence,
    home,
    xdg,
    checkout,
    scope: profile ? "profile" : "components",
    profile,
    profileRoot: profile ? join(evidence, "profile-root") : undefined,
    host,
    pi,
    node,
    nodeVersion: run(node, ["--version"]).trim(),
    bunVersion: process.versions.bun,
    fixtureSha256: createHash("sha256")
      .update(readFileSync(join(root, "tests/hunk-turn-review-live.ts")))
      .digest("hex"),
    sourceHashes: Object.fromEntries(
      [
        join(
          homeAssets,
          ".local/share/hunk-turn-review/dist",
          profile ? "runtime.js" : "src/runtime.js",
        ),
        join(homeAssets, ".pi/agent/extensions/hunk-turn-review/index.ts"),
        join(homeAssets, ".codex/hunk-turn-review/adapter.mjs"),
        join(homeAssets, ".config/hunk/extensions/human-review/turn-review.ts"),
      ].map((file) => [file, createHash("sha256").update(readFileSync(file)).digest("hex")]),
    ),
  });
  run(herdr, ["integration", "install", selectedKind, "--session", session]);
  const runtime = profile ? join(profile, "bin/hunk-turn-review-runtime") : node;
  const runtimeArgs = profile
    ? []
    : [
        join(homeAssets, ".local/share/hunk-turn-review/dist/src/runtime.js"),
        "--state",
        state,
        "--socket",
        socket,
        "--pluginId",
        "hunk-turn-review",
        "--entrypoint",
        "review",
      ];
  owned(runtime, runtimeArgs, "core");
  await wait("core ready", () => existsSync(socket));
  const portServer = createServer();
  await new Promise<void>((r) => portServer.listen(0, "127.0.0.1", r));
  const address = portServer.address();
  check(address && typeof address !== "string", "No private broker port");
  hunkEnv.HUNK_MCP_PORT = String(address.port);
  portServer.close();
  const launcher = join(evidence, "review.sh");
  // Retain the exact immutable host/extension, mapping only broker HOME/XDG/port
  // into the fixture namespace because packaged wrappers pin the user's port.
  const hostBinary = host;
  writeFileSync(
    launcher,
    `#!/bin/sh\nexport HUNK_MCP_PORT=${hunkEnv.HUNK_MCP_PORT}\nexport XDG_RUNTIME_DIR=${shellQuote(runtimeDir)}\nexport XDG_CONFIG_HOME=${shellQuote(join(evidence, "hunk-config"))}\nexec ${shellQuote(hostBinary!)} --extension ${shellQuote(join(homeAssets, ".config/hunk/extensions/human-review"))} turn-review\n`,
    { mode: 0o700 },
  );
  hunkEnv.XDG_CONFIG_HOME = join(evidence, "hunk-config");
  writeFileSync(
    join(newPlugin, "herdr-plugin.toml"),
    `id = "hunk-turn-review"\nname = "Owned Hunk native acceptance"\nversion = "1.0.0"\nmin_herdr_version = "0.9.3"\nplatforms = ["macos"]\n[[panes]]\nid = "review"\ntitle = "Owned response review"\ncommand = ${JSON.stringify([launcher])}\n`,
  );
  cli("plugin", "link", newPlugin);
  const workspace = cli(
    "workspace",
    "create",
    "--cwd",
    checkout,
    "--label",
    "Owned native acceptance",
    "--no-focus",
  );
  const empty = workspace.result.root_pane.pane_id;
  let nativeArgv: string[];
  let nativeId = randomUUID();
  if (selectedKind === "pi") {
    const driver = join(evidence, "provider.ts");
    writeFileSync(driver, piDriver());
    nativeArgv = [
      pi!,
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
      join(evidence, "pi-sessions"),
      "--session-id",
      nativeId,
      "-e",
      join(home, ".pi/agent/extensions/herdr-agent-state.ts"),
      "-e",
      join(homeAssets, ".pi/agent/extensions/hunk-turn-review/index.ts"),
      "-e",
      driver,
    ];
  } else {
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
    nativeArgv = [codex, "app-server", "--listen", endpoint];
    const hooksFile = join(home, ".codex/hooks.json");
    const installed = JSON.parse(readFileSync(hooksFile, "utf8"));
    const hookCommand = `${shellQuote(node)} ${shellQuote(join(homeAssets, ".codex/hunk-turn-review/hook.mjs"))}`;
    for (const event of [
      "SessionStart",
      "UserPromptSubmit",
      "PostToolUse",
      "Stop",
      "Interrupt",
      "SessionEnd",
    ])
      (installed.hooks[event] ??= []).push({
        hooks: [{ type: "command", command: hookCommand, timeout: 15 }],
      });
    writeFileSync(hooksFile, JSON.stringify(installed));
  }
  // Herdr starts commands through a login shell. Select this immutable input
  // after shell startup too, including its Bash for unchanged generated hooks.
  if (profile) nativeArgv = ["/usr/bin/env", `PATH=${baseEnv.PATH}`, ...nativeArgv];
  writeFileSync(
    join(nativePlugin, "herdr-plugin.toml"),
    `id = "htr.native"\nname = "Owned native fixture"\nversion = "1.0.0"\nmin_herdr_version = "0.9.3"\nplatforms = ["macos"]\n[[panes]]\nid = "native"\ntitle = "Actual native ${selectedKind}"\ncommand = ${JSON.stringify(nativeArgv)}\n`,
  );
  cli("plugin", "link", nativePlugin);
  activePane = cli(
    "plugin",
    "pane",
    "open",
    "--plugin",
    "htr.native",
    "--entrypoint",
    "native",
    "--placement",
    "split",
    "--direction",
    "right",
    "--target-pane",
    empty,
    "--cwd",
    checkout,
    "--no-focus",
  ).result.plugin_pane.pane.pane_id;
  cli("pane", "close", empty);
  if (selectedKind !== "pi") {
    rpc = await wait("original native Codex endpoint", () => openAppServer(endpoint));
    const hooks = await rpc.request("hooks/list", { cwds: [checkout] });
    record("inspected-local-hooks", hooks);
    const hookState = Object.fromEntries(
      hooks.data[0].hooks.map((h: any) => [h.key, { enabled: true, trusted_hash: h.currentHash }]),
    );
    const addr = provider.address();
    check(addr && typeof addr !== "string", "No local provider");
    codexConfig = {
      hooks: { state: hookState },
      model_providers: {
        htr: {
          name: "Local fixture",
          base_url: `http://127.0.0.1:${addr.port}/v1`,
          wire_api: "responses",
          requires_openai_auth: false,
        },
      },
      model_reasoning_effort: "minimal",
    };
    const started = await rpc.request("thread/start", {
      cwd: checkout,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      model: "htr-local",
      modelProvider: "htr",
      config: codexConfig,
    });
    nativeId = started.thread.id;
    record("native-thread", started.thread);
  }
  if (selectedKind === "pi") {
    attached = await wait("native original session attach", () =>
      client.request("session.find", { kind: selectedKind, nativeId, checkout }),
    );
    record("initial-binding", attached);
  }
  const prompt = async (text: string) => {
    if (selectedKind === "pi") {
      cli("pane", "send-text", activePane, text);
      keys(activePane, "enter");
    } else
      await rpc.request("turn/start", {
        threadId: nativeId,
        input: [{ type: "text", text, text_elements: [] }],
        clientUserMessageId: randomUUID(),
      });
  };
  const before = snapshot();
  await prompt("EDIT1: use only the local tracked.txt fixture");
  if (selectedKind !== "pi") {
    attached = await wait("native original SessionStart hook binding", () =>
      client.request("session.find", { kind: selectedKind, nativeId, checkout }),
    );
    record("initial-binding", attached);
  }
  const firstWorking = await wait("review opens during actual native first response", async () => {
    const s = await call("review.status");
    return s.active && !s.latest && s.layoutState?.state === "open" && s;
  });
  viewer = firstWorking.layoutState.paneId;
  const waitingView = await wait("Hunk waits for native first response", async () =>
    (await hunk("list")).sessions.find(
      (s: any) => s.repoRoot === checkout && s.title === "Waiting for first completed response",
    ),
  );
  record("waiting-native-first-response", {
    status: await call("review.status"),
    waitingView,
    pane: paneText(viewer),
  });
  writeFileSync(join(evidence, "first-response-release"), "yes", { mode: 0o600 });
  await wait("first native completed response", async () => (await call("review.status")).latest);
  const review = await call("review.get");
  record("first-review", review);
  check(
    review.changes.length === 1 && review.changes[0].path === "tracked.txt",
    `Expected one reviewed tracked fixture edit excluding old.txt; observed ${JSON.stringify(review.changes.map((c: any) => c.path))}`,
  );
  check(
    Buffer.from(review.changes[0].before.content, "base64").toString() === "first = 2\n",
    "Pre-request dirty baseline missing",
  );
  const status = await wait("automatic right review pane", async () => {
    const s = await call("review.status");
    return s.layoutState?.state === "open" && s;
  });
  viewer = status.layoutState.paneId;
  check(snapshot().focused_pane_id === before.focused_pane_id, "Automatic review stole focus");
  check(
    cli("pane", "neighbor", "--pane", activePane, "--direction", "right").result.neighbor
      .neighbor_pane_id === viewer,
    "Review is not original native pane's right sibling",
  );
  hunkSession = await wait("actual Hunk session registration", async () => {
    const list = (await hunk("list")).sessions;
    return list.find(
      (s: any) => s.repoRoot === checkout && s.title?.includes(review.id.slice(0, 16)),
    )?.sessionId;
  });
  record("first-layout", { snapshot: snapshot(), status, hunkSession });
  const saved = await note(
    "APPLY-CORRECTION: inspect current tracked.txt then change first to 11; retain this original context.",
  );
  const tabScenario = async () => {
    // Exercise the offered native full-tab workflow while the original receiver is
    // alive. The final detached tab-open check alone cannot prove feedback delivery.
    await call("review.pin", { reviewId: review.id });
    await wait("original immutable source before full tab", async () =>
      (await hunk("list")).sessions.find(
        (s: any) => s.sessionId === hunkSession && s.title?.includes(review.id.slice(0, 16)),
      ),
    );
    const splitViewer = viewer;
    const splitHunkSession = hunkSession;
    const checkpointBeforeTab = await call("review.checkpoint.read", { reviewId: review.id });
    const priorHunkIds = new Set((await hunk("list")).sessions.map((s: any) => s.sessionId));
    const focusBeforeTab = snapshot().focused_pane_id;
    await action(5);
    const interactiveTab = await wait("native action opens full-width review tab", async () => {
      const s = await call("review.status");
      return (
        s.layoutState?.state === "open" && s.layoutState.paneId !== splitViewer && s.layoutState
      );
    });
    viewer = interactiveTab.paneId;
    hunkSession = await wait(
      "full-tab immutable Hunk registration",
      async () =>
        (await hunk("list")).sessions.find(
          (s: any) =>
            !priorHunkIds.has(s.sessionId) &&
            s.repoRoot === checkout &&
            s.title?.includes(review.id.slice(0, 16)),
        )?.sessionId,
    );
    const tabSnapshot = snapshot();
    const tabPane = tabSnapshot.panes.find((p: any) => p.pane_id === viewer);
    check(tabSnapshot.focused_pane_id === focusBeforeTab, "Offered full-tab action stole focus");
    check(
      tabSnapshot.tabs.find((t: any) => t.tab_id === tabPane?.tab_id)?.pane_count === 1,
      "Full-width review tab has sibling panes",
    );
    const checkpointAfterTabOpen = await call("review.checkpoint.read", { reviewId: review.id });
    // Retire only the prior owned viewer, avoiding two writers of one checkpoint.
    cli("pane", "close", splitViewer);
    await wait(
      "prior owned Hunk viewer unregistered",
      async () => !(await hunk("list")).sessions.some((s: any) => s.sessionId === splitHunkSession),
    );
    const checkpointAfterSplitClose = await call("review.checkpoint.read", { reviewId: review.id });
    record("full-tab-checkpoint-handoff", {
      checkpointBeforeTab,
      checkpointAfterTabOpen,
      checkpointAfterSplitClose,
      splitViewer,
      interactiveTab,
      hunkSession,
    });
    if (options.get("--tab-recovery") === "close-and-reopen") {
      const staleTab = { viewer, hunkSession };
      cli("pane", "close", viewer);
      await wait(
        "explicit recovery closes stale owned tab",
        async () =>
          !(await hunk("list")).sessions.some((s: any) => s.sessionId === staleTab.hunkSession),
      );
      const settledCheckpoint = await call("review.checkpoint.read", { reviewId: review.id });
      const beforeRecoveryIds = new Set((await hunk("list")).sessions.map((s: any) => s.sessionId));
      const recoveredTab = await call("layout.tab");
      check(recoveredTab.state === "open", "Explicit diagnostic tab recovery failed");
      viewer = recoveredTab.paneId;
      hunkSession = await wait(
        "explicitly recovered tab restores original review",
        async () =>
          (await hunk("list")).sessions.find(
            (s: any) =>
              !beforeRecoveryIds.has(s.sessionId) &&
              s.repoRoot === checkout &&
              s.title?.includes(review.id.slice(0, 16)),
          )?.sessionId,
      );
      record("full-tab-explicit-recovery", {
        staleTab,
        settledCheckpoint,
        recoveredTab,
        hunkSession,
        limitation: "Extra explicit recovery; does not prove direct full-tab checkpoint handoff",
      });
    }
    const editNativeNote = async (suffix: string) => {
      const nativeNotes = (await hunk("comment", "list", hunkSession, "--type", "user")).comments;
      const original = nativeNotes.find((n: any) => n.noteId === saved.noteId);
      check(original?.noteId && original.editable, "Original full-tab human note unavailable");
      record("full-tab-public-native-note", original);
      check(
        original.filePath === "tracked.txt" &&
          original.newRange?.[0] === 1 &&
          nativeNotes.filter((n: any) => n.editable).length === 1,
        "Full-tab original note has no unique reviewed line anchor",
      );
      // Line navigation clears native note focus; --comment selects live-agent
      // comments. Exercise the original native selection restored by the host.
      const cp = await call("review.checkpoint.read", { reviewId: review.id });
      check(
        cp.checkpoint?.selection.activeNoteId === saved.noteId,
        "Full-tab did not restore the original native human note selection",
      );
      keys(viewer, "shift+e");
      await render("Edit note");
      cli("pane", "send-text", viewer, suffix);
    };
    const beforeTabBatchIds = new Set((await call("review.status")).batches.map((b: any) => b.id));
    await editNativeNote(
      " FULL-TAB-SAVED: inspect current code and preserve this original reviewed context for the handoff.",
    );
    keys(viewer, "ctrl+s");
    await render("Your note");
    const tabSaved = await wait("full-tab native edit durably saved", async () => {
      const cp = await call("review.checkpoint.read", { reviewId: review.id });
      return (
        !cp.checkpoint?.draft &&
        cp.checkpoint?.notes.some(
          (n: any) => n.id === saved.noteId && n.summary.includes("FULL-TAB-SAVED"),
        ) &&
        cp.checkpoint
      );
    });
    check(
      (await call("review.status")).batches.length === beforeTabBatchIds.size,
      "Full-tab save submitted without explicit Send",
    );
    record("full-tab-native-saved", { tabSaved, status: await call("review.status") });
    if (options.get("--case") === "tab-checkpoint") return;
    const latestBeforeTabEdit = (await call("review.status")).latest;
    await prompt(
      "BUSY: create a newer fixture edit while the full-tab original note remains unsent",
    );
    await wait("newer native response completes while tab stays pinned", async () => {
      const s = await call("review.status");
      return !s.active && s.latest !== latestBeforeTabEdit && s;
    });
    await render("Newer review available");
    const newerTabReview = await call("review.get", { selection: "latest" });
    check(
      newerTabReview.changes.some(
        (c: any) =>
          c.path === "tracked.txt" &&
          Buffer.from(c.after.content, "base64").toString() === "first = 20\n",
      ),
      "Full-tab pin check did not observe a newer native code change",
    );
    check(
      (await call("review.status")).pinned === review.id,
      "Full-tab unsent note lost its original pin",
    );
    check(
      (await hunk("list")).sessions
        .find((s: any) => s.sessionId === hunkSession)
        ?.title?.includes(review.id.slice(0, 16)),
      "Full-tab note silently moved to newer lines",
    );
    await editNativeNote(
      " FULL-TAB-DRAFT: CLARIFY-HANDOFF inspect current code; explain the older original context; do not edit.",
    );
    const tabDraft = await wait("full-tab unsaved composer durably checkpointed", async () => {
      const cp = await call("review.checkpoint.read", { reviewId: review.id });
      return cp.checkpoint?.draft?.body.includes("FULL-TAB-DRAFT") && cp.checkpoint;
    });
    check(
      tabDraft.notes.find((n: any) => n.id === saved.noteId)?.summary ===
        tabSaved.notes.find((n: any) => n.id === saved.noteId)?.summary,
      "Unsaved tab composer manufactured an actionable note revision",
    );
    check(
      (await call("review.status")).batches.length === beforeTabBatchIds.size,
      "Full-tab composer submitted without explicit Send",
    );
    const crashCandidates = execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" })
      .split("\n")
      .filter(
        (line) =>
          line.includes(resolve(host!, "..")) &&
          line.includes(join(homeAssets, ".config/hunk/extensions/human-review")) &&
          line.includes("turn-review"),
      )
      .map((line) => ({ pid: Number(line.trim().split(/\s+/, 1)[0]), command: line.trim() }))
      .filter(({ pid }) => {
        try {
          return execFileSync("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
            encoding: "utf8",
          })
            .split("\n")
            .includes("n" + checkout);
        } catch {
          return false;
        }
      });
    check(
      crashCandidates.length === 1,
      "Native Hunk crash target is not uniquely owned; preserved",
    );
    const crashedHunkSession = hunkSession;
    record("full-tab-before-crash", {
      interactiveTab,
      tabSnapshot,
      tabSaved,
      tabDraft,
      crashCandidates,
    });
    process.kill(crashCandidates[0].pid, "SIGKILL");
    await wait("exact owned Hunk exits after crash", () => {
      try {
        process.kill(crashCandidates[0].pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    const restoredTab = await call("layout.tab");
    check(restoredTab.state === "open", "Explicit full-tab reopen after crash failed");
    viewer = restoredTab.paneId;
    hunkSession = await wait(
      "crashed full-tab original review restored",
      async () =>
        (await hunk("list")).sessions.find(
          (s: any) =>
            s.sessionId !== crashedHunkSession &&
            !priorHunkIds.has(s.sessionId) &&
            s.repoRoot === checkout &&
            s.title?.includes(review.id.slice(0, 16)),
        )?.sessionId,
    );
    await render("Edit note");
    await render("FULL-TAB-DRAFT");
    const tabRestored = (await call("review.checkpoint.read", { reviewId: review.id })).checkpoint;
    check(
      tabRestored.documentIdentity === tabDraft.documentIdentity &&
        JSON.stringify(tabRestored.selection) === JSON.stringify(tabDraft.selection) &&
        JSON.stringify(tabRestored.draft) === JSON.stringify(tabDraft.draft),
      "Full-tab crash restore changed original source, selection, or composer ownership",
    );
    check(
      tabRestored.notes.find((n: any) => n.id === saved.noteId)?.summary ===
        tabSaved.notes.find((n: any) => n.id === saved.noteId)?.summary,
      "Full-tab crash restore lost the original saved human identity",
    );
    keys(viewer, "ctrl+s");
    await render("Your note");
    await wait("restored tab composer explicitly saved", async () => {
      const cp = await call("review.checkpoint.read", { reviewId: review.id });
      return (
        !cp.checkpoint?.draft &&
        cp.checkpoint?.notes.find(
          (n: any) => n.id === saved.noteId && n.summary.includes("FULL-TAB-DRAFT"),
        )
      );
    });
    const codeBeforeTabSend = readFileSync(join(checkout, "tracked.txt"), "utf8");
    await send();
    const tabBatch = await wait("full-tab explicit Send creates original native batch", async () =>
      (await call("review.status")).batches.find(
        (b: any) => !beforeTabBatchIds.has(b.id) && b.requested,
      ),
    );
    const tabCompleted = await wait(
      "full-tab feedback completes in original native backend",
      async () => {
        const r = await call("review.get", { selection: "latest" });
        if (selectedKind !== "pi")
          return r.requestId === tabBatch.id && r.outcome === "completed" && r;
        const ended = readFileSync(join(evidence, "pi-events.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((s) => JSON.parse(s))
          .find((e) => e.type === "user_request_end" && e.request.correlationId === tabBatch.id);
        return ended?.outcome === "completed" && r.requestId === ended.request.id && r;
      },
      30000,
    );
    const tabReceipt = await call("batch.reconcile", { batchId: tabBatch.id });
    check(tabReceipt.state === "queued", "Full-tab Send lacks native history/queue receipt");
    check(
      readFileSync(join(checkout, "tracked.txt"), "utf8") === codeBeforeTabSend,
      "Full-tab clarification/handoff feedback caused a code rewrite",
    );
    const tabFinal = await call("review.checkpoint.read", { reviewId: review.id });
    check(
      tabFinal.checkpoint.notes.find((n: any) => n.id === saved.noteId)?.status === "open",
      "Full-tab submission resolved the original native human note",
    );
    check(
      (await call("review.get", { reviewId: review.id })).id === review.id,
      "Full-tab feedback changed its immutable original review",
    );
    record("full-tab-native-feedback", {
      restoredTab,
      tabRestored,
      tabBatch,
      tabReceipt,
      tabCompleted,
      originalNativeId: nativeId,
      tabFinal,
      status: await call("review.status"),
      codeBeforeTabSend,
    });
  };
  check(
    (await call("review.status")).batches.length === 0,
    "Draft/save submitted without explicit Send",
  );
  if (options.get("--case") === "tab-checkpoint") {
    await tabScenario();
    record("result", {
      result: "passed",
      scope: "minimal-native-tab-checkpoint",
      kind: selectedKind,
      session,
      evidence,
      recovery: options.get("--tab-recovery"),
      notProved: ["complete native scenario", "rendered pixels", "native feedback delivery"],
    });
    process.stdout.write(
      JSON.stringify({
        result: "passed",
        scope: "minimal-native-tab-checkpoint",
        evidence,
        session,
        kind: selectedKind,
      }) + "\n",
    );
    break nativeFixture;
  }
  await prompt("BUSY: use only the local tracked.txt fixture and wait for the local release gate");
  await wait("busy native response", async () => (await call("review.status")).active);
  if (selectedKind === "pi") writeFileSync(join(evidence, "hold"), "yes");
  else hold = true;
  await send();
  const pending = await wait("busy feedback retained pending", async () => {
    const s = await call("review.status");
    return s.batches.find((b: any) => b.state === "pending" && b.requested);
  });
  record("pending-batch", pending);
  check(
    (await call("review.status")).pinned === review.id,
    "Unsent comments failed to pin original review",
  );
  check(
    readFileSync(join(checkout, "tracked.txt"), "utf8") !== "first = 11\n",
    "Feedback interrupted active work",
  );
  if (selectedKind === "pi") writeFileSync(join(evidence, "release"), "yes");
  hold = false;
  for (const release of held.splice(0)) release();
  await wait(
    "native feedback code response",
    () => readFileSync(join(checkout, "tracked.txt"), "utf8") === "first = 11\n",
  );
  await wait(
    "feedback completed with original batch identity",
    async () => {
      const r = await call("review.get", { selection: "latest" });
      if (selectedKind !== "pi") return r.requestId === pending.id && r.outcome === "completed";
      const events = readFileSync(join(evidence, "pi-events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s));
      const ended = events.find(
        (e) => e.type === "user_request_end" && e.request.correlationId === pending.id,
      );
      return (
        ended?.outcome === "completed" &&
        r.requestId === ended.request.id &&
        r.outcome === "completed"
      );
    },
    30000,
  );
  const receipt = await call("batch.reconcile", { batchId: pending.id });
  check(receipt.state === "queued", "No native queue/history admission receipt");
  const finalStatus = await call("review.status");
  const completedFeedback = await call("review.get", { selection: "latest" });
  check(
    finalStatus.notes.find((n: any) => n.id === saved.noteId)?.state === "submitted",
    "Submission changed original note identity or resolved it",
  );
  record("native-feedback-complete", {
    receipt,
    status: finalStatus,
    completedFeedback,
    immutableOriginal: await call("review.get", { reviewId: review.id }),
  });
  await wait("admitted open note allows newest review", async () =>
    (await hunk("list")).sessions.find(
      (s: any) =>
        s.sessionId === hunkSession && s.title?.includes(completedFeedback.id.slice(0, 16)),
    ),
  );
  await call("review.pin", { reviewId: review.id });
  await wait("explicit old immutable review selected", async () =>
    (await hunk("list")).sessions.find(
      (s: any) => s.sessionId === hunkSession && s.title?.includes(review.id.slice(0, 16)),
    ),
  );
  keys(viewer, "shift+e");
  await render("Edit note");
  cli(
    "pane",
    "send-text",
    viewer,
    " CLARIFY-HANDOFF: inspect the current code and explain this older context for a handoff; do not edit.",
  );
  keys(viewer, "ctrl+s");
  await render("Your note");
  const revised = await wait("edited admitted native note durable", async () => {
    const cp = await call("review.checkpoint.read", { reviewId: review.id });
    return cp.checkpoint?.notes.find(
      (n: any) => n.id === saved.noteId && n.summary.includes("CLARIFY-HANDOFF"),
    );
  });
  check(revised.status === "open", "Editing after admission changed native open-note disposition");
  const beforeClarify = readFileSync(join(checkout, "tracked.txt"), "utf8");
  await send();
  const clarification = await wait("explicit native clarification batch", async () =>
    (await call("review.status")).batches.find((b: any) => b.id !== pending.id && b.requested),
  );
  await wait(
    "native clarification completed in original context",
    async () => {
      const r = await call("review.get", { selection: "latest" });
      if (selectedKind !== "pi")
        return r.requestId === clarification.id && r.outcome === "completed";
      const events = readFileSync(join(evidence, "pi-events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s));
      const ended = events.find(
        (e) => e.type === "user_request_end" && e.request.correlationId === clarification.id,
      );
      return ended?.outcome === "completed" && r.requestId === ended.request.id;
    },
    30000,
  );
  check(
    readFileSync(join(checkout, "tracked.txt"), "utf8") === beforeClarify,
    "Clarification intent caused a code rewrite",
  );
  record("clarification-handoff", {
    revised,
    receipt: await call("batch.reconcile", { batchId: clarification.id }),
    status: await call("review.status"),
  });
  cli("pane", "close", viewer);
  await prompt("EDIT1: a subsequent response must preserve manual review closure");
  await wait(
    "manual pane close opt-out",
    async () => (await call("review.status")).layoutState?.state === "opted-out",
  );
  const reopened = await call("layout.reopen");
  record("explicit-reopen", reopened);
  check(reopened.state === "open", "Explicit review reopen unavailable");
  viewer = reopened.paneId;
  const closedHunkSession = hunkSession;
  hunkSession = await wait(
    "explicitly reopened actual Hunk viewer",
    async () =>
      (await hunk("list")).sessions.find(
        (s: any) => s.repoRoot === checkout && s.sessionId !== closedHunkSession,
      )?.sessionId,
  );
  const receiver = createClient({ socket: (await call("review.status")).receiver.socket });
  const invalidIdentity = await receiver.request("admission.check", {
    identity: { ...attached.identity, nativeId: randomUUID() },
    epoch: attached.epoch,
  });
  check(
    invalidIdentity.state === "blocked",
    "Actual native receiver accepted a replacement identity",
  );
  record("native-identity-refusal", invalidIdentity);
  if (selectedKind === "pi") {
    await wait("native Pi idle before same-pane replacement", () =>
      snapshot().agents.some(
        (a: any) => a.pane_id === activePane && ["idle", "done"].includes(a.agent_status),
      ),
    );
    cli("pane", "send-text", activePane, "/new");
    keys(activePane, "enter");
    await wait(
      "real same-pane native replacement detaches original",
      async () => !(await call("review.status")).receiver,
    );
    const replacementRef = await wait("new native conversation occupies same pane", () => {
      const ref = snapshot().agents.find((a: any) => a.pane_id === activePane)?.agent_session;
      return ref?.kind === "path" && ref.value !== attached.identity.sessionPath && ref;
    });
    check(
      replacementRef.value.startsWith(join(evidence, "pi-sessions") + "/"),
      "Replacement native history left fixture scope",
    );
    const replacementId = await wait(
      "replacement UUID from actual native SDK context",
      () =>
        readFileSync(join(evidence, "pi-events.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((s) => JSON.parse(s))
          .find((e) => e.type === "htr_fixture_session" && e.sessionPath === replacementRef.value)
          ?.nativeId,
    );
    check(replacementId !== nativeId, "Native /new did not create a replacement identity");
    keys(viewer, "shift+e");
    await render("Edit note");
    cli(
      "pane",
      "send-text",
      viewer,
      " ORIGINAL-ONLY: retain this feedback for the original conversation without reassigning it.",
    );
    keys(viewer, "ctrl+s");
    await render("Your note");
    await send();
    const heldOriginal = await wait(
      "Hunk Send holds feedback instead of targeting replacement",
      async () =>
        (await call("review.status")).batches.find(
          (b: any) =>
            ![pending.id, clarification.id].includes(b.id) &&
            b.requested &&
            ["blocked", "pending"].includes(b.state),
        ),
    );
    const replacement = await client.request("session.find", {
      kind: "pi",
      nativeId: replacementId,
      checkout,
    });
    check(
      replacement.batches.length === 0,
      "Feedback was reassigned to the replacement native conversation",
    );
    record("same-pane-native-replacement", {
      originalStatus: await call("review.status"),
      heldOriginal,
      replacement,
      snapshot: snapshot(),
      pane: paneText(viewer),
    });
  } else {
    await wait(
      "original Codex idle before replacement metadata",
      async () => !(await call("review.status")).active,
    );
    const replacementThread = await rpc.request("thread/start", {
      cwd: checkout,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      model: "htr-local",
      modelProvider: "htr",
      config: codexConfig,
    });
    const replacementId = replacementThread.thread.id;
    await rpc.request("turn/start", {
      threadId: replacementId,
      input: [
        {
          type: "text",
          text: "CLARIFY-HANDOFF: replacement conversation should only inspect local tracked.txt",
          text_elements: [],
        },
      ],
      clientUserMessageId: randomUUID(),
    });
    await wait("actual replacement Codex UUID reported on same pane", () =>
      snapshot().agents.some(
        (a: any) =>
          a.pane_id === activePane &&
          a.agent_session?.kind === "id" &&
          a.agent_session.value === replacementId,
      ),
    );
    const replacementSnapshot = snapshot();
    keys(viewer, "shift+e");
    await render("Edit note");
    cli(
      "pane",
      "send-text",
      viewer,
      " ORIGINAL-ONLY: keep this clarification bound to the original native conversation, regardless of current pane metadata.",
    );
    keys(viewer, "ctrl+s");
    await render("Your note");
    await send();
    const originalBatch = await wait("actual original-only Codex feedback", async () =>
      (await call("review.status")).batches.find(
        (b: any) => ![pending.id, clarification.id].includes(b.id) && b.requested,
      ),
    );
    await wait(
      "Codex processes feedback in original rather than replacement",
      async () => {
        const r = await call("review.get", { selection: "latest" });
        return r.requestId === originalBatch.id && r.outcome === "completed";
      },
      30000,
    );
    const originalHistory = await rpc.request("thread/items/list", {
      threadId: nativeId,
      cursor: null,
      limit: 100,
    });
    const replacementHistory = await rpc.request("thread/items/list", {
      threadId: replacementId,
      cursor: null,
      limit: 100,
    });
    const containsBatch = (page: any) =>
      page.data.some(
        (entry: any) =>
          entry.item?.type === "userMessage" && entry.item.clientId === originalBatch.id,
      );
    check(
      containsBatch(originalHistory) && !containsBatch(replacementHistory),
      "Same-pane metadata reassigned Codex feedback to a replacement conversation",
    );
    record("same-pane-native-replacement", {
      replacementSnapshot,
      originalBatch,
      originalHistory,
      replacementHistory,
      originalStatus: await call("review.status"),
    });
  }
  const stableBeforeExit = await call("review.status");
  cli("pane", "close", activePane);
  await wait(
    "original native process exit detaches receiver",
    async () => !(await call("review.status")).receiver,
  );
  record("original-exit", { status: await call("review.status"), hunk: await hunk("list") });
  check(
    (await call("review.get", { reviewId: review.id })).id === review.id,
    "Agent exit discarded original review",
  );
  if (selectedKind !== "pi") {
    rpc.close();
    await wait("exact original Codex endpoint closed", async () => {
      try {
        const live = await openAppServer(endpoint);
        live.close();
        return false;
      } catch {
        return true;
      }
    });
    const endpointPath = join(evidence, "c.sock");
    if (existsSync(endpointPath)) {
      const st = lstatSync(endpointPath);
      check(
        st.isSocket() && st.uid === process.getuid?.(),
        "Owned endpoint identity changed; preserve it",
      );
      unlinkSync(endpointPath);
    }
  } else {
    const idIndex = nativeArgv.indexOf("--session-id");
    nativeArgv.splice(idIndex, 2);
    nativeArgv.push("--session", attached.identity.sessionPath);
  }
  writeFileSync(
    join(nativePlugin, "herdr-plugin.toml"),
    `id = "htr.native"\nname = "Owned original resume"\nversion = "1.0.0"\nmin_herdr_version = "0.9.3"\nplatforms = ["macos"]\n[[panes]]\nid = "native"\ntitle = "Original native resume"\ncommand = ${JSON.stringify(nativeArgv)}\n`,
  );
  cli("plugin", "link", nativePlugin);
  const focusBeforeResume = snapshot().focused_pane_id;
  activePane = cli(
    "plugin",
    "pane",
    "open",
    "--plugin",
    "htr.native",
    "--entrypoint",
    "native",
    "--placement",
    "tab",
    "--workspace",
    workspace.result.workspace.workspace_id,
    "--cwd",
    checkout,
    "--no-focus",
  ).result.plugin_pane.pane.pane_id;
  check(snapshot().focused_pane_id === focusBeforeResume, "Task-owned original resume stole focus");
  if (selectedKind !== "pi") {
    rpc = await wait("owned resumed Codex listener", () => openAppServer(endpoint));
    const resumedThread = await rpc.request("thread/resume", {
      threadId: nativeId,
      cwd: checkout,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      model: "htr-local",
      modelProvider: "htr",
      config: codexConfig,
    });
    check(resumedThread.thread.id === nativeId, "Native Codex resumed a different conversation");
    await prompt(
      "CLARIFY-HANDOFF: read current fixture in the resumed original conversation without changing code",
    );
  }
  const resumed = await wait("original identity resumes with a new receiver epoch", async () => {
    const s = await call("review.status");
    return s.receiver && s.epoch !== stableBeforeExit.epoch && s;
  });
  check(
    JSON.stringify(resumed.identity) === JSON.stringify(stableBeforeExit.identity),
    "Resume transferred native identity or canonical checkout",
  );
  const restored = await call("review.checkpoint.read", { reviewId: review.id });
  check(
    restored.checkpoint.notes
      .find((n: any) => n.id === saved.noteId)
      ?.summary.includes("CLARIFY-HANDOFF"),
    "Original native human note was lost on resume",
  );
  record("original-resume", { status: resumed, restored, snapshot: snapshot() });
  await wait(
    "resumed original response settled",
    async () => !(await call("review.status")).active,
  );
  await tabScenario();
  const beforeFailure = (await call("review.status")).latest;
  await prompt(
    "FAIL-FIXTURE: use only local tracked.txt and exercise the deterministic failure after its edit",
  );
  const failed = await wait(
    "actual native failed response snapshot",
    async () => {
      const r = await call("review.get", { selection: "latest" });
      return r.id !== beforeFailure && r.outcome === "failed" && r;
    },
    30000,
  );
  check(
    failed.changes.some((c: any) => c.path === "tracked.txt"),
    "Failed native response lost its observed edit",
  );
  await action(2);
  await render("Explicit immutable review selection");
  keys(viewer, "enter");
  await render("Switch to");
  keys(viewer, "enter");
  await wait("failed native review displayed by actual Hunk", async () =>
    (await hunk("list")).sessions.find(
      (s: any) =>
        s.sessionId === hunkSession &&
        s.title?.includes(failed.id.slice(0, 16)) &&
        s.title.includes("failed"),
    ),
  );
  record("failed-native-view", {
    review: failed,
    hunk: await hunk("list"),
    pane: paneText(viewer),
  });
  hold = true;
  if (selectedKind === "pi" && existsSync(join(evidence, "release")))
    unlinkSync(join(evidence, "release"));
  await prompt(
    "BUSY: use only local tracked.txt; this owned process will exit while its response is still active",
  );
  await wait(
    "native edit before process-exit interruption",
    async () =>
      (await call("review.status")).active &&
      readFileSync(join(checkout, "tracked.txt"), "utf8") === "first = 20\n",
  );
  cli("pane", "close", activePane);
  const interrupted = await wait("actual native process exit publishes interruption", async () => {
    const r = await call("review.get", { selection: "latest" });
    return r.id !== failed.id && r.outcome === "interrupted" && r;
  });
  if (selectedKind === "pi") {
    await action(2);
    await render("Explicit immutable review selection");
    keys(viewer, "enter");
    await render("Switch to");
    keys(viewer, "enter");
  }
  await wait("actual Hunk displays interrupted native response", async () =>
    (await hunk("list")).sessions.find(
      (s: any) =>
        s.sessionId === hunkSession &&
        s.title?.includes(interrupted.id.slice(0, 16)) &&
        s.title.includes("interrupted"),
    ),
  );
  record("interrupted-native-view", {
    review: interrupted,
    status: await call("review.status"),
    hunk: await hunk("list"),
    pane: paneText(viewer),
  });
  const fullTab = await call("layout.tab");
  record("full-width-tab", fullTab);
  check(fullTab.state === "open", `Full-width review tab unavailable: ${JSON.stringify(fullTab)}`);
  record("result", {
    result: "passed",
    scope: options.has("--tab-recovery")
      ? "native-protocol-with-explicit-tab-recovery"
      : profile
        ? "immutable-profile-native-protocol"
        : "source-components-native-protocol",
    kind: selectedKind,
    recovery: options.get("--tab-recovery"),
    session,
    activePane,
    viewer,
    evidence,
    checks: [
      "actual native interactive lifecycle",
      "dirty baseline exclusion",
      "right sibling without focus",
      "native Hunk note editor",
      "Ctrl-G explicit Send",
      "busy pending",
      "no interrupt",
      "native original receiver and batch response",
      "receipt distinct from resolution",
      "manual close opt-out",
      "explicit reopen",
      "original native identity refusal",
      "original process exit and original-session resume",
      "editable admitted human ID and clarification/handoff intent",
      "failed and interrupted native Hunk views",
      "full-width tab",
      "full-tab native editing/save/pin/crash restore/explicit Send to original backend",
    ],
    notProved: [
      ...(options.has("--tab-recovery")
        ? ["direct full-tab checkpoint handoff before explicit recovery"]
        : []),
      "end-user rendered pixels",
      "production native hook trust",
      "final profile when components are supplied",
    ],
  });
  process.stdout.write(
    JSON.stringify({
      result: "passed",
      evidence,
      session,
      kind: selectedKind,
      recovery: options.get("--tab-recovery"),
    }) + "\n",
  );
} catch (error) {
  try {
    if (attached) record("failure-core-status", await call("review.status"));
    record("failure-snapshot", snapshot());
    if (activePane) record("failure-native-pane", paneText(activePane));
    if (viewer) record("failure-hunk-pane", paneText(viewer));
  } catch {}
  record("result", {
    result: "failed",
    error: String(error),
    session,
    evidence,
    kind: selectedKind,
    case: options.get("--case"),
    recovery: options.get("--tab-recovery"),
  });
  process.stderr.write(`${String(error)}\nEvidence: ${evidence}\n`);
  process.exitCode = 1;
} finally {
  writeFileSync(join(evidence, "first-response-release"), "yes", { mode: 0o600 });
  hold = false;
  for (const release of held.splice(0)) release();
  rpc?.close();
  provider.closeAllConnections();
  provider.close();
  // Exact owned session only. No global acceptance server or handover session is touched.
  if (server?.pid && server.exitCode === null) {
    try {
      cli("session", "stop", session, "--json");
    } catch {}
  }
  for (const child of children) {
    if (child.pid && child.exitCode === null)
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
  }
  await delay(1000);
  const cleanup: unknown[] = [];
  const brokerDir = join(runtimeDir, "hunk-mcp");
  if (existsSync(brokerDir))
    for (const file of readdirSync(brokerDir).filter((f) => /^daemon-.*\.json$/.test(f))) {
      const daemon = JSON.parse(readFileSync(join(brokerDir, file), "utf8"));
      if (daemon.port !== Number(hunkEnv.HUNK_MCP_PORT) || !Number.isInteger(daemon.pid)) continue;
      try {
        const command = execFileSync("/bin/ps", ["-p", String(daemon.pid), "-o", "command="], {
          encoding: "utf8",
        });
        const listening = execFileSync(
          "/usr/sbin/lsof",
          ["-nP", "-a", "-p", String(daemon.pid), `-iTCP:${daemon.port}`, "-sTCP:LISTEN"],
          { encoding: "utf8" },
        );
        check(
          command.includes(resolve(host!, "..")) &&
            command.includes("daemon serve") &&
            listening.includes(String(daemon.pid)),
          "Owned broker identity no longer matches; preserved",
        );
        process.kill(daemon.pid, "SIGTERM");
        cleanup.push({
          daemonPid: daemon.pid,
          port: daemon.port,
          action: "terminated exact owned broker",
        });
      } catch (error) {
        cleanup.push({
          daemonPid: daemon.pid,
          action: "no unsafe fallback",
          detail: String(error),
        });
      }
    }
  await delay(300);
  const remaining = execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.includes(evidence));
  for (const line of remaining) {
    // Native SessionStart creates one detached observer in this exact fixture state.
    if (
      line.includes(join(homeAssets, ".codex/hunk-turn-review/observer.mjs")) &&
      line.includes(state)
    ) {
      const pid = Number(line.trim().split(/\s+/, 1)[0]);
      process.kill(pid, "SIGTERM");
      cleanup.push({ observerPid: pid, action: "terminated exact owned detached observer" });
    }
  }
  const remainingAfterCleanup = execFileSync("/bin/ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
  })
    .split("\n")
    .filter((line) => line.includes(evidence));
  record("cleanup-verification", {
    cleanup,
    remainingBeforeObserverCleanup: remaining,
    remainingAfterCleanup,
    complete: remainingAfterCleanup.length === 0,
  });
  if (remainingAfterCleanup.length) {
    process.stderr.write(
      `Owned fixture processes remain; inspect ${evidence}/cleanup-verification.json\n`,
    );
    process.exitCode = 1;
  }
  record("cleanup", {
    session,
    serverPid: server?.pid,
    ownedChildren: children.map((c) => ({ pid: c.pid, exitCode: c.exitCode })),
    retainedEvidence: evidence,
  });
}

function piDriver() {
  return `import {createAssistantMessageEventStream} from "@earendil-works/pi-ai";
import {writeFileSync,existsSync,appendFileSync} from "node:fs";
export default function(pi){
pi.registerProvider("htr-fixture",{baseUrl:"http://127.0.0.1:1",apiKey:"local-fixture",api:"htr-fixture",models:[{id:"local",name:"Local acceptance",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:1000}],streamSimple(model,context){
const stream=createAssistantMessageEventStream();
appendFileSync(${JSON.stringify(join(evidence, "pi-model.jsonl"))},JSON.stringify(context.messages)+"\\n");
const last=context.messages.at(-1),user=[...context.messages].reverse().find(m=>m.role==="user");
const text=JSON.stringify(user?.content??last?.content??"");
const correction=text.includes("APPLY-CORRECTION"),busy=text.includes("BUSY"),clarify=text.includes("CLARIFY-HANDOFF");
const read=last?.role!=="toolResult",edit=last?.role==="toolResult"&&last.toolName==="read"&&!clarify;
const fail=text.includes("FAIL-FIXTURE");
const tool=read?{type:"toolCall",id:"read-"+Date.now(),name:"read",arguments:{path:"tracked.txt"}}:{type:"toolCall",id:"write-"+Date.now(),name:"write",arguments:{path:"tracked.txt",content:fail?"first = 99\\n":correction?"first = 11\\n":busy?"first = 20\\n":"first = 10\\n"}};
const message={role:"assistant",content:read||edit?[tool]:[{type:"text",text:clarify?"Clarification and handoff: original reviewed code was first = 10; current fixture was read; no code change was requested.":"Inspected current fixture. Local response completed."}],api:"htr-fixture",provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:read||edit?"toolUse":"stop",timestamp:Date.now()};
setTimeout(async()=>{if(!read&&!edit&&!existsSync(${JSON.stringify(join(evidence, "first-response-release"))})){while(!existsSync(${JSON.stringify(join(evidence, "first-response-release"))}))await new Promise(r=>setTimeout(r,50));}
if(busy&&!read&&!edit){writeFileSync(${JSON.stringify(join(evidence, "hold"))},"yes");while(!existsSync(${JSON.stringify(join(evidence, "release"))}))await new Promise(r=>setTimeout(r,50));}
stream.push({type:"start",partial:message});
if(fail&&!read&&!edit){const error={...message,content:[],stopReason:"error",errorMessage:"Deliberate local acceptance provider failure"};stream.push({type:"error",reason:"error",error});}else stream.push({type:"done",reason:message.stopReason,message});
stream.end();},read||edit||!existsSync(${JSON.stringify(join(evidence, "first-response-release"))})?500:5000);return stream;
}});
for(const name of ["user_request_start","user_request_end"]) pi.on(name,(event)=>appendFileSync(${JSON.stringify(join(evidence, "pi-events.jsonl"))},JSON.stringify(event)+"\\n"));
pi.on("session_start",(_e,ctx)=>{appendFileSync(${JSON.stringify(join(evidence, "pi-events.jsonl"))},JSON.stringify({type:"htr_fixture_session",nativeId:ctx.sessionManager.getSessionId(),sessionPath:ctx.sessionManager.getSessionFile()})+"\\n");ctx.ui.setStatus("htr-driver","local-native-ready");});
}`;
}
