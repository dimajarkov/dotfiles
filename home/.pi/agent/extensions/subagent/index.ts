import { resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  getMarkdownTheme,
  keyText,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { withHerdrBlocked } from "../lib/herdr-blocked.ts";
import { sanitizeMetadata } from "../lib/terminal-safety.ts";
import {
  discoverAgents,
  materializeSystemPrompt,
  resolveAgentSkills,
  type AgentScope,
} from "./agents.ts";
import {
  COMPLETION_TYPE,
  CompletionDelivery,
} from "./completion-delivery.ts";
import { renderCompletionMessage } from "./completion-renderer.ts";
import { summarizeChild } from "./child-summary.ts";
import { buildSubagentTree, renderSubagentWidgetLayout, type TreeRow } from "./widget.ts";
import { SubagentInspector } from "./inspector.ts";
import {
  SubagentOrchestrator,
  type ChildRecord,
  type CommandExecution,
  type HerdrTransport,
} from "./orchestrator.ts";
import { renderSubagentToolCall, renderSubagentToolResult } from "./tool-renderer.ts";

const STATE_DIRECTORY = resolve(getAgentDir(), "herdr-subagents");
const WIDGET_KEY = "herdr-subagents";

class PiExecHerdrTransport implements HerdrTransport {
  readonly #pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.#pi = pi;
  }

  async run(args: string[], signal?: AbortSignal): Promise<CommandExecution> {
    const isLongWait = args[0] === "agent" && args[1] === "wait";
    const result = await this.#pi.exec("herdr", args, {
      signal,
      timeout: isLongWait ? 86_410_000 : 70_000,
    });
    return {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
}

const ActionSchema = StringEnum(
  ["spawn", "list", "inspect", "message", "cancel", "resume"] as const,
  { description: "Subagent operation" },
);

const ScopeSchema = StringEnum(["user", "project", "both"] as const, {
  description: "Agent definition scope for spawn. Defaults to user.",
});

const Parameters = Type.Object({
  action: ActionSchema,
  agent: Type.Optional(Type.String({ description: "Agent role for spawn" })),
  name: Type.Optional(
    Type.String({ description: "Stable semantic child name for spawn or target name for controls" }),
  ),
  task: Type.Optional(Type.String({ description: "Task for spawn" })),
  workScope: Type.Optional(
    Type.String({ description: "Shared workstream slug. Required for root spawns; inherited by descendants." }),
  ),
  cwd: Type.Optional(Type.String({ description: "Explicit child working directory" })),
  message: Type.Optional(Type.String({ description: "Steering or follow-up message" })),
  agentScope: Type.Optional(ScopeSchema),
});

type ToolParameters = {
  action: "spawn" | "list" | "inspect" | "message" | "cancel" | "resume";
  agent?: string;
  name?: string;
  task?: string;
  workScope?: string;
  cwd?: string;
  message?: string;
  agentScope?: AgentScope;
};

function rootId(ctx: ExtensionContext): string {
  return process.env.HERDR_SUBAGENT_ROOT_ID ?? ctx.sessionManager.getSessionId();
}

function currentParentId(ctx: ExtensionContext): string {
  return process.env.HERDR_SUBAGENT_AGENT_ID ?? ctx.sessionManager.getSessionId();
}

function textResult(text: string, details?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

export default function herdrSubagents(pi: ExtensionAPI) {
  let currentContext: ExtensionContext | undefined;
  let widgetTimer: ReturnType<typeof setInterval> | undefined;
  let deliveryController = new AbortController();
  let completionDelivery: CompletionDelivery | undefined;
  const inspector = new SubagentInspector();

  const orchestrator = new SubagentOrchestrator({
    transport: new PiExecHerdrTransport(pi),
    stateDirectory: STATE_DIRECTORY,
    onCompletion: async (child) => {
      const ctx = currentContext;
      if (!ctx || !completionDelivery) return false;
      const sameSession = child.parentSessionFile
        ? ctx.sessionManager.getSessionFile() === child.parentSessionFile
        : ctx.sessionManager.getSessionId() === child.parentSessionId;
      if (!sameSession) return false;
      return completionDelivery.deliver(child);
    },
  });

  function treeRows(ctx: ExtensionContext): TreeRow[] {
    return buildSubagentTree(orchestrator.list(rootId(ctx)), currentParentId(ctx));
  }

  function updateWidget(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    let rows: TreeRow[];
    try {
      rows = treeRows(ctx);
    } catch {
      rows = [];
    }
    if (rows.length === 0) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    ctx.ui.setWidget(
      WIDGET_KEY,
      (_tui, theme) => {
        let layout: ReturnType<typeof renderSubagentWidgetLayout> | undefined;
        return {
          render: (width) => {
            layout = renderSubagentWidgetLayout(rows, width, theme);
            return layout.lines;
          },
          handleMouse: (event) => {
            if (event.type !== "click" || event.button !== "left" || !layout) return undefined;
            const target = layout.targets.find((target) => target.y === event.y);
            if (target) {
              const output =
                target.outputStart !== undefined &&
                event.x >= target.outputStart &&
                event.x < target.outputStart + "[output]".length;
              void inspector
                .show(ctx, rows, output ? "output" : "prompt", "", target.row)
                .catch((error) => ctx.ui.notify(sanitizeMetadata(String(error)), "error"));
              return { handled: true };
            }
            if (event.y > (layout.targets.at(-1)?.y ?? -1)) {
              void inspector
                .show(ctx, rows)
                .catch((error) => ctx.ui.notify(sanitizeMetadata(String(error)), "error"));
              return { handled: true };
            }
            return undefined;
          },
          invalidate() {},
        };
      },
      { placement: "aboveEditor" },
    );
  }

  pi.on("session_start", async (_event, ctx) => {
    inspector.dispose();
    deliveryController.abort();
    deliveryController = new AbortController();
    orchestrator.restart();
    currentContext = ctx;
    completionDelivery = new CompletionDelivery({
      getBranch: () => ctx.sessionManager.getBranch(),
      appendEntry: (customType, data) => pi.appendEntry(customType, data),
      sendMessage: (message) => pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: true }),
      signal: deliveryController.signal,
    });
    completionDelivery.replay();
    await orchestrator.recover(rootId(ctx), currentParentId(ctx));
    updateWidget(ctx);
    if (widgetTimer) clearInterval(widgetTimer);
    if (ctx.mode === "tui") {
      widgetTimer = setInterval(() => updateWidget(ctx), 1_000);
      widgetTimer.unref?.();
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    // Aborting/clearing Pi's volatile queue must not lose a saved completion.
    if (!ctx.hasPendingMessages()) completionDelivery?.replay();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    inspector.dispose();
    deliveryController.abort();
    completionDelivery = undefined;
    await orchestrator.shutdown();
    if (widgetTimer) clearInterval(widgetTimer);
    widgetTimer = undefined;
    currentContext = undefined;
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  });

  pi.registerMessageRenderer(COMPLETION_TYPE, (message, options, theme) =>
    renderCompletionMessage(
      message,
      options,
      theme,
      getMarkdownTheme(),
      keyText("app.tools.expand"),
    ),
  );

  pi.registerCommand("subagents", {
    description: "Inspect subagent tree and full delegation prompts (optional name)",
    handler: async (args, ctx) => inspector.show(ctx, treeRows(ctx), "prompt", args),
  });

  pi.registerCommand("subagent-output", {
    description: "Read a subagent's saved final response (optional name)",
    handler: async (args, ctx) => inspector.show(ctx, treeRows(ctx), "output", args),
  });

  pi.registerCommand("subagent-focus", {
    description: "Focus a persistent Herdr subagent by semantic name",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /subagent-focus <name>", "warning");
        return;
      }
      await orchestrator.resume(rootId(ctx), currentParentId(ctx), args.trim());
    },
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Spawn and control persistent interactive Pi subagents in Herdr. Related agents in one conversation share the master Pi agent's current Herdr tab, each in its own pane. Root spawns use a workScope, and descendants inherit it. Spawning is asynchronous. Actions: spawn, list, inspect, message, cancel, resume.",
    promptSnippet:
      "Spawn or control persistent interactive Herdr Pi subagents by stable semantic name",
    promptGuidelines: [
      "Use subagent spawn for delegated work that benefits from an isolated persistent Pi session.",
      "Give every subagent spawn a short stable semantic name.",
      "Pass one shared workScope slug on every related root spawn; descendants inherit it.",
      "Use subagent inspect, message, cancel, or resume with the semantic name returned by spawn.",
    ],
    parameters: Parameters,

    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = rawParams as ToolParameters;
      const lineage = rootId(ctx);
      if (params.action === "list") {
        const children = orchestrator
          .list(lineage)
          .filter((child) => child.parentId === currentParentId(ctx));
        return textResult(
          children.length > 0 ? children.map(summarizeChild).join("\n") : "No subagents",
          { children },
        );
      }

      if (!params.name?.trim()) throw new Error(`${params.action} requires name`);
      const name = params.name.trim();

      if (params.action === "inspect") {
        const child = await orchestrator.inspect(lineage, currentParentId(ctx), name, signal);
        return textResult(summarizeChild(child), { child });
      }
      if (params.action === "message") {
        if (!params.message) throw new Error("message requires message text");
        const child = await orchestrator.message(lineage, currentParentId(ctx), name, params.message, signal);
        updateWidget(ctx);
        return textResult(`Message sent to ${sanitizeMetadata(child.semanticName)}`, { child });
      }
      if (params.action === "cancel") {
        const child = await orchestrator.cancel(lineage, currentParentId(ctx), name, signal);
        updateWidget(ctx);
        return textResult(
          child.state === "cancelled"
            ? `Cancelled ${sanitizeMetadata(child.semanticName)}`
            : `Already ${sanitizeMetadata(child.state)}: ${sanitizeMetadata(child.semanticName)}`,
          { child },
        );
      }
      if (params.action === "resume") {
        const child = await orchestrator.resume(lineage, currentParentId(ctx), name, signal);
        return textResult(
          `Focused ${sanitizeMetadata(child.semanticName)} in ${sanitizeMetadata(child.paneId)}`,
          { child },
        );
      }

      if (!params.agent || !params.task) {
        throw new Error("spawn requires agent, name, and task");
      }
      const callerDepth = Number.parseInt(process.env.HERDR_SUBAGENT_DEPTH ?? "0", 10);
      if (callerDepth === 0 && !params.workScope) {
        throw new Error("Root subagent spawn requires workScope");
      }
      const scope = params.agentScope ?? "user";
      if (scope !== "user" && !ctx.isProjectTrusted()) {
        throw new Error("Project subagents require a trusted project");
      }
      const discovery = discoverAgents(ctx.cwd, scope);
      const agent = discovery.agents.find((candidate) => candidate.name === params.agent);
      if (!agent) {
        throw new Error(
          `Unknown agent role ${sanitizeMetadata(params.agent)}. Available: ${discovery.agents.map((candidate) => sanitizeMetadata(candidate.name)).join(", ") || "none"}`,
        );
      }
      if (agent.source === "project") {
        if (!ctx.hasUI) {
          throw new Error("Project subagent approval requires interactive UI");
        }
        const approved = await withHerdrBlocked(
          (event) => pi.events.emit("herdr:blocked", event),
          `Approval: project agent ${sanitizeMetadata(agent.name)}`,
          () => ctx.ui.confirm(
            "Run project-local agent?",
            `Agent: ${sanitizeMetadata(agent.name)}\nSource: ${sanitizeMetadata(agent.filePath)}`,
          ),
        );
        if (!approved) return textResult("Cancelled: project-local agent not approved");
      }

      const allowedWorkerTargets = new Set(["scout", "researcher", "planner", "reviewer"]);
      const spawnTargets = agent.name === "worker"
        ? agent.spawnTargets.filter((target) => allowedWorkerTargets.has(target))
        : [];
      const tools = agent.tools ? [...agent.tools] : [...pi.getActiveTools()];
      const withoutSubagent = tools.filter((tool) => tool !== "subagent");
      const strictTools = spawnTargets.length > 0
        ? [...new Set([...withoutSubagent, "subagent"])]
        : withoutSubagent;
      const child = await orchestrator.spawn({
        name,
        task: params.task,
        cwd: resolve(ctx.cwd, params.cwd ?? ctx.cwd),
        parentSessionId: ctx.sessionManager.getSessionId(),
        parentSessionFile: ctx.sessionManager.getSessionFile(),
        workScope: params.workScope,
        agent: {
          name: agent.name,
          description: agent.description,
          tools: strictTools,
          model: agent.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
          thinking: agent.thinking ?? ctx.thinkingLevel,
          systemPromptPath: materializeSystemPrompt(STATE_DIRECTORY, agent),
          skillPaths: resolveAgentSkills(ctx.cwd, agent.skills),
          spawnTargets,
        },
      }, signal);
      updateWidget(ctx);
      return textResult(
        `Spawned asynchronously: ${summarizeChild(child)} as ${sanitizeMetadata(child.herdrName)}`,
        { child },
      );
    },

    renderCall(args, theme) {
      return renderSubagentToolCall(args, theme);
    },

    renderResult(result, _options, theme) {
      return renderSubagentToolResult(result, theme);
    },
  });
}
