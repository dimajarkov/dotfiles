import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
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
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      additionalExtensionPaths: [resolve(packageDir, "../mcp-shortcut.ts")],
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
    const terminalInputHandlers: Array<(data: string) => { consume?: boolean } | undefined> = [];
    const uiContext = {
      onTerminalInput(handler: (data: string) => { consume?: boolean } | undefined) {
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
      notify() {},
    } as unknown as ExtensionUIContext;
    const dispatchedMessages: Array<{ content: unknown; options: unknown }> = [];
    session.sendUserMessage = async (content, options) => {
      dispatchedMessages.push({ content, options });
    };

    await session.bindExtensions({ uiContext, mode: "tui" });

    const draft = "unfinished request that must stay in the editor";
    editor.setText(draft);

    const inputHandler = terminalInputHandlers[0];
    assert.ok(inputHandler);
    assert.equal(inputHandler("\r"), undefined);
    assert.equal(editor.getText(), draft);
    assert.equal(inputHandler("\u001b[109;5u")?.consume, true);
    assert.equal(editor.getText(), draft);
    assert.deepEqual(dispatchedMessages, [
      { content: "/mcp", options: { expandPromptTemplates: true } },
    ]);
  } finally {
    session?.dispose();
    await rm(agentDir, { recursive: true, force: true });
  }
});
