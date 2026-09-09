// Test-only startup probe. The model and Herdr process boundaries are never invoked.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "../agents.ts";
import registerSubagents from "../index.ts";
import { SubagentOrchestrator, type SpawnRequest } from "../orchestrator.ts";

export default function roleSmoke(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const name = process.env.ROLE_SMOKE_NAME!;
    const output = process.env.ROLE_SMOKE_OUTPUT!;
    const contract: { model: string; tools: string[] } = JSON.parse(process.env.ROLE_SMOKE_CONTRACT!);
    try {
      assert.ok(!process.env.HERDR_ENV, "Smoke must not operate a live Herdr session");
      const role = discoverAgents(ctx.cwd, "user").agents.find((agent) => agent.name === name);
      assert.ok(role, `Missing bundled role: ${name}`);
      const targets = name === "worker" ? ["scout", "researcher"] : [];
      assert.equal(role.model, contract.model);
      assert.equal(role.thinking, "xhigh");
      assert.deepEqual(role.spawnTargets, targets);
      assert.deepEqual(pi.getActiveTools().slice().sort(), contract.tools.slice().sort());
      assert.equal(`${ctx.model?.provider}/${ctx.model?.id}`, contract.model);
      assert.equal(ctx.thinkingLevel, "xhigh");
      let tool: ToolDefinition | undefined;
      let request: SpawnRequest | undefined;
      const originalSpawn = SubagentOrchestrator.prototype.spawn;
      SubagentOrchestrator.prototype.spawn = async function (input) {
        request = input;
        return {
          id: "smoke", rootId: "smoke", parentId: "smoke", parentSessionId: "smoke",
          semanticName: input.name, herdrName: "smoke", role: name, task: input.task, cwd: input.cwd,
          depth: 1, generation: 1, workspaceId: "smoke", herdrSession: "smoke", completionMarkerPath: "unused",
          state: "working", tabId: "smoke:tab", paneId: "smoke:pane", workScope: input.workScope,
          model: input.agent.model, thinking: input.agent.thinking,
          createdAt: 0, updatedAt: 0,
          launchLoadout: { version: 1, role: name, tools: input.agent.tools, skills: [], spawnTargets: targets, cwd: input.cwd, environment: {} },
        };
      };
      try {
        // Preserve the real API's shape while capturing registration and forbidding external transport.
        registerSubagents(new Proxy(pi, {
          get(target, key, receiver) {
            if (key === "on" || key === "registerCommand" || key === "registerMessageRenderer") return () => {};
            if (key === "registerTool") return (value: ToolDefinition) => { tool = value; };
            if (key === "exec") return () => { throw new Error("Smoke must not operate Herdr surfaces"); };
            return Reflect.get(target, key, receiver);
          },
        }));
        assert.ok(tool);
        const result = await tool.execute("role-smoke", { action: "spawn", agent: name, name: `smoke-${name}`, workScope: "role-smoke", task: "Role resolution only" }, undefined, undefined, ctx);
        const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("");
        assert.ok(text.includes("scope=role-smoke"));
        assert.ok(text.includes(`model=${contract.model}`));
        assert.ok(text.includes("thinking=xhigh"));
        assert.ok(request);
        assert.equal(request.agent.model, contract.model);
        assert.equal(request.agent.thinking, "xhigh");
        assert.deepEqual(request.agent.tools.slice().sort(), contract.tools.slice().sort());
        assert.deepEqual(request.agent.spawnTargets, targets);
      } finally {
        SubagentOrchestrator.prototype.spawn = originalSpawn;
      }
      writeFileSync(output, JSON.stringify({ ok: true, name, model: role.model, thinking: ctx.thinkingLevel, tools: pi.getActiveTools(), spawnTargets: targets }));
    } catch (error) {
      writeFileSync(output, JSON.stringify({ ok: false, name, error: String(error), tools: pi.getActiveTools() }));
    }
    ctx.shutdown();
  });
}
