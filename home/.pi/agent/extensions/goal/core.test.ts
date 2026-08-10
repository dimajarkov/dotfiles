import assert from "node:assert/strict";
import test from "node:test";
import {
  accountGoalUsage,
  budgetLimitPrompt,
  continuationPrompt,
  formatGoalElapsedSeconds,
  formatTokensCompact,
  GOAL_STATE_ENTRY_TYPE,
  goalCommandHint,
  goalStatusIndicator,
  goalStatusLabel,
  goalToolResponse,
  objectiveUpdatedPrompt,
  restoreGoalFromEntries,
  validateGoalBudget,
  validateGoalObjective,
  type GoalState,
} from "./core.ts";

function testGoal(overrides: Partial<GoalState> = {}): GoalState {
  return {
    version: 1,
    threadId: "thread-1",
    goalId: "goal-1",
    objective: "Ship <the> & feature",
    status: "active",
    tokensUsed: 12_500,
    timeUsedSeconds: 90,
    createdAtMs: 1_000,
    updatedAtMs: 2_000,
    continuationDeferred: false,
    ...overrides,
  };
}

test("objective and budget validation match the Codex limits", () => {
  assert.equal(validateGoalObjective("  ship it  "), "ship it");
  assert.throws(() => validateGoalObjective("   "), /must not be empty/);
  assert.throws(() => validateGoalObjective("x".repeat(4_001)), /at most 4000/);
  assert.doesNotThrow(() => validateGoalBudget(undefined));
  assert.doesNotThrow(() => validateGoalBudget(50_000));
  assert.throws(() => validateGoalBudget(0), /positive integers/);
  assert.throws(() => validateGoalBudget(1.5), /positive integers/);
});

test("goal snapshots restore the latest branch-local value", () => {
  const first = testGoal();
  const second = testGoal({ objective: "new objective", status: "paused" });
  assert.deepEqual(
    restoreGoalFromEntries([
      { type: "custom", customType: GOAL_STATE_ENTRY_TYPE, data: { goal: first } },
      { type: "message" },
      { type: "custom", customType: GOAL_STATE_ENTRY_TYPE, data: { goal: null } },
      { type: "custom", customType: GOAL_STATE_ENTRY_TYPE, data: { goal: second } },
    ]),
    second,
  );
  assert.equal(
    restoreGoalFromEntries([
      { type: "custom", customType: GOAL_STATE_ENTRY_TYPE, data: { goal: first } },
      { type: "custom", customType: GOAL_STATE_ENTRY_TYPE, data: { goal: null } },
    ]),
    null,
  );
});

test("usage accounting reaches but does not confuse a token budget with completion", () => {
  const goal = testGoal({ tokenBudget: 15_000 });
  const updated = accountGoalUsage(goal, 2_500, 30, 3_000);
  assert.equal(updated.status, "budget_limited");
  assert.equal(updated.tokensUsed, 15_000);
  assert.equal(updated.timeUsedSeconds, 120);

  const complete = accountGoalUsage(
    testGoal({ status: "complete", tokenBudget: 15_000 }),
    3_000,
    5,
    4_000,
  );
  assert.equal(complete.status, "complete");
});

test("continuation prompt preserves the full Codex completion and blocked audits", () => {
  const prompt = continuationPrompt(testGoal({ tokenBudget: 50_000 }));
  assert.match(prompt, /<objective>\nShip &lt;the&gt; &amp; feature\n<\/objective>/);
  assert.match(prompt, /Tokens remaining: 37500/);
  assert.match(prompt, /The audit must prove completion/);
  assert.match(prompt, /at least three consecutive goal turns/);
  assert.match(prompt, /call update_goal with status "complete"/);
});

test("budget and objective-update prompts preserve lifecycle boundaries", () => {
  const goal = testGoal({ tokenBudget: 12_500, status: "budget_limited" });
  assert.match(budgetLimitPrompt(goal), /do not start new substantive work/);
  assert.match(budgetLimitPrompt(goal), /status "budget_limited"|status "complete"|budget_limited/);
  assert.match(objectiveUpdatedPrompt(goal), /supersedes any previous thread goal objective/);
  assert.match(objectiveUpdatedPrompt(goal), /Tokens remaining: 0/);
});

test("goal tool responses use Codex camel-case fields and completion reporting", () => {
  const goal = testGoal({
    status: "complete",
    tokenBudget: 50_000,
    tokensUsed: 40_000,
    timeUsedSeconds: 120,
  });
  const response = goalToolResponse(goal, true);
  assert.deepEqual(response.goal, {
    threadId: "thread-1",
    objective: "Ship <the> & feature",
    status: "complete",
    tokenBudget: 50_000,
    tokensUsed: 40_000,
    timeUsedSeconds: 120,
    createdAt: 1,
    updatedAt: 2,
  });
  assert.equal(response.remainingTokens, 10_000);
  assert.match(response.completionBudgetReport ?? "", /Report final usage/);
});

test("status and usage formatting matches the Codex UI", () => {
  assert.equal(formatTokensCompact(999), "999");
  assert.equal(formatTokensCompact(12_500), "12.5K");
  assert.equal(formatTokensCompact(63_876), "63.9K");
  assert.equal(formatTokensCompact(2_000_000), "2M");
  assert.equal(formatGoalElapsedSeconds(59), "59s");
  assert.equal(formatGoalElapsedSeconds(90 * 60), "1h 30m");
  assert.equal(formatGoalElapsedSeconds(24 * 60 * 60), "1d 0h 0m");
  assert.equal(goalStatusLabel("blocked"), "stalled");
  assert.equal(
    goalCommandHint("budget_limited"),
    "Commands: /goal edit, /goal clear",
  );
  assert.equal(
    goalStatusIndicator(testGoal(), 30),
    "Pursuing goal (2m)",
  );
  assert.equal(
    goalStatusIndicator(testGoal({ tokenBudget: 50_000 })),
    "Pursuing goal (12.5K / 50K)",
  );
  assert.equal(
    goalStatusIndicator(
      testGoal({ status: "complete", tokenBudget: 50_000, tokensUsed: 40_000 }),
    ),
    "Goal achieved (40K tokens)",
  );
});
