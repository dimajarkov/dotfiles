// Compare installed-resource registration with and without the Nix rules package.
// No session hooks, model calls, credentials, package installs, or live settings writes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const installed = join(process.env.HOME, ".pi/agent");
const sdkPath = process.env.PI_TEST_PACKAGES;
const packageDir = process.env.PI_RULES_PACKAGE_DIR;
assert.ok(sdkPath && packageDir, "set PI_TEST_PACKAGES and PI_RULES_PACKAGE_DIR");
const sdk = await import(pathToFileURL(join(sdkPath, "coding-agent/dist/index.js")));
const settings = JSON.parse(readFileSync(join(root, "home/.pi/agent/settings.json")));
const source = "~/.pi/agent/packages/pi-claude-rules";
assert.equal(settings.packages.filter((entry) => entry === source).length, 1);
assert.ok(
  !settings.packages.some((entry) =>
    JSON.stringify(entry).includes("npm:@jordyvanvorselen/pi-claude-rules"),
  ),
);
const baselineSettings = {
  ...settings,
  packages: settings.packages.filter((entry) => entry !== source),
};
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const preserved = ["settings.json", "auth.json", "npm/package.json", "npm/package-lock.json"]
  .map((path) => join(installed, path))
  .filter(existsSync)
  .map((path) => [path, hash(path)]);
const temp = mkdtempSync(join(tmpdir(), "pi-rules-resources-"));
const agentDir = join(temp, "home/.pi/agent");
const cwd = join(temp, "project");
const previousCwd = process.cwd();
const previousEnv = Object.fromEntries(
  ["HOME", "PI_CODING_AGENT_DIR", "PI_OFFLINE"].map((key) => [key, process.env[key]]),
);
try {
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  mkdirSync(cwd);
  // APFS clones keep the large existing caches private without reinstalling them.
  for (const name of ["npm", "git", "extensions", "skills", "themes", "agents"]) {
    const path = join(installed, name);
    if (existsSync(path)) execFileSync("/bin/cp", ["-cR", path, join(agentDir, name)]);
  }
  mkdirSync(join(agentDir, "packages"));
  symlinkSync(resolve(packageDir), join(agentDir, "packages/pi-claude-rules"));
  writeFileSync(
    join(agentDir, "claude-rules.json"),
    readFileSync(join(root, "home/.pi/agent/claude-rules.json")),
  );
  const sharedSkills = join(previousEnv.HOME, ".agents/skills");
  if (existsSync(sharedSkills)) {
    mkdirSync(join(temp, "home/.agents"));
    symlinkSync(sharedSkills, join(temp, "home/.agents/skills"));
  }
  process.env.HOME = join(temp, "home");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  process.chdir(cwd);
  async function registrations(config) {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(config));
    const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, noContextFiles: true });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, [], "all installed extensions must load without errors");
    const runner = new sdk.ExtensionRunner(loaded.extensions, loaded.runtime, cwd, {}, {});
    return {
      paths: loaded.extensions.map((extension) => extension.path),
      commands: runner
        .getRegisteredCommands()
        .map((command) => command.invocationName)
        .sort(),
      tools: runner
        .getAllRegisteredTools()
        .map((tool) => tool.definition.name)
        .sort(),
      diagnostics: runner.getCommandDiagnostics(),
    };
  }
  const baseline = await registrations(baselineSettings);
  const candidate = await registrations(settings);
  assert.equal(
    candidate.paths.length,
    baseline.paths.length + 1,
    "load the rules extension exactly once",
  );
  for (const path of baseline.paths)
    assert.ok(candidate.paths.includes(path), `unrelated extension lost: ${path}`);
  assert.deepEqual(candidate.tools, baseline.tools, "preserve every installed tool");
  assert.deepEqual(
    candidate.commands.filter((name) => !["claude-rules", "claude-rules-reload"].includes(name)),
    baseline.commands,
  );
  for (const name of ["claude-rules", "claude-rules-reload"])
    assert.equal(candidate.commands.filter((value) => value === name).length, 1);
  assert.deepEqual(
    candidate.diagnostics,
    baseline.diagnostics,
    "do not introduce command conflicts",
  );
  const rollback = await registrations(baselineSettings);
  assert.deepEqual(rollback, baseline, "removing the declaration restores baseline registrations");
  for (const [path, before] of preserved)
    assert.equal(hash(path), before, `live file changed: ${path}`);
  console.log(
    `PASS: ${baseline.paths.length} existing extensions preserved; rules loaded once; two commands added; rollback exact`,
  );
  console.log(
    "PASS: live settings, credentials and npm manifests unchanged; no session hooks or model requests",
  );
} finally {
  process.chdir(previousCwd);
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(temp, { recursive: true, force: true });
}
