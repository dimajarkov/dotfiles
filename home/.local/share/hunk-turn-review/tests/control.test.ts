import { expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fixture } from "./runtime.test.js";

const node = execFileSync("which", ["node"], { encoding: "utf8" }).trim();
const controlEntry = join(import.meta.dir, "../dist/src/control.js");
const hookEntry = join(import.meta.dir, "../../../../.codex/hunk-turn-review/hook.mjs");

function runNode(entry: string, args: string[], env: NodeJS.ProcessEnv, input = "") {
  return new Promise<{ status: number | null; stdout: string; stderr: string; error?: Error }>(
    (resolve, reject) => {
      const child = spawn(node, [entry, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ status: null, stdout, stderr, error: new Error("Child process timed out") });
      }, 10000);
      child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (status) => {
        clearTimeout(timeout);
        resolve({ status, stdout, stderr });
      });
      child.stdin.end(input);
    },
  );
}

test("narrow Codex review stays accessible through visible tab and explicit control commands", async () => {
  const f = await fixture({ pluginId: "hunk-turn-review", entrypoint: "review" });
  const identity = {
    kind: "codex" as const,
    nativeId: `codex-native-${process.pid}`,
    sessionPath: join(f.dir, "codex-session.jsonl"),
    checkout: f.checkout,
  };
  const epoch = `epoch-${process.pid}`;
  let columns = 70;
  let reviewPaneOpen = false;
  let opens = 0;
  const herdrSocket = join(f.dir, "state", "herdr.sock");
  const calls: Array<{ method: string; params: any }> = [];
  const connections = new Set<any>();
  const herdr = createServer((connection) => {
    connections.add(connection);
    connection.once("close", () => connections.delete(connection));
    connection.once("data", (chunk) => {
      const request = JSON.parse(chunk.toString());
      calls.push(request);
      const original = {
        pane_id: "native-codex-pane",
        terminal_id: "native-codex-terminal",
        workspace_id: "native-codex-workspace",
        agent: "codex",
        cwd: f.checkout,
        foreground_cwd: f.checkout,
        agent_session: { agent: "codex", kind: "id", value: identity.nativeId },
      };
      const panes = [
        original,
        ...(reviewPaneOpen
          ? [
              {
                pane_id: `review-pane-${opens}`,
                terminal_id: `review-terminal-${opens}`,
                tokens: { htr_actor: calls.at(-1)?.params?.env?.HUNK_TURN_REVIEW_ACTOR_ID },
              },
            ]
          : []),
      ];
      let result: any;
      if (request.method === "session.snapshot")
        result = {
          snapshot: {
            version: "0.9.3",
            protocol: 22,
            agents: [original],
            panes,
            workspaces: [{ workspace_id: "native-codex-workspace" }],
          },
        };
      else if (request.method === "pane.layout")
        result = {
          layout: { panes: [{ pane_id: original.pane_id, rect: { width: columns } }] },
        };
      else if (request.method === "plugin.list")
        result = {
          plugins: [
            {
              plugin_id: "hunk-turn-review",
              enabled: true,
              panes: [{ id: "review", command: ["hunk-turn-review"] }],
            },
          ],
        };
      else if (request.method === "plugin.pane.open") {
        opens++;
        reviewPaneOpen = true;
        result = {
          plugin_pane: {
            pane: { pane_id: `review-pane-${opens}`, terminal_id: `review-terminal-${opens}` },
          },
        };
      } else result = { type: "ok" };
      connection.end(JSON.stringify({ id: request.id, result }) + "\n");
    });
  });
  await mkdir(join(f.dir, "state"), { recursive: true });
  await new Promise<void>((resolve) => herdr.listen(herdrSocket, resolve));
  chmodSync(herdrSocket, 0o600);

  try {
    const attached = await f.client.request("session.attach", {
      identity,
      epoch,
      layout: { session: "codex-layout-fixture", socket: herdrSocket, paneId: "native-codex-pane" },
    });
    const sessionId = attached.sessionId as string;
    const call = (method: string, params = {}) =>
      f.client.request(method, { sessionId, epoch, ...params });

    await call("request.begin", { requestId: "codex-edit" });
    await writeFile(join(f.checkout, "tracked.txt"), "narrow Codex edit\n");
    const reconcile = await call("request.reconcile");
    expect(reconcile).toMatchObject({ observed: true });
    expect(reconcile.warnings).toBeUndefined();
    expect((await call("review.status")).layoutState).toMatchObject({ state: "unavailable" });

    const environment = {
      ...process.env,
      HERDR_ENV: "1",
      HUNK_TURN_REVIEW_SOCKET: f.socket,
      HUNK_TURN_REVIEW_STATE: join(f.dir, "state"),
    };
    const hookEvent = JSON.stringify({
      hook_event_name: "PostToolUse",
      session_id: identity.nativeId,
      transcript_path: identity.sessionPath,
      cwd: f.checkout,
    });
    const hook = await runNode(hookEntry, [], environment, hookEvent);
    expect(hook.status, `${hook.stderr}\n${hook.stdout}\n${String(hook.error)}`).toBe(0);
    const hookMessage = JSON.parse(hook.stdout);
    expect(hookMessage).toEqual({ systemMessage: expect.any(String) });
    expect(hookMessage.systemMessage).toContain(identity.nativeId);
    expect(hookMessage.systemMessage).toContain(sessionId);
    expect(hookMessage.systemMessage).toContain(
      `hunk-turn-review-control tab --session-id ${sessionId}`,
    );
    expect(hookMessage).not.toHaveProperty("decision");

    await call("request.complete", { requestId: "codex-edit", outcome: "completed" });
    const review = await call("review.get");
    const note = await call("note.save", {
      reviewId: review.id,
      note: { text: "Keep this comment with the same native review." },
    });
    const statusBeforeTab = await call("review.status");

    const cliEnvironment = { ...environment, HOME: f.dir };
    const runControl = (args: string[]) => runNode(controlEntry, args, cliEnvironment);
    const help = await runControl(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("status|tab|reopen");

    const callsBeforeStatus = calls.length;
    const cliStatus = await runControl(["status", "--session-id", sessionId, "--socket", f.socket]);
    expect(cliStatus.status, cliStatus.stderr).toBe(0);
    expect(JSON.parse(cliStatus.stdout)).toMatchObject({
      sessionId,
      action: "status",
      identity: { kind: "codex", nativeId: identity.nativeId, checkout: f.checkout },
      receipt: { layoutState: { state: "unavailable" } },
    });
    expect(calls).toHaveLength(callsBeforeStatus);

    const tab = await runControl(["tab", "--session-id", sessionId, "--socket", f.socket]);
    expect(
      tab.status,
      `${tab.stderr}\n${tab.stdout}\n${String(tab.error)}\n${JSON.stringify(calls)}`,
    ).toBe(0);
    const tabReceipt = JSON.parse(tab.stdout);
    expect(tabReceipt).toMatchObject({
      sessionId,
      action: "tab",
      identity: { kind: "codex", nativeId: identity.nativeId, checkout: f.checkout },
      receipt: { state: "open" },
    });
    expect(calls.at(-2)?.method).toBe("plugin.pane.open");
    expect(calls.at(-2)?.params).toMatchObject({
      placement: "tab",
      focus: false,
      workspace_id: "native-codex-workspace",
      cwd: f.checkout,
      env: {
        HUNK_TURN_REVIEW_SOCKET: f.socket,
        HUNK_TURN_REVIEW_SESSION_ID: sessionId,
      },
    });
    expect(calls.at(-2)?.params).not.toHaveProperty("target_pane_id");
    expect((await call("review.get", { reviewId: review.id })).id).toBe(review.id);
    expect(await call("review.status")).toMatchObject({
      latest: statusBeforeTab.latest,
      notes: [note],
    });

    const repeatedHook = await runNode(hookEntry, [], environment, hookEvent);
    expect(repeatedHook.status, repeatedHook.stderr).toBe(0);
    expect(repeatedHook.stdout).toBe("");

    reviewPaneOpen = false;
    columns = 120;
    await call("request.begin", { requestId: "after-close" });
    await writeFile(join(f.checkout, "tracked.txt"), "edit after deliberate close\n");
    await call("request.reconcile");
    expect(opens).toBe(1);
    expect((await call("review.status")).layoutState).toMatchObject({ state: "opted-out" });

    const reopen = await runControl(["reopen", "--session-id", sessionId, "--socket", f.socket]);
    expect(reopen.status, reopen.stderr).toBe(0);
    expect(JSON.parse(reopen.stdout)).toMatchObject({
      sessionId,
      action: "reopen",
      receipt: { state: "open" },
    });
    expect(opens).toBe(2);
    expect(calls.at(-2)?.params).toMatchObject({
      placement: "split",
      direction: "right",
      focus: false,
      target_pane_id: "native-codex-pane",
    });

    const beforeRefusal = calls.length;
    const unsafeSocket = join(f.dir, "not-a-socket");
    await writeFile(unsafeSocket, "not a unix socket");
    chmodSync(unsafeSocket, 0o600);
    const unsafe = await runControl([
      "status",
      "--session-id",
      sessionId,
      "--socket",
      unsafeSocket,
    ]);
    expect(unsafe.status).not.toBe(0);
    for (const args of [
      ["tab", "--session-id", identity.nativeId, "--socket", f.socket],
      ["tab", "--session-id", "a".repeat(64), "--socket", f.socket],
      ["tab", "--session-id", sessionId, "--session-id", sessionId, "--socket", f.socket],
      ["tab", "--session-id", sessionId, "--unknown", f.socket],
      ["tab"],
    ]) {
      const refused = await runControl(args);
      expect(refused.status).not.toBe(0);
    }
    expect(calls).toHaveLength(beforeRefusal);
  } finally {
    for (const connection of connections) connection.destroy();
    await new Promise<void>((resolve) => herdr.close(() => resolve()));
    await f.close();
  }
}, 45000);
