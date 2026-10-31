// Verify the declared Git installation with the real Pi loader and runner, without a model call.
// PI_TEST_PACKAGES must point to the installed Pi packages directory.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const settings = JSON.parse(await readFile(join(root, "home/.pi/agent/settings.json"), "utf8"));
const sources = settings.packages.map(entry => typeof entry === "string" ? entry : entry.source);
const source = sources.find(entry => entry.startsWith("git:github.com/dimajarkov/pi-packages@"));
assert.ok(source, "install inline-skills from the owned fork");
assert.match(source, /@[0-9a-f]{40}$/);
assert.ok(!sources.some(entry => entry.startsWith("npm:@tunglam/pi-inline-skills")), "do not load both copies");
assert.ok(process.env.PI_TEST_PACKAGES, "set PI_TEST_PACKAGES to the installed Pi packages directory");
const sdk = await import(pathToFileURL(join(process.env.PI_TEST_PACKAGES, "coding-agent/dist/index.js")));
const installed = join(process.env.HOME, ".pi/agent/git/github.com/dimajarkov/pi-packages");
assert.equal(execFileSync("git", ["-C", installed, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), source.split("@").at(-1));
assert.match(execFileSync("git", ["-C", installed, "remote", "get-url", "origin"], { encoding: "utf8" }).trim(), /^https:\/\/github\.com\/dimajarkov\/pi-packages(?:\.git)?$/);
const temp = await mkdtemp(join(tmpdir(), "pi-inline-skills-install-"));
const priorOffline = process.env.PI_OFFLINE;
process.env.PI_OFFLINE = "1";
try {
  const agentDir = join(temp, "agent");
  const cwd = join(temp, "project");
  const gitParent = join(agentDir, "git/github.com/dimajarkov");
  await mkdir(gitParent, { recursive: true });
  await mkdir(cwd);
  await symlink(installed, join(gitParent, "pi-packages"));
  const loader = new sdk.DefaultResourceLoader({
    cwd, agentDir,
    settingsManager: sdk.SettingsManager.inMemory({ packages: [source] }),
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1, "the fork must expose only inline-skills");
  assert.ok(loaded.extensions[0].path.endsWith("/packages/pi-inline-skills/src/index.ts"));
  assert.ok(!loader.getSkills().skills.some(skill => skill.filePath.includes("/pi-packages/")), "do not load unrelated skills from the fork");
  const skillPath = join(temp, "SKILL.md");
  await writeFile(skillPath, "---\nname: regression\ndescription: Fixture\n---\n\n# Regression Skill\n\nFixture instructions.\n");
  loaded.runtime.getCommands = () => [{ name: "skill:regression", source: "skill", sourceInfo: { path: skillPath } }];
  const runner = new sdk.ExtensionRunner(loaded.extensions, loaded.runtime, cwd, { getEntries: () => [], getLeafId: () => null }, {});
  const errors = [];
  runner.onError(error => errors.push(error));
  const custom = await runner.emitBeforeAgentStart({ messageType: "custom", message: { role: "custom", customType: "regression", content: "Use $regression", display: false } }, { cwd });
  assert.equal(custom.messages.length, 0);
  const user = await runner.emitBeforeAgentStart({ messageType: "user", prompt: "Use $regression" }, { cwd });
  assert.equal(user.messages.length, 1);
  assert.match(user.messages[0].content, /# Regression Skill/);
  assert.deepEqual(errors, []);
  console.log("PASS: owned commit discovered once; custom messages skipped; user skill injection preserved");
} finally {
  if (priorOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = priorOffline;
  await rm(temp, { recursive: true, force: true });
}
