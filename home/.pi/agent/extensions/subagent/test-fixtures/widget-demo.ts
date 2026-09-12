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
  SubagentOrchestrator.prototype.recover = async () => [];
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
        role: index === 0 ? "worker" : "reviewer",
        state:
          scenario === "completed"
            ? "completed"
            : index === 1 || index === 7
              ? "blocked"
              : "working",
        task:
          "PROMPT-FIRST: Inspect the subagent widget\n\n" +
          Array.from(
            { length: 100 },
            (_, line) => `Prompt line ${line + 1}: preserve **literal** material.`,
          ).join("\n") +
          "\nPROMPT-LAST: exact final instruction",
        herdrName: `fixture-${index}`,
        cwd: process.cwd(),
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
    if (scenario === "history") {
      return [
        { ...children[0], semanticName: "HISTORY-PARENT" },
        ...Array.from({ length: 4 }, (_, index) => ({
          ...children[0],
          id: `history-${index}`,
          parentId: "fixture-0",
          semanticName: `done-history-${index}`,
          state: "completed" as const,
          depth: 2,
        })),
        { ...children[1], semanticName: "ACTIVE-SIBLING", state: "working" },
      ];
    }
    children.push({
      ...children[0],
      id: "nested",
      parentId: "fixture-0",
      semanticName: "nested-scout",
      role: "researcher",
      depth: 2,
    });
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
      result:
        "OUTPUT-FIRST: exact agent conclusion\n[Report](./report%20notes.md)\n[Reference](https://example.com/subagent-report)\n\n" +
        Array.from(
          { length: 100 },
          (_, line) => `Result line ${line + 1}: preserved **literal** material.`,
        ).join("\n") +
        "\nOUTPUT-LAST: final conclusion ends here\n",
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
  pi.registerCommand("completion-safety", {
    description: "Test-only untrusted completion rendering",
    handler: async () => {
      pi.sendMessage(
        {
          customType: "herdr-subagent-completion",
          content: "Fixture completion",
          display: true,
          details: {
            completionDataVersion: 1,
            semanticName: "SAFE-NAME\x1b]52;c;METADATA-CONTROL\x07\nwrapped",
            role: "worker\x1b]52;c;ROLE-CONTROL\x07",
            state: "completed",
            result:
              "SAFETY-FIRST\n\n[unsafe reference][danger]\n\n[danger]: command:unsafe-fixture\n\n" +
              "[safe reference][docs]\n\n[docs]: https://example.com/safe-reference\n\nSAFETY-LAST",
          },
        },
        { triggerTurn: false },
      );
    },
  });
  pi.on("session_shutdown", () => {
    SubagentOrchestrator.prototype.list = originalList;
    SubagentOrchestrator.prototype.recover = originalRecover;
  });
}
