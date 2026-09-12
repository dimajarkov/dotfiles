import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  SubagentOrchestrator,
  type CommandExecution,
  type HerdrTransport,
} from "./orchestrator.ts";
import { writeCompletionSettlement } from "./completion-protocol.ts";
import { withRegistryLock } from "./registry-lock.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "herdr-subagent-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function waitUntil(predicate: () => boolean, timeout = 1_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

class FakeHerdrTransport implements HerdrTransport {
  readonly calls: string[][] = [];
  readonly responses: CommandExecution[];
  readonly ownershipReads: string[][] = [];
  #runtimeAgents = new Map<string, unknown>();
  #runtimePaneId: string | undefined;
  #runtimeSessionPath: string | undefined;
  #focusedPaneId: string | undefined;

  constructor(responses: unknown[], focusedPaneId = "w1:p1") {
    this.#focusedPaneId = focusedPaneId;
    this.responses = responses.map((response) => ({
      code: 0,
      stdout: `${JSON.stringify(response)}\n`,
      stderr: "",
    }));
  }

  async run(args: string[], _signal?: AbortSignal): Promise<CommandExecution> {
    let nextId: string | undefined;
    try {
      nextId = JSON.parse(this.responses[0]?.stdout ?? "{}").id;
    } catch {
      /* Scripted malformed responses remain intact. */
    }
    let observation: unknown;
    // The fake transport supplies stable master observations and an initial
    // layout without consuming scripted lifecycle responses.
    // Explicit identity/layout responses override these defaults.
    if (args[0] === "pane" && args[1] === "current" && nextId !== "cli:pane:current") {
      observation = {
        pane: {
          pane_id: "w1:p1",
          tab_id: "w1:t1",
          workspace_id: "w1",
          agent: "pi",
          agent_session: { kind: "path", value: "/tmp/parent.jsonl" },
        },
      };
    } else if (args[0] === "pane" && args[1] === "get" && nextId !== "cli:pane:get") {
      observation = {
        pane: {
          pane_id: args[2],
          tab_id: "w1:t1",
          workspace_id: "w1",
          focused: args[2] === this.#focusedPaneId,
          ...(args[2] === "w1:p1"
            ? { agent: "pi", agent_session: { kind: "path", value: "/tmp/parent.jsonl" } }
            : {}),
        },
      };
    } else if (args[0] === "pane" && args[1] === "layout" && nextId !== "cli:pane:layout") {
      observation = {
        layout: {
          tab_id: "w1:t1",
          workspace_id: "w1",
          panes: [
            { pane_id: "w1:p1", rect: { width: 120, height: 60 } },
            ...(this.#runtimePaneId && this.#runtimePaneId !== "w1:p1"
              ? [{ pane_id: this.#runtimePaneId, rect: { width: 120, height: 60 } }]
              : []),
          ],
        },
      };
    } else if (
      args[0] === "pane" &&
      args[1] === "process-info" &&
      nextId !== "cli:pane:process_info"
    ) {
      observation = {
        process_info: {
          pane_id: args[3],
          shell_pid: 100,
          foreground_processes: [{ pid: 100, argv0: "zsh" }],
        },
      };
    } else if (
      args[0] === "agent" &&
      args[1] === "get" &&
      ["cli:agent:prompt", "cli:agent:send-keys", "cli:agent:focus"].includes(nextId ?? "") &&
      this.#runtimeAgents.has(args[2]!)
    ) {
      observation = { agent: this.#runtimeAgents.get(args[2]!) };
    }
    if (observation) {
      this.ownershipReads.push([...args]);
      return { code: 0, stdout: JSON.stringify({ result: observation }), stderr: "" };
    }
    this.calls.push([...args]);
    const response = this.responses.shift();
    assert.ok(response, `Unexpected Herdr call: ${args.join(" ")}`);
    if (response.code !== 0) return response;
    let body: {
      result?: {
        panes?: Array<{ workspace_id?: string }>;
        pane?: { pane_id?: string };
        agent?: {
          pane_id?: string;
          agent_session?: { kind?: string; value?: string };
        };
      };
    };
    try {
      body = JSON.parse(response.stdout) as typeof body;
    } catch {
      return response;
    }
    if (args[0] === "pane" && args[1] === "list" && body.result?.panes) {
      for (const pane of body.result.panes) pane.workspace_id ??= "w1";
      return { ...response, stdout: JSON.stringify(body) };
    }
    const pane = body.result?.pane;
    if (args[0] === "pane" && args[1] === "split" && pane?.pane_id) {
      this.#runtimePaneId = pane.pane_id;
    }
    const agent = body.result?.agent;
    if (args[0] === "agent" && args[1] === "start" && agent) {
      this.#runtimePaneId = agent.pane_id;
      this.#runtimeSessionPath =
        agent.agent_session?.kind === "path" ? agent.agent_session.value : undefined;
    }
    if (args[0] === "agent" && args[1] === "wait" && agent) {
      agent.pane_id ??= this.#runtimePaneId;
      agent.agent_session ??= this.#runtimeSessionPath
        ? { kind: "path", value: this.#runtimeSessionPath }
        : undefined;
    }
    if (args[0] === "agent" && ["start", "get", "prompt", "wait"].includes(args[1]!) && agent) {
      const current = this.#runtimeAgents.get(args[2]!);
      this.#runtimeAgents.set(args[2]!, {
        ...(typeof current === "object" && current !== null ? current : {}),
        ...agent,
      });
    }
    if (args[0] === "agent" && args[1] === "wait" && agent) {
      return { ...response, stdout: `${JSON.stringify(body)}\n` };
    }
    return response;
  }
}

function successfulRootSpawnResponses(): unknown[] {
  return [
    {
      id: "cli:pane:split",
      result: {
        pane: { pane_id: "w1:p9", tab_id: "w1:t1" },
        type: "pane_split",
      },
    },
    { id: "cli:pane:rename", result: { pane: { pane_id: "w1:p9" } } },
    {
      id: "cli:agent:start",
      result: {
        agent: {
          name: "authentication-worker-child1",
          pane_id: "w1:p9",
          agent_status: "idle",
          agent_session: { kind: "path", value: "/tmp/child.jsonl" },
        },
      },
    },
    {
      id: "cli:agent:prompt",
      result: {
        agent: { name: "authentication-worker-child1", pane_id: "w1:p9", agent_status: "working" },
      },
    },
  ];
}

function writeCompletionMarker(
  stateDirectory: string,
  rootId: string,
  childId: string,
  generation = 1,
  stopReason = "stop",
  entryId?: string,
  sessionPath?: string,
): string {
  const inferredSessionPath =
    sessionPath ??
    readdirSync(stateDirectory)
      .filter((entry) => entry.endsWith(".jsonl"))
      .map((entry) => join(stateDirectory, entry))
      .at(-1);
  assert.ok(inferredSessionPath, "completion marker requires a session artifact");
  const inferredEntryId =
    entryId ??
    readFileSync(inferredSessionPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id?: string; message?: { role?: string } })
      .filter((entry) => entry.message?.role === "assistant")
      .at(-1)?.id;
  assert.ok(inferredEntryId, "completion marker requires an assistant entry");
  const registryDirectory = join(stateDirectory, rootId);
  const markerPath = join(registryDirectory, `${childId}.generation-${generation}.complete`);
  mkdirSync(registryDirectory, { recursive: true });
  writeFileSync(
    markerPath,
    `${JSON.stringify({
      version: 1,
      childId,
      generation,
      stopReason,
      entryId: inferredEntryId,
      sessionPath: inferredSessionPath,
    })}\n`,
  );
  return markerPath;
}

function writeLineageIdentity(
  stateDirectory: string,
  rootId: string,
  session = "default",
  workspaceId = "w1",
  masterPaneId = "w1:p1",
  tabId = "w1:t1",
): void {
  const registry = join(stateDirectory, rootId);
  mkdirSync(registry, { recursive: true });
  writeFileSync(
    join(registry, ".lineage.json"),
    `${JSON.stringify({
      version: 1,
      rootId,
      herdrSession: session,
      workspaceId,
      masterPaneId,
      tabId,
      masterSessionPath: "/tmp/parent.jsonl",
      createdAt: 1,
      updatedAt: 1,
    })}\n`,
  );
}

function spawnRequest() {
  const artifacts = temporaryDirectory();
  const systemPromptPath = join(artifacts, "worker-system.md");
  const skillPath = join(artifacts, "tdd-SKILL.md");
  writeFileSync(systemPromptPath, "SYSTEM_PROMPT\n");
  writeFileSync(skillPath, "SKILL\n");
  return {
    name: "authentication",
    task: "Inspect auth, then report.",
    cwd: "/work/project",
    parentSessionId: "parent-session",
    parentSessionFile: "/tmp/parent.jsonl",
    agent: {
      name: "worker",
      description: "Implementation worker",
      tools: ["read", "bash", "subagent"],
      model: "openai-codex/gpt-5.6-sol",
      thinking: "high",
      systemPromptPath,
      skillPaths: [skillPath],
      spawnTargets: ["scout", "reviewer"],
    },
  };
}

test("spawns always split horizontally regardless of pane dimensions", async (t) => {
  for (const [width, height] of [
    [240, 60],
    [120, 60],
    [89, 30],
    [89, 10],
    [40, 8],
  ]) {
    await t.test(`${width} columns by ${height} rows`, async () => {
      const transport = new FakeHerdrTransport([
        {
          id: "cli:pane:layout",
          result: {
            layout: {
              tab_id: "w1:t1",
              workspace_id: "w1",
              panes: [{ pane_id: "w1:p1", rect: { width, height } }],
            },
          },
        },
        ...successfulRootSpawnResponses(),
      ]);
      const orchestrator = new SubagentOrchestrator({
        transport,
        stateDirectory: temporaryDirectory(),
        environment: {
          HERDR_ENV: "1",
          HERDR_WORKSPACE_ID: "w1",
          HERDR_TAB_ID: "w1:t1",
          HERDR_PANE_ID: "w1:p1",
        },
        id: () => "child-1",
        monitor: false,
      });

      await orchestrator.spawn(spawnRequest());

      const split = transport.calls.find((call) => call[0] === "pane" && call[1] === "split");
      assert.ok(split);
      assert.equal(split[split.indexOf("--direction") + 1], "down");
      assert.ok(split.includes("--no-focus"));
    });
  }
});

test("zoomed master spawns never issue focus-changing zoom restoration", async () => {
  const lifecycle = successfulRootSpawnResponses();
  const transport = new FakeHerdrTransport([
    {
      id: "cli:pane:layout",
      result: {
        layout: {
          tab_id: "w1:t1",
          workspace_id: "w1",
          focused_pane_id: "w1:p1",
          zoomed: true,
          panes: [{ pane_id: "w1:p1", rect: { width: 120, height: 60 } }],
        },
      },
    },
    lifecycle[0],
    {
      id: "cli:pane:layout",
      result: {
        layout: {
          tab_id: "w1:t1",
          workspace_id: "w1",
          focused_pane_id: "w1:p1",
          zoomed: false,
          panes: [
            { pane_id: "w1:p1", rect: { width: 120, height: 30 } },
            { pane_id: "w1:p9", rect: { width: 120, height: 30 } },
          ],
        },
      },
    },
    ...lifecycle.slice(1),
  ]);
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: temporaryDirectory(),
    environment: {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_TAB_ID: "w1:t1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    monitor: false,
  });

  await orchestrator.spawn(spawnRequest());

  assert.deepEqual(
    transport.calls
      .filter((call) => !(call[0] === "pane" && call[1] === "layout"))
      .map((call) => call.slice(0, 2)),
    [
      ["pane", "split"],
      ["pane", "rename"],
      ["agent", "start"],
      ["agent", "prompt"],
    ],
  );
  assert.equal(
    transport.calls.some((call) => call[0] === "pane" && call[1] === "zoom"),
    false,
  );
  assert.equal(
    transport.calls.some((call) => call[0] === "agent" && call[1] === "focus"),
    false,
  );
});

test("does not restore a background zoomed tab and steal unrelated focus", async () => {
  const lifecycle = successfulRootSpawnResponses();
  const transport = new FakeHerdrTransport(
    [
      {
        id: "cli:pane:layout",
        result: {
          layout: {
            tab_id: "w1:t1",
            workspace_id: "w1",
            focused_pane_id: "w1:p1",
            zoomed: true,
            panes: [{ pane_id: "w1:p1", rect: { width: 120, height: 60 } }],
          },
        },
      },
      lifecycle[0],
      {
        id: "cli:pane:layout",
        result: {
          layout: {
            tab_id: "w1:t1",
            workspace_id: "w1",
            focused_pane_id: "w1:p1",
            zoomed: false,
            panes: [
              { pane_id: "w1:p1", rect: { width: 120, height: 30 } },
              { pane_id: "w1:p9", rect: { width: 120, height: 30 } },
            ],
          },
        },
      },
      ...lifecycle.slice(1),
    ],
    "w1:p-other",
  );
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: temporaryDirectory(),
    environment: {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_TAB_ID: "w1:t1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    monitor: false,
  });

  await orchestrator.spawn(spawnRequest());

  assert.equal(
    transport.calls.some((call) => call[0] === "pane" && call[1] === "zoom"),
    false,
  );
  assert.equal(
    transport.calls.some((call) => call[0] === "agent" && call[1] === "focus"),
    false,
  );
});

test("resume uses explicit focus only when requested", async () => {
  const responses = successfulRootSpawnResponses();
  responses.push({ id: "cli:agent:focus", result: { type: "agent_focus" } });
  const transport = new FakeHerdrTransport(responses);
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: temporaryDirectory(),
    environment: {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    monitor: false,
  });

  const child = await orchestrator.spawn(spawnRequest());
  await orchestrator.resume("parent-session", "parent-session", child.id);

  assert.deepEqual(transport.calls.at(-1), ["agent", "focus", child.herdrName]);
  assert.equal(
    transport.calls.filter((call) => call[0] === "agent" && call[1] === "focus").length,
    1,
  );
});

test("depth zero spawn splits the master pane and prompts a ready persistent Pi", async () => {
  const transport = new FakeHerdrTransport(successfulRootSpawnResponses());
  const stateDirectory = temporaryDirectory();
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory,
    environment: {
      HERDR_ENV: "1",
      HERDR_SESSION: "session-a",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_TAB_ID: "w1:t1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    now: () => 1_000,
    monitor: false,
  });

  const request = spawnRequest();
  const child = await orchestrator.spawn(request);

  assert.equal(child.state, "working");
  assert.equal(child.herdrSession, "session-a");
  assert.equal(child.tabId, "w1:t1");
  assert.equal(child.paneId, "w1:p9");
  assert.equal(child.herdrName, "authentication-worker-child1");
  assert.equal(
    child.completionMarkerPath,
    join(stateDirectory, "parent-session", "child-1.generation-1.complete"),
  );

  const [create, rename, start, prompt] = transport.calls;
  assert.deepEqual(create.slice(0, 6), ["pane", "split", "--pane", "w1:p1", "--direction", "down"]);
  assert.ok(create.includes("--no-focus"));
  assert.ok(create.includes("HERDR_SUBAGENT_DEPTH=1"));
  assert.ok(create.includes("HERDR_SUBAGENT_PARENT_ID=parent-session"));
  assert.ok(create.includes("HERDR_SUBAGENT_AGENT_ID=child-1"));
  assert.ok(create.includes("HERDR_SUBAGENT_GENERATION=1"));
  assert.ok(create.some((value) => value.startsWith("HERDR_SUBAGENT_REGISTRY=")));
  assert.ok(create.includes(`HERDR_SUBAGENT_COMPLETION_MARKER=${child.completionMarkerPath}`));
  assert.ok(create.includes("HERDR_SUBAGENT_SPAWN_TARGETS=scout,reviewer"));

  assert.deepEqual(rename, ["pane", "rename", "w1:p9", "Worker: authentication"]);
  assert.deepEqual(start.slice(0, 10), [
    "agent",
    "start",
    "authentication-worker-child1",
    "--kind",
    "pi",
    "--pane",
    "w1:p9",
    "--timeout",
    "60000",
    "--",
  ]);
  assert.ok(!start.includes("--no-session"));
  assert.deepEqual(start.slice(10, 13), ["--name", "authentication", "--extension"]);
  assert.ok(start[13]?.endsWith("/subagent/completion-protocol.ts"));
  assert.deepEqual(start.slice(14), [
    "--model",
    "openai-codex/gpt-5.6-sol",
    "--thinking",
    "high",
    "--tools",
    "read,bash,subagent",
    "--append-system-prompt",
    request.agent.systemPromptPath,
    "--skill",
    request.agent.skillPaths[0],
  ]);
  assert.deepEqual(prompt, [
    "agent",
    "prompt",
    "authentication-worker-child1",
    "Inspect auth, then report.",
  ]);
});

test("spawn persists its resolved versioned launch loadout before surface creation", async () => {
  let orchestrator!: SubagentOrchestrator;
  class RegistryObservingTransport extends FakeHerdrTransport {
    override async run(args: string[]): Promise<CommandExecution> {
      if (args[0] === "tab" && args[1] === "create") {
        const reserved = orchestrator.list("parent-session")[0];
        assert.deepEqual(reserved?.launchLoadout, {
          version: 1,
          role: "worker",
          model: "openai-codex/gpt-5.6-sol",
          thinking: "high",
          tools: ["read", "bash", "subagent"],
          systemPrompt: {
            path: request.agent.systemPromptPath,
            sha256: "11096184904fec1a8ab379c6ffcb0caa6119595058210a494350fd8d65339a57",
          },
          skills: [
            {
              path: request.agent.skillPaths[0],
              sha256: "20238c978f1fd6122a1cb99dba433f9e5d5c67c1fff7c52cc3747acefede67b0",
            },
          ],
          spawnTargets: ["scout", "reviewer"],
          cwd: "/work/project",
          environment: {
            PI_CODING_AGENT_DIR: "/safe/pi",
            PI_OFFLINE: "1",
          },
        });
      }
      return super.run(args);
    }
  }
  const request = spawnRequest();
  const transport = new RegistryObservingTransport(successfulRootSpawnResponses());
  orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: temporaryDirectory(),
    environment: {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
      PI_CODING_AGENT_DIR: "/safe/pi",
      PI_OFFLINE: "1",
      PI_API_KEY: "must-not-propagate",
    },
    id: () => "child-1",
    monitor: false,
  });

  const child = await orchestrator.spawn(request);

  assert.deepEqual(child.launchLoadout, orchestrator.list("parent-session")[0]?.launchLoadout);
  const create = transport.calls[0];
  assert.ok(create.includes("PI_CODING_AGENT_DIR=/safe/pi"));
  assert.ok(create.includes("PI_OFFLINE=1"));
  assert.ok(!create.some((argument) => argument.includes("PI_API_KEY")));
});

test("nested spawn splits the lineage master pane in the master tab", async () => {
  const responses = successfulRootSpawnResponses();
  responses[0] = {
    id: "cli:pane:split",
    result: {
      pane: { pane_id: "w1:p2", tab_id: "w1:t1" },
      type: "pane_split",
    },
  };
  responses[1] = {
    id: "cli:pane:rename",
    result: { pane: { pane_id: "w1:p2" } },
  };
  const started = responses[2] as {
    result: { agent: { pane_id: string } };
  };
  started.result.agent.pane_id = "w1:p2";
  const stateDirectory = temporaryDirectory();
  writeLineageIdentity(stateDirectory, "root-1");
  const transport = new FakeHerdrTransport(responses);
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory,
    environment: {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_TAB_ID: "w1:t1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_SUBAGENT_DEPTH: "1",
      HERDR_SUBAGENT_ROOT_ID: "root-1",
      HERDR_SUBAGENT_AGENT_ID: "worker-1",
      HERDR_SUBAGENT_MASTER_ROOT_ID: "root-1",
      HERDR_SUBAGENT_MASTER_HERDR_SESSION: "default",
      HERDR_SUBAGENT_MASTER_WORKSPACE_ID: "w1",
      HERDR_SUBAGENT_MASTER_PANE_ID: "w1:p1",
      HERDR_SUBAGENT_MASTER_TAB_ID: "w1:t1",
      HERDR_SUBAGENT_MASTER_SESSION_PATH: "/tmp/parent.jsonl",
      HERDR_SUBAGENT_ROLE: "worker",
      HERDR_SUBAGENT_SPAWN_TARGETS: "scout,planner,reviewer",
    },
    id: () => "child-2",
    monitor: false,
  });

  const child = await orchestrator.spawn({
    ...spawnRequest(),
    name: "review",
    agent: { ...spawnRequest().agent, name: "reviewer", spawnTargets: [] },
  });

  assert.equal(child.tabId, "w1:t1");
  assert.equal(child.paneId, "w1:p2");
  assert.equal(child.depth, 2);
  assert.equal(child.parentId, "worker-1");
  const create = transport.calls[0];
  assert.deepEqual(create.slice(0, 6), ["pane", "split", "--pane", "w1:p1", "--direction", "down"]);
  assert.ok(create.includes("--no-focus"));
  assert.ok(create.includes("--cwd"));
  assert.ok(create.includes("/work/project"));
  assert.ok(create.includes("HERDR_SUBAGENT_DEPTH=2"));
  assert.ok(!transport.calls.some((call) => call[0] === "tab"));
});

test("nested role allowlist and depth bounds reject before mutating Herdr", async () => {
  for (const environment of [
    {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_TAB_ID: "w1:t7",
      HERDR_PANE_ID: "w1:p1",
      HERDR_SUBAGENT_DEPTH: "1",
      HERDR_SUBAGENT_ROOT_ID: "root-1",
      HERDR_SUBAGENT_AGENT_ID: "worker-1",
      HERDR_SUBAGENT_SPAWN_TARGETS: "scout,planner",
    },
    {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_TAB_ID: "w1:t7",
      HERDR_PANE_ID: "w1:p1",
      HERDR_SUBAGENT_DEPTH: "3",
      HERDR_SUBAGENT_ROOT_ID: "root-1",
      HERDR_SUBAGENT_AGENT_ID: "worker-1",
      HERDR_SUBAGENT_SPAWN_TARGETS: "reviewer",
    },
  ]) {
    const transport = new FakeHerdrTransport([]);
    const orchestrator = new SubagentOrchestrator({
      transport,
      stateDirectory: temporaryDirectory(),
      environment,
      id: () => "forbidden-child",
      monitor: false,
    });

    await assert.rejects(
      orchestrator.spawn({
        ...spawnRequest(),
        agent: { ...spawnRequest().agent, name: "reviewer" },
      }),
      environment.HERDR_SUBAGENT_DEPTH === "3"
        ? /Maximum subagent depth/
        : /cannot spawn role reviewer/,
    );
    assert.deepEqual(transport.calls, []);
  }
});

test("per-parent concurrency bound rejects a fifth live child before layout mutation", async () => {
  const transport = new FakeHerdrTransport(
    Array.from({ length: 4 }, () => successfulRootSpawnResponses()).flat(),
  );
  let childNumber = 0;
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: temporaryDirectory(),
    environment: {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_TAB_ID: "w1:t1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => `child-${++childNumber}`,
    monitor: false,
  });
  for (let index = 1; index <= 4; index += 1) {
    await orchestrator.spawn({ ...spawnRequest(), name: `child-${index}` });
  }
  const names = orchestrator.list("parent-session").map((child) => child.herdrName);
  assert.equal(new Set(names).size, 4);
  assert.ok(names.every((name) => /^[a-z][a-z0-9_-]{0,31}$/.test(name)));
  await assert.rejects(
    orchestrator.spawn({ ...spawnRequest(), name: "child-5" }),
    /Maximum of 4 live subagents per parent/,
  );
  assert.equal(transport.calls.length, 16);
});

test("concurrent orchestrators atomically reserve one same-name child", async () => {
  const directory = temporaryDirectory();
  const environment = {
    HERDR_ENV: "1",
    HERDR_WORKSPACE_ID: "w1",
    HERDR_TAB_ID: "w1:t1",
    HERDR_PANE_ID: "w1:p1",
  };
  const firstTransport = new FakeHerdrTransport(successfulRootSpawnResponses());
  const secondTransport = new FakeHerdrTransport(successfulRootSpawnResponses());
  const first = new SubagentOrchestrator({
    transport: firstTransport,
    stateDirectory: directory,
    environment,
    id: () => "first-child",
    monitor: false,
  });
  const second = new SubagentOrchestrator({
    transport: secondTransport,
    stateDirectory: directory,
    environment,
    id: () => "second-child",
    monitor: false,
  });

  const results = await Promise.allSettled([
    first.spawn(spawnRequest()),
    second.spawn(spawnRequest()),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(first.list("parent-session").length, 1);
  assert.equal(firstTransport.calls.length + secondTransport.calls.length, 4);
});

test("a stable semantic name permanently addresses one durable child", async () => {
  const responses = successfulRootSpawnResponses();
  responses.push(
    { id: "cli:agent:send-keys", result: { agent: { agent_status: "working" } } },
    { id: "cli:agent:wait", result: { agent: { agent_status: "idle" } } },
    { id: "cli:tab:close", result: { type: "ok" } },
  );
  const transport = new FakeHerdrTransport(responses);
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: temporaryDirectory(),
    environment: {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    monitor: false,
  });
  await orchestrator.spawn(spawnRequest());
  await orchestrator.cancel("parent-session", "parent-session", "authentication");

  await assert.rejects(
    orchestrator.spawn(spawnRequest()),
    /A child named authentication already exists for this parent.*message/,
  );
  assert.equal(orchestrator.list("parent-session").length, 1);
  assert.equal(transport.calls.length, 7);
});

test("malformed Herdr JSON fails visibly and preserves a failed registry record", async () => {
  const transport = new FakeHerdrTransport([]);
  transport.responses.push({ code: 0, stdout: "not-json\n", stderr: "" });
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: temporaryDirectory(),
    environment: {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_TAB_ID: "w1:t1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "malformed-child",
    monitor: false,
  });

  await assert.rejects(orchestrator.spawn(spawnRequest()), /Malformed Herdr JSON/);
  assert.equal(orchestrator.list("parent-session")[0]?.state, "failed");
  assert.equal(transport.calls.length, 1);
});

test("startup failure closes only the recorded pane created for the failed child", async () => {
  const responses = successfulRootSpawnResponses();
  const transport = new FakeHerdrTransport(responses);
  transport.responses[2] = { code: 1, stdout: "", stderr: "agent failed to start" };
  transport.responses[3] = {
    code: 0,
    stdout: `${JSON.stringify({ id: "cli:tab:close", result: { type: "ok" } })}\n`,
    stderr: "",
  };
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: temporaryDirectory(),
    environment: {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_TAB_ID: "w1:t1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "failed-child",
    monitor: false,
  });

  await assert.rejects(orchestrator.spawn(spawnRequest()), /agent failed to start/);
  assert.deepEqual(transport.calls.at(-1), ["pane", "close", "w1:p9"]);
  assert.equal(orchestrator.list("parent-session")[0]?.state, "failed");
});

test("agent startup retries Herdr pane readiness without creating another layout", async () => {
  const responses = successfulRootSpawnResponses();
  responses.splice(2, 0, {
    error: { code: "agent_pane_busy", message: "pane shell is not ready" },
  });
  const transport = new FakeHerdrTransport(responses);
  transport.responses[2] = {
    code: 1,
    stdout: "",
    stderr: JSON.stringify({ error: { code: "agent_pane_busy" } }),
  };
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: temporaryDirectory(),
    environment: {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_TAB_ID: "w1:t1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    monitor: false,
  });

  await orchestrator.spawn(spawnRequest());
  assert.equal(
    transport.calls.filter((call) => call[0] === "agent" && call[1] === "start").length,
    2,
  );
  assert.equal(transport.calls.filter((call) => call[0] === "tab").length, 0);
});

test("initial prompt failure stops the started agent and closes its recorded pane", async () => {
  const transport = new FakeHerdrTransport(successfulRootSpawnResponses());
  transport.responses[3] = { code: 1, stdout: "", stderr: "prompt rejected" };
  transport.responses.push(
    {
      code: 0,
      stdout: `${JSON.stringify({ id: "cli:agent:send-keys", result: { type: "ok" } })}\n`,
      stderr: "",
    },
    {
      code: 0,
      stdout: `${JSON.stringify({ id: "cli:tab:close", result: { type: "ok" } })}\n`,
      stderr: "",
    },
  );
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: temporaryDirectory(),
    environment: {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_TAB_ID: "w1:t1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "failed-prompt-child",
    monitor: false,
  });

  await assert.rejects(orchestrator.spawn(spawnRequest()), /prompt rejected/);
  assert.deepEqual(transport.calls.at(-2), [
    "agent",
    "send-keys",
    "authentication-worker-failed",
    "ctrl+c",
    "ctrl+c",
  ]);
  assert.deepEqual(transport.calls.at(-1), ["pane", "close", "w1:p9"]);
});

test("recovery rejects a child owned by another Herdr session", async () => {
  const directory = temporaryDirectory();
  const initial = new SubagentOrchestrator({
    transport: new FakeHerdrTransport(successfulRootSpawnResponses()),
    stateDirectory: directory,
    environment: {
      HERDR_ENV: "1",
      HERDR_SESSION: "session-a",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    monitor: false,
  });
  await initial.spawn(spawnRequest());

  const transport = new FakeHerdrTransport([]);
  const recovered = new SubagentOrchestrator({
    transport,
    stateDirectory: directory,
    environment: {
      HERDR_ENV: "1",
      HERDR_SESSION: "session-b",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
    },
    monitor: false,
  });

  await assert.rejects(
    recovered.recover("parent-session", "parent-session"),
    /belongs to Herdr session session-a.*current session is session-b/,
  );
  assert.deepEqual(transport.calls, []);
  assert.equal(recovered.list("parent-session")[0]?.state, "working");
});

test("spawn reconciles a persistent session omitted from the start response", async () => {
  const spawnResponses = successfulRootSpawnResponses();
  const started = spawnResponses[2] as {
    result: { agent: { agent_session?: unknown } };
  };
  delete started.result.agent.agent_session;
  spawnResponses.splice(3, 0, {
    id: "cli:agent:get",
    result: {
      agent: {
        name: "authentication-worker-child1",
        pane_id: "w1:p9",
        agent_status: "idle",
        agent_session: { kind: "path", value: "/tmp/child.jsonl" },
      },
    },
  });
  const directory = temporaryDirectory();
  const environment = {
    HERDR_ENV: "1",
    HERDR_WORKSPACE_ID: "w1",
    HERDR_TAB_ID: "w1:t1",
    HERDR_PANE_ID: "w1:p1",
  };
  const transport = new FakeHerdrTransport(spawnResponses);
  const initial = new SubagentOrchestrator({
    transport,
    stateDirectory: directory,
    environment,
    id: () => "child-1",
    monitor: false,
  });
  const child = await initial.spawn(spawnRequest());

  assert.equal(child.sessionPath, "/tmp/child.jsonl");
  assert.deepEqual(
    transport.calls.slice(2, 5).map((call) => call.slice(0, 2)),
    [
      ["agent", "start"],
      ["agent", "get"],
      ["agent", "prompt"],
    ],
  );
});

test("spawn rejects an unproven persistent session before prompting", async () => {
  const responses = successfulRootSpawnResponses();
  const started = responses[2] as {
    result: { agent: { agent_session?: unknown } };
  };
  delete started.result.agent.agent_session;
  responses.splice(3, 0, {
    id: "cli:agent:get",
    result: {
      agent: {
        name: "authentication-worker-child1",
        pane_id: "w1:p9",
        agent_status: "idle",
      },
    },
  });
  const transport = new FakeHerdrTransport(responses);
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: temporaryDirectory(),
    environment: {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_TAB_ID: "w1:t1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    monitor: false,
  });

  await assert.rejects(orchestrator.spawn(spawnRequest()), /did not report a persistent session/);

  assert.equal(
    transport.calls.some((call) => call[0] === "agent" && call[1] === "prompt"),
    false,
  );
  assert.equal(orchestrator.list("parent-session")[0]?.state, "failed");
});

test("spawn reconciles a committed start whose response is malformed", async () => {
  const responses = successfulRootSpawnResponses();
  const transport = new FakeHerdrTransport(responses);
  transport.responses[2] = { code: 0, stdout: "not-json\n", stderr: "" };
  transport.responses.splice(3, 0, {
    code: 0,
    stdout: `${JSON.stringify({
      id: "cli:agent:get",
      result: {
        agent: {
          name: "authentication-worker-child1",
          pane_id: "w1:p9",
          agent_status: "idle",
          agent_session: { kind: "path", value: "/tmp/child.jsonl" },
        },
      },
    })}\n`,
    stderr: "",
  });
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: temporaryDirectory(),
    environment: {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_TAB_ID: "w1:t1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    monitor: false,
  });

  const child = await orchestrator.spawn(spawnRequest());

  assert.equal(child.state, "working");
  assert.equal(child.sessionPath, "/tmp/child.jsonl");
  assert.deepEqual(
    transport.calls.slice(2, 5).map((call) => call.slice(0, 2)),
    [
      ["agent", "start"],
      ["agent", "get"],
      ["agent", "prompt"],
    ],
  );
});

test("restart recovery classifies a missing live agent as stale", async () => {
  const directory = temporaryDirectory();
  const environment = {
    HERDR_ENV: "1",
    HERDR_WORKSPACE_ID: "w1",
    HERDR_TAB_ID: "w1:t1",
    HERDR_PANE_ID: "w1:p1",
  };
  const initial = new SubagentOrchestrator({
    transport: new FakeHerdrTransport(successfulRootSpawnResponses()),
    stateDirectory: directory,
    environment,
    id: () => "child-1",
    monitor: false,
  });
  await initial.spawn(spawnRequest());

  const missing = new FakeHerdrTransport([]);
  missing.responses.push({ code: 1, stdout: "", stderr: "agent not found" });
  const recovered = new SubagentOrchestrator({
    transport: missing,
    stateDirectory: directory,
    environment,
    monitor: false,
  });
  await recovered.recover("parent-session", "parent-session");
  assert.equal(recovered.list("parent-session")[0]?.state, "stale");
});

test("recovery delivers proven output before observing a replaced runtime", async () => {
  const directory = temporaryDirectory();
  const childSession = join(directory, "immutable-session.jsonl");
  writeFileSync(
    childSession,
    `${JSON.stringify({
      type: "message",
      id: "assistant-1",
      parentId: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "RECORDED_RESULT" }],
        stopReason: "stop",
      },
    })}\n`,
  );
  writeCompletionMarker(directory, "parent-session", "child-1");
  const spawnResponses = successfulRootSpawnResponses();
  const started = spawnResponses[2] as {
    result: { agent: { agent_session: { value: string } } };
  };
  started.result.agent.agent_session.value = childSession;
  const environment = {
    HERDR_ENV: "1",
    HERDR_SESSION: "session-a",
    HERDR_WORKSPACE_ID: "w1",
    HERDR_PANE_ID: "w1:p1",
  };
  const initial = new SubagentOrchestrator({
    transport: new FakeHerdrTransport(spawnResponses),
    stateDirectory: directory,
    environment,
    id: () => "child-1",
    monitor: false,
  });
  await initial.spawn(spawnRequest());

  const transport = new FakeHerdrTransport([
    {
      id: "cli:agent:get",
      result: {
        agent: {
          pane_id: "w1:p9",
          agent_status: "done",
          agent_session: { kind: "path", value: "/tmp/different-session.jsonl" },
        },
      },
    },
  ]);
  let deliveries = 0;
  const recovered = new SubagentOrchestrator({
    transport,
    stateDirectory: directory,
    environment,
    monitor: false,
    onCompletion: async () => {
      deliveries += 1;
      return true;
    },
  });

  await recovered.recover("parent-session", "parent-session");

  const child = recovered.list("parent-session")[0];
  assert.equal(child?.state, "completed");
  assert.equal(child?.result, "RECORDED_RESULT");
  assert.equal(deliveries, 1);
  assert.equal(
    transport.calls.some((call) => call[0] === "agent" && call[1] === "get"),
    false,
  );
});

test("monitor delivers proven output before observing a replaced pane", async () => {
  const directory = temporaryDirectory();
  const childSession = join(directory, "monitor-pane-mismatch.jsonl");
  writeFileSync(
    childSession,
    `${JSON.stringify({
      type: "message",
      id: "assistant-1",
      parentId: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "WRONG_RUNTIME_RESULT" }],
        stopReason: "stop",
      },
    })}\n`,
  );
  writeCompletionMarker(directory, "parent-session", "child-1");
  const responses = successfulRootSpawnResponses();
  const started = responses[2] as {
    result: { agent: { agent_session: { value: string } } };
  };
  started.result.agent.agent_session.value = childSession;
  responses.push({
    id: "cli:agent:wait",
    result: {
      agent: {
        pane_id: "w1:p-other",
        agent_status: "done",
        agent_session: { kind: "path", value: childSession },
      },
    },
  });
  let deliveries = 0;
  const transport = new FakeHerdrTransport(responses);
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: directory,
    environment: {
      HERDR_ENV: "1",
      HERDR_SESSION: "session-a",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    onCompletion: async () => {
      deliveries += 1;
      return true;
    },
  });

  await orchestrator.spawn(spawnRequest());
  await new Promise<void>((resolve) => setTimeout(resolve, 25));

  const child = orchestrator.list("parent-session")[0];
  assert.equal(child?.state, "completed");
  assert.equal(child?.result, "WRONG_RUNTIME_RESULT");
  assert.equal(deliveries, 1);
  assert.equal(
    transport.calls.some(
      (call) => call[0] === "agent" && (call[1] === "wait" || call[1] === "get"),
    ),
    false,
  );
});

test("recovery reconciles only children owned by the current parent", async () => {
  const directory = temporaryDirectory();
  const rootEnvironment = {
    HERDR_ENV: "1",
    HERDR_WORKSPACE_ID: "w1",
    HERDR_TAB_ID: "w1:t1",
    HERDR_PANE_ID: "w1:p1",
  };
  const root = new SubagentOrchestrator({
    transport: new FakeHerdrTransport(successfulRootSpawnResponses()),
    stateDirectory: directory,
    environment: rootEnvironment,
    id: () => "root-child",
    monitor: false,
  });
  await root.spawn(spawnRequest());

  const nestedResponses = successfulRootSpawnResponses();
  nestedResponses[0] = {
    id: "cli:pane:split",
    result: { pane: { pane_id: "w1:p2", tab_id: "w1:t1" } },
  };
  const nestedStarted = nestedResponses[2] as {
    result: { agent: { pane_id: string } };
  };
  nestedStarted.result.agent.pane_id = "w1:p2";
  const nested = new SubagentOrchestrator({
    transport: new FakeHerdrTransport(nestedResponses),
    stateDirectory: directory,
    environment: {
      ...rootEnvironment,
      HERDR_SUBAGENT_DEPTH: "1",
      HERDR_SUBAGENT_ROOT_ID: "parent-session",
      HERDR_SUBAGENT_AGENT_ID: "other-parent",
      HERDR_SUBAGENT_MASTER_ROOT_ID: "parent-session",
      HERDR_SUBAGENT_MASTER_HERDR_SESSION: "default",
      HERDR_SUBAGENT_MASTER_WORKSPACE_ID: "w1",
      HERDR_SUBAGENT_MASTER_PANE_ID: "w1:p1",
      HERDR_SUBAGENT_MASTER_TAB_ID: "w1:t1",
      HERDR_SUBAGENT_MASTER_SESSION_PATH: "/tmp/parent.jsonl",
      HERDR_SUBAGENT_ROLE: "worker",
      HERDR_SUBAGENT_SPAWN_TARGETS: "scout",
    },
    id: () => "nested-child",
    monitor: false,
  });
  await nested.spawn({
    ...spawnRequest(),
    name: "nested",
    agent: { ...spawnRequest().agent, name: "scout", spawnTargets: [] },
  });

  const recoveryTransport = new FakeHerdrTransport([
    {
      id: "cli:agent:get",
      result: {
        agent: {
          pane_id: "w1:p9",
          agent_status: "working",
          agent_session: { kind: "path", value: "/tmp/root-child.jsonl" },
        },
      },
    },
  ]);
  const recovered = new SubagentOrchestrator({
    transport: recoveryTransport,
    stateDirectory: directory,
    environment: rootEnvironment,
    monitor: false,
  });
  await recovered.recover("parent-session", "parent-session");
  assert.equal(recoveryTransport.calls.length, 1);
  assert.equal(
    recovered.list("parent-session").find((child) => child.parentId === "other-parent")?.state,
    "working",
  );
});

test("shutdown aborts an outstanding detached Herdr wait without corrupting state", async () => {
  let resolveAborted!: () => void;
  const aborted = new Promise<void>((resolve) => {
    resolveAborted = resolve;
  });
  class AbortableTransport extends FakeHerdrTransport {
    override async run(args: string[], signal?: AbortSignal): Promise<CommandExecution> {
      if (args[0] === "agent" && args[1] === "wait") {
        return new Promise<CommandExecution>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              resolveAborted();
              reject(signal.reason ?? new Error("aborted"));
            },
            { once: true },
          );
        });
      }
      return super.run(args);
    }
  }
  const transport = new AbortableTransport(successfulRootSpawnResponses());
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: temporaryDirectory(),
    environment: {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_TAB_ID: "w1:t1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
  });
  await orchestrator.spawn(spawnRequest());
  await new Promise<void>((resolve) => setImmediate(resolve));
  const shuttingDown = orchestrator.shutdown();
  await aborted;
  await shuttingDown;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(orchestrator.list("parent-session")[0]?.state, "working");
});

test("inspect racing monitor completion cannot regress a same-generation terminal record", async () => {
  const directory = temporaryDirectory();
  const childSession = join(directory, "inspect-monitor-race.jsonl");
  writeFileSync(
    childSession,
    `${JSON.stringify({
      type: "message",
      id: "assistant-completed",
      parentId: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "DONE" }],
        stopReason: "stop",
      },
    })}\n`,
  );
  const responses = successfulRootSpawnResponses();
  const started = responses[2] as {
    result: { agent: { agent_session: { value: string } } };
  };
  started.result.agent.agent_session.value = childSession;
  let releaseWait!: () => void;
  let releaseInspect!: () => void;
  let inspectStarted!: () => void;
  const startedInspect = new Promise<void>((resolve) => {
    inspectStarted = resolve;
  });
  class MonitorInspectRaceTransport extends FakeHerdrTransport {
    override async run(args: string[]): Promise<CommandExecution> {
      if (args[0] === "agent" && args[1] === "wait") {
        this.calls.push([...args]);
        await new Promise<void>((resolve) => {
          releaseWait = resolve;
        });
        return {
          code: 0,
          stdout: `${JSON.stringify({
            id: "cli:agent:wait",
            result: {
              agent: {
                pane_id: "w1:p9",
                agent_status: "done",
                agent_session: { kind: "path", value: childSession },
              },
            },
          })}\n`,
          stderr: "",
        };
      }
      if (args[0] === "agent" && args[1] === "get") {
        this.calls.push([...args]);
        inspectStarted();
        await new Promise<void>((resolve) => {
          releaseInspect = resolve;
        });
        return {
          code: 0,
          stdout: `${JSON.stringify({
            id: "cli:agent:get",
            result: {
              agent: {
                pane_id: "w1:p9",
                agent_status: "working",
                agent_session: { kind: "path", value: childSession },
              },
            },
          })}\n`,
          stderr: "",
        };
      }
      return super.run(args);
    }
  }
  const transport = new MonitorInspectRaceTransport(responses);
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: directory,
    environment: {
      HERDR_ENV: "1",
      HERDR_SESSION: "session-a",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    onCompletion: async () => false,
  });
  await orchestrator.spawn(spawnRequest());
  await new Promise<void>((resolve) => setImmediate(resolve));
  writeCompletionMarker(directory, "parent-session", "child-1");

  const inspecting = orchestrator.inspect("parent-session", "parent-session", "authentication");
  await startedInspect;
  releaseWait();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (orchestrator.list("parent-session")[0]?.state === "completed") break;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(orchestrator.list("parent-session")[0]?.state, "completed");
  releaseInspect();
  const inspected = await inspecting;

  assert.equal(inspected.state, "completed");
  assert.equal(orchestrator.list("parent-session")[0]?.state, "completed");
  assert.equal(orchestrator.list("parent-session")[0]?.surfaceState, "open");
});

test("concurrent inspect and cancel serialize without stale state overwrite", async () => {
  const responses = successfulRootSpawnResponses();
  responses.push(
    { id: "cli:agent:send-keys", result: { agent: { agent_status: "working" } } },
    { id: "cli:agent:wait", result: { agent: { agent_status: "idle" } } },
    { id: "cli:pane:close", result: { type: "ok" } },
  );
  let releaseInspect!: () => void;
  let inspectStarted!: () => void;
  const startedInspect = new Promise<void>((resolve) => {
    inspectStarted = resolve;
  });
  class DelayedInspectTransport extends FakeHerdrTransport {
    #delayed = false;
    override async run(args: string[]): Promise<CommandExecution> {
      if (args[0] === "agent" && args[1] === "get" && !this.#delayed) {
        this.#delayed = true;
        this.calls.push([...args]);
        inspectStarted();
        await new Promise<void>((resolve) => {
          releaseInspect = resolve;
        });
        return {
          code: 0,
          stdout: `${JSON.stringify({
            id: "cli:agent:get",
            result: {
              agent: {
                pane_id: "w1:p9",
                agent_status: "working",
                agent_session: { kind: "path", value: "/tmp/child.jsonl" },
              },
            },
          })}\n`,
          stderr: "",
        };
      }
      return super.run(args);
    }
  }
  const transport = new DelayedInspectTransport(responses);
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: temporaryDirectory(),
    environment: {
      HERDR_ENV: "1",
      HERDR_SESSION: "session-a",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    monitor: false,
  });
  await orchestrator.spawn(spawnRequest());

  const inspecting = orchestrator.inspect("parent-session", "parent-session", "authentication");
  await startedInspect;
  const cancelling = orchestrator.cancel("parent-session", "parent-session", "authentication");
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseInspect();
  await Promise.all([inspecting, cancelling]);

  const child = orchestrator.list("parent-session")[0];
  assert.equal(child?.state, "cancelled");
  assert.equal(child?.surfaceState, "closed");
});

test("concurrent message and cancel serialize without reopening a cancelled child", async () => {
  const responses = successfulRootSpawnResponses();
  responses.push(
    { id: "cli:agent:prompt", result: { agent: { agent_status: "working" } } },
    { id: "cli:agent:send-keys", result: { agent: { agent_status: "working" } } },
    { id: "cli:agent:wait", result: { agent: { agent_status: "idle" } } },
    { id: "cli:pane:close", result: { type: "ok" } },
  );
  let promptCount = 0;
  let releaseMessage!: () => void;
  let messageStarted!: () => void;
  const startedMessage = new Promise<void>((resolve) => {
    messageStarted = resolve;
  });
  class DelayedMessageTransport extends FakeHerdrTransport {
    override async run(args: string[]): Promise<CommandExecution> {
      const response = await super.run(args);
      if (args[0] === "agent" && args[1] === "prompt" && ++promptCount === 2) {
        messageStarted();
        await new Promise<void>((resolve) => {
          releaseMessage = resolve;
        });
      }
      return response;
    }
  }
  const transport = new DelayedMessageTransport(responses);
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: temporaryDirectory(),
    environment: {
      HERDR_ENV: "1",
      HERDR_SESSION: "session-a",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    monitor: false,
  });
  await orchestrator.spawn(spawnRequest());

  const messaging = orchestrator.message(
    "parent-session",
    "parent-session",
    "authentication",
    "CONTINUE",
  );
  await startedMessage;
  const cancelling = orchestrator.cancel("parent-session", "parent-session", "authentication");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    transport.calls.some((call) => call[1] === "send-keys"),
    false,
  );
  releaseMessage();
  await Promise.all([messaging, cancelling]);

  const child = orchestrator.list("parent-session")[0];
  assert.equal(child?.state, "cancelled");
  assert.equal(child?.surfaceState, "closed");
});

test("separate orchestrators serialize cancellation through the durable child lock", async () => {
  const directory = temporaryDirectory();
  const environment = {
    HERDR_ENV: "1",
    HERDR_SESSION: "session-a",
    HERDR_WORKSPACE_ID: "w1",
    HERDR_PANE_ID: "w1:p1",
  };
  const firstResponses = successfulRootSpawnResponses();
  firstResponses.push(
    {
      id: "cli:agent:get",
      result: {
        agent: {
          pane_id: "w1:p9",
          agent_status: "working",
          agent_session: { kind: "path", value: "/tmp/child.jsonl" },
        },
      },
    },
    { id: "cli:agent:send-keys", result: { agent: { agent_status: "working" } } },
    {
      id: "cli:agent:wait",
      result: {
        agent: {
          pane_id: "w1:p9",
          agent_status: "idle",
          agent_session: { kind: "path", value: "/tmp/child.jsonl" },
        },
      },
    },
    { id: "cli:pane:close", result: { type: "ok" } },
  );
  const firstTransport = new FakeHerdrTransport(firstResponses);
  const first = new SubagentOrchestrator({
    transport: firstTransport,
    stateDirectory: directory,
    environment,
    id: () => "child-1",
    monitor: false,
  });
  await first.spawn(spawnRequest());

  const secondTransport = new FakeHerdrTransport([
    {
      id: "cli:agent:get",
      result: {
        agent: {
          pane_id: "w1:p9",
          agent_status: "working",
          agent_session: { kind: "path", value: "/tmp/child.jsonl" },
        },
      },
    },
    { id: "cli:agent:send-keys", result: { agent: { agent_status: "working" } } },
    {
      id: "cli:agent:wait",
      result: {
        agent: {
          pane_id: "w1:p9",
          agent_status: "idle",
          agent_session: { kind: "path", value: "/tmp/child.jsonl" },
        },
      },
    },
    { id: "cli:pane:close", result: { type: "ok" } },
  ]);
  const second = new SubagentOrchestrator({
    transport: secondTransport,
    stateDirectory: directory,
    environment,
    id: () => "child-2",
    monitor: false,
  });

  const [left, right] = await Promise.all([
    first.cancel("parent-session", "parent-session", "authentication"),
    second.cancel("parent-session", "parent-session", "authentication"),
  ]);

  assert.equal(left.state, "cancelled");
  assert.equal(right.state, "cancelled");
  assert.equal(
    firstTransport.calls.filter((call) => call[1] === "send-keys").length +
      secondTransport.calls.filter((call) => call[1] === "send-keys").length,
    1,
  );
  assert.equal(
    firstTransport.calls.filter((call) => call[1] === "close").length +
      secondTransport.calls.filter((call) => call[1] === "close").length,
    1,
  );
});

test("duplicate concurrent cancel performs one idempotent cleanup", async () => {
  const responses = successfulRootSpawnResponses();
  responses.push(
    { id: "cli:agent:send-keys", result: { agent: { agent_status: "working" } } },
    { id: "cli:agent:wait", result: { agent: { agent_status: "idle" } } },
    { id: "cli:pane:close", result: { type: "ok" } },
  );
  const transport = new FakeHerdrTransport(responses);
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: temporaryDirectory(),
    environment: {
      HERDR_ENV: "1",
      HERDR_SESSION: "session-a",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    monitor: false,
  });
  await orchestrator.spawn(spawnRequest());

  const results = await Promise.all([
    orchestrator.cancel("parent-session", "parent-session", "authentication"),
    orchestrator.cancel("parent-session", "parent-session", "authentication"),
  ]);

  assert.ok(results.every((child) => child.state === "cancelled"));
  assert.equal(transport.calls.filter((call) => call[1] === "send-keys").length, 1);
  assert.equal(transport.calls.filter((call) => call[1] === "wait").length, 1);
  assert.equal(transport.calls.filter((call) => call[1] === "close").length, 1);
});

test("task and steering text stay exact argv values and controls target the registered agent", async () => {
  const specialTask = "line one\n'\"; $(touch /tmp/never) ☃";
  const specialMessage = "steer\n`echo nope` •";
  const responses = successfulRootSpawnResponses();
  responses[3] = {
    id: "cli:agent:prompt",
    result: { agent: { name: "authentication-worker-child1", agent_status: "working" } },
  };
  responses.push(
    { id: "cli:agent:prompt", result: { agent: { agent_status: "working" } } },
    { id: "cli:agent:send-keys", result: { agent: { agent_status: "working" } } },
    { id: "cli:agent:wait", result: { agent: { agent_status: "idle" } } },
    { id: "cli:tab:close", result: { type: "ok" } },
  );
  const transport = new FakeHerdrTransport(responses);
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: temporaryDirectory(),
    environment: {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_TAB_ID: "w1:t1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    monitor: false,
  });

  await orchestrator.spawn({ ...spawnRequest(), task: specialTask });
  await orchestrator.message("parent-session", "parent-session", "authentication", specialMessage);
  await orchestrator.cancel("parent-session", "parent-session", "authentication");
  assert.equal(orchestrator.list("parent-session")[0]?.state, "cancelled");
  assert.equal(orchestrator.list("parent-session")[0]?.surfaceState, "closed");
  await assert.rejects(
    orchestrator.resume("parent-session", "parent-session", "authentication"),
    /use message/,
  );

  assert.equal(transport.calls[3].at(-1), specialTask);
  assert.deepEqual(transport.calls[4], [
    "agent",
    "prompt",
    "authentication-worker-child1",
    specialMessage,
  ]);
  assert.deepEqual(transport.calls[5], [
    "agent",
    "send-keys",
    "authentication-worker-child1",
    "escape",
  ]);
  assert.deepEqual(transport.calls[6], [
    "agent",
    "wait",
    "authentication-worker-child1",
    "--until",
    "idle",
    "--until",
    "done",
    "--timeout",
    "30000",
  ]);
  assert.deepEqual(transport.calls[7], ["pane", "close", "w1:p9"]);
});

test("cleanup rejects a child owned by another Herdr session", async () => {
  const directory = temporaryDirectory();
  const initial = new SubagentOrchestrator({
    transport: new FakeHerdrTransport(successfulRootSpawnResponses()),
    stateDirectory: directory,
    environment: {
      HERDR_ENV: "1",
      HERDR_SESSION: "session-a",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    monitor: false,
  });
  await initial.spawn(spawnRequest());

  const transport = new FakeHerdrTransport([]);
  const otherSession = new SubagentOrchestrator({
    transport,
    stateDirectory: directory,
    environment: {
      HERDR_ENV: "1",
      HERDR_SESSION: "session-b",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
    },
    monitor: false,
  });

  await assert.rejects(
    otherSession.cancel("parent-session", "parent-session", "authentication"),
    /belongs to Herdr session session-a.*current session is session-b/,
  );
  assert.deepEqual(transport.calls, []);
});

test("active lifecycle controls reject a foreign Herdr session before mutation or transport", async () => {
  const directory = temporaryDirectory();
  const initial = new SubagentOrchestrator({
    transport: new FakeHerdrTransport(successfulRootSpawnResponses()),
    stateDirectory: directory,
    environment: {
      HERDR_ENV: "1",
      HERDR_SESSION: "session-a",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    monitor: false,
  });
  await initial.spawn(spawnRequest());

  const transport = new FakeHerdrTransport([]);
  const foreign = new SubagentOrchestrator({
    transport,
    stateDirectory: directory,
    environment: {
      HERDR_ENV: "1",
      HERDR_SESSION: "session-b",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
    },
    monitor: false,
  });
  const before = JSON.stringify(foreign.list("parent-session"));
  const controls = [
    () => foreign.inspect("parent-session", "parent-session", "authentication"),
    () => foreign.message("parent-session", "parent-session", "authentication", "follow up"),
    () => foreign.resume("parent-session", "parent-session", "authentication"),
    () => foreign.cancel("parent-session", "parent-session", "authentication"),
  ];

  for (const control of controls) {
    await assert.rejects(
      control,
      /belongs to Herdr session session-a.*current session is session-b/,
    );
  }
  assert.equal(JSON.stringify(foreign.list("parent-session")), before);
  assert.deepEqual(transport.calls, []);
});

test("cancel validates the reported pane and immutable session before accepting wait status", async () => {
  const directory = temporaryDirectory();
  const childSession = join(directory, "cancel-identity.jsonl");
  writeFileSync(
    childSession,
    `${JSON.stringify({
      type: "message",
      id: "assistant-1",
      parentId: null,
      message: { role: "assistant", content: [], stopReason: "aborted" },
    })}\n`,
  );
  const responses = successfulRootSpawnResponses();
  const started = responses[2] as {
    result: { agent: { agent_session: { value: string } } };
  };
  started.result.agent.agent_session.value = childSession;
  responses.push(
    { id: "cli:agent:send-keys", result: { agent: { agent_status: "working" } } },
    {
      id: "cli:agent:wait",
      result: {
        agent: {
          pane_id: "w1:p-other",
          agent_status: "idle",
          agent_session: { kind: "path", value: childSession },
        },
      },
    },
  );
  const transport = new FakeHerdrTransport(responses);
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: directory,
    environment: {
      HERDR_ENV: "1",
      HERDR_SESSION: "session-a",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    monitor: false,
  });
  await orchestrator.spawn(spawnRequest());

  await assert.rejects(
    orchestrator.cancel("parent-session", "parent-session", "authentication"),
    /pane identity changed/,
  );

  assert.equal(orchestrator.list("parent-session")[0]?.state, "working");
  assert.equal(
    transport.calls.some((call) => call[1] === "close"),
    false,
  );
});

test("explicit cancel closes only its recorded root pane and leaves tab lifecycle to Herdr", async () => {
  const responses = successfulRootSpawnResponses();
  responses.push(
    { id: "cli:agent:send-keys", result: { agent: { agent_status: "working" } } },
    { id: "cli:agent:wait", result: { agent: { agent_status: "idle" } } },
    { id: "cli:tab:close", result: { type: "ok" } },
  );
  const transport = new FakeHerdrTransport(responses);
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: temporaryDirectory(),
    environment: {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    monitor: false,
  });
  await orchestrator.spawn(spawnRequest());

  const child = await orchestrator.cancel("parent-session", "parent-session", "authentication");

  assert.equal(child.state, "cancelled");
  assert.equal(child.surfaceState, "closed");
  assert.deepEqual(transport.calls.slice(-3), [
    ["agent", "send-keys", "authentication-worker-child1", "escape"],
    [
      "agent",
      "wait",
      "authentication-worker-child1",
      "--until",
      "idle",
      "--until",
      "done",
      "--timeout",
      "30000",
    ],
    ["pane", "close", "w1:p9"],
  ]);
  assert.equal(
    transport.calls.some((call) => call[0] === "tab" && call[1] === "close"),
    false,
  );
});

test("live message prompt failure stops the owned agent and cleans its pane", async () => {
  const responses = successfulRootSpawnResponses();
  responses.push(
    { id: "unused-prompt", result: { type: "unused" } },
    { id: "cli:agent:send-keys", result: { type: "ok" } },
    { id: "cli:pane:close", result: { type: "ok" } },
  );
  const transport = new FakeHerdrTransport(responses);
  transport.responses[4] = { code: 1, stdout: "", stderr: "follow-up rejected" };
  transport.responses.splice(4, 0, {
    code: 0,
    stderr: "",
    stdout: JSON.stringify({
      id: "cli:agent:get",
      result: {
        agent: {
          pane_id: "w1:p9",
          agent_status: "working",
          agent_session: { kind: "path", value: "/tmp/child.jsonl" },
        },
      },
    }),
  });
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: temporaryDirectory(),
    environment: {
      HERDR_ENV: "1",
      HERDR_SESSION: "session-a",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    monitor: false,
  });
  await orchestrator.spawn(spawnRequest());

  await assert.rejects(
    orchestrator.message("parent-session", "parent-session", "authentication", "CONTINUE"),
    /follow-up rejected/,
  );

  const child = orchestrator.list("parent-session")[0];
  assert.equal(child?.state, "failed");
  assert.equal(typeof child?.deliveredAt, "number");
  assert.equal(child?.surfaceState, "closed");
  assert.deepEqual(transport.calls.slice(-3), [
    ["agent", "prompt", child?.herdrName ?? "", "CONTINUE"],
    ["agent", "send-keys", child?.herdrName ?? "", "ctrl+c", "ctrl+c"],
    ["pane", "close", "w1:p9"],
  ]);
});

test("message replaces an actively waiting monitor within the launched generation", async () => {
  const directory = temporaryDirectory();
  const childSession = join(directory, "active-monitor.jsonl");
  const oldLines = [
    JSON.stringify({ type: "session", version: 3, id: "session", cwd: "/work/project" }),
    JSON.stringify({
      type: "message",
      id: "old-assistant",
      parentId: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "OLD_RESULT" }],
        stopReason: "stop",
      },
    }),
  ];
  writeFileSync(childSession, `${oldLines.join("\n")}\n`);
  const normalResponses = successfulRootSpawnResponses();
  const started = normalResponses[2] as {
    result: { agent: { agent_session: { value: string } } };
  };
  started.result.agent.agent_session.value = childSession;
  normalResponses.push({
    id: "cli:agent:prompt",
    result: { agent: { agent_status: "working" } },
  });
  let resolveWaitStarted!: () => void;
  const waitStarted = new Promise<void>((resolve) => {
    resolveWaitStarted = resolve;
  });
  let waitCount = 0;
  class ReplacingMonitorTransport extends FakeHerdrTransport {
    override async run(args: string[], signal?: AbortSignal): Promise<CommandExecution> {
      if (args[0] !== "agent" || args[1] !== "wait") return super.run(args);
      this.calls.push([...args]);
      waitCount += 1;
      if (waitCount === 1) {
        resolveWaitStarted();
        return new Promise<CommandExecution>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted old monitor")), {
            once: true,
          });
        });
      }
      setTimeout(() => {
        writeFileSync(
          childSession,
          `${oldLines.join("\n")}\n${JSON.stringify({
            type: "message",
            id: "new-assistant",
            parentId: "old-assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "NEW_GENERATION" }],
              stopReason: "stop",
            },
          })}\n`,
        );
        writeCompletionMarker(directory, "parent-session", "child-1");
      }, 25);
      return {
        code: 0,
        stdout: `${JSON.stringify({
          id: "cli:agent:wait",
          result: {
            agent: {
              pane_id: "w1:p9",
              agent_status: "done",
              agent_session: { kind: "path", value: childSession },
            },
          },
        })}\n`,
        stderr: "",
      };
    }
  }
  const transport = new ReplacingMonitorTransport(normalResponses);
  let resolveDelivered!: (child: { generation: number; result?: string }) => void;
  const delivered = new Promise<{ generation: number; result?: string }>((resolve) => {
    resolveDelivered = resolve;
  });
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: directory,
    environment: {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_TAB_ID: "w1:t1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    onCompletion: async (child) => {
      resolveDelivered(child);
      return true;
    },
  });

  await orchestrator.spawn(spawnRequest());
  await waitStarted;
  const active = orchestrator.list("parent-session")[0]!;
  writeCompletionSettlement(active.completionMarkerPath, {
    version: 1,
    childId: active.id,
    generation: active.generation,
    phase: "running",
    sessionPath: childSession,
    frontierEntryId: "old-assistant",
  });
  await orchestrator.message("parent-session", "parent-session", "authentication", "New work");
  const completed = await delivered;
  assert.equal(waitCount, 2);
  assert.equal(completed.generation, 1);
  assert.equal(completed.result, "NEW_GENERATION");
});

test("follow-up completion waits for a new assistant session entry", async () => {
  const directory = temporaryDirectory();
  const childSession = join(directory, "follow-up.jsonl");
  const oldLines = [
    JSON.stringify({ type: "session", version: 3, id: "session", cwd: "/work/project" }),
    JSON.stringify({
      type: "message",
      id: "old-assistant",
      parentId: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "OLD_RESULT" }],
        stopReason: "stop",
      },
    }),
  ];
  writeFileSync(childSession, `${oldLines.join("\n")}\n`);

  const spawnResponses = successfulRootSpawnResponses();
  const started = spawnResponses[2] as {
    result: { agent: { agent_session: { value: string } } };
  };
  started.result.agent.agent_session.value = childSession;
  const firstTransport = new FakeHerdrTransport(spawnResponses);
  const common = {
    stateDirectory: directory,
    environment: {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_TAB_ID: "w1:t1",
      HERDR_PANE_ID: "w1:p1",
    },
  };
  const initial = new SubagentOrchestrator({
    ...common,
    transport: firstTransport,
    id: () => "child-1",
    monitor: false,
  });
  await initial.spawn(spawnRequest());
  const active = initial.list("parent-session")[0]!;
  writeCompletionSettlement(active.completionMarkerPath, {
    version: 1,
    childId: active.id,
    generation: active.generation,
    phase: "running",
    sessionPath: childSession,
    frontierEntryId: "old-assistant",
  });

  class DelayedSessionTransport extends FakeHerdrTransport {
    override async run(args: string[]): Promise<CommandExecution> {
      const result = await super.run(args);
      if (args[0] === "agent" && args[1] === "wait") {
        setTimeout(() => {
          writeFileSync(
            childSession,
            `${oldLines.join("\n")}\n${JSON.stringify({
              type: "message",
              id: "new-assistant",
              parentId: "old-assistant",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "NEW_RESULT" }],
                stopReason: "stop",
              },
            })}\n`,
          );
          writeCompletionMarker(directory, "parent-session", "child-1");
        }, 25);
      }
      return result;
    }
  }

  const transport = new DelayedSessionTransport([
    {
      id: "cli:agent:get",
      result: {
        agent: {
          pane_id: "w1:p9",
          agent_status: "working",
          agent_session: { kind: "path", value: childSession },
        },
      },
    },
    { id: "cli:agent:prompt", result: { agent: { agent_status: "working" } } },
    {
      id: "cli:agent:wait",
      result: {
        agent: {
          pane_id: "w1:p9",
          agent_status: "done",
          agent_session: { kind: "path", value: childSession },
        },
      },
    },
  ]);
  let resolveDelivered!: (child: { result?: string }) => void;
  const delivered = new Promise<{ result?: string }>((resolve) => {
    resolveDelivered = resolve;
  });
  const followUp = new SubagentOrchestrator({
    ...common,
    transport,
    onCompletion: async (child) => {
      resolveDelivered(child);
      return true;
    },
  });
  await followUp.message("parent-session", "parent-session", "authentication", "Continue");
  assert.equal((await delivered).result, "NEW_RESULT");
});

test("message relaunches a finished root child with its exact saved loadout and session", async () => {
  const directory = temporaryDirectory();
  const childSession = join(directory, "root-relaunch.jsonl");
  writeFileSync(
    childSession,
    `${JSON.stringify({
      type: "message",
      id: "assistant-1",
      parentId: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "FIRST_RESULT" }],
        stopReason: "stop",
      },
    })}\n`,
  );
  writeCompletionMarker(directory, "parent-session", "child-1");
  const spawnResponses = successfulRootSpawnResponses();
  const initiallyStarted = spawnResponses[2] as {
    result: { agent: { agent_session: { value: string } } };
  };
  initiallyStarted.result.agent.agent_session.value = childSession;
  spawnResponses.push(
    {
      id: "cli:agent:wait",
      result: {
        agent: {
          pane_id: "w1:p9",
          agent_status: "done",
          agent_session: { kind: "path", value: childSession },
        },
      },
    },
    { id: "cli:pane:close", result: { type: "ok" } },
  );
  let resolveDelivered!: () => void;
  const delivered = new Promise<void>((resolve) => {
    resolveDelivered = resolve;
  });
  const environment = {
    HERDR_ENV: "1",
    HERDR_WORKSPACE_ID: "w1",
    HERDR_PANE_ID: "w1:p1",
    PI_CODING_AGENT_DIR: "/saved/pi",
    PI_OFFLINE: "1",
  };
  const request = spawnRequest();
  const initial = new SubagentOrchestrator({
    transport: new FakeHerdrTransport(spawnResponses),
    stateDirectory: directory,
    environment,
    id: () => "child-1",
    onCompletion: async () => {
      resolveDelivered();
      return true;
    },
  });
  await initial.spawn(request);
  await delivered;
  await new Promise<void>((resolve) => setImmediate(resolve));
  await initial.shutdown();

  class CompletingRelaunchTransport extends FakeHerdrTransport {
    override async run(args: string[]): Promise<CommandExecution> {
      const execution = await super.run(args);
      if (args[0] === "agent" && args[1] === "wait") {
        writeFileSync(
          childSession,
          `${JSON.stringify({
            type: "message",
            id: "assistant-1",
            parentId: null,
            message: {
              role: "assistant",
              content: [{ type: "text", text: "FIRST_RESULT" }],
              stopReason: "stop",
            },
          })}\n${JSON.stringify({
            type: "message",
            id: "assistant-2",
            parentId: "assistant-1",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "SECOND_RESULT" }],
              stopReason: "stop",
            },
          })}\n`,
        );
        writeCompletionMarker(directory, "parent-session", "child-1", 2);
      }
      return execution;
    }
  }
  const relaunchTransport = new CompletingRelaunchTransport([
    {
      id: "cli:pane:split",
      result: { pane: { pane_id: "w1:p10", tab_id: "w1:t1" } },
    },
    { id: "cli:pane:rename", result: { pane: { pane_id: "w1:p10" } } },
    {
      id: "cli:agent:start",
      result: {
        agent: {
          pane_id: "w1:p10",
          agent_status: "idle",
        },
      },
    },
    {
      id: "cli:agent:get",
      result: {
        agent: {
          pane_id: "w1:p10",
          agent_status: "idle",
          agent_session: { kind: "path", value: childSession },
        },
      },
    },
    { id: "cli:agent:prompt", result: { agent: { agent_status: "working" } } },
    {
      id: "cli:agent:wait",
      result: {
        agent: {
          pane_id: "w1:p10",
          agent_status: "done",
          agent_session: { kind: "path", value: childSession },
        },
      },
    },
    { id: "cli:pane:close", result: { type: "ok" } },
  ]);
  let resolveRelaunchDelivered!: (child: { result?: string }) => void;
  const relaunchDelivered = new Promise<{ result?: string }>((resolve) => {
    resolveRelaunchDelivered = resolve;
  });
  const relaunched = new SubagentOrchestrator({
    transport: relaunchTransport,
    stateDirectory: directory,
    environment,
    onCompletion: async (completedChild) => {
      resolveRelaunchDelivered(completedChild);
      return true;
    },
  });

  const child = await relaunched.message(
    "parent-session",
    "parent-session",
    "authentication",
    "FOLLOW_UP",
  );

  assert.equal(child.generation, 2);
  assert.equal(child.state, "working");
  assert.equal(child.surfaceState, "open");
  assert.equal(child.tabId, "w1:t1");
  assert.equal(child.paneId, "w1:p10");
  assert.equal(
    child.completionMarkerPath,
    join(directory, "parent-session", "child-1.generation-2.complete"),
  );
  const create = relaunchTransport.calls[0];
  assert.ok(create.includes("HERDR_SUBAGENT_GENERATION=2"));
  assert.ok(create.includes("PI_CODING_AGENT_DIR=/saved/pi"));
  assert.ok(create.includes("PI_OFFLINE=1"));
  const start = relaunchTransport.calls[2];
  assert.deepEqual(start?.slice(0, 13), [
    "agent",
    "start",
    "authentication-worker-child1",
    "--kind",
    "pi",
    "--pane",
    "w1:p10",
    "--timeout",
    "60000",
    "--",
    "--name",
    "authentication",
    "--extension",
  ]);
  assert.ok(start?.[13]?.endsWith("/subagent/completion-protocol.ts"));
  assert.deepEqual(start?.slice(14), [
    "--model",
    "openai-codex/gpt-5.6-sol",
    "--thinking",
    "high",
    "--tools",
    "read,bash,subagent",
    "--append-system-prompt",
    request.agent.systemPromptPath,
    "--skill",
    request.agent.skillPaths[0],
    "--session",
    childSession,
  ]);
  assert.deepEqual(relaunchTransport.calls[4], [
    "agent",
    "prompt",
    "authentication-worker-child1",
    "FOLLOW_UP",
  ]);
  assert.equal((await relaunchDelivered).result, "SECOND_RESULT");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await waitUntil(() => relaunched.list("parent-session")[0]?.surfaceState === "closed");
  assert.equal(relaunched.list("parent-session")[0]?.surfaceState, "closed");
  assert.deepEqual(relaunchTransport.calls.at(-1), ["pane", "close", "w1:p10"]);
});

test("closed child relaunch rejects changed safe Pi environment values", async () => {
  const directory = temporaryDirectory();
  const childSession = join(directory, "changed-environment-relaunch.jsonl");
  writeFileSync(
    childSession,
    `${JSON.stringify({
      type: "message",
      id: "assistant-1",
      parentId: null,
      message: { role: "assistant", content: [], stopReason: "aborted" },
    })}\n`,
  );
  const responses = successfulRootSpawnResponses();
  const started = responses[2] as {
    result: { agent: { agent_session: { value: string } } };
  };
  started.result.agent.agent_session.value = childSession;
  responses.push(
    { id: "cli:agent:send-keys", result: { agent: { agent_status: "working" } } },
    { id: "cli:agent:wait", result: { agent: { agent_status: "idle" } } },
    { id: "cli:pane:close", result: { type: "ok" } },
  );
  const initial = new SubagentOrchestrator({
    transport: new FakeHerdrTransport(responses),
    stateDirectory: directory,
    environment: {
      HERDR_ENV: "1",
      HERDR_SESSION: "session-a",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
      PI_CODING_AGENT_DIR: "/safe/pi",
      PI_OFFLINE: "1",
    },
    id: () => "child-1",
    monitor: false,
  });
  await initial.spawn(spawnRequest());
  await initial.cancel("parent-session", "parent-session", "authentication");

  const transport = new FakeHerdrTransport([]);
  const changedEnvironment = new SubagentOrchestrator({
    transport,
    stateDirectory: directory,
    environment: {
      HERDR_ENV: "1",
      HERDR_SESSION: "session-a",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
      PI_CODING_AGENT_DIR: "/safe/pi",
      PI_OFFLINE: "0",
    },
    monitor: false,
  });

  await assert.rejects(
    changedEnvironment.message("parent-session", "parent-session", "authentication", "CONTINUE"),
    /saved Pi environment no longer matches the current parent environment/,
  );
  assert.deepEqual(transport.calls, []);
  assert.equal(changedEnvironment.list("parent-session")[0]?.generation, 1);
});

test("closed child relaunch rejects a different current Herdr session", async () => {
  const directory = temporaryDirectory();
  const childSession = join(directory, "cross-session-relaunch.jsonl");
  writeFileSync(
    childSession,
    `${JSON.stringify({
      type: "message",
      id: "assistant-1",
      parentId: null,
      message: { role: "assistant", content: [], stopReason: "aborted" },
    })}\n`,
  );
  const responses = successfulRootSpawnResponses();
  const started = responses[2] as {
    result: { agent: { agent_session: { value: string } } };
  };
  started.result.agent.agent_session.value = childSession;
  responses.push(
    { id: "cli:agent:send-keys", result: { agent: { agent_status: "working" } } },
    { id: "cli:agent:wait", result: { agent: { agent_status: "idle" } } },
    { id: "cli:pane:close", result: { type: "ok" } },
  );
  const initial = new SubagentOrchestrator({
    transport: new FakeHerdrTransport(responses),
    stateDirectory: directory,
    environment: {
      HERDR_ENV: "1",
      HERDR_SESSION: "session-a",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    monitor: false,
  });
  await initial.spawn(spawnRequest());
  await initial.cancel("parent-session", "parent-session", "authentication");

  const transport = new FakeHerdrTransport([]);
  const otherSession = new SubagentOrchestrator({
    transport,
    stateDirectory: directory,
    environment: {
      HERDR_ENV: "1",
      HERDR_SESSION: "session-b",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
    },
    monitor: false,
  });

  await assert.rejects(
    otherSession.message("parent-session", "parent-session", "authentication", "CONTINUE"),
    /belongs to Herdr session session-a.*current session is session-b/,
  );
  assert.deepEqual(transport.calls, []);
  assert.equal(otherSession.list("parent-session")[0]?.generation, 1);
});

test("closed message rejects changed saved loadout artifacts before creating a surface", async () => {
  const directory = temporaryDirectory();
  const childSession = join(directory, "cancelled-relaunch.jsonl");
  writeFileSync(
    childSession,
    `${JSON.stringify({
      type: "message",
      id: "assistant-aborted",
      parentId: null,
      message: { role: "assistant", content: [], stopReason: "aborted" },
    })}\n`,
  );
  const responses = successfulRootSpawnResponses();
  const started = responses[2] as {
    result: { agent: { agent_session: { value: string } } };
  };
  started.result.agent.agent_session.value = childSession;
  responses.push(
    { id: "cli:agent:send-keys", result: { agent: { agent_status: "working" } } },
    { id: "cli:agent:wait", result: { agent: { agent_status: "idle" } } },
    { id: "cli:tab:close", result: { type: "ok" } },
  );
  const request = spawnRequest();
  const transport = new FakeHerdrTransport(responses);
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: directory,
    environment: {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    monitor: false,
  });
  await orchestrator.spawn(request);
  await orchestrator.cancel("parent-session", "parent-session", "authentication");
  writeFileSync(request.agent.skillPaths[0], "CHANGED_SKILL\n");

  await assert.rejects(
    orchestrator.message("parent-session", "parent-session", "authentication", "CONTINUE"),
    /saved skill artifact changed/,
  );
  assert.equal(transport.calls.length, 7);
  assert.equal(orchestrator.list("parent-session")[0]?.generation, 1);
  assert.equal(orchestrator.list("parent-session")[0]?.surfaceState, "closed");
});

test("message relaunches a finished nested child in a fresh owner pane", async () => {
  const directory = temporaryDirectory();
  const childSession = join(directory, "nested-relaunch.jsonl");
  writeFileSync(
    childSession,
    `${JSON.stringify({
      type: "message",
      id: "assistant-nested-1",
      parentId: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "FIRST_NESTED_RESULT" }],
        stopReason: "stop",
      },
    })}\n`,
  );
  writeCompletionMarker(directory, "root-1", "child-2");
  const spawnResponses = successfulRootSpawnResponses();
  spawnResponses[0] = {
    id: "cli:pane:split",
    result: { pane: { pane_id: "w1:p2", tab_id: "w1:t1" } },
  };
  const initiallyStarted = spawnResponses[2] as {
    result: { agent: { pane_id: string; agent_session: { value: string } } };
  };
  initiallyStarted.result.agent.pane_id = "w1:p2";
  initiallyStarted.result.agent.agent_session.value = childSession;
  spawnResponses.push(
    {
      id: "cli:agent:wait",
      result: {
        agent: {
          pane_id: "w1:p2",
          agent_status: "done",
          agent_session: { kind: "path", value: childSession },
        },
      },
    },
    { id: "cli:pane:close", result: { type: "ok" } },
  );
  let resolveDelivered!: () => void;
  const delivered = new Promise<void>((resolve) => {
    resolveDelivered = resolve;
  });
  const environment = {
    HERDR_ENV: "1",
    HERDR_WORKSPACE_ID: "w1",
    HERDR_PANE_ID: "w1:p1",
    HERDR_SUBAGENT_DEPTH: "1",
    HERDR_SUBAGENT_ROOT_ID: "root-1",
    HERDR_SUBAGENT_AGENT_ID: "worker-1",
    HERDR_SUBAGENT_MASTER_ROOT_ID: "root-1",
    HERDR_SUBAGENT_MASTER_HERDR_SESSION: "default",
    HERDR_SUBAGENT_MASTER_WORKSPACE_ID: "w1",
    HERDR_SUBAGENT_MASTER_PANE_ID: "w1:p1",
    HERDR_SUBAGENT_MASTER_TAB_ID: "w1:t1",
    HERDR_SUBAGENT_MASTER_SESSION_PATH: "/tmp/parent.jsonl",
    HERDR_SUBAGENT_ROLE: "worker",
    HERDR_SUBAGENT_SPAWN_TARGETS: "reviewer",
  };
  const request = {
    ...spawnRequest(),
    name: "review",
    agent: { ...spawnRequest().agent, name: "reviewer", spawnTargets: [] },
  };
  writeLineageIdentity(directory, "root-1");
  const initial = new SubagentOrchestrator({
    transport: new FakeHerdrTransport(spawnResponses),
    stateDirectory: directory,
    environment,
    id: () => "child-2",
    onCompletion: async () => {
      resolveDelivered();
      return true;
    },
  });
  await initial.spawn(request);
  await delivered;
  await new Promise<void>((resolve) => setImmediate(resolve));
  await initial.shutdown();

  const relaunchTransport = new FakeHerdrTransport([
    {
      id: "cli:pane:split",
      result: { pane: { pane_id: "w1:p3", tab_id: "w1:t1" } },
    },
    { id: "cli:pane:rename", result: { pane: { pane_id: "w1:p3" } } },
    {
      id: "cli:agent:start",
      result: {
        agent: {
          pane_id: "w1:p3",
          agent_status: "idle",
          agent_session: { kind: "path", value: childSession },
        },
      },
    },
    { id: "cli:agent:prompt", result: { agent: { agent_status: "working" } } },
  ]);
  const relaunched = new SubagentOrchestrator({
    transport: relaunchTransport,
    stateDirectory: directory,
    environment: { ...environment, HERDR_PANE_ID: "w1:p20" },
    monitor: false,
  });

  const child = await relaunched.message("root-1", "worker-1", "review", "REVIEW_MORE");

  assert.equal(child.generation, 2);
  assert.equal(child.tabId, "w1:t1");
  assert.equal(child.paneId, "w1:p3");
  assert.deepEqual(relaunchTransport.calls[0]?.slice(0, 6), [
    "pane",
    "split",
    "--pane",
    "w1:p1",
    "--direction",
    "down",
  ]);
  assert.ok(!relaunchTransport.calls.some((call) => call[0] === "tab"));
  assert.deepEqual(relaunchTransport.calls[1], ["pane", "rename", "w1:p3", "reviewer: review"]);
  assert.ok(relaunchTransport.calls[2]?.includes("--session"));
  assert.equal(relaunchTransport.calls[2]?.at(-1), childSession);
  assert.deepEqual(relaunchTransport.calls[3], ["agent", "prompt", child.herdrName, "REVIEW_MORE"]);
});

test("inspect returns the durable terminal record after its surface is closed", async () => {
  const directory = temporaryDirectory();
  const responses = successfulRootSpawnResponses();
  responses.push(
    { id: "cli:agent:send-keys", result: { agent: { agent_status: "working" } } },
    { id: "cli:agent:wait", result: { agent: { agent_status: "idle" } } },
    { id: "cli:pane:close", result: { type: "ok" } },
  );
  const environment = {
    HERDR_ENV: "1",
    HERDR_SESSION: "session-a",
    HERDR_WORKSPACE_ID: "w1",
    HERDR_PANE_ID: "w1:p1",
  };
  const initial = new SubagentOrchestrator({
    transport: new FakeHerdrTransport(responses),
    stateDirectory: directory,
    environment,
    id: () => "child-1",
    monitor: false,
  });
  await initial.spawn(spawnRequest());
  await initial.cancel("parent-session", "parent-session", "authentication");

  const transport = new FakeHerdrTransport([]);
  const inspecting = new SubagentOrchestrator({
    transport,
    stateDirectory: directory,
    environment,
    monitor: false,
  });

  const child = await inspecting.inspect("parent-session", "parent-session", "authentication");

  assert.equal(child.state, "cancelled");
  assert.equal(child.surfaceState, "closed");
  assert.deepEqual(transport.calls, []);
});

test("resume rejects a closed surface and directs the caller to message", async () => {
  const directory = temporaryDirectory();
  const childSession = join(directory, "closed-focus.jsonl");
  writeFileSync(
    childSession,
    `${JSON.stringify({
      type: "message",
      id: "assistant-1",
      parentId: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "DONE" }],
        stopReason: "stop",
      },
    })}\n`,
  );
  writeCompletionMarker(directory, "parent-session", "child-1");
  const responses = successfulRootSpawnResponses();
  const started = responses[2] as {
    result: { agent: { agent_session: { value: string } } };
  };
  started.result.agent.agent_session.value = childSession;
  responses.push(
    {
      id: "cli:agent:wait",
      result: {
        agent: {
          pane_id: "w1:p9",
          agent_status: "done",
          agent_session: { kind: "path", value: childSession },
        },
      },
    },
    { id: "cli:pane:close", result: { type: "ok" } },
  );
  let resolveDelivered!: () => void;
  const delivered = new Promise<void>((resolve) => {
    resolveDelivered = resolve;
  });
  const transport = new FakeHerdrTransport(responses);
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: directory,
    environment: {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    onCompletion: async () => {
      resolveDelivered();
      return true;
    },
  });
  await orchestrator.spawn(spawnRequest());
  await delivered;
  await waitUntil(() => orchestrator.list("parent-session")[0]?.surfaceState === "closed");

  await assert.rejects(
    orchestrator.resume("parent-session", "parent-session", "authentication"),
    /surface is closed.*use message/i,
  );
  assert.equal(transport.calls.length, 5);
});

test("successful detached root completion closes only its recorded pane after durable delivery", async () => {
  const directory = temporaryDirectory();
  const childSession = join(directory, "completed-child.jsonl");
  writeFileSync(
    childSession,
    `${JSON.stringify({
      type: "message",
      id: "assistant-1",
      parentId: null,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "\n  DELIVERED" },
          { type: "text", text: "_RESULT" },
          { type: "text", text: "  \n" },
        ],
        stopReason: "stop",
      },
    })}\n`,
  );

  writeCompletionMarker(directory, "parent-session", "child-1");

  const responses = successfulRootSpawnResponses();
  const started = responses[2] as {
    result: { agent: { agent_session: { value: string } } };
  };
  started.result.agent.agent_session.value = childSession;
  responses.push(
    {
      id: "cli:agent:wait",
      result: {
        agent: {
          pane_id: "w1:p9",
          agent_status: "done",
          agent_session: { kind: "path", value: childSession },
        },
      },
    },
    { id: "cli:pane:close", result: { type: "ok" } },
  );
  const transport = new FakeHerdrTransport(responses);
  let resolveDelivered!: () => void;
  const delivered = new Promise<void>((resolve) => {
    resolveDelivered = resolve;
  });
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: directory,
    environment: {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_TAB_ID: "w1:t1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    now: () => 2_000,
    onCompletion: async () => {
      resolveDelivered();
      return true;
    },
  });

  await orchestrator.spawn(spawnRequest());
  await delivered;
  await waitUntil(() => orchestrator.list("parent-session")[0]?.surfaceState === "closed");

  const child = orchestrator.list("parent-session")[0];
  assert.equal(child?.state, "completed");
  assert.equal(child?.deliveredAt, 2_000);
  assert.equal(child?.sessionPath, childSession);
  assert.equal(child?.result, "\n  DELIVERED_RESULT  \n");
  assert.equal(child?.surfaceState, "closed");
  assert.deepEqual(transport.calls.at(-1), ["pane", "close", "w1:p9"]);
  assert.equal(
    transport.calls.some((call) => call[0] === "tab" && call[1] === "close"),
    false,
  );
});

test("successful nested completion closes only its child pane", async () => {
  const directory = temporaryDirectory();
  const childSession = join(directory, "nested-completed.jsonl");
  writeFileSync(
    childSession,
    `${JSON.stringify({
      type: "message",
      id: "assistant-nested",
      parentId: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "NESTED_RESULT" }],
        stopReason: "stop",
      },
    })}\n`,
  );
  writeCompletionMarker(directory, "root-1", "child-2");
  const responses = successfulRootSpawnResponses();
  responses[0] = {
    id: "cli:pane:split",
    result: { pane: { pane_id: "w1:p2", tab_id: "w1:t1" } },
  };
  const started = responses[2] as {
    result: { agent: { pane_id: string; agent_session: { value: string } } };
  };
  started.result.agent.pane_id = "w1:p2";
  started.result.agent.agent_session.value = childSession;
  responses.push(
    {
      id: "cli:agent:wait",
      result: {
        agent: {
          pane_id: "w1:p2",
          agent_status: "done",
          agent_session: { kind: "path", value: childSession },
        },
      },
    },
    { id: "cli:pane:close", result: { type: "ok" } },
  );
  writeLineageIdentity(directory, "root-1");
  const transport = new FakeHerdrTransport(responses);
  let resolveDelivered!: () => void;
  const delivered = new Promise<void>((resolve) => {
    resolveDelivered = resolve;
  });
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: directory,
    environment: {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_TAB_ID: "w1:t1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_SUBAGENT_DEPTH: "1",
      HERDR_SUBAGENT_ROOT_ID: "root-1",
      HERDR_SUBAGENT_AGENT_ID: "worker-1",
      HERDR_SUBAGENT_MASTER_ROOT_ID: "root-1",
      HERDR_SUBAGENT_MASTER_HERDR_SESSION: "default",
      HERDR_SUBAGENT_MASTER_WORKSPACE_ID: "w1",
      HERDR_SUBAGENT_MASTER_PANE_ID: "w1:p1",
      HERDR_SUBAGENT_MASTER_TAB_ID: "w1:t1",
      HERDR_SUBAGENT_MASTER_SESSION_PATH: "/tmp/parent.jsonl",
      HERDR_SUBAGENT_ROLE: "worker",
      HERDR_SUBAGENT_SPAWN_TARGETS: "reviewer",
    },
    id: () => "child-2",
    onCompletion: async () => {
      resolveDelivered();
      return true;
    },
  });

  await orchestrator.spawn({
    ...spawnRequest(),
    name: "review",
    agent: { ...spawnRequest().agent, name: "reviewer", spawnTargets: [] },
  });
  await delivered;
  await waitUntil(() => orchestrator.list("root-1")[0]?.surfaceState === "closed");

  assert.deepEqual(transport.calls.at(-1), ["pane", "close", "w1:p2"]);
  assert.equal(orchestrator.list("root-1")[0]?.surfaceState, "closed");
});

test("same-generation marker for an earlier assistant entry cannot authorize a newer result", async () => {
  const directory = temporaryDirectory();
  const childSession = join(directory, "stale-entry-marker.jsonl");
  writeFileSync(
    childSession,
    `${JSON.stringify({
      type: "message",
      id: "assistant-old",
      parentId: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "OLD_RESULT" }],
        stopReason: "stop",
      },
    })}\n${JSON.stringify({
      type: "message",
      id: "assistant-new",
      parentId: "assistant-old",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "NEW_RESULT" }],
        stopReason: "stop",
      },
    })}\n`,
  );
  writeCompletionMarker(
    directory,
    "parent-session",
    "child-1",
    1,
    "stop",
    "assistant-old",
    childSession,
  );
  const responses = successfulRootSpawnResponses();
  const started = responses[2] as {
    result: { agent: { agent_session: { value: string } } };
  };
  started.result.agent.agent_session.value = childSession;
  responses.push(
    {
      id: "cli:agent:wait",
      result: {
        agent: {
          pane_id: "w1:p9",
          agent_status: "done",
          agent_session: { kind: "path", value: childSession },
        },
      },
    },
    ...Array.from({ length: 2 }, () => ({
      id: "cli:agent:get",
      result: {
        agent: {
          pane_id: "w1:p9",
          agent_status: "done",
          agent_session: { kind: "path", value: childSession },
        },
      },
    })),
  );
  let deliveries = 0;
  const transport = new FakeHerdrTransport(responses);
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: directory,
    environment: {
      HERDR_ENV: "1",
      HERDR_SESSION: "session-a",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    onCompletion: async () => {
      deliveries += 1;
      return true;
    },
  });

  await orchestrator.spawn(spawnRequest());
  await new Promise<void>((resolve) => setTimeout(resolve, 300));

  assert.equal(deliveries, 0);
  assert.equal(orchestrator.list("parent-session")[0]?.state, "working");
  assert.equal(orchestrator.list("parent-session")[0]?.surfaceState, "open");
  assert.equal(
    transport.calls.some((call) => call[1] === "close"),
    false,
  );
  await orchestrator.shutdown();
});

test("Herdr done with generation-mismatched protocol evidence retains the durable child", async () => {
  const directory = temporaryDirectory();
  const childSession = join(directory, "unproven.jsonl");
  writeFileSync(
    childSession,
    `${JSON.stringify({
      type: "message",
      id: "assistant-unproven",
      parentId: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "NOT_PROVEN" }],
        stopReason: "stop",
      },
    })}\n`,
  );
  const markerPath = writeCompletionMarker(directory, "parent-session", "child-1");
  writeFileSync(
    markerPath,
    `${JSON.stringify({
      version: 1,
      childId: "child-1",
      generation: 2,
      stopReason: "stop",
    })}\n`,
  );
  const responses = successfulRootSpawnResponses();
  const started = responses[2] as {
    result: { agent: { agent_session: { value: string } } };
  };
  started.result.agent.agent_session.value = childSession;
  responses.push(
    {
      id: "cli:agent:wait",
      result: {
        agent: {
          pane_id: "w1:p9",
          agent_status: "done",
          agent_session: { kind: "path", value: childSession },
        },
      },
    },
    ...Array.from({ length: 2 }, () => ({
      id: "cli:agent:get",
      result: {
        agent: {
          pane_id: "w1:p9",
          agent_status: "done",
          agent_session: { kind: "path", value: childSession },
        },
      },
    })),
  );
  const transport = new FakeHerdrTransport(responses);
  let deliveries = 0;
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: directory,
    environment: {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    onCompletion: async () => {
      deliveries += 1;
      return true;
    },
  });

  await orchestrator.spawn(spawnRequest());
  await new Promise<void>((resolve) => setTimeout(resolve, 300));

  assert.equal(deliveries, 0);
  assert.equal(orchestrator.list("parent-session")[0]?.state, "working");
  assert.equal(orchestrator.list("parent-session")[0]?.surfaceState, "open");
  assert.equal(
    transport.calls.some((call) => call[1] === "close"),
    false,
  );
  await orchestrator.shutdown();
});

test("relaunched child persists a blocked transition while waiting for completion proof", async () => {
  const directory = temporaryDirectory();
  const childSession = join(directory, "blocked-relaunch.jsonl");
  writeFileSync(
    childSession,
    `${JSON.stringify({
      type: "message",
      id: "assistant-aborted",
      parentId: null,
      message: { role: "assistant", content: [], stopReason: "aborted" },
    })}\n`,
  );
  const environment = {
    HERDR_ENV: "1",
    HERDR_SESSION: "session-a",
    HERDR_WORKSPACE_ID: "w1",
    HERDR_PANE_ID: "w1:p1",
  };
  const initialResponses = successfulRootSpawnResponses();
  const initiallyStarted = initialResponses[2] as {
    result: { agent: { agent_session: { value: string } } };
  };
  initiallyStarted.result.agent.agent_session.value = childSession;
  initialResponses.push(
    { id: "cli:agent:send-keys", result: { agent: { agent_status: "working" } } },
    { id: "cli:agent:wait", result: { agent: { agent_status: "idle" } } },
    { id: "cli:pane:close", result: { type: "ok" } },
  );
  const initial = new SubagentOrchestrator({
    transport: new FakeHerdrTransport(initialResponses),
    stateDirectory: directory,
    environment,
    id: () => "child-1",
    monitor: false,
  });
  await initial.spawn(spawnRequest());
  await initial.cancel("parent-session", "parent-session", "authentication");

  let observeBlocked!: () => void;
  const blockedObserved = new Promise<void>((resolve) => {
    observeBlocked = resolve;
  });
  let observeWorking!: () => void;
  const workingObserved = new Promise<void>((resolve) => {
    observeWorking = resolve;
  });
  let runtimeStatus: "blocked" | "working" = "blocked";
  let waitCount = 0;
  class BlockedRelaunchTransport extends FakeHerdrTransport {
    override async run(args: string[], signal?: AbortSignal): Promise<CommandExecution> {
      if (args[0] === "agent" && args[1] === "wait") {
        this.calls.push([...args]);
        waitCount += 1;
        if (waitCount === 1) {
          return {
            code: 0,
            stdout: `${JSON.stringify({
              id: "cli:agent:wait",
              result: {
                agent: {
                  pane_id: "w1:p10",
                  agent_status: "idle",
                  agent_session: { kind: "path", value: childSession },
                },
              },
            })}\n`,
            stderr: "",
          };
        }
        return new Promise<CommandExecution>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), {
            once: true,
          });
        });
      }
      if (args[0] === "agent" && args[1] === "get") {
        this.calls.push([...args]);
        if (runtimeStatus === "blocked") observeBlocked();
        else observeWorking();
        return {
          code: 0,
          stdout: `${JSON.stringify({
            id: "cli:agent:get",
            result: {
              agent: {
                pane_id: "w1:p10",
                agent_status: runtimeStatus,
                agent_session: { kind: "path", value: childSession },
              },
            },
          })}\n`,
          stderr: "",
        };
      }
      return super.run(args, signal);
    }
  }
  const transport = new BlockedRelaunchTransport([
    {
      id: "cli:pane:split",
      result: { pane: { pane_id: "w1:p10", tab_id: "w1:t1" } },
    },
    { id: "cli:pane:rename", result: { pane: { pane_id: "w1:p10" } } },
    {
      id: "cli:agent:start",
      result: {
        agent: {
          pane_id: "w1:p10",
          agent_status: "idle",
          agent_session: { kind: "path", value: childSession },
        },
      },
    },
    { id: "cli:agent:prompt", result: { agent: { agent_status: "working" } } },
    { id: "cli:pane:close", result: { type: "ok" } },
  ]);
  let deliverRelaunch!: (child: { result?: string }) => void;
  const relaunchDelivered = new Promise<{ result?: string }>((resolve) => {
    deliverRelaunch = resolve;
  });
  const relaunched = new SubagentOrchestrator({
    transport,
    stateDirectory: directory,
    environment,
    onCompletion: async (child) => {
      deliverRelaunch(child);
      return true;
    },
  });

  await relaunched.message("parent-session", "parent-session", "authentication", "BLOCK_FOR_INPUT");
  try {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      blockedObserved,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("monitor did not re-observe the blocked relaunch")),
          1_000,
        );
      }),
    ]).finally(() => clearTimeout(timeout));
    await waitUntil(() => relaunched.list("parent-session")[0]?.state === "blocked");

    const child = relaunched.list("parent-session")[0];
    assert.equal(child?.generation, 2);
    assert.equal(child?.state, "blocked");
    assert.equal(waitCount, 1);
    assert.equal(
      transport.calls.filter((call) => call[0] === "agent" && call[1] === "get").length,
      1,
    );

    runtimeStatus = "working";
    let workingTimeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      workingObserved,
      new Promise<never>((_resolve, reject) => {
        workingTimeout = setTimeout(
          () => reject(new Error("monitor did not persist the working transition")),
          1_000,
        );
      }),
    ]).finally(() => clearTimeout(workingTimeout));
    await waitUntil(() => relaunched.list("parent-session")[0]?.state === "working");
    assert.equal(relaunched.list("parent-session")[0]?.state, "working");

    writeFileSync(
      childSession,
      `${JSON.stringify({
        type: "message",
        id: "assistant-aborted",
        parentId: null,
        message: { role: "assistant", content: [], stopReason: "aborted" },
      })}\n${JSON.stringify({
        type: "message",
        id: "assistant-completed",
        parentId: "assistant-aborted",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "BLOCKED_RELAUNCH_DONE" }],
          stopReason: "stop",
        },
      })}\n`,
    );
    writeCompletionMarker(directory, "parent-session", "child-1", 2);
    let completionTimeout: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([
      relaunchDelivered,
      new Promise<never>((_resolve, reject) => {
        completionTimeout = setTimeout(
          () => reject(new Error("valid marker did not finalize the active relaunch")),
          1_000,
        );
      }),
    ]).finally(() => clearTimeout(completionTimeout));

    assert.equal(completed.result, "BLOCKED_RELAUNCH_DONE");
    assert.equal(relaunched.list("parent-session")[0]?.state, "completed");
  } finally {
    await relaunched.shutdown();
  }
});

test("marker-wait polling conservatively detects a positively absent runtime", async () => {
  const responses = successfulRootSpawnResponses();
  responses.push(
    {
      id: "cli:agent:wait",
      result: {
        agent: {
          pane_id: "w1:p9",
          agent_status: "idle",
          agent_session: { kind: "path", value: "/tmp/child.jsonl" },
        },
      },
    },
    { id: "unused-get", result: { type: "unused" } },
    { id: "cli:pane:close", result: { type: "ok" } },
  );
  const transport = new FakeHerdrTransport(responses);
  transport.responses[5] = { code: 1, stdout: "", stderr: "agent not found" };
  let reportCrash!: (child: { state: string; error?: string }) => void;
  const crashReported = new Promise<{ state: string; error?: string }>((resolve) => {
    reportCrash = resolve;
  });
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: temporaryDirectory(),
    environment: {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    onCompletion: async (child) => {
      reportCrash(child);
      return true;
    },
  });

  await orchestrator.spawn(spawnRequest());
  const crashed = await crashReported;
  await waitUntil(() => orchestrator.list("parent-session")[0]?.surfaceState === "closed");

  assert.equal(crashed.state, "crashed");
  assert.match(crashed.error ?? "", /disappeared.*agent not found/);
  assert.equal(orchestrator.list("parent-session")[0]?.surfaceState, "closed");
  assert.deepEqual(
    transport.calls.slice(-2).map((call) => call.slice(0, 2)),
    [
      ["agent", "get"],
      ["pane", "close"],
    ],
  );
});

test("recovery keeps monitoring the same idle runtime until delayed completion proof arrives", async () => {
  const directory = temporaryDirectory();
  const childSession = join(directory, "recovery-delayed-marker.jsonl");
  writeFileSync(
    childSession,
    `${JSON.stringify({
      type: "message",
      id: "assistant-delayed-recovery",
      parentId: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "RECOVERED_DELAYED_RESULT" }],
        stopReason: "stop",
      },
    })}\n`,
  );
  const spawnResponses = successfulRootSpawnResponses();
  const started = spawnResponses[2] as {
    result: { agent: { agent_session: { value: string } } };
  };
  started.result.agent.agent_session.value = childSession;
  const environment = {
    HERDR_ENV: "1",
    HERDR_SESSION: "session-a",
    HERDR_WORKSPACE_ID: "w1",
    HERDR_PANE_ID: "w1:p1",
  };
  const initial = new SubagentOrchestrator({
    transport: new FakeHerdrTransport(spawnResponses),
    stateDirectory: directory,
    environment,
    id: () => "child-1",
    monitor: false,
  });
  await initial.spawn(spawnRequest());

  class RecoveryDelayedMarkerTransport extends FakeHerdrTransport {
    override async run(args: string[]): Promise<CommandExecution> {
      const response = await super.run(args);
      if (args[0] === "agent" && args[1] === "wait") {
        setTimeout(() => {
          writeCompletionMarker(directory, "parent-session", "child-1");
        }, 50);
      }
      return response;
    }
  }
  const transport = new RecoveryDelayedMarkerTransport([
    {
      id: "cli:agent:get",
      result: {
        agent: {
          pane_id: "w1:p9",
          agent_status: "idle",
          agent_session: { kind: "path", value: childSession },
        },
      },
    },
    {
      id: "cli:agent:wait",
      result: {
        agent: {
          pane_id: "w1:p9",
          agent_status: "done",
          agent_session: { kind: "path", value: childSession },
        },
      },
    },
    { id: "cli:pane:close", result: { type: "ok" } },
  ]);
  let resolveDelivered!: (child: { result?: string }) => void;
  const delivered = new Promise<{ result?: string }>((resolve) => {
    resolveDelivered = resolve;
  });
  const recovered = new SubagentOrchestrator({
    transport,
    stateDirectory: directory,
    environment,
    onCompletion: async (child) => {
      resolveDelivered(child);
      return true;
    },
  });

  await recovered.recover("parent-session", "parent-session");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    delivered,
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("recovery monitor did not continue")), 1_000);
    }),
  ]).finally(() => clearTimeout(timeout));
  await waitUntil(() => recovered.list("parent-session")[0]?.surfaceState === "closed");

  assert.equal(outcome.result, "RECOVERED_DELAYED_RESULT");
  assert.equal(recovered.list("parent-session")[0]?.surfaceState, "closed");
  assert.deepEqual(
    transport.calls.map((call) => call.slice(0, 2)),
    [
      ["agent", "get"],
      ["agent", "wait"],
      ["pane", "close"],
    ],
  );
});

test("monitor stays alive for a delayed marker after initially unproven idle", async () => {
  const directory = temporaryDirectory();
  const childSession = join(directory, "delayed-marker.jsonl");
  writeFileSync(
    childSession,
    `${JSON.stringify({
      type: "message",
      id: "assistant-delayed",
      parentId: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "DELAYED_RESULT" }],
        stopReason: "stop",
      },
    })}\n`,
  );
  const responses = successfulRootSpawnResponses();
  const started = responses[2] as {
    result: { agent: { agent_session: { value: string } } };
  };
  started.result.agent.agent_session.value = childSession;
  responses.push(
    {
      id: "cli:agent:wait",
      result: {
        agent: {
          pane_id: "w1:p9",
          agent_status: "idle",
          agent_session: { kind: "path", value: childSession },
        },
      },
    },
    {
      id: "cli:agent:get",
      result: {
        agent: {
          pane_id: "w1:p9",
          agent_status: "done",
          agent_session: { kind: "path", value: childSession },
        },
      },
    },
    { id: "cli:pane:close", result: { type: "ok" } },
  );
  class DelayedMarkerTransport extends FakeHerdrTransport {
    override async run(args: string[]): Promise<CommandExecution> {
      const result = await super.run(args);
      if (args[0] === "agent" && args[1] === "wait") {
        setTimeout(() => {
          writeCompletionMarker(directory, "parent-session", "child-1");
        }, 350);
      }
      return result;
    }
  }
  const transport = new DelayedMarkerTransport(responses);
  let resolveDelivered!: (child: { result?: string }) => void;
  const delivered = new Promise<{ result?: string }>((resolve) => {
    resolveDelivered = resolve;
  });
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: directory,
    environment: {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    onCompletion: async (child) => {
      resolveDelivered(child);
      return true;
    },
  });

  await orchestrator.spawn(spawnRequest());
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    delivered,
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("monitor stopped before delayed marker")), 1_500);
    }),
  ]).finally(() => clearTimeout(timeout));
  await waitUntil(() => orchestrator.list("parent-session")[0]?.surfaceState === "closed");

  assert.equal(outcome.result, "DELAYED_RESULT");
  assert.equal(
    transport.calls.filter((call) => call[0] === "agent" && call[1] === "wait").length,
    1,
  );
  assert.equal(orchestrator.list("parent-session")[0]?.surfaceState, "closed");
});

test("recovery cleans and classifies interrupted starting cleanup for spawn and relaunch", async () => {
  for (const generation of [1, 2]) {
    const directory = temporaryDirectory();
    const initial = new SubagentOrchestrator({
      transport: new FakeHerdrTransport(successfulRootSpawnResponses()),
      stateDirectory: directory,
      environment: {
        HERDR_ENV: "1",
        HERDR_SESSION: "session-a",
        HERDR_WORKSPACE_ID: "w1",
        HERDR_PANE_ID: "w1:p1",
      },
      id: () => "child-1",
      monitor: false,
    });
    await initial.spawn(spawnRequest());
    const interrupted = {
      ...initial.list("parent-session")[0],
      generation,
      state: "starting",
      surfaceState: "cleanup-pending",
      deliveredAt: undefined,
      error: undefined,
    };
    writeFileSync(
      join(directory, "parent-session", "child-1.json"),
      `${JSON.stringify(interrupted, null, 2)}\n`,
    );

    const transport = new FakeHerdrTransport([{ id: "cli:pane:close", result: { type: "ok" } }]);
    const recovered = new SubagentOrchestrator({
      transport,
      stateDirectory: directory,
      environment: {
        HERDR_ENV: "1",
        HERDR_SESSION: "session-a",
        HERDR_WORKSPACE_ID: "w1",
        HERDR_PANE_ID: "w1:p1",
      },
      monitor: false,
    });
    await recovered.recover("parent-session", "parent-session");

    const child = recovered.list("parent-session")[0];
    assert.equal(child?.state, "failed", `generation ${generation}`);
    assert.equal(child?.surfaceState, "closed", `generation ${generation}`);
    assert.match(child?.error ?? "", /interrupted cleanup/i);
    assert.deepEqual(transport.calls, [["pane", "close", "w1:p9"]]);
  }
});

test("recovery retries cleanup-pending after failed spawn", async () => {
  const directory = temporaryDirectory();
  const responses = successfulRootSpawnResponses();
  const transport = new FakeHerdrTransport(responses);
  transport.responses[2] = { code: 1, stdout: "", stderr: "agent failed to start" };
  transport.responses[3] = { code: 1, stdout: "", stderr: "pane close failed" };
  const environment = {
    HERDR_ENV: "1",
    HERDR_SESSION: "session-a",
    HERDR_WORKSPACE_ID: "w1",
    HERDR_PANE_ID: "w1:p1",
  };
  const initial = new SubagentOrchestrator({
    transport,
    stateDirectory: directory,
    environment,
    id: () => "failed-child",
    monitor: false,
  });

  await assert.rejects(initial.spawn(spawnRequest()), /agent failed to start/);
  const pending = initial.list("parent-session")[0];
  assert.equal(pending?.state, "failed");
  assert.equal(pending?.surfaceState, "cleanup-pending");
  assert.equal(typeof pending?.deliveredAt, "number");

  const recoveryTransport = new FakeHerdrTransport([
    { id: "unused-close", result: { type: "unused" } },
  ]);
  recoveryTransport.responses[0] = {
    code: 1,
    stdout: "",
    stderr: "pane not found",
  };
  const recovered = new SubagentOrchestrator({
    transport: recoveryTransport,
    stateDirectory: directory,
    environment,
    monitor: false,
  });
  await recovered.recover("parent-session", "parent-session");

  assert.deepEqual(recoveryTransport.calls, [["pane", "close", "w1:p9"]]);
  assert.equal(recovered.list("parent-session")[0]?.surfaceState, "closed");
});

test("recovery cleans a delivered cancelled record left open by a crash window", async () => {
  const directory = temporaryDirectory();
  const responses = successfulRootSpawnResponses();
  responses.push(
    { id: "cli:agent:send-keys", result: { agent: { agent_status: "working" } } },
    { id: "cli:agent:wait", result: { agent: { agent_status: "idle" } } },
    { id: "cli:pane:close", result: { type: "ok" } },
  );
  const environment = {
    HERDR_ENV: "1",
    HERDR_SESSION: "session-a",
    HERDR_WORKSPACE_ID: "w1",
    HERDR_PANE_ID: "w1:p1",
  };
  const initial = new SubagentOrchestrator({
    transport: new FakeHerdrTransport(responses),
    stateDirectory: directory,
    environment,
    id: () => "child-1",
    monitor: false,
  });
  await initial.spawn(spawnRequest());
  await initial.cancel("parent-session", "parent-session", "authentication");
  const crashedRecord = {
    ...initial.list("parent-session")[0],
    surfaceState: "open",
  };
  writeFileSync(
    join(directory, "parent-session", "child-1.json"),
    `${JSON.stringify(crashedRecord, null, 2)}\n`,
  );

  const transport = new FakeHerdrTransport([{ id: "cli:pane:close", result: { type: "ok" } }]);
  const recovered = new SubagentOrchestrator({
    transport,
    stateDirectory: directory,
    environment,
    monitor: false,
  });
  await recovered.recover("parent-session", "parent-session");

  assert.deepEqual(transport.calls, [["pane", "close", "w1:p9"]]);
  assert.equal(recovered.list("parent-session")[0]?.surfaceState, "closed");
});

test("recovery retries cleanup-pending after cancellation", async () => {
  const directory = temporaryDirectory();
  const responses = successfulRootSpawnResponses();
  responses.push(
    { id: "cli:agent:send-keys", result: { agent: { agent_status: "working" } } },
    { id: "cli:agent:wait", result: { agent: { agent_status: "idle" } } },
    { id: "unused-close", result: { type: "unused" } },
  );
  const transport = new FakeHerdrTransport(responses);
  transport.responses[6] = { code: 1, stdout: "", stderr: "pane close failed" };
  const environment = {
    HERDR_ENV: "1",
    HERDR_SESSION: "session-a",
    HERDR_WORKSPACE_ID: "w1",
    HERDR_PANE_ID: "w1:p1",
  };
  const initial = new SubagentOrchestrator({
    transport,
    stateDirectory: directory,
    environment,
    id: () => "child-1",
    monitor: false,
  });
  await initial.spawn(spawnRequest());
  await initial.cancel("parent-session", "parent-session", "authentication");
  assert.equal(initial.list("parent-session")[0]?.state, "cancelled");
  assert.equal(initial.list("parent-session")[0]?.surfaceState, "cleanup-pending");
  assert.equal(typeof initial.list("parent-session")[0]?.deliveredAt, "number");

  const recoveryTransport = new FakeHerdrTransport([
    { id: "cli:pane:close", result: { type: "ok" } },
  ]);
  const recovered = new SubagentOrchestrator({
    transport: recoveryTransport,
    stateDirectory: directory,
    environment,
    monitor: false,
  });
  await recovered.recover("parent-session", "parent-session");

  assert.deepEqual(recoveryTransport.calls, [["pane", "close", "w1:p9"]]);
  assert.equal(recovered.list("parent-session")[0]?.surfaceState, "closed");
});

test("recovery retries cleanup-pending after relaunch failure", async () => {
  const directory = temporaryDirectory();
  const childSession = join(directory, "relaunch-cleanup-retry.jsonl");
  writeFileSync(
    childSession,
    `${JSON.stringify({
      type: "message",
      id: "assistant-aborted",
      parentId: null,
      message: { role: "assistant", content: [], stopReason: "aborted" },
    })}\n`,
  );
  const responses = successfulRootSpawnResponses();
  const started = responses[2] as {
    result: { agent: { agent_session: { value: string } } };
  };
  started.result.agent.agent_session.value = childSession;
  responses.push(
    { id: "cli:agent:send-keys", result: { agent: { agent_status: "working" } } },
    { id: "cli:agent:wait", result: { agent: { agent_status: "idle" } } },
    { id: "cli:pane:close", result: { type: "ok" } },
    {
      id: "cli:pane:split",
      result: { pane: { pane_id: "w1:p10", tab_id: "w1:t1" } },
    },
    { id: "cli:pane:rename", result: { pane: { pane_id: "w1:p10" } } },
    { id: "unused-start", result: { type: "unused" } },
    { id: "unused-close", result: { type: "unused" } },
  );
  const transport = new FakeHerdrTransport(responses);
  transport.responses[9] = { code: 1, stdout: "", stderr: "relaunch failed" };
  transport.responses[10] = { code: 1, stdout: "", stderr: "pane close failed" };
  const environment = {
    HERDR_ENV: "1",
    HERDR_SESSION: "session-a",
    HERDR_WORKSPACE_ID: "w1",
    HERDR_PANE_ID: "w1:p1",
  };
  const initial = new SubagentOrchestrator({
    transport,
    stateDirectory: directory,
    environment,
    id: () => "child-1",
    monitor: false,
  });
  await initial.spawn(spawnRequest());
  await initial.cancel("parent-session", "parent-session", "authentication");
  await assert.rejects(
    initial.message("parent-session", "parent-session", "authentication", "CONTINUE"),
    /relaunch failed/,
  );
  const pending = initial.list("parent-session")[0];
  assert.equal(pending?.state, "failed");
  assert.equal(pending?.surfaceState, "cleanup-pending");
  assert.equal(pending?.paneId, "w1:p10");
  assert.equal(typeof pending?.deliveredAt, "number");

  const recoveryTransport = new FakeHerdrTransport([
    { id: "cli:pane:close", result: { type: "ok" } },
  ]);
  const recovered = new SubagentOrchestrator({
    transport: recoveryTransport,
    stateDirectory: directory,
    environment,
    monitor: false,
  });
  await recovered.recover("parent-session", "parent-session");

  assert.deepEqual(recoveryTransport.calls, [["pane", "close", "w1:p10"]]);
  assert.equal(recovered.list("parent-session")[0]?.surfaceState, "closed");
});

test("failed surface close stays cleanup-pending and recovery retries it", async () => {
  const directory = temporaryDirectory();
  const childSession = join(directory, "cleanup-retry.jsonl");
  writeFileSync(
    childSession,
    `${JSON.stringify({
      type: "message",
      id: "assistant-cleanup",
      parentId: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "DONE" }],
        stopReason: "stop",
      },
    })}\n`,
  );
  writeCompletionMarker(directory, "parent-session", "child-1");
  const responses = successfulRootSpawnResponses();
  const started = responses[2] as {
    result: { agent: { agent_session: { value: string } } };
  };
  started.result.agent.agent_session.value = childSession;
  responses.push({ id: "cli:pane:close", result: { type: "unused" } });
  const transport = new FakeHerdrTransport(responses);
  transport.responses[4] = { code: 1, stdout: "", stderr: "pane close failed" };
  let resolveDelivered!: () => void;
  const delivered = new Promise<void>((resolve) => {
    resolveDelivered = resolve;
  });
  const environment = {
    HERDR_ENV: "1",
    HERDR_WORKSPACE_ID: "w1",
    HERDR_PANE_ID: "w1:p1",
  };
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: directory,
    environment,
    id: () => "child-1",
    onCompletion: async () => {
      resolveDelivered();
      return true;
    },
  });

  await orchestrator.spawn(spawnRequest());
  await delivered;
  await waitUntil(() => orchestrator.list("parent-session")[0]?.surfaceState === "cleanup-pending");
  const pending = orchestrator.list("parent-session")[0];
  assert.equal(pending?.surfaceState, "cleanup-pending");
  assert.equal(pending?.cleanupError, "pane close failed");

  const recoveryTransport = new FakeHerdrTransport([
    { id: "cli:pane:close", result: { type: "ok" } },
  ]);
  const recovered = new SubagentOrchestrator({
    transport: recoveryTransport,
    stateDirectory: directory,
    environment,
    monitor: false,
  });
  await recovered.recover("parent-session", "parent-session");
  assert.deepEqual(recoveryTransport.calls, [["pane", "close", "w1:p9"]]);
  assert.equal(recovered.list("parent-session")[0]?.surfaceState, "closed");
});

test("follow-up cleans a pending terminal surface and relaunches a fresh generation", async () => {
  const directory = temporaryDirectory();
  const childSession = join(directory, "pending-follow-up.jsonl");
  writeFileSync(
    childSession,
    `${JSON.stringify({
      type: "message",
      id: "assistant-1",
      parentId: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "FIRST_RESULT" }],
        stopReason: "stop",
      },
    })}\n`,
  );
  const spawnResponses = successfulRootSpawnResponses();
  const started = spawnResponses[2] as {
    result: { agent: { agent_session: { value: string } } };
  };
  started.result.agent.agent_session.value = childSession;
  const environment = {
    HERDR_ENV: "1",
    HERDR_WORKSPACE_ID: "w1",
    HERDR_PANE_ID: "w1:p1",
  };
  const initial = new SubagentOrchestrator({
    transport: new FakeHerdrTransport(spawnResponses),
    stateDirectory: directory,
    environment,
    id: () => "child-1",
    monitor: false,
  });
  await initial.spawn(spawnRequest());
  const pending = {
    ...initial.list("parent-session")[0]!,
    state: "completed",
    surfaceState: "cleanup-pending",
    result: "FIRST_RESULT",
    deliveredAt: 1,
  };
  writeFileSync(
    join(directory, "parent-session", "child-1.json"),
    `${JSON.stringify(pending, null, 2)}\n`,
  );

  const transport = new FakeHerdrTransport([
    { id: "cli:pane:close", result: { type: "ok" } },
    { id: "cli:pane:split", result: { pane: { pane_id: "w1:p10", tab_id: "w1:t1" } } },
    { id: "cli:pane:rename", result: { pane: { pane_id: "w1:p10" } } },
    {
      id: "cli:agent:start",
      result: {
        agent: {
          pane_id: "w1:p10",
          agent_status: "idle",
          agent_session: { kind: "path", value: childSession },
        },
      },
    },
    { id: "cli:agent:prompt", result: { agent: { agent_status: "working" } } },
  ]);
  const relaunched = new SubagentOrchestrator({
    transport,
    stateDirectory: directory,
    environment,
    monitor: false,
  });

  const child = await relaunched.message(
    "parent-session",
    "parent-session",
    "authentication",
    "FOLLOW_UP",
  );

  assert.equal(child.generation, 2);
  assert.equal(child.state, "working");
  assert.equal(child.surfaceState, "open");
  assert.equal(child.paneId, "w1:p10");
  assert.deepEqual(
    transport.calls.map((call) => call.slice(0, 2)),
    [
      ["pane", "close"],
      ["pane", "split"],
      ["pane", "rename"],
      ["agent", "start"],
      ["agent", "prompt"],
    ],
  );
  assert.ok(transport.calls[1]?.includes("HERDR_SUBAGENT_GENERATION=2"));
});

test("error completion is delivered as failed and its recorded pane is cleaned", async () => {
  const directory = temporaryDirectory();
  const childSession = join(directory, "error.jsonl");
  writeFileSync(
    childSession,
    `${JSON.stringify({
      type: "message",
      id: "assistant-error",
      parentId: null,
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "provider exploded",
      },
    })}\n`,
  );
  writeCompletionMarker(directory, "parent-session", "child-1", 1, "error");
  const responses = successfulRootSpawnResponses();
  const started = responses[2] as {
    result: { agent: { agent_session: { value: string } } };
  };
  started.result.agent.agent_session.value = childSession;
  responses.push(
    {
      id: "cli:agent:wait",
      result: {
        agent: {
          pane_id: "w1:p9",
          agent_status: "done",
          agent_session: { kind: "path", value: childSession },
        },
      },
    },
    { id: "cli:pane:close", result: { type: "ok" } },
  );
  const transport = new FakeHerdrTransport(responses);
  let resolveDelivered!: (child: { state: string; error?: string }) => void;
  const delivered = new Promise<{ state: string; error?: string }>((resolve) => {
    resolveDelivered = resolve;
  });
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: directory,
    environment: {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    onCompletion: async (child) => {
      resolveDelivered(child);
      return true;
    },
  });

  await orchestrator.spawn(spawnRequest());
  const outcome = await delivered;
  await waitUntil(() => orchestrator.list("parent-session")[0]?.surfaceState === "closed");

  assert.equal(outcome.state, "failed");
  assert.equal(outcome.error, "provider exploded");
  const child = orchestrator.list("parent-session")[0];
  assert.equal(child?.state, "failed");
  assert.equal(child?.result, "");
  assert.equal(child?.error, "provider exploded");
  assert.equal(child?.surfaceState, "closed");
  assert.deepEqual(transport.calls.at(-1), ["pane", "close", "w1:p9"]);
});

test("successful empty final response is preserved exactly", async () => {
  const directory = temporaryDirectory();
  const childSession = join(directory, "empty.jsonl");
  writeFileSync(
    childSession,
    `${JSON.stringify({
      type: "message",
      id: "assistant-empty",
      parentId: null,
      message: {
        role: "assistant",
        content: [],
        stopReason: "stop",
      },
    })}\n`,
  );
  writeCompletionMarker(directory, "parent-session", "child-1");
  const responses = successfulRootSpawnResponses();
  const started = responses[2] as {
    result: { agent: { agent_session: { value: string } } };
  };
  started.result.agent.agent_session.value = childSession;
  responses.push(
    {
      id: "cli:agent:wait",
      result: {
        agent: {
          pane_id: "w1:p9",
          agent_status: "done",
          agent_session: { kind: "path", value: childSession },
        },
      },
    },
    { id: "cli:pane:close", result: { type: "ok" } },
  );
  const transport = new FakeHerdrTransport(responses);
  let resolveDelivered!: (child: { result?: string; error?: string }) => void;
  const delivered = new Promise<{ result?: string; error?: string }>((resolve) => {
    resolveDelivered = resolve;
  });
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: directory,
    environment: {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    onCompletion: async (child) => {
      resolveDelivered(child);
      return true;
    },
  });

  await orchestrator.spawn(spawnRequest());
  const outcome = await delivered;
  await waitUntil(() => orchestrator.list("parent-session")[0]?.surfaceState === "closed");

  assert.equal(outcome.result, "");
  assert.equal(outcome.error, undefined);
  const child = orchestrator.list("parent-session")[0];
  assert.equal(child?.result, "");
  assert.equal(child?.error, undefined);
});

test("agent wait transport failure reconciles the same runtime and continues monitoring", async () => {
  const directory = temporaryDirectory();
  const childSession = join(directory, "wait-reconciled.jsonl");
  writeFileSync(
    childSession,
    `${JSON.stringify({
      type: "message",
      id: "assistant-reconciled",
      parentId: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "RECONCILED_RESULT" }],
        stopReason: "stop",
      },
    })}\n`,
  );
  const responses = successfulRootSpawnResponses();
  const started = responses[2] as {
    result: { agent: { agent_session: { value: string } } };
  };
  started.result.agent.agent_session.value = childSession;
  responses.push(
    { id: "unused-wait", result: { type: "unused" } },
    {
      id: "cli:agent:get",
      result: {
        agent: {
          pane_id: "w1:p9",
          agent_status: "working",
          agent_session: { kind: "path", value: childSession },
        },
      },
    },
    {
      id: "cli:agent:wait",
      result: {
        agent: {
          pane_id: "w1:p9",
          agent_status: "done",
          agent_session: { kind: "path", value: childSession },
        },
      },
    },
    { id: "cli:pane:close", result: { type: "ok" } },
  );
  let waitCount = 0;
  class ReconciledWaitTransport extends FakeHerdrTransport {
    override async run(args: string[], signal?: AbortSignal): Promise<CommandExecution> {
      const response = await super.run(args, signal);
      if (args[0] === "agent" && args[1] === "wait") {
        waitCount += 1;
        if (waitCount === 2) {
          writeCompletionMarker(directory, "parent-session", "child-1");
        }
      }
      return response;
    }
  }
  const transport = new ReconciledWaitTransport(responses);
  transport.responses[4] = { code: 1, stdout: "", stderr: "wait socket reset" };
  let resolveDelivered!: (child: { state: string; result?: string }) => void;
  const delivered = new Promise<{ state: string; result?: string }>((resolve) => {
    resolveDelivered = resolve;
  });
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: directory,
    environment: {
      HERDR_ENV: "1",
      HERDR_SESSION: "session-a",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    onCompletion: async (child) => {
      resolveDelivered(child);
      return true;
    },
  });

  await orchestrator.spawn(spawnRequest());
  const outcome = await delivered;
  await waitUntil(() => orchestrator.list("parent-session")[0]?.surfaceState === "closed");

  assert.equal(outcome.state, "completed");
  assert.equal(outcome.result, "RECONCILED_RESULT");
  assert.deepEqual(
    transport.calls.slice(4, 8).map((call) => call.slice(0, 2)),
    [
      ["agent", "wait"],
      ["agent", "get"],
      ["agent", "wait"],
      ["pane", "close"],
    ],
  );
});

test("ambiguous wait and reconciliation failures mark stale without cleanup", async () => {
  const responses = successfulRootSpawnResponses();
  responses.push(
    { id: "unused-wait", result: { type: "unused" } },
    { id: "unused-get", result: { type: "unused" } },
  );
  const transport = new FakeHerdrTransport(responses);
  transport.responses[4] = { code: 1, stdout: "", stderr: "wait socket reset" };
  transport.responses[5] = { code: 1, stdout: "", stderr: "control socket timed out" };
  let deliveries = 0;
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: temporaryDirectory(),
    environment: {
      HERDR_ENV: "1",
      HERDR_SESSION: "session-a",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    onCompletion: async () => {
      deliveries += 1;
      return true;
    },
  });

  await orchestrator.spawn(spawnRequest());
  await waitUntil(() => orchestrator.list("parent-session")[0]?.state === "stale");

  const child = orchestrator.list("parent-session")[0];
  assert.equal(child?.state, "stale");
  assert.match(child?.error ?? "", /control socket timed out/);
  assert.equal(deliveries, 0);
  assert.equal(
    transport.calls.some((call) => call[1] === "close"),
    false,
  );
  assert.deepEqual(
    transport.calls.slice(4).map((call) => call.slice(0, 2)),
    [
      ["agent", "wait"],
      ["agent", "get"],
    ],
  );
});

test("positively absent child is delivered as crashed and cleaned", async () => {
  const responses = successfulRootSpawnResponses();
  responses.push(
    { id: "unused-wait", result: { type: "unused" } },
    { id: "unused-get", result: { type: "unused" } },
    { id: "cli:pane:close", result: { type: "ok" } },
  );
  const transport = new FakeHerdrTransport(responses);
  transport.responses[4] = { code: 1, stdout: "", stderr: "agent process disappeared" };
  transport.responses[5] = { code: 1, stdout: "", stderr: "agent not found" };
  let resolveDelivered!: (child: { state: string; error?: string }) => void;
  const delivered = new Promise<{ state: string; error?: string }>((resolve) => {
    resolveDelivered = resolve;
  });
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: temporaryDirectory(),
    environment: {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    onCompletion: async (child) => {
      resolveDelivered(child);
      return true;
    },
  });

  await orchestrator.spawn(spawnRequest());
  const outcome = await delivered;
  await waitUntil(() => orchestrator.list("parent-session")[0]?.surfaceState === "closed");

  assert.equal(outcome.state, "crashed");
  assert.equal(outcome.error, "agent process disappeared");
  assert.equal(orchestrator.list("parent-session")[0]?.surfaceState, "closed");
  assert.deepEqual(transport.calls.at(-1), ["pane", "close", "w1:p9"]);
});

test("crash delivery retains the lifecycle lock through parent side effects", async () => {
  const directory = temporaryDirectory();
  const responses = successfulRootSpawnResponses();
  responses.push(
    { id: "unused-wait", result: { type: "unused" } },
    { id: "unused-get", result: { type: "unused" } },
    { id: "cli:pane:close", result: { type: "ok" } },
  );
  const transport = new FakeHerdrTransport(responses);
  transport.responses[4] = { code: 1, stdout: "", stderr: "agent process disappeared" };
  transport.responses[5] = { code: 1, stdout: "", stderr: "agent not found" };
  let beginDelivery!: () => void;
  const deliveryStarted = new Promise<void>((resolve) => {
    beginDelivery = resolve;
  });
  let releaseDelivery!: () => void;
  const deliveryReleased = new Promise<void>((resolve) => {
    releaseDelivery = resolve;
  });
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: directory,
    environment: {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    onCompletion: async () => {
      beginDelivery();
      await deliveryReleased;
      return true;
    },
  });

  await orchestrator.spawn(spawnRequest());
  await deliveryStarted;
  const lifecycleLock = join(directory, "parent-session", ".child-1.lifecycle.lock");
  try {
    await assert.rejects(
      withRegistryLock(
        lifecycleLock,
        () => assert.fail("Crash delivery released the child lifecycle transaction"),
        { timeoutSeconds: 0 },
      ),
      /Timed out acquiring registry lock/,
    );
  } finally {
    releaseDelivery();
  }
  await waitUntil(() => orchestrator.list("parent-session")[0]?.surfaceState === "closed");
  assert.equal(orchestrator.list("parent-session")[0]?.state, "crashed");
});

test("detached delivery callback errors are absorbed and persisted", async () => {
  const directory = temporaryDirectory();
  const childSession = join(directory, "callback-error.jsonl");
  writeFileSync(
    childSession,
    `${JSON.stringify({
      type: "message",
      id: "assistant-callback-error",
      parentId: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "DONE" }],
        stopReason: "stop",
      },
    })}\n`,
  );
  writeCompletionMarker(directory, "parent-session", "child-1");
  const responses = successfulRootSpawnResponses();
  const started = responses[2] as {
    result: { agent: { agent_session: { value: string } } };
  };
  started.result.agent.agent_session.value = childSession;
  responses.push({
    id: "cli:agent:wait",
    result: {
      agent: {
        pane_id: "w1:p9",
        agent_status: "done",
        agent_session: { kind: "path", value: childSession },
      },
    },
  });
  const orchestrator = new SubagentOrchestrator({
    transport: new FakeHerdrTransport(responses),
    stateDirectory: directory,
    environment: {
      HERDR_ENV: "1",
      HERDR_SESSION: "session-a",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    onCompletion: async () => {
      throw new Error("parent callback unavailable");
    },
  });

  await orchestrator.spawn(spawnRequest());
  await waitUntil(() => orchestrator.list("parent-session")[0]?.lifecycleError !== undefined);

  const child = orchestrator.list("parent-session")[0];
  assert.equal(child?.state, "completed");
  assert.equal(child?.deliveredAt, undefined);
  assert.equal(child?.surfaceState, "open");
  assert.match(child?.lifecycleError ?? "", /parent callback unavailable/);
});

test("detached monitor absorbs and persists a transient registry filesystem error", async () => {
  const directory = temporaryDirectory();
  const registry = join(directory, "parent-session");
  const childSession = join(directory, "filesystem-error.jsonl");
  writeFileSync(
    childSession,
    `${JSON.stringify({
      type: "message",
      id: "assistant-filesystem-error",
      parentId: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "DONE" }],
        stopReason: "stop",
      },
    })}\n`,
  );
  const responses = successfulRootSpawnResponses();
  const started = responses[2] as {
    result: { agent: { agent_session: { value: string } } };
  };
  started.result.agent.agent_session.value = childSession;
  responses.push({
    id: "cli:agent:wait",
    result: {
      agent: {
        pane_id: "w1:p9",
        agent_status: "done",
        agent_session: { kind: "path", value: childSession },
      },
    },
  });
  class FilesystemFailureTransport extends FakeHerdrTransport {
    override async run(args: string[]): Promise<CommandExecution> {
      const response = await super.run(args);
      if (args[0] === "agent" && args[1] === "wait") {
        writeCompletionMarker(directory, "parent-session", "child-1");
        chmodSync(registry, 0o500);
        setTimeout(() => chmodSync(registry, 0o700), 30);
      }
      return response;
    }
  }
  const orchestrator = new SubagentOrchestrator({
    transport: new FilesystemFailureTransport(responses),
    stateDirectory: directory,
    environment: {
      HERDR_ENV: "1",
      HERDR_SESSION: "session-a",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
  });

  await orchestrator.spawn(spawnRequest());
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  chmodSync(registry, 0o700);

  assert.match(
    orchestrator.list("parent-session")[0]?.lifecycleError ?? "",
    /Detached monitor failed/,
  );
});

test("detached completion reads the session artifact and delivers exactly once across recovery", async () => {
  const directory = temporaryDirectory();
  const childSession = join(directory, "child.jsonl");
  writeFileSync(
    childSession,
    [
      JSON.stringify({ type: "session", version: 3, id: "child-session", cwd: "/work/project" }),
      JSON.stringify({
        type: "message",
        id: "user-1",
        parentId: null,
        message: { role: "user", content: "Do work" },
      }),
      JSON.stringify({
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "STRUCTURED_RESULT" }],
          stopReason: "stop",
        },
      }),
    ].join("\n") + "\n",
  );

  writeCompletionMarker(directory, "parent-session", "child-1");
  const responses = successfulRootSpawnResponses();
  const started = responses[2] as {
    result: { agent: { agent_session: { value: string } } };
  };
  started.result.agent.agent_session.value = childSession;
  responses.push(
    {
      id: "cli:agent:wait",
      result: {
        agent: {
          name: "authentication-worker-child1",
          pane_id: "w1:p9",
          agent_status: "done",
          agent_session: { kind: "path", value: childSession },
        },
      },
    },
    { id: "cli:tab:close", result: { type: "ok" } },
  );
  const transport = new FakeHerdrTransport(responses);
  let deliveries = 0;
  let resolveDelivered!: () => void;
  const delivered = new Promise<void>((resolve) => {
    resolveDelivered = resolve;
  });
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: directory,
    environment: {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_TAB_ID: "w1:t1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    now: () => 2_000,
    onCompletion: async (child) => {
      deliveries += 1;
      assert.equal(child.result, "STRUCTURED_RESULT");
      resolveDelivered();
      return true;
    },
  });

  await orchestrator.spawn(spawnRequest());
  await delivered;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(deliveries, 1);
  assert.equal(orchestrator.list("parent-session")[0]?.deliveredAt, 2_000);

  const recovered = new SubagentOrchestrator({
    transport: new FakeHerdrTransport([]),
    stateDirectory: directory,
    environment: {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_TAB_ID: "w1:t1",
      HERDR_PANE_ID: "w1:p1",
    },
    onCompletion: async () => {
      deliveries += 1;
      return true;
    },
  });
  await recovered.recover("parent-session", "parent-session");
  assert.equal(deliveries, 1);
});

test("lineage placement lock serializes concurrent surface creation", async () => {
  const stateDirectory = temporaryDirectory();
  const environment = {
    HERDR_ENV: "1",
    HERDR_SESSION: "session-a",
    HERDR_WORKSPACE_ID: "w1",
    HERDR_PANE_ID: "w1:p1",
  };
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstAgentStartStarted = false;
  class DelayedFirstTransport extends FakeHerdrTransport {
    override async run(args: string[], signal?: AbortSignal): Promise<CommandExecution> {
      if (args[0] === "agent" && args[1] === "start" && !firstAgentStartStarted) {
        firstAgentStartStarted = true;
        await firstGate;
      }
      return super.run(args, signal);
    }
  }
  let secondSplitStarted = false;
  class ObservingSecondTransport extends FakeHerdrTransport {
    override async run(args: string[], signal?: AbortSignal): Promise<CommandExecution> {
      if (args[0] === "pane" && args[1] === "split") secondSplitStarted = true;
      return super.run(args, signal);
    }
  }
  const first = new SubagentOrchestrator({
    transport: new DelayedFirstTransport(successfulRootSpawnResponses()),
    stateDirectory,
    environment,
    id: () => "child-1",
    monitor: false,
  });
  const second = new SubagentOrchestrator({
    transport: new ObservingSecondTransport(successfulRootSpawnResponses()),
    stateDirectory,
    environment,
    id: () => "child-2",
    monitor: false,
  });

  const firstSpawn = first.spawn(spawnRequest());
  await waitUntil(() => firstAgentStartStarted);
  const secondSpawn = second.spawn({ ...spawnRequest(), name: "second" });
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  assert.equal(
    secondSplitStarted,
    false,
    "A contender cannot split while the first child is starting",
  );
  releaseFirst();
  await Promise.all([firstSpawn, secondSpawn]);
  assert.equal(secondSplitStarted, true);
});

test("failed scoped layout verification closes only the pane returned by split", async () => {
  const stateDirectory = temporaryDirectory();
  const environment = {
    HERDR_ENV: "1",
    HERDR_SESSION: "session-a",
    HERDR_WORKSPACE_ID: "w1",
    HERDR_PANE_ID: "w1:p1",
  };
  const initial = new SubagentOrchestrator({
    transport: new FakeHerdrTransport(successfulRootSpawnResponses()),
    stateDirectory,
    environment,
    id: () => "child-1",
    monitor: false,
  });
  await initial.spawn({ ...spawnRequest(), workScope: "layout-failure" });

  const transport = new FakeHerdrTransport([
    {
      id: "cli:pane:layout",
      result: {
        layout: {
          tab_id: "w1:t1",
          workspace_id: "w1",
          panes: [
            { pane_id: "w1:p1", rect: { width: 120, height: 60 } },
            { pane_id: "w1:p9", rect: { width: 200, height: 40 } },
          ],
        },
      },
    },
    {
      id: "cli:pane:split",
      result: { pane: { pane_id: "w1:p10", tab_id: "w1:t1" } },
    },
    {
      id: "cli:pane:layout",
      result: {
        layout: {
          tab_id: "w1:t1",
          workspace_id: "w1",
          panes: [
            { pane_id: "w1:p1", rect: { width: 120, height: 60 } },
            { pane_id: "w1:p9", rect: { width: 200, height: 40 } },
          ],
        },
      },
    },
    { id: "cli:pane:close", result: { type: "ok" } },
  ]);
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory,
    environment,
    id: () => "child-2",
    monitor: false,
  });

  await assert.rejects(
    orchestrator.spawn({
      ...spawnRequest(),
      name: "review",
      workScope: "layout-failure",
      agent: { ...spawnRequest().agent, name: "reviewer", spawnTargets: [] },
    }),
    /split pane is not live/,
  );

  const child = orchestrator.list("parent-session").find((candidate) => candidate.id === "child-2");
  assert.equal(child?.paneId, "w1:p10");
  assert.equal(child?.surfaceState, "closed");
  assert.deepEqual(
    transport.calls.filter((call) => call[0] === "pane" && call[1] === "close"),
    [["pane", "close", "w1:p10"]],
  );
});

test("different work scopes share the master tab without scope placement records", async () => {
  const stateDirectory = temporaryDirectory();
  const registry = join(stateDirectory, "parent-session");
  mkdirSync(registry, { recursive: true });
  writeFileSync(join(registry, ".scope-legacy.json"), "not a current placement record\n");
  const environment = {
    HERDR_ENV: "1",
    HERDR_SESSION: "session-a",
    HERDR_WORKSPACE_ID: "w1",
    HERDR_PANE_ID: "w1:p1",
  };
  const secondResponses = [
    {
      id: "cli:pane:layout",
      result: {
        layout: {
          tab_id: "w1:t1",
          workspace_id: "w1",
          panes: [
            { pane_id: "w1:p1", rect: { width: 120, height: 60 } },
            { pane_id: "w1:p9", rect: { width: 200, height: 40 } },
            { pane_id: "w1:p-human", rect: { width: 800, height: 800 } },
          ],
        },
      },
    },
    { id: "cli:pane:split", result: { pane: { pane_id: "w1:p10", tab_id: "w1:t1" } } },
    { id: "cli:pane:rename", result: { pane: { pane_id: "w1:p10" } } },
    {
      id: "cli:agent:start",
      result: {
        agent: {
          name: "second-worker-child2",
          pane_id: "w1:p10",
          agent_status: "idle",
          agent_session: { kind: "path", value: "/tmp/second.jsonl" },
        },
      },
    },
    {
      id: "cli:agent:prompt",
      result: {
        agent: { name: "second-worker-child2", pane_id: "w1:p10", agent_status: "working" },
      },
    },
  ];
  const first = new SubagentOrchestrator({
    transport: new FakeHerdrTransport(successfulRootSpawnResponses()),
    stateDirectory,
    environment,
    id: () => "child-1",
    monitor: false,
  });
  await first.spawn({ ...spawnRequest(), workScope: "first-scope" });

  const secondTransport = new FakeHerdrTransport(secondResponses);
  const second = new SubagentOrchestrator({
    transport: secondTransport,
    stateDirectory,
    environment,
    id: () => "child-2",
    monitor: false,
  });
  const child = await second.spawn({
    ...spawnRequest(),
    name: "second",
    workScope: "second-scope",
  });

  assert.equal(child.tabId, "w1:t1");
  assert.deepEqual(
    secondTransport.calls.find((call) => call[0] === "pane" && call[1] === "split")?.slice(0, 4),
    ["pane", "split", "--pane", "w1:p9"],
  );
  assert.equal(
    secondTransport.calls.some((call) => call[0] === "tab"),
    false,
  );
  assert.equal(readdirSync(registry).filter((entry) => entry.startsWith(".scope-")).length, 1);
  const master = JSON.parse(readFileSync(join(registry, ".lineage.json"), "utf8")) as {
    rootId: string;
    workspaceId: string;
    masterPaneId: string;
    tabId: string;
    herdrSession: string;
  };
  assert.deepEqual(
    {
      rootId: master.rootId,
      workspaceId: master.workspaceId,
      masterPaneId: master.masterPaneId,
      tabId: master.tabId,
      herdrSession: master.herdrSession,
    },
    {
      rootId: "parent-session",
      workspaceId: "w1",
      masterPaneId: "w1:p1",
      tabId: "w1:t1",
      herdrSession: "session-a",
    },
  );
});

test("a human pane is never selected as a lineage placement target", async () => {
  const stateDirectory = temporaryDirectory();
  const environment = {
    HERDR_ENV: "1",
    HERDR_SESSION: "session-a",
    HERDR_WORKSPACE_ID: "w1",
    HERDR_PANE_ID: "w1:p1",
  };
  const responses = [
    {
      id: "cli:pane:layout",
      result: {
        layout: {
          tab_id: "w1:t1",
          workspace_id: "w1",
          panes: [
            { pane_id: "w1:p1", rect: { width: 120, height: 60 } },
            { pane_id: "w1:p9", rect: { width: 100, height: 40 } },
            { pane_id: "w1:p-human", rect: { width: 1000, height: 1000 } },
          ],
        },
      },
    },
    { id: "cli:pane:split", result: { pane: { pane_id: "w1:p10", tab_id: "w1:t1" } } },
    { id: "cli:pane:rename", result: { pane: { pane_id: "w1:p10" } } },
    {
      id: "cli:agent:start",
      result: {
        agent: {
          name: "second-worker-child2",
          pane_id: "w1:p10",
          agent_status: "idle",
          agent_session: { kind: "path", value: "/tmp/second.jsonl" },
        },
      },
    },
    { id: "cli:agent:prompt", result: { agent: { agent_status: "working" } } },
  ];
  const first = new SubagentOrchestrator({
    transport: new FakeHerdrTransport(successfulRootSpawnResponses()),
    stateDirectory,
    environment,
    id: () => "child-1",
    monitor: false,
  });
  await first.spawn(spawnRequest());
  const transport = new FakeHerdrTransport(responses);
  const second = new SubagentOrchestrator({
    transport,
    stateDirectory,
    environment,
    id: () => "child-2",
    monitor: false,
  });
  await second.spawn({ ...spawnRequest(), name: "second" });
  assert.equal(
    transport.calls.find((call) => call[0] === "pane" && call[1] === "split")?.[3],
    "w1:p1",
  );
});

test("persisted master tab identity changes fail closed", async () => {
  const stateDirectory = temporaryDirectory();
  const environment = {
    HERDR_ENV: "1",
    HERDR_SESSION: "session-a",
    HERDR_WORKSPACE_ID: "w1",
    HERDR_PANE_ID: "w1:p1",
  };
  const first = new SubagentOrchestrator({
    transport: new FakeHerdrTransport(successfulRootSpawnResponses()),
    stateDirectory,
    environment,
    id: () => "child-1",
    monitor: false,
  });
  await first.spawn(spawnRequest());
  const transport = new FakeHerdrTransport([
    {
      id: "cli:pane:current",
      result: {
        pane: {
          pane_id: "w1:p1",
          tab_id: "w1:t9",
          workspace_id: "w1",
          agent: "pi",
          agent_session: { kind: "path", value: "/tmp/parent.jsonl" },
        },
      },
    },
  ]);
  const second = new SubagentOrchestrator({
    transport,
    stateDirectory,
    environment,
    id: () => "child-2",
    monitor: false,
  });
  await assert.rejects(
    () => second.spawn({ ...spawnRequest(), name: "second" }),
    /Lineage master identity changed/,
  );
  assert.deepEqual(transport.calls, [["pane", "current", "--current"]]);
});

test("root spawn rejects a non-Pi master occupant before allocation", async () => {
  const stateDirectory = temporaryDirectory();
  const transport = new FakeHerdrTransport([
    {
      id: "cli:pane:current",
      result: {
        pane: {
          pane_id: "w1:p1",
          tab_id: "w1:t1",
          workspace_id: "w1",
          agent: "claude",
          agent_session: { kind: "path", value: "/tmp/parent.jsonl" },
        },
      },
    },
  ]);
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory,
    environment: {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    monitor: false,
  });

  await assert.rejects(
    () => orchestrator.spawn(spawnRequest()),
    /Lineage master pane is not occupied by Pi/,
  );
  assert.deepEqual(transport.calls, [["pane", "current", "--current"]]);
});

test("descendant master observations fail closed without a proven Pi session", async () => {
  const observations = [
    {
      name: "missing session metadata",
      pane: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent: "pi" },
      error: /Lineage master session artifact changed/,
    },
    {
      name: "changed session path",
      pane: {
        pane_id: "w1:p1",
        tab_id: "w1:t1",
        workspace_id: "w1",
        agent: "pi",
        agent_session: { kind: "path", value: "/tmp/foreign.jsonl" },
      },
      error: /Lineage master session artifact changed/,
    },
    {
      name: "foreign occupant",
      pane: {
        pane_id: "w1:p1",
        tab_id: "w1:t1",
        workspace_id: "w1",
        agent: "claude",
        agent_session: { kind: "path", value: "/tmp/parent.jsonl" },
      },
      error: /Lineage master pane is not occupied by Pi/,
    },
  ];

  for (const observation of observations) {
    const stateDirectory = temporaryDirectory();
    writeLineageIdentity(stateDirectory, "root-1");
    const transport = new FakeHerdrTransport([
      { id: "cli:pane:get", result: { pane: observation.pane } },
    ]);
    const orchestrator = new SubagentOrchestrator({
      transport,
      stateDirectory,
      environment: {
        HERDR_ENV: "1",
        HERDR_WORKSPACE_ID: "w1",
        HERDR_PANE_ID: "w1:p2",
        HERDR_SUBAGENT_DEPTH: "1",
        HERDR_SUBAGENT_ROOT_ID: "root-1",
        HERDR_SUBAGENT_AGENT_ID: "worker-1",
        HERDR_SUBAGENT_MASTER_ROOT_ID: "root-1",
        HERDR_SUBAGENT_MASTER_HERDR_SESSION: "default",
        HERDR_SUBAGENT_MASTER_WORKSPACE_ID: "w1",
        HERDR_SUBAGENT_MASTER_PANE_ID: "w1:p1",
        HERDR_SUBAGENT_MASTER_TAB_ID: "w1:t1",
        HERDR_SUBAGENT_MASTER_SESSION_PATH: "/tmp/parent.jsonl",
        HERDR_SUBAGENT_ROLE: "worker",
        HERDR_SUBAGENT_SPAWN_TARGETS: "scout",
      },
      id: () => `descendant-${observation.name}`,
      monitor: false,
    });

    await assert.rejects(
      () =>
        orchestrator.spawn({
          ...spawnRequest(),
          name: observation.name,
          agent: { ...spawnRequest().agent, name: "scout", spawnTargets: [] },
        }),
      observation.error,
    );
    assert.deepEqual(transport.calls, [["pane", "get", "w1:p1"]]);
  }
});

test("a split in another tab is persisted but never cleaned as owned", async () => {
  const stateDirectory = temporaryDirectory();
  const transport = new FakeHerdrTransport([
    {
      id: "cli:pane:split",
      result: { pane: { pane_id: "w1:p10", tab_id: "w1:t9" } },
    },
    {
      id: "cli:pane:get",
      result: { pane: { pane_id: "w1:p10", tab_id: "w1:t9", workspace_id: "w1" } },
    },
  ]);
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory,
    environment: {
      HERDR_ENV: "1",
      HERDR_SESSION: "session-a",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: () => "child-1",
    monitor: false,
  });
  await assert.rejects(() => orchestrator.spawn(spawnRequest()), /different tab/);
  const child = orchestrator.list("parent-session")[0];
  assert.equal(child?.state, "failed");
  assert.equal(child?.surfaceState, "released");
  assert.equal(
    transport.calls.some((call) => call[0] === "pane" && call[1] === "close"),
    false,
  );
});

test("stale cancellation preserves a proven prior completion after an interrupted follow-up", async () => {
  const directory = temporaryDirectory();
  const childSession = join(directory, "scope-tests.jsonl");
  writeFileSync(
    childSession,
    `${JSON.stringify({
      type: "message",
      id: "c6c47482",
      parentId: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "PRESERVED_SCOUT_FINDINGS" }],
        stopReason: "stop",
      },
    })}\n`,
  );
  const spawnResponses = successfulRootSpawnResponses();
  const started = spawnResponses[2] as {
    result: { agent: { agent_session: { value: string } } };
  };
  started.result.agent.agent_session.value = childSession;
  spawnResponses.push({
    id: "cli:agent:prompt",
    result: { agent: { agent_status: "working" } },
  });
  const environment = {
    HERDR_ENV: "1",
    HERDR_SESSION: "session-a",
    HERDR_WORKSPACE_ID: "w1",
    HERDR_PANE_ID: "w1:p1",
  };
  const initial = new SubagentOrchestrator({
    transport: new FakeHerdrTransport(spawnResponses),
    stateDirectory: directory,
    environment,
    id: () => "child-1",
    monitor: false,
  });
  const active = await initial.spawn({ ...spawnRequest(), workScope: "scope-tests" });
  writeCompletionSettlement(active.completionMarkerPath, {
    version: 1,
    childId: active.id,
    generation: active.generation,
    phase: "running",
    sessionPath: childSession,
    frontierEntryId: "c6c47482",
  });
  await initial.message(
    "parent-session",
    "parent-session",
    "authentication",
    "INTERRUPTED_FOLLOW_UP",
  );
  writeCompletionMarker(directory, "parent-session", "child-1");

  const recoveryTransport = new FakeHerdrTransport([
    { id: "unused-get", result: { type: "unused" } },
  ]);
  recoveryTransport.responses[0] = {
    code: 1,
    stdout: "",
    stderr: "agent not found",
  };
  const recovered = new SubagentOrchestrator({
    transport: recoveryTransport,
    stateDirectory: directory,
    environment,
    monitor: false,
    onCompletion: async () => true,
  });
  await recovered.recover("parent-session", "parent-session");
  assert.equal(recovered.list("parent-session")[0]?.state, "stale");

  recoveryTransport.responses.push({
    code: 0,
    stdout: `${JSON.stringify({ id: "cli:pane:close", result: { type: "ok" } })}\n`,
    stderr: "",
  });
  const reconciled = await recovered.cancel("parent-session", "parent-session", "authentication");

  assert.equal(reconciled.state, "completed");
  assert.equal(reconciled.result, "PRESERVED_SCOUT_FINDINGS");
  assert.equal(typeof reconciled.deliveredAt, "number");
  assert.equal(reconciled.surfaceState, "closed");
  assert.deepEqual(recoveryTransport.calls, [
    ["agent", "get", "authentication-worker-child1"],
    ["pane", "close", "w1:p9"],
  ]);
});

test("different named scopes create separate panes in the master tab", async () => {
  const responses = [
    ...successfulRootSpawnResponses(),
    ...successfulRootSpawnResponses().map((response, index) => {
      if (index === 0) {
        return {
          id: "cli:pane:split",
          result: { pane: { pane_id: "w1:p10", tab_id: "w1:t1" } },
        };
      }
      if (index === 1) return { id: "cli:pane:rename", result: { pane: { pane_id: "w1:p10" } } };
      if (index === 2) {
        return {
          id: "cli:agent:start",
          result: {
            agent: {
              name: "authentication-worker-child2",
              pane_id: "w1:p10",
              agent_status: "idle",
              agent_session: { kind: "path", value: "/tmp/child2.jsonl" },
            },
          },
        };
      }
      return {
        id: "cli:agent:prompt",
        result: {
          agent: {
            name: "authentication-worker-child2",
            pane_id: "w1:p10",
            agent_status: "working",
          },
        },
      };
    }),
  ];
  const transport = new FakeHerdrTransport(responses);
  const orchestrator = new SubagentOrchestrator({
    transport,
    stateDirectory: temporaryDirectory(),
    environment: {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
    },
    id: (() => {
      let next = 0;
      return () => `child-${++next}`;
    })(),
    monitor: false,
  });

  const first = await orchestrator.spawn({ ...spawnRequest(), workScope: "one" });
  const second = await orchestrator.spawn({ ...spawnRequest(), name: "other", workScope: "two" });

  assert.equal(first.tabId, "w1:t1");
  assert.equal(second.tabId, "w1:t1");
  assert.equal(
    transport.calls.filter((call) => call[0] === "tab" && call[1] === "create").length,
    0,
  );
});
