import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import askUser from "./index.ts";
import { buildAskUserResultMessage } from "./prompt.ts";

test("registered ask_user guidance reaches Pi's runtime-built system prompt", async () => {
  const cwd = process.cwd();
  const agentDir = mkdtempSync(join(cwd, ".ask-user-prompt-"));
  try {
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      extensionFactories: [{ name: "ask-user", factory: askUser }],
      noContextFiles: true,
      noPromptTemplates: true,
      noSkills: true,
      noThemes: true,
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      tools: ["ask_user"],
    });
    try {
      assert.ok(session.getToolDefinition("ask_user"));
      assert.match(
        session.systemPrompt,
        /ask_user: Ask the user a multiple-choice question \(2-5 options plus a free-form answer\)/,
      );
      assert.match(
        session.systemPrompt,
        /use the ask_user tool instead of asking in plain text/,
      );
      assert.match(
        session.systemPrompt,
        /Ask one question per ask_user call; ask follow-up questions in subsequent calls\./,
      );
    } finally {
      session.dispose();
    }
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("returns explicit behavioral messages for every outcome", () => {
  assert.match(buildAskUserResultMessage({ kind: "no-ui" }), /Ask the user in plain text instead/);
  assert.equal(buildAskUserResultMessage({ kind: "cancelled" }), "Cancelled");
  assert.match(buildAskUserResultMessage({ kind: "dismissed" }), /Do not assume an answer/);
  assert.equal(
    buildAskUserResultMessage({ kind: "custom", answer: "Something else" }),
    "User wrote their own answer: Something else",
  );
  assert.equal(
    buildAskUserResultMessage({
      kind: "selected",
      answer: "Ship it",
      index: 2,
    }),
    "User selected option 2: Ship it",
  );
});
