import assert from "node:assert/strict";
import test from "node:test";
import {
  ASK_USER_PARAMETER_DESCRIPTIONS,
  ASK_USER_PROMPT_GUIDELINES,
  ASK_USER_PROMPT_SNIPPET,
  ASK_USER_TOOL_DESCRIPTION,
  buildAskUserResultMessage,
} from "./prompt.ts";

test("describes the bounded single-question contract to the model", () => {
  assert.match(ASK_USER_TOOL_DESCRIPTION, /single multiple-choice question/i);
  assert.match(ASK_USER_TOOL_DESCRIPTION, /2-5 options/);
  assert.match(ASK_USER_TOOL_DESCRIPTION, /dismiss/i);
  assert.match(ASK_USER_PROMPT_SNIPPET, /free-form answer/i);
  assert.equal(ASK_USER_PROMPT_GUIDELINES.length, 2);
  assert.match(ASK_USER_PROMPT_GUIDELINES[0]!, /ask_user tool/);
  assert.match(ASK_USER_PARAMETER_DESCRIPTIONS.options, /never include/i);
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
