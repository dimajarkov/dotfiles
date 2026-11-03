// Resource-only Pi reload contract. Never starts a model, session hooks or a mux.
// Run with PI_TEST_PACKAGES=<installed Pi packages directory>; see the install doc.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const settingsPath = join(root, "home/.pi/agent/settings.json");
const settings = JSON.parse(readFileSync(settingsPath));
const priorPin = "116f5a611a879e99c65ddd61d527823e277c4d47";
const candidatePin = "9237ccff593181698f3b80dfb3562b1ff1bb3cad";
const guidancePath = "home/.pi/agent/skills/subagents/SKILL.md";
const baselineRevision =
  process.env.PI_HERDR_BASE_REVISION ?? "9ad19b70d44e68760c0632ce74d3df9b7aa85a0b";
const priorGuidance = execFileSync(
  "git",
  ["-C", root, "show", `${baselineRevision}:${guidancePath}`],
  { encoding: "utf8" },
);
const candidateGuidance = readFileSync(join(root, guidancePath), "utf8");
const packageSource = (entry) => (typeof entry === "string" ? entry : entry.source);
const fork = settings.packages.find((entry) =>
  packageSource(entry).startsWith("git:github.com/dimajarkov/pi-interactive-subagents@"),
);
assert.ok(fork, "declarative candidate must install the immutable interactive fork");
assert.equal(
  packageSource(fork),
  `git:github.com/dimajarkov/pi-interactive-subagents@${candidatePin}`,
);
const dependencies = settings.packages.find((entry) =>
  packageSource(entry).startsWith("git:github.com/HazAT/pi-config@"),
);
assert.ok(dependencies, "planning resources must be declared alongside the interactive fork");
assert.equal(
  packageSource(dependencies),
  "git:github.com/HazAT/pi-config@34829ad8053667e16b1288f9c1d24d8a300ec077",
);
assert.deepEqual(dependencies.extensions, ["extensions/todos/index.ts"]);
assert.deepEqual(dependencies.skills, ["skills/write-todos", "skills/commit"]);
assert.deepEqual(dependencies.prompts, []);
assert.deepEqual(dependencies.themes, []);
assert.equal(settings.defaultProvider, "openai-codex");
assert.equal(settings.defaultModel, "gpt-6.1-sol");
assert.equal(settings.defaultThinkingLevel, "medium");
assert.ok(settings.extensions.includes("-extensions/subagents/index.ts"));
assert.ok(settings.extensions.includes("-extensions/ask-user/index.ts"));
assert.ok(settings.extensions.includes("-builtin:mcp"));
assert.ok(!settings.skills.includes("-skills/subagents/SKILL.md"));

const packages = process.env.PI_TEST_PACKAGES;
assert.ok(packages, "PI_TEST_PACKAGES must point at the existing declared Pi runtime");
const runtimeVersion = JSON.parse(
  readFileSync(join(packages, "coding-agent/package.json")),
).version;
assert.equal(
  runtimeVersion,
  "1.4.0",
  "installation proof must use installed Pi 1.4, not the unit SDK",
);
const sdk = await import(pathToFileURL(join(packages, "coding-agent/dist/index.js")));
const { KeybindingsManager } = await import(
  pathToFileURL(join(packages, "coding-agent/dist/core/keybindings.js"))
);
const installed = resolve(
  process.env.PI_HERDR_INSTALLED_DIR ?? join(process.env.HOME, ".pi/agent"),
);
const baselineSettings = JSON.parse(readFileSync(join(installed, "settings.json")));
const baselineFork = baselineSettings.packages.find((entry) =>
  packageSource(entry).includes("pi-interactive-subagents"),
);
assert.equal(
  packageSource(baselineFork),
  `git:github.com/dimajarkov/pi-interactive-subagents@${priorPin}`,
);
assert.deepEqual(
  baselineSettings,
  JSON.parse(
    execFileSync("git", ["-C", root, "show", `${baselineRevision}:home/.pi/agent/settings.json`], {
      encoding: "utf8",
    }),
  ),
  "installed baseline must match the recorded prior selection",
);
const unrelated = (config) =>
  Object.fromEntries(Object.entries(config).filter(([key]) => key !== "packages"));
assert.deepEqual(
  unrelated(settings),
  unrelated(baselineSettings),
  "installation must preserve every unrelated setting",
);
assert.deepEqual(
  settings.packages.filter((entry) => entry !== fork && entry !== dependencies),
  baselineSettings.packages.filter(
    (entry) => entry !== baselineFork && packageSource(entry) !== packageSource(dependencies),
  ),
  "unrelated package declarations must remain unchanged",
);
assert.ok(
  process.env.PI_HERDR_FORK_SOURCE && process.env.PI_HERDR_DEPENDENCY_SOURCE,
  "supply verified fork and dependency checkout sources",
);
const sourceWorktrees = execFileSync(
  "git",
  ["-C", process.env.PI_HERDR_FORK_SOURCE, "worktree", "list", "--porcelain"],
  { encoding: "utf8" },
)
  .split("\n")
  .filter((line) => line.startsWith("worktree "))
  .map((line) => line.slice(9));
const worktreeIdentities = [...sourceWorktrees, root].map((path) => [
  path,
  existsSync(path) ? statSync(path).ino : null,
]);
const privateRoot = mkdtempSync(join(tmpdir(), "pi-herdr-install-"));
console.log(`Private resource-reload directory: ${privateRoot}`);
const agentDir = join(privateRoot, "agent");
const project = join(privateRoot, "project");
mkdirSync(agentDir, { mode: 0o700 });
mkdirSync(project, { mode: 0o700 });
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
// Identity/metadata only: never read credential values or expose them to the fixture.
const authIdentity = () => {
  const info = statSync(join(installed, "auth.json"));
  return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs];
};
const originalAuth = authIdentity();
const liveGuidance = join(installed, "skills/subagents/SKILL.md");
const originalGuidance = hash(liveGuidance);
const originalSettings = hash(join(installed, "settings.json"));
const originalHistory = readdirSync(join(installed, "sessions"), { recursive: true })
  .filter((path) => path.endsWith(".jsonl"))
  .map((path) => join(installed, "sessions", path));
const historyBefore = originalHistory.map((path) => [path, hash(path)]);
// Clone the installed cache rather than sharing a writable package-manager prefix.
execFileSync("/bin/cp", ["-cR", join(installed, "npm"), join(agentDir, "npm")]);
execFileSync("/bin/cp", ["-cR", join(installed, "git"), join(agentDir, "git")]);
cpSync(join(installed, "extensions"), join(agentDir, "extensions"), {
  recursive: true,
  verbatimSymlinks: true,
});
cpSync(join(installed, "skills"), join(agentDir, "skills"), {
  recursive: true,
  verbatimSymlinks: true,
});
cpSync(join(installed, "themes"), join(agentDir, "themes"), {
  recursive: true,
  verbatimSymlinks: true,
});
cpSync(join(installed, "agents"), join(agentDir, "agents"), {
  recursive: true,
  verbatimSymlinks: true,
});
cpSync(join(root, "home/.pi/agent/keybindings.json"), join(agentDir, "keybindings.json"));
writeFileSync(join(agentDir, "auth.json"), "{}", { mode: 0o600 });
mkdirSync(join(agentDir, "sessions"));
writeFileSync(
  join(agentDir, "sessions/preserved.jsonl"),
  '{"type":"session","id":"preserved-native-history"}\n',
);
writeFileSync(join(project, "preserved.txt"), "unchanged project content\n");
const preserved = [join(agentDir, "sessions/preserved.jsonl"), join(project, "preserved.txt")].map(
  (path) => [path, hash(path)],
);
const originalEnv = { ...process.env };
const originalCwd = process.cwd();
for (const name of Object.keys(process.env)) {
  if (name.startsWith("PI_SUBAGENT_") || name === "PI_DENY_TOOLS") delete process.env[name];
}
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
// Make command prompt generation resource-only, even when the caller is in a mux.
process.env.PI_SUBAGENT_MUX = "tmux";
delete process.env.TMUX;
delete process.env.PI_CODEX_VISUAL_HOST;
process.chdir(project);

function summarize(loader) {
  const loaded = loader.getExtensions();
  const runner = new sdk.ExtensionRunner(loaded.extensions, loaded.runtime, project, {}, {});
  const commands = runner.getRegisteredCommands();
  const shortcuts = runner.getShortcuts(KeybindingsManager.create(agentDir).getEffectiveConfig());
  return {
    loaded,
    runner,
    commands,
    shortcuts,
    inventory: {
      extensions: loaded.extensions.map((extension) => extension.sourceInfo),
      tools: runner
        .getAllRegisteredTools()
        .map((tool) => ({ name: tool.definition.name, source: tool.sourceInfo })),
      commands: commands.map((command) => ({
        name: command.invocationName,
        source: command.sourceInfo,
      })),
      shortcuts: [...shortcuts].map(([key, shortcut]) => ({ key, source: shortcut.extensionPath })),
      diagnostics: [
        ...(loaded.errors ?? []),
        ...(loaded.warnings ?? []),
        ...runner.getCommandDiagnostics(),
        ...runner.getShortcutDiagnostics(),
        ...loader.getSkills().diagnostics,
      ],
      skills: loader
        .getSkills()
        .skills.map((skill) => ({ name: skill.name, path: skill.filePath })),
    },
  };
}
async function reload(next) {
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(next, null, 2));
  const loader = new sdk.DefaultResourceLoader({ cwd: project, agentDir, noContextFiles: true });
  await loader.reload();
  return { loader, ...summarize(loader) };
}
try {
  const skillFile = join(agentDir, "skills/subagents/SKILL.md");
  rmSync(dirname(skillFile), { recursive: true, force: true });
  mkdirSync(dirname(skillFile));
  writeFileSync(skillFile, priorGuidance);
  const baseline = await reload(baselineSettings);
  const baselineExtension = baseline.loaded.extensions.find((extension) =>
    extension.tools.has("subagents_list"),
  );
  const baselineRoles = (await baselineExtension.tools.get("subagents_list").definition.execute())
    .details.agents;
  writeFileSync(join(privateRoot, "baseline.json"), JSON.stringify(baseline.inventory, null, 2), {
    mode: 0o600,
  });
  assert.equal(
    baseline.loaded.errors.length,
    0,
    "installed extensions must load without errors before comparison",
  );
  // Seed exact immutable Git checkouts into the isolated manager cache.
  // This exercises normal package-source/filter resolution without modifying live caches.
  for (const [entry, source] of [
    [fork, process.env.PI_HERDR_FORK_SOURCE],
    [dependencies, process.env.PI_HERDR_DEPENDENCY_SOURCE],
  ]) {
    assert.ok(source, "supply verified local immutable checkout sources for an offline reload");
    const parts = packageSource(entry).slice(4).split("@");
    const sha = parts.pop();
    assert.equal(
      execFileSync("git", ["-C", source, "rev-parse", sha], { encoding: "utf8" }).trim(),
      sha,
    );
    const destination = join(agentDir, "git", parts.join("@"));
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(dirname(destination), { recursive: true });
    execFileSync("git", ["clone", "--shared", "--no-checkout", source, destination], {
      stdio: "pipe",
    });
    execFileSync("git", ["-C", destination, "checkout", "--detach", sha], { stdio: "pipe" });
    assert.equal(
      execFileSync("git", ["-C", destination, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      sha,
    );
  }
  let networkInstall = false;
  if (process.env.PI_HERDR_NETWORK_INSTALL === "1") {
    const networkDir = join(privateRoot, "network-agent");
    mkdirSync(networkDir, { mode: 0o700 });
    const cli = join(packages, "coding-agent/dist/cli.js");
    for (const entry of [fork, dependencies]) {
      execFileSync(process.execPath, [cli, "install", packageSource(entry)], {
        env: { ...process.env, PI_CODING_AGENT_DIR: networkDir },
        stdio: "pipe",
        timeout: 180000,
      });
      const [repository, sha] = packageSource(entry).slice(4).split("@");
      const fetched = join(networkDir, "git", repository);
      assert.equal(
        execFileSync("git", ["-C", fetched, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        sha,
      );
      const destination = join(agentDir, "git", repository);
      rmSync(destination, { recursive: true, force: true });
      cpSync(fetched, destination, { recursive: true });
    }
    assert.ok(!existsSync(join(networkDir, "auth.json")), "install must not create credentials");
    assert.ok(!existsSync(join(networkDir, "sessions")), "install must not create native sessions");
    networkInstall = true;
  }
  // The private skill file models the existing Home Manager mapping without touching its live target.
  writeFileSync(skillFile, candidateGuidance);
  assert.notEqual(candidateGuidance, priorGuidance, "pin and guidance must move together");
  for (const contract of [
    /Alt\+J/,
    /branch column/,
    /outstanding/,
    /spawning: false/,
    /subagent-policy/,
    /medium/,
  ])
    assert.match(candidateGuidance, contract);
  const candidate = await reload(settings);
  writeFileSync(join(privateRoot, "candidate.json"), JSON.stringify(candidate.inventory, null, 2), {
    mode: 0o600,
  });
  assert.equal(candidate.loaded.errors.length, 0, "candidate extensions must load without errors");
  const childLoader = new sdk.DefaultResourceLoader({
    cwd: project,
    agentDir,
    noContextFiles: true,
    additionalExtensionPaths: [
      join(
        agentDir,
        "git/github.com/dimajarkov/pi-interactive-subagents/pi-extension/subagents/subagent-done.ts",
      ),
    ],
  });
  await childLoader.reload();
  const child = summarize(childLoader);
  assert.equal(
    child.loaded.errors.length,
    0,
    "child completion extension must load alongside installed resources",
  );
  assert.ok(child.shortcuts.has("ctrl+alt+j"), "child must retain its tools-widget shortcut");
  const herdrKeys = readFileSync(join(root, "home/.config/herdr/config.toml"), "utf8")
    .split("[keys]")[1]
    .split("[ui]")[0];
  const directNavigation = new Set(
    [...herdrKeys.matchAll(/"([^"\n]+)"/g)]
      .map((match) => match[1])
      .filter((key) => key.startsWith("alt+")),
  );
  for (const key of child.shortcuts.keys())
    assert.ok(!directNavigation.has(key), `child shortcut intercepts configured Herdr ${key}`);
  assert.ok(
    child.commands.some((command) => command.invocationName === "subagent-tools"),
    "child has a command toggle independent of terminal modifier encoding",
  );
  writeFileSync(join(privateRoot, "child.json"), JSON.stringify(child.inventory, null, 2), {
    mode: 0o600,
  });
  const registrations = candidate.loaded.extensions.flatMap((extension) => [
    ...extension.tools.keys(),
  ]);
  assert.equal(
    new Set(registrations).size,
    registrations.length,
    "duplicate tools must not be hidden by first-registration wins",
  );
  assert.deepEqual(
    candidate.runner.getCommandDiagnostics(),
    baseline.runner.getCommandDiagnostics(),
    "candidate must not add command conflicts",
  );
  assert.deepEqual(
    candidate.runner.getShortcutDiagnostics(),
    baseline.runner.getShortcutDiagnostics(),
    "candidate must not add parent shortcut conflicts",
  );
  const newChildDiagnostics = child.runner.getShortcutDiagnostics();
  assert.equal(newChildDiagnostics.length, 0, "Ctrl+Alt+J must not collide with native new-line");
  const toolNames = candidate.inventory.tools.map((tool) => tool.name);
  for (const name of [
    "subagent",
    "subagent_interrupt",
    "subagents_list",
    "subagent_resume",
    "todo",
  ])
    assert.ok(toolNames.includes(name), `missing registered ${name}`);
  for (const name of [
    "subagent_spawn",
    "subagent_wait",
    "subagent_cancel",
    "subagent_check",
    "subagent_list",
  ])
    assert.ok(!toolNames.includes(name), `legacy tool still registered: ${name}`);
  for (const name of ["plan", "iterate", "subagent"])
    assert.ok(candidate.commands.some((command) => command.invocationName === name));
  for (const name of ["subagents", "write-todos", "commit", "browser-routing"])
    assert.equal(
      candidate.inventory.skills.filter((skill) => skill.name === name).length,
      1,
      `${name} must resolve exactly once`,
    );
  assert.equal(
    candidate.inventory.skills.find((skill) => skill.name === "subagents").path,
    skillFile,
    "loader must select the private matching guidance",
  );
  const extension = candidate.loaded.extensions.find((extension) =>
    extension.tools.has("subagent"),
  );
  const roles = (await extension.tools.get("subagents_list").definition.execute()).details.agents;
  for (const name of ["planner", "scout", "worker", "reviewer", "visual-tester"]) {
    const role = roles.find((role) => role.name === name);
    assert.equal(role.model, `openai-codex/${name === "planner" ? "gpt-6-astra" : "gpt-6.1-sol"}`);
    assert.equal(role.thinking, "medium");
    assert.notEqual(role.spawning, false);
    assert.notEqual(role.cli, "claude");
  }
  // Public extension registration must respect inherited explicit delegation denials.
  process.env.PI_DENY_TOOLS = "subagent,subagent_interrupt,subagents_list,subagent_resume,claude";
  const denied = await reload(settings);
  for (const name of [
    "subagent",
    "subagent_interrupt",
    "subagents_list",
    "subagent_resume",
    "claude",
  ]) {
    assert.ok(
      !denied.inventory.tools.some((tool) => tool.name === name),
      `explicit denial must suppress ${name}`,
    );
  }
  delete process.env.PI_DENY_TOOLS;
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(agentDir, "models-store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const effectiveRoles = {};
  const delegationTools = ["subagent", "subagent_interrupt", "subagents_list", "subagent_resume"];
  const expectedTools = {
    scout: ["read", "bash", ...delegationTools],
    reviewer: ["read", "bash", ...delegationTools],
    worker: ["read", "bash", "write", "edit", "todo", ...delegationTools],
    "visual-tester": ["read", "write", "codex_computer_use", ...delegationTools],
  };
  for (const [name, expected] of Object.entries(expectedTools)) {
    const role = roles.find((role) => role.name === name);
    assert.notEqual(role.spawning, false);
    if (["scout", "worker"].includes(name)) assert.equal(role.denyTools, "claude");
    const declared = role.tools.split(",").map((tool) => tool.trim());
    assert.deepEqual(
      declared,
      expected,
      `${name} effective definition differs from its intended tools`,
    );
    const model = modelRuntime.getModel("openai-codex", "gpt-6.1-sol");
    assert.ok(
      model,
      "existing Pi runtime must know the requested Sol model; this does not prove execution",
    );
    const roleLoader = new sdk.DefaultResourceLoader({
      cwd: project,
      agentDir,
      noContextFiles: true,
      additionalExtensionPaths: [
        join(
          agentDir,
          "git/github.com/dimajarkov/pi-interactive-subagents/pi-extension/subagents/subagent-done.ts",
        ),
      ],
    });
    await roleLoader.reload();
    const { session } = await sdk.createAgentSession({
      cwd: project,
      agentDir,
      modelRuntime,
      model,
      thinkingLevel: "medium",
      resourceLoader: roleLoader,
      sessionManager: sdk.SessionManager.inMemory(project),
      settingsManager: sdk.SettingsManager.inMemory(settings),
      tools: [...declared, "caller_ping", "subagent_done"],
    });
    const active = session.getActiveToolNames().sort();
    const expectedActive = [
      ...expected.filter((tool) => tool !== "codex_computer_use"),
      "caller_ping",
      "subagent_done",
    ].sort();
    assert.deepEqual(
      active,
      expectedActive,
      `${name} SDK allowlist must exclude unrelated installed tools`,
    );
    effectiveRoles[name] = {
      activeTools: active,
      model: `${session.model.provider}/${session.model.id}`,
      thinking: session.thinkingLevel,
      missingVisualHostCapability: name === "visual-tester",
    };
    session.dispose();
  }
  const { session: parent } = await sdk.createAgentSession({
    cwd: project,
    agentDir,
    modelRuntime,
    resourceLoader: candidate.loader,
    model: modelRuntime.getModel(settings.defaultProvider, settings.defaultModel),
    thinkingLevel: settings.defaultThinkingLevel,
    sessionManager: sdk.SessionManager.inMemory(project),
    settingsManager: sdk.SettingsManager.inMemory(settings),
  });
  assert.equal(parent.model.provider, "openai-codex");
  assert.equal(parent.model.id, "gpt-6.1-sol");
  assert.equal(parent.thinkingLevel, "medium");
  const prompts = [];
  candidate.loaded.runtime.sendUserMessage = (text) => prompts.push(text);
  const context = {
    ui: {
      notify(message) {
        throw new Error(message);
      },
    },
  };
  for (const [command, args] of [
    ["iterate", "Synthetic focused change"],
    ["subagent", "scout Synthetic read-only survey"],
    ["plan", "Synthetic feature plan"],
  ])
    await extension.commands.get(command).handler(args, context);
  assert.match(prompts[0], /fork: true/);
  assert.match(prompts[1], /agent: "scout"/);
  assert.match(prompts[2], /<skill name="plan"/);
  parent.dispose();
  const baselineTools = new Set(baseline.inventory.tools.map((tool) => tool.name));
  for (const name of baselineTools)
    assert.ok(toolNames.includes(name), `unrelated tool lost: ${name}`);
  // Pi resource reload does not change an already-present Git cache's revision.
  // Reinstall the prior source through the public CLI, fetching only from the verified local source.
  const privateFork = join(agentDir, "git/github.com/dimajarkov/pi-interactive-subagents");
  execFileSync(
    "git",
    ["-C", privateFork, "remote", "set-url", "origin", process.env.PI_HERDR_FORK_SOURCE],
    { stdio: "pipe" },
  );
  execFileSync(
    process.execPath,
    [join(packages, "coding-agent/dist/cli.js"), "install", packageSource(baselineFork)],
    { env: process.env, stdio: "pipe", timeout: 60000 },
  );
  writeFileSync(skillFile, priorGuidance);
  const rollback = await reload(baselineSettings);
  assert.equal(
    readFileSync(skillFile, "utf8"),
    priorGuidance,
    "rollback must restore matching prior guidance",
  );
  assert.deepEqual(
    JSON.parse(readFileSync(join(agentDir, "settings.json"))),
    baselineSettings,
    "rollback must restore the entire prior selection",
  );
  assert.equal(
    execFileSync(
      "git",
      [
        "-C",
        join(agentDir, "git/github.com/dimajarkov/pi-interactive-subagents"),
        "rev-parse",
        "HEAD",
      ],
      { encoding: "utf8" },
    ).trim(),
    priorPin,
    "rollback must restore the prior cache checkout",
  );
  const rollbackExtension = rollback.loaded.extensions.find((extension) =>
    extension.tools.has("subagents_list"),
  );
  assert.deepEqual(
    (await rollbackExtension.tools.get("subagents_list").definition.execute()).details.agents,
    baselineRoles,
    "rollback must load original bundled definitions, not just restore settings text",
  );
  assert.deepEqual(
    rollback.inventory,
    baseline.inventory,
    "rollback must restore every registered resource and diagnostic",
  );
  assert.deepEqual(
    rollback.inventory.commands,
    baseline.inventory.commands,
    "rollback must restore exact registered commands",
  );
  assert.deepEqual(
    rollback.inventory.shortcuts,
    baseline.inventory.shortcuts,
    "rollback must restore exact registered shortcuts",
  );
  for (const [path, before] of [...preserved, ...historyBefore])
    assert.equal(hash(path), before, `preserved content changed: ${path}`);
  for (const [path, inode] of worktreeIdentities)
    assert.equal(
      existsSync(path) ? statSync(path).ino : null,
      inode,
      `worktree root changed: ${path}`,
    );
  assert.deepEqual(authIdentity(), originalAuth);
  assert.equal(hash(join(installed, "settings.json")), originalSettings);
  assert.equal(
    hash(liveGuidance),
    originalGuidance,
    "live out-of-store guidance must remain unchanged",
  );
  assert.deepEqual(
    readdirSync(join(installed, "sessions"), { recursive: true })
      .filter((path) => path.endsWith(".jsonl"))
      .map((path) => join(installed, "sessions", path)),
    originalHistory,
    "fixture must not create active native histories",
  );
  assert.equal(
    execFileSync("git", ["-C", privateFork, "rev-parse", candidatePin], {
      encoding: "utf8",
    }).trim(),
    candidatePin,
    "rollback must retain candidate Git objects",
  );
  const report = {
    priorPin,
    candidatePin,
    baselineRevision,
    networkInstall,
    runtimePackages: packages,
    runtimeVersion,
    explicitDenialsRespected: true,
    matchingGuidanceRestored: true,
    liveGuidancePreserved: true,
    candidateCacheRetained: true,
    baseline: baseline.inventory,
    candidate: candidate.inventory,
    child: child.inventory,
    rollback: rollback.inventory,
    roles,
    effectiveRoles,
    commandPrompts: prompts,
    parentDefaultsPreserved: true,
    nativeHistoryPreserved: true,
    credentialIdentityAndMetadataPreserved: true,
    credentialValuesRead: false,
    activeSettingsPreserved: true,
    projectFilePreserved: true,
    worktreeRootsPreserved: true,
    modelRequests: 0,
    sessionHooksExecuted: false,
  };
  writeFileSync(join(privateRoot, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(
    `Resource reload and rollback passed. Private report: ${join(privateRoot, "report.json")}`,
  );
} finally {
  process.chdir(originalCwd);
  process.env = originalEnv;
}
