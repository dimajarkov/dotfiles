import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  accountGoalUsage,
  budgetLimitPrompt,
  continuationPrompt,
  formatGoalElapsedSeconds,
  formatTokensCompact,
  GOAL_CONTEXT_MESSAGE_TYPE,
  GOAL_DISPLAY_ENTRY_TYPE,
  GOAL_STATE_ENTRY_TYPE,
  GOAL_USAGE,
  goalCommandHint,
  goalStatusIndicator,
  goalStatusLabel,
  goalToolResponse,
  goalUsageSummary,
  MAX_GOAL_OBJECTIVE_CHARS,
  objectiveUpdatedPrompt,
  restoreGoalFromEntries,
  validateGoalBudget,
  validateGoalObjective,
  type GoalState,
  type GoalStatus,
} from "./core.ts";

interface GoalDisplayEntry {
  level: "info" | "error";
  title: string;
  lines?: string[];
}

const GOAL_TOOL_NAMES = ["get_goal", "create_goal", "update_goal"];
const GOAL_FILE_PREFIX = "Read the Pi goal objective file at ";
const GOAL_FILE_SUFFIX = " before continuing.";

function assistantUsageTokens(message: {
  usage?: { input?: number; output?: number };
}): number {
  return Math.max(0, message.usage?.input ?? 0) +
    Math.max(0, message.usage?.output ?? 0);
}

function toolResultUsageTokens(message: {
  usage?: { input?: number; output?: number };
}): number {
  return assistantUsageTokens(message);
}

function assistantHasToolCall(message: { content?: unknown }): boolean {
  return (
    Array.isArray(message.content) &&
    message.content.some(
      (block) =>
        !!block &&
        typeof block === "object" &&
        (block as { type?: string }).type === "toolCall",
    )
  );
}

function finalAssistantStopReason(
  messages: readonly unknown[],
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message &&
      typeof message === "object" &&
      (message as { role?: string }).role === "assistant"
    ) {
      return (message as { stopReason?: string }).stopReason;
    }
  }
  return undefined;
}

function finalAssistantErrorMessage(
  messages: readonly unknown[],
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message &&
      typeof message === "object" &&
      (message as { role?: string }).role === "assistant"
    ) {
      return (message as { errorMessage?: string }).errorMessage;
    }
  }
  return undefined;
}

function isUsageLimitError(message: string | undefined): boolean {
  return !!message &&
    /usage limit|rate limit|quota|insufficient_quota|exceeded[^\n]*limit/i.test(
      message,
    );
}

export default function goalExtension(pi: ExtensionAPI): void {
  let goal: GoalState | null = null;
  let activeSinceMs: number | undefined;
  let currentTurnGoalId: string | undefined;
  let currentRunAutomatic = false;
  let nextRunAutomatic = false;
  let continuationQueued = false;
  let currentRunHadToolCall = false;
  let currentRunWasAborted = false;
  let lastStopReason: string | undefined;
  let lastErrorMessage: string | undefined;
  let budgetLimitReportedGoalId: string | undefined;
  let statusTimer: ReturnType<typeof setInterval> | undefined;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;

  function requirePersistedSession(ctx: ExtensionContext): void {
    if (ctx.sessionManager.getSessionFile() === undefined) {
      throw new Error(
        "Goals need a saved session. Start Pi with session persistence, or resume a saved session.",
      );
    }
  }

  function persistGoal(): void {
    pi.appendEntry(GOAL_STATE_ENTRY_TYPE, {
      goal: goal ? structuredClone(goal) : null,
    });
  }

  function recordDisplay(
    ctx: ExtensionContext,
    entry: GoalDisplayEntry,
  ): void {
    if (ctx.mode === "tui") {
      pi.appendEntry(GOAL_DISPLAY_ENTRY_TYPE, entry);
      return;
    }
    const message = [entry.title, ...(entry.lines ?? [])].join("\n");
    ctx.ui.notify(message, entry.level === "error" ? "error" : "info");
  }

  function recordError(ctx: ExtensionContext, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    recordDisplay(ctx, { level: "error", title: message });
  }

  function accountLiveElapsed(nowMs = Date.now()): number {
    if (!goal || activeSinceMs === undefined) return 0;
    const elapsedSeconds = Math.floor((nowMs - activeSinceMs) / 1_000);
    if (elapsedSeconds <= 0) return 0;
    goal = accountGoalUsage(goal, 0, elapsedSeconds, nowMs);
    activeSinceMs += elapsedSeconds * 1_000;
    if (goal.status !== "active") activeSinceMs = undefined;
    return elapsedSeconds;
  }

  function liveElapsedSeconds(): number {
    if (activeSinceMs === undefined) return 0;
    return Math.max(0, Math.floor((Date.now() - activeSinceMs) / 1_000));
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (!goal) {
      ctx.ui.setStatus("goal", undefined);
      return;
    }
    ctx.ui.setStatus(
      "goal",
      ctx.ui.theme.fg(
        "accent",
        goalStatusIndicator(goal, liveElapsedSeconds()),
      ),
    );
  }

  function stopStatusTimer(): void {
    if (statusTimer !== undefined) {
      clearInterval(statusTimer);
      statusTimer = undefined;
    }
  }

  function startStatusTimer(ctx: ExtensionContext): void {
    stopStatusTimer();
    if (!goal || goal.status !== "active" || activeSinceMs === undefined) return;
    statusTimer = setInterval(() => updateStatus(ctx), 1_000);
  }

  function applyStatus(
    status: GoalStatus,
    ctx: ExtensionContext,
    options: { persist?: boolean; clearDeferral?: boolean } = {},
  ): void {
    if (!goal) throw new Error("No goal is currently set.");
    const nowMs = Date.now();
    accountLiveElapsed(nowMs);
    goal = {
      ...goal,
      status,
      continuationDeferred:
        options.clearDeferral === true ? false : goal.continuationDeferred,
      updatedAtMs: nowMs,
    };
    if (status === "active" && !ctx.isIdle()) {
      activeSinceMs = nowMs;
    } else if (status !== "active") {
      activeSinceMs = undefined;
      stopStatusTimer();
    }
    if (options.persist !== false) persistGoal();
    updateStatus(ctx);
    if (status === "active") startStatusTimer(ctx);
  }

  function setNewGoal(
    ctx: ExtensionContext,
    objective: string,
    tokenBudget?: number,
    objectiveFile?: string,
  ): GoalState {
    validateGoalBudget(tokenBudget);
    const nowMs = Date.now();
    goal = {
      version: 1,
      threadId: ctx.sessionManager.getSessionId(),
      goalId: randomUUID(),
      objective,
      ...(objectiveFile ? { objectiveFile } : {}),
      status: "active",
      ...(tokenBudget === undefined ? {} : { tokenBudget }),
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      continuationDeferred: false,
    };
    activeSinceMs = ctx.isIdle() ? undefined : nowMs;
    budgetLimitReportedGoalId = undefined;
    persistGoal();
    updateStatus(ctx);
    if (activeSinceMs !== undefined) startStatusTimer(ctx);
    return goal;
  }

  async function prepareObjective(
    rawObjective: string,
  ): Promise<{ objective: string; objectiveFile?: string }> {
    const trimmed = rawObjective.trim();
    if (trimmed.length === 0) {
      throw new Error("Goal objective must not be empty.");
    }
    if ([...trimmed].length <= MAX_GOAL_OBJECTIVE_CHARS) {
      return { objective: validateGoalObjective(trimmed) };
    }

    const outputDirectory = join(
      getAgentDir(),
      "attachments",
      randomUUID(),
    );
    const objectiveFile = join(outputDirectory, "goal-objective.md");
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(objectiveFile, trimmed, "utf8");
    const objective = `${GOAL_FILE_PREFIX}${objectiveFile}${GOAL_FILE_SUFFIX}`;
    validateGoalObjective(objective);
    return { objective, objectiveFile };
  }

  async function objectiveTextForEdit(): Promise<string> {
    if (!goal) throw new Error("No goal is currently set.");
    if (!goal.objectiveFile) return goal.objective;
    return readFile(goal.objectiveFile, "utf8");
  }

  function sendGoalContext(
    content: string,
    deliverAs: "steer" | "followUp",
    triggerTurn: boolean,
  ): void {
    pi.sendMessage(
      {
        customType: GOAL_CONTEXT_MESSAGE_TYPE,
        content,
        display: false,
      },
      { deliverAs, triggerTurn },
    );
  }

  function startContinuation(ctx: ExtensionContext): boolean {
    if (
      !goal ||
      goal.status !== "active" ||
      goal.continuationDeferred ||
      continuationQueued ||
      !ctx.isIdle() ||
      ctx.hasPendingMessages()
    ) {
      return false;
    }
    continuationQueued = true;
    nextRunAutomatic = true;
    try {
      sendGoalContext(continuationPrompt(goal), "followUp", true);
      return true;
    } catch (error) {
      continuationQueued = false;
      nextRunAutomatic = false;
      recordError(ctx, error);
      return false;
    }
  }

  function scheduleContinuation(ctx: ExtensionContext, delayMs = 0): void {
    if (startupTimer !== undefined) clearTimeout(startupTimer);
    startupTimer = setTimeout(() => {
      startupTimer = undefined;
      startContinuation(ctx);
    }, delayMs);
  }

  function queueBudgetLimitSteering(ctx: ExtensionContext): void {
    if (!goal || goal.status !== "budget_limited") return;
    if (budgetLimitReportedGoalId === goal.goalId) return;
    budgetLimitReportedGoalId = goal.goalId;
    try {
      sendGoalContext(budgetLimitPrompt(goal), "steer", false);
    } catch (error) {
      recordError(ctx, error);
    }
  }

  function accountTokenDelta(
    ctx: ExtensionContext,
    tokenDelta: number,
    mayNeedWrapUpTurn: boolean,
  ): void {
    if (
      !goal ||
      currentTurnGoalId === undefined ||
      goal.goalId !== currentTurnGoalId
    ) {
      return;
    }
    const wasActive = goal.status === "active";
    const nowMs = Date.now();
    accountLiveElapsed(nowMs);
    goal = accountGoalUsage(goal, tokenDelta, 0, nowMs);
    if (wasActive && goal.status === "budget_limited") {
      activeSinceMs = undefined;
      stopStatusTimer();
    }
    persistGoal();
    updateStatus(ctx);
    if (mayNeedWrapUpTurn && goal.status === "budget_limited") {
      queueBudgetLimitSteering(ctx);
    }
  }

  function showGoalSummary(ctx: ExtensionContext): void {
    if (!goal) {
      recordDisplay(ctx, {
        level: "info",
        title: GOAL_USAGE,
        lines: ["No goal is currently set."],
      });
      return;
    }
    accountLiveElapsed();
    persistGoal();
    const lines = [
      `Status: ${goalStatusLabel(goal.status)}`,
      `Objective: ${goal.objective}`,
      `Time used: ${formatGoalElapsedSeconds(goal.timeUsedSeconds)}`,
      `Tokens used: ${formatTokensCompact(goal.tokensUsed)}`,
    ];
    if (goal.tokenBudget !== undefined) {
      lines.push(`Token budget: ${formatTokensCompact(goal.tokenBudget)}`);
    }
    lines.push("", goalCommandHint(goal.status));
    recordDisplay(ctx, { level: "info", title: "Goal", lines });
    updateStatus(ctx);
  }

  async function replaceFromCommand(
    rawObjective: string,
    ctx: ExtensionContext,
  ): Promise<void> {
    requirePersistedSession(ctx);
    const prepared = await prepareObjective(rawObjective);
    if (goal && goal.status !== "complete") {
      if (!ctx.hasUI) {
        throw new Error(
          "An unfinished goal already exists. Clear it before replacing it in non-interactive mode.",
        );
      }
      const replace = await ctx.ui.confirm(
        "Replace goal?",
        `New objective: ${prepared.objective.slice(0, 200)}`,
      );
      if (!replace) return;
    }
    setNewGoal(ctx, prepared.objective, undefined, prepared.objectiveFile);
    recordDisplay(ctx, {
      level: "info",
      title: "Goal active",
      lines: [goalUsageSummary(goal!)],
    });
    startContinuation(ctx);
  }

  async function editGoal(ctx: ExtensionContext): Promise<void> {
    requirePersistedSession(ctx);
    if (!goal) throw new Error("No goal is currently set.");
    if (!ctx.hasUI) throw new Error("Goal editing requires an interactive UI.");
    const edited = await ctx.ui.editor("Edit goal", await objectiveTextForEdit());
    if (edited === undefined) return;
    const prepared = await prepareObjective(edited);
    const previousStatus = goal.status;
    const nextStatus =
      previousStatus === "budget_limited" || previousStatus === "complete"
        ? "active"
        : previousStatus;
    const nowMs = Date.now();
    accountLiveElapsed(nowMs);
    goal = {
      ...goal,
      objective: prepared.objective,
      ...(prepared.objectiveFile
        ? { objectiveFile: prepared.objectiveFile }
        : { objectiveFile: undefined }),
      status: nextStatus,
      continuationDeferred: nextStatus === "active" ? false : goal.continuationDeferred,
      updatedAtMs: nowMs,
    };
    if (nextStatus === "active" && !ctx.isIdle()) activeSinceMs = nowMs;
    persistGoal();
    updateStatus(ctx);
    recordDisplay(ctx, {
      level: "info",
      title: `Goal ${goalStatusLabel(goal.status)}`,
      lines: [goalUsageSummary(goal)],
    });
    if (nextStatus === "active" && !ctx.isIdle()) {
      sendGoalContext(objectiveUpdatedPrompt(goal), "steer", false);
    } else if (nextStatus === "active") {
      startContinuation(ctx);
    }
  }

  async function handleGoalCommand(
    rawArgs: string,
    ctx: ExtensionContext,
  ): Promise<void> {
    try {
      requirePersistedSession(ctx);
      const trimmed = rawArgs.trim();
      if (trimmed.length === 0) {
        showGoalSummary(ctx);
        return;
      }
      switch (trimmed.toLowerCase()) {
        case "clear": {
          if (!goal) {
            recordDisplay(ctx, {
              level: "info",
              title: "No goal to clear",
              lines: ["This thread does not currently have a goal."],
            });
            return;
          }
          accountLiveElapsed();
          goal = null;
          activeSinceMs = undefined;
          currentTurnGoalId = undefined;
          continuationQueued = false;
          nextRunAutomatic = false;
          budgetLimitReportedGoalId = undefined;
          stopStatusTimer();
          persistGoal();
          updateStatus(ctx);
          recordDisplay(ctx, {
            level: "info",
            title: "Goal cleared",
          });
          return;
        }
        case "edit":
          await editGoal(ctx);
          return;
        case "pause":
          applyStatus("paused", ctx);
          recordDisplay(ctx, {
            level: "info",
            title: "Goal paused",
            lines: [goalUsageSummary(goal!)],
          });
          return;
        case "resume":
          applyStatus("active", ctx, { clearDeferral: true });
          recordDisplay(ctx, {
            level: "info",
            title: "Goal active",
            lines: [goalUsageSummary(goal!)],
          });
          startContinuation(ctx);
          return;
        default:
          await replaceFromCommand(rawArgs, ctx);
      }
    } catch (error) {
      recordError(ctx, error);
    }
  }

  pi.registerEntryRenderer<GoalDisplayEntry>(
    GOAL_DISPLAY_ENTRY_TYPE,
    (entry, _options, theme) => {
      const data = entry.data ?? {
        level: "error",
        title: "Goal display data is unavailable.",
      };
      const color = data.level === "error" ? "error" : "accent";
      const title = theme.fg(color, theme.bold(data.title));
      const lines = data.lines ?? [];
      const body = lines.length > 0
        ? `\n${lines.map((line) => theme.fg(line.length > 0 ? "muted" : "dim", line)).join("\n")}`
        : "";
      return new Text(`${title}${body}`, 0, 0);
    },
  );

  pi.registerCommand("goal", {
    description: "Set or view the goal for a long-running task",
    getArgumentCompletions: (prefix) => {
      const commands = ["clear", "edit", "pause", "resume"];
      const matches = commands
        .filter((command) => command.startsWith(prefix.toLowerCase()))
        .map((command) => ({ value: command, label: command }));
      return matches.length > 0 ? matches : null;
    },
    handler: handleGoalCommand,
  });

  pi.registerTool({
    name: "get_goal",
    label: "Get Goal",
    description:
      "Get the current goal for this thread, including status, budgets, token and elapsed-time usage, and remaining token budget.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      requirePersistedSession(ctx);
      accountLiveElapsed();
      if (goal) persistGoal();
      const response = goalToolResponse(goal);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
        details: response,
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("get_goal")), 0, 0);
    },
  });

  pi.registerTool({
    name: "create_goal",
    label: "Create Goal",
    description:
      "Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks. Set token_budget only when an explicit token budget is requested. Fails if an unfinished goal exists; use update_goal only for status.",
    parameters: Type.Object(
      {
        objective: Type.String({
          description:
            "Required. The concrete objective to start pursuing. This starts a new active goal when no goal exists or replaces the current goal when it is complete.",
          maxLength: MAX_GOAL_OBJECTIVE_CHARS,
        }),
        token_budget: Type.Optional(
          Type.Integer({
            description:
              "Positive token budget for the new goal. Omit unless explicitly requested.",
            minimum: 1,
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      requirePersistedSession(ctx);
      const objective = validateGoalObjective(params.objective);
      validateGoalBudget(params.token_budget);
      if (goal && goal.status !== "complete") {
        throw new Error(
          "Cannot create a new goal because this thread has an unfinished goal; complete the existing goal first.",
        );
      }
      setNewGoal(ctx, objective, params.token_budget);
      const response = goalToolResponse(goal);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
        details: response,
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("create_goal "))}${theme.fg("muted", args.objective ?? "")}`,
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "update_goal",
    label: "Update Goal",
    description:
      "Update the existing goal. Use this tool only to mark the goal achieved or genuinely blocked. Set status to complete only when the objective has actually been achieved and no required work remains. Set status to blocked only when the same blocking condition has repeated for at least three consecutive goal turns and the agent cannot make meaningful progress without user input or an external-state change. Do not use blocked merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification. You cannot use this tool to pause, resume, budget-limit, or usage-limit a goal; those status changes are controlled by the user or system.",
    parameters: Type.Object(
      {
        status: StringEnum(["complete", "blocked"] as const, {
          description:
            "Set to complete only when the objective is achieved and no required work remains. Set to blocked only after the same blocking condition has recurred for at least three consecutive goal turns and the agent is at an impasse.",
        }),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      requirePersistedSession(ctx);
      if (!goal) throw new Error("Cannot update goal because this thread has no goal.");
      applyStatus(params.status, ctx);
      const response = goalToolResponse(goal, params.status === "complete");
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
        details: response,
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("update_goal "))}${theme.fg("muted", args.status)}`,
        0,
        0,
      );
    },
  });

  pi.on("session_start", async (event, ctx) => {
    goal = restoreGoalFromEntries(ctx.sessionManager.getBranch());
    activeSinceMs = undefined;
    currentTurnGoalId = undefined;
    currentRunAutomatic = false;
    nextRunAutomatic = false;
    continuationQueued = false;
    currentRunHadToolCall = false;
    currentRunWasAborted = false;
    lastStopReason = undefined;
    lastErrorMessage = undefined;
    budgetLimitReportedGoalId = undefined;
    stopStatusTimer();

    if (ctx.sessionManager.getSessionFile() === undefined) {
      pi.setActiveTools(
        pi.getActiveTools().filter((name) => !GOAL_TOOL_NAMES.includes(name)),
      );
      updateStatus(ctx);
      return;
    }

    if (
      goal &&
      (goal.threadId !== ctx.sessionManager.getSessionId() ||
        event.reason === "fork")
    ) {
      goal = {
        ...goal,
        threadId: ctx.sessionManager.getSessionId(),
        goalId: randomUUID(),
        continuationDeferred: true,
        updatedAtMs: Date.now(),
      };
      persistGoal();
    }

    if (
      goal &&
      (goal.status === "paused" ||
        goal.status === "blocked" ||
        goal.status === "usage_limited") &&
      (event.reason === "startup" || event.reason === "resume") &&
      ctx.mode === "tui"
    ) {
      const choice = await ctx.ui.select("Resume paused goal?", [
        "Resume goal",
        "Leave paused",
      ]);
      if (choice === "Resume goal") {
        applyStatus("active", ctx, { clearDeferral: true });
      }
    }

    updateStatus(ctx);
    if (
      goal?.status === "active" &&
      !goal.continuationDeferred &&
      event.reason !== "fork"
    ) {
      scheduleContinuation(ctx, 100);
    }
  });

  pi.on("session_before_fork", (_event, ctx) => {
    if (!goal) return;
    if (accountLiveElapsed() > 0) persistGoal();
    updateStatus(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    goal = restoreGoalFromEntries(ctx.sessionManager.getBranch());
    activeSinceMs = undefined;
    currentTurnGoalId = undefined;
    updateStatus(ctx);
    if (goal?.status === "active" && !goal.continuationDeferred) {
      scheduleContinuation(ctx, 0);
    }
  });

  pi.on("before_agent_start", (_event, ctx) => {
    currentRunAutomatic = nextRunAutomatic;
    nextRunAutomatic = false;
    continuationQueued = false;
    currentRunHadToolCall = false;
    currentRunWasAborted = false;
    lastStopReason = undefined;
    lastErrorMessage = undefined;
    if (goal?.status === "active" && !currentRunAutomatic && goal.continuationDeferred) {
      goal = {
        ...goal,
        continuationDeferred: false,
        updatedAtMs: Date.now(),
      };
      persistGoal();
      updateStatus(ctx);
    }
  });

  pi.on("agent_start", (_event, ctx) => {
    if (nextRunAutomatic) {
      currentRunAutomatic = true;
      nextRunAutomatic = false;
      continuationQueued = false;
      currentRunHadToolCall = false;
      currentRunWasAborted = false;
      lastStopReason = undefined;
      lastErrorMessage = undefined;
    }
    if (goal?.status === "active" && activeSinceMs === undefined) {
      activeSinceMs = Date.now();
    }
    updateStatus(ctx);
    startStatusTimer(ctx);
  });

  pi.on("turn_start", () => {
    currentTurnGoalId =
      goal?.status === "active" || goal?.status === "budget_limited"
        ? goal.goalId
        : undefined;
  });

  pi.on("tool_execution_start", () => {
    currentRunHadToolCall = true;
  });

  pi.on("tool_execution_end", (_event, ctx) => {
    currentRunWasAborted ||= ctx.signal?.aborted === true;
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    currentRunWasAborted ||= ctx.signal?.aborted === true;
    lastStopReason = event.message.stopReason;
    lastErrorMessage = event.message.errorMessage;
    accountTokenDelta(
      ctx,
      assistantUsageTokens(event.message),
      assistantHasToolCall(event.message),
    );
  });

  pi.on("turn_end", (event, ctx) => {
    lastStopReason =
      event.message.role === "assistant"
        ? event.message.stopReason
        : lastStopReason;
    const nestedUsage = event.toolResults.reduce(
      (total, result) => total + toolResultUsageTokens(result),
      0,
    );
    if (nestedUsage > 0) {
      accountTokenDelta(ctx, nestedUsage, event.toolResults.length > 0);
    } else if (goal && accountLiveElapsed() > 0) {
      persistGoal();
      updateStatus(ctx);
    }
  });

  pi.on("agent_end", (event, ctx) => {
    currentRunWasAborted ||= ctx.signal?.aborted === true;
    lastStopReason = finalAssistantStopReason(event.messages) ?? lastStopReason;
    lastErrorMessage =
      finalAssistantErrorMessage(event.messages) ?? lastErrorMessage;
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (goal && accountLiveElapsed() > 0) persistGoal();
    activeSinceMs = undefined;
    stopStatusTimer();

    if (
      goal?.status === "active" &&
      (currentRunWasAborted || lastStopReason === "aborted")
    ) {
      applyStatus("paused", ctx);
      recordDisplay(ctx, {
        level: "info",
        title: "Goal paused",
        lines: [goalUsageSummary(goal)],
      });
    } else if (goal?.status === "active" && lastStopReason === "error") {
      applyStatus(isUsageLimitError(lastErrorMessage) ? "usage_limited" : "blocked", ctx);
    }

    if (
      goal?.status === "active" &&
      currentRunAutomatic &&
      !currentRunHadToolCall
    ) {
      goal = {
        ...goal,
        continuationDeferred: true,
        updatedAtMs: Date.now(),
      };
      persistGoal();
    }

    updateStatus(ctx);
    currentTurnGoalId = undefined;
    currentRunAutomatic = false;
    currentRunHadToolCall = false;
    currentRunWasAborted = false;
    lastStopReason = undefined;
    lastErrorMessage = undefined;
    startContinuation(ctx);
  });

  pi.on("context", (event) => {
    if (goal) return;
    return {
      messages: event.messages.filter(
        (message) =>
          !(
            message.role === "custom" &&
            message.customType === GOAL_CONTEXT_MESSAGE_TYPE
          ),
      ),
    };
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (startupTimer !== undefined) {
      clearTimeout(startupTimer);
      startupTimer = undefined;
    }
    if (goal && accountLiveElapsed() > 0) persistGoal();
    activeSinceMs = undefined;
    stopStatusTimer();
    ctx.ui.setStatus("goal", undefined);
  });
}
