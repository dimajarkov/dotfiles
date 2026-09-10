// Test-only UI fixture. Uses the real extension with an in-memory registry, never Herdr.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerSubagents from "../index.ts";
import { SubagentOrchestrator, type ChildRecord } from "../orchestrator.ts";

export default function widgetDemo(pi: ExtensionAPI) {
  if (process.env.HERDR_ENV || !process.env.SUBAGENT_WIDGET_E2E) {
    throw new Error("Widget fixture requires an isolated test process");
  }
  let scenario = "active";
  let parentId = "";
  const originalList = SubagentOrchestrator.prototype.list;
  const originalRecover = SubagentOrchestrator.prototype.recover;
  SubagentOrchestrator.prototype.recover = async () => {};
  SubagentOrchestrator.prototype.list = () => {
    if (scenario === "empty") return [];
    const children: ChildRecord[] = Array.from(
      { length: scenario === "many" ? 8 : 2 },
      (_, index) => ({
        id: `fixture-${index}`,
        rootId: parentId,
        parentId,
        parentSessionId: parentId,
        semanticName: index === 0 ? "widget-reference" : `layout-review-${index}`,
        role: index === 0 ? "researcher" : "reviewer",
        state: index === 1 || index === 7 ? "blocked" : "working",
        task: "Inspect the subagent widget",
        herdrName: `fixture-${index}`,
        cwd: "/test",
        depth: 1,
        generation: 1,
        workspaceId: "test",
        herdrSession: "test",
        completionMarkerPath: "unused",
        workScope: "subagent-widget",
        model: "openai-codex/gpt-6-astra",
        thinking: "xhigh",
        tabId: "test:t1",
        paneId: `test:p${index}`,
        createdAt: 0,
        updatedAt: 0,
        launchLoadout: {
          version: 1,
          role: "researcher",
          tools: [],
          skills: [],
          spawnTargets: [],
          cwd: "/test",
          environment: {},
        },
      }),
    );
    children.push({
      ...children[0],
      id: "other-parent",
      parentId: "another-parent",
      semanticName: "NOT-OUR-CHILD",
    });
    children.push({
      ...children[0],
      id: "finished",
      state: "completed",
      semanticName: "FINISHED-CHILD",
    });
    return children;
  };
  pi.on("session_start", (_event, ctx) => {
    parentId = ctx.sessionManager.getSessionId();
    ctx.ui.setEditorText("Type your next message");
  });
  registerSubagents(
    new Proxy(pi, {
      get(target, key, receiver) {
        if (key === "exec")
          return () => {
            throw new Error("Widget fixture must never invoke Herdr");
          };
        return Reflect.get(target, key, receiver);
      },
    }),
  );
  pi.registerCommand("widget-demo", {
    description: "Test-only widget state",
    handler: async (args) => {
      scenario = args.trim();
    },
  });
  pi.on("session_shutdown", () => {
    SubagentOrchestrator.prototype.list = originalList;
    SubagentOrchestrator.prototype.recover = originalRecover;
  });
}
