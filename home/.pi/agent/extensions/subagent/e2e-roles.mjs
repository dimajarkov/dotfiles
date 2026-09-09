#!/usr/bin/env node
// Bounded RPC startup/handler smoke for the installed bundled roles. No prompt or model inference.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "subagent-roles-e2e-"));
console.log(`Evidence: ${directory}`);
const contracts = {
  scout: { model: "openai-codex/gpt-6-astra", tools: ["read", "grep", "find", "ls"] },
  researcher: { model: "openai-codex/gpt-6-astra", tools: ["read", "web_search", "web_fetch", "source_check", "fetch_content", "get_search_content"] },
  planner: { model: "openai-codex/gpt-6-astra", tools: ["read", "bash"] },
  worker: { model: "openai-codex/gpt-5.6-luna", tools: ["read", "write", "edit", "bash", "web_search", "web_fetch", "subagent"] },
  reviewer: { model: "openai-codex/gpt-5.6-sol", tools: ["read", "bash"] },
};
for (const [name, contract] of Object.entries(contracts)) {
  const output = join(directory, `${name}.json`);
  // No Herdr caller identity may reach this smoke process or any of its extensions.
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HERDR_")));
  Object.assign(environment, { ROLE_SMOKE_NAME: name, ROLE_SMOKE_CONTRACT: JSON.stringify(contract), ROLE_SMOKE_OUTPUT: output });
  const transcript = [];
  const child = spawn("pi", ["--mode", "rpc", "--no-session", "--extension", join(here, "test-fixtures", "role-smoke.ts"),
    "--model", contract.model, "--thinking", "xhigh", "--tools", contract.tools.join(",")], { env: environment, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.on("data", (data) => transcript.push(data.toString()));
  child.stderr.on("data", (data) => transcript.push(data.toString()));
  let timedOut = false;
  // RPC processes wait for client input after startup. EOF requests orderly disposal.
  const ready = setInterval(() => { if (existsSync(output)) child.stdin.end(); }, 25);
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 20_000);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => { clearTimeout(timer); clearInterval(ready); });
  writeFileSync(join(directory, `${name}.log`), transcript.join(""));
  assert.ok(!timedOut, `${name} startup timed out`);
  assert.equal(code, 0, `${name} Pi exit`);
  const result = JSON.parse(readFileSync(output, "utf8"));
  assert.ok(result.ok, `${name}: ${result.error}`);
  console.log(`PASS ${name}: ${result.model}, xhigh, exact active tools and launch permissions`);
}
