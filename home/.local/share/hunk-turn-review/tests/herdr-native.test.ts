import { expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

test("Herdr 0.9.3 opens a plugin tab in its workspace without split fields or focus changes", async () => {
  expect(process.env.HERDR_ENV).toBe("1");
  const herdr = execFileSync("which", ["herdr"], { encoding: "utf8" }).trim();
  expect(execFileSync(herdr, ["--version"], { encoding: "utf8" }).trim()).toBe("herdr 0.9.3");

  const root = mkdtempSync(
    join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "htr-herdr-native."),
  );
  const checkout = join(root, "checkout");
  const home = join(root, "home");
  const xdg = join(root, "xdg");
  const runtime = join(root, "runtime");
  const config = join(xdg, "herdr", "config.toml");
  const session = `htr-native-tab-${process.pid}`;
  const marker = join(root, "plugin-environment.txt");
  for (const directory of [checkout, home, join(xdg, "herdr"), runtime])
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(config, 'onboarding = false\n[shell]\ncommand = "/bin/zsh"\n');
  const env = {
    PATH: "/opt/homebrew/bin:/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: xdg,
    XDG_RUNTIME_DIR: runtime,
    TMPDIR: root,
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
    HERDR_ENV: "1",
    HERDR_SESSION: session,
    HERDR_CONFIG_PATH: config,
  };
  const server = spawn(herdr, ["--session", session, "server"], {
    cwd: checkout,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let serverError = "";
  server.stderr?.on("data", (chunk) => (serverError += chunk.toString()));
  const cli = (args: string[]) => {
    const output = execFileSync(herdr, [...args, "--session", session], {
      cwd: checkout,
      env,
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return output.trim() ? JSON.parse(output) : {};
  };

  try {
    const deadline = Date.now() + 8000;
    let ready = false;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`Herdr exited early: ${serverError}`);
      try {
        cli(["api", "snapshot"]);
        ready = true;
        break;
      } catch {
        await delay(100);
      }
    }
    expect(ready, serverError).toBe(true);

    const plugin = join(root, "plugin");
    mkdirSync(plugin, { mode: 0o700 });
    const command = [
      "/bin/sh",
      "-c",
      `printf '%s\\n' "$PWD" "$HUNK_TURN_REVIEW_SOCKET" "$HUNK_TURN_REVIEW_SESSION_ID" "$HUNK_TURN_REVIEW_ACTOR_ID" > ${shellQuote(marker)}; exec /usr/bin/tail -f /dev/null`,
    ];
    writeFileSync(
      join(plugin, "herdr-plugin.toml"),
      `id = "htr.native-tab"
name = "Native tab payload fixture"
version = "1.0.0"
min_herdr_version = "0.9.3"
platforms = ["macos"]
[[panes]]
id = "review"
title = "Native review tab"
command = ${JSON.stringify(command)}
`,
    );
    cli(["plugin", "link", plugin]);
    const created = cli([
      "workspace",
      "create",
      "--cwd",
      checkout,
      "--label",
      "native-tab-fixture",
      "--no-focus",
    ]);
    const workspaceId = created.result.workspace.workspace_id;
    cli(["workspace", "focus", workspaceId]);
    const before = cli(["api", "snapshot"]).result.snapshot;
    expect(before.focused_pane_id).toBe(created.result.root_pane.pane_id);

    const opened = cli([
      "plugin",
      "pane",
      "open",
      "--plugin",
      "htr.native-tab",
      "--entrypoint",
      "review",
      "--placement",
      "tab",
      "--workspace",
      workspaceId,
      "--cwd",
      checkout,
      "--env",
      "HUNK_TURN_REVIEW_SOCKET=/private/tmp/native-tab.sock",
      "--env",
      "HUNK_TURN_REVIEW_SESSION_ID=original-session",
      "--env",
      "HUNK_TURN_REVIEW_ACTOR_ID=original-actor",
      "--no-focus",
    ]);
    expect(opened.result.plugin_pane.pane.pane_id).toBeTruthy();
    const launchDeadline = Date.now() + 8000;
    while (!existsSync(marker) && Date.now() < launchDeadline) await delay(50);
    expect(existsSync(marker), serverError).toBe(true);
    expect(readFileSync(marker, "utf8")).toBe(
      [checkout, "/private/tmp/native-tab.sock", "original-session", "original-actor", ""].join(
        "\n",
      ),
    );
    const after = cli(["api", "snapshot"]).result.snapshot;
    const openedPaneId = opened.result.plugin_pane.pane.pane_id;
    expect(
      after.panes.find(
        (pane: { pane_id: string; workspace_id?: string }) => pane.pane_id === openedPaneId,
      )?.workspace_id,
    ).toBe(workspaceId);
    expect(after.focused_pane_id).toBe(before.focused_pane_id);
  } finally {
    try {
      cli(["session", "stop", session, "--json"]);
    } catch {}
    if (server.exitCode === null) server.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (server.exitCode !== null) return resolve();
      const timeout = setTimeout(resolve, 2000);
      server.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
