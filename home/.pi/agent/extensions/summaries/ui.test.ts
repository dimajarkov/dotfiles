import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderRecap, type RecapEntryData } from "./src/ui.ts";

const theme = {
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

const recap: RecapEntryData = {
  title: "Add semantic recap titles",
  recap: "Updated the summary response and card.",
  next: "Reload Pi.",
  provider: "openai-codex",
  model: "gpt-5.6-luna",
  reasoning: "medium",
};

test("renders the semantic title instead of the generic run recap label", () => {
  const output = renderRecap(recap, false, theme).render(80).join("\n");

  assert.match(output, /✦ Add semantic recap titles/);
  assert.doesNotMatch(output, /Run recap/i);
});

test("derives a semantic title for legacy recap entries", () => {
  const legacyRecap = {
    ...recap,
    title: undefined,
    recap:
      "The main-agent run completed. The run used 2 tool calls across edit, bash. Added semantic recap titles.",
  } as unknown as RecapEntryData;
  const output = renderRecap(legacyRecap, false, theme).render(80).join("\n");

  assert.match(output, /✦ Added semantic recap titles/);
  assert.doesNotMatch(output, /Run recap/i);
});
