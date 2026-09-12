import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, test } from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-coding-agent") {
      return { url: "agents-test:pi-coding-agent", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "agents-test:pi-coding-agent") {
      return {
        format: "module",
        source:
          'export const CONFIG_DIR_NAME = ".pi"; export const getAgentDir = () => "/tmp"; export const parseFrontmatter = () => ({ frontmatter: {}, body: "" });',
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const { materializeSystemPrompt } = await import("./agents.ts");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("system prompt materialization publishes one private complete file", () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "herdr-agent-prompt-test-"));
  temporaryDirectories.push(stateDirectory);
  const path = materializeSystemPrompt(stateDirectory, {
    name: "worker",
    description: "Worker",
    systemPrompt: "Complete prompt",
    skills: [],
    spawnTargets: [],
    source: "project",
    filePath: "/project/.pi/agents/worker.md",
  });

  if (!path) assert.fail("expected a materialized prompt path");
  assert.equal(readFileSync(path, "utf8"), "Complete prompt\n");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(stateDirectory, "prompts")), [basename(path)]);
});
