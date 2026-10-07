import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

test("Ctrl+M opens the MCP panel without changing the editor draft", async () => {
  const cwd = process.cwd();
  const packageDir = dirname(fileURLToPath(import.meta.url));
  const agentDir = await mkdtemp(join(cwd, ".mcp-shortcut-test-"));
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

  try {
    const settingsManager = SettingsManager.inMemory();
    const mcpCommandPath = join(agentDir, "mcp-command.ts");
    await writeFile(
      mcpCommandPath,
      'export default function(pi) { pi.registerCommand("mcp", { description: "test MCP command", handler: async (_args, ctx) => ctx.ui.notify("MCP command opened", "info") }); }',
    );
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      additionalExtensionPaths: [resolve(packageDir, "../mcp-shortcut.ts"), mcpCommandPath],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();

    const created = await createAgentSession({
      cwd,
      agentDir,
      settingsManager,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      noTools: "all",
    });
    session = created.session;

    assert.deepEqual(created.extensionsResult.errors, []);

    const theme: EditorTheme = {
      borderColor: (text) => text,
      selectList: {
        selectedPrefix: (text) => text,
        selectedText: (text) => text,
        description: (text) => text,
        scrollInfo: (text) => text,
        noMatch: (text) => text,
      },
    };
    const editor = new Editor({ requestRender() {} } as TUI, theme);
    const notifications: string[] = [];
    const terminalInputHandlers: Array<
      (data: string) => { consume?: boolean; data?: string } | undefined
    > = [];
    const uiContext = {
      onTerminalInput(
        handler: (data: string) => { consume?: boolean; data?: string } | undefined,
      ) {
        terminalInputHandlers.push(handler);
        return () => {
          const index = terminalInputHandlers.indexOf(handler);
          if (index >= 0) terminalInputHandlers.splice(index, 1);
        };
      },
      setEditorText(text: string) {
        editor.setText(text);
      },
      getEditorText() {
        return editor.getExpandedText();
      },
      notify(message: string) {
        notifications.push(message);
      },
    } as unknown as ExtensionUIContext;

    await session.bindExtensions({ uiContext, mode: "tui" });

    const draft = "unfinished request that must stay in the editor";
    editor.setText(draft);

    const inputHandler = terminalInputHandlers[0];
    assert.ok(inputHandler);
    assert.equal(inputHandler("\r"), undefined);
    assert.equal(editor.getText(), draft);
    assert.equal(inputHandler("\u001b[109;5u")?.data, "\r");
    assert.equal(editor.getText(), "/mcp");
    await session.prompt(editor.getText(), { expandPromptTemplates: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(editor.getText(), draft);
    assert.deepEqual(notifications, ["MCP command opened"]);
  } finally {
    session?.dispose();
    await rm(agentDir, { recursive: true, force: true });
  }
});
