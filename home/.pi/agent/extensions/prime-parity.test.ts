import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  ContinualRefinementController,
  createPrimeParityExtension,
  loadHarness,
  normalizeAutoRefinementConfig,
  serializeTrajectory,
  writeJsonAtomic,
  type HarnessEntry,
} from "./prime-parity.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "prime-parity-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function textResponse(value: unknown, stopReason = "stop") {
  return { stopReason, content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

function fakePi() {
  const events = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const appended: Array<{ type: string; data: unknown }> = [];
  const pi = {
    on(name: string, handler: (...args: any[]) => any) { events.set(name, handler); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    appendEntry(type: string, data: unknown) { appended.push({ type, data }); },
  };
  return { pi: pi as any, events, commands, appended };
}

interface FakeContextOptions {
  sessionId?: string;
  leafId?: string | null;
  entries?: SessionEntry[];
  branch?: SessionEntry[];
  responses?: any[];
  idle?: boolean;
}

function fakeContext(options: FakeContextOptions = {}) {
  const notifications: Array<{ message: string; level?: string }> = [];
  const completions: Array<{ model: unknown; context: any; options: any }> = [];
  const responses = [...(options.responses ?? [])];
  const entries = options.entries ?? [];
  const branch = options.branch ?? entries;
  const context = {
    model: { provider: "fake", id: "curator", input: ["text"] },
    modelRegistry: {
      async complete(model: unknown, modelContext: any, completeOptions: any) {
        completions.push({ model, context: modelContext, options: completeOptions });
        const response = responses.shift();
        if (response instanceof Error) throw response;
        if (response && typeof response.then === "function") return response;
        return response ?? textResponse({ shouldRefine: false, rationale: "nothing durable" });
      },
    },
    sessionManager: {
      getSessionId: () => options.sessionId ?? "session-1",
      getLeafId: () => options.leafId === undefined ? "leaf-1" : options.leafId,
      buildContextEntries: () => entries,
      getBranch: () => branch,
    },
    ui: { notify(message: string, level?: string) { notifications.push({ message, level }); } },
    isIdle: () => options.idle ?? true,
  } as unknown as ExtensionContext;
  return { context, notifications, completions, responses };
}

function entry(overrides: Partial<HarnessEntry> = {}): HarnessEntry {
  return {
    id: "entry-1",
    kind: "memory",
    title: "Focused regression",
    content: "Run the focused regression before changing the parser.",
    createdAt: "2026-01-01T00:00:00.000Z",
    sourceSessionId: "session-1",
    ...overrides,
  };
}

function localHarnessPath(directory: string, sessionId = "session-1") {
  return join(directory, "session-artifacts", sessionId, "continual-harness.json");
}

function requestPath(directory: string, sessionId = "session-1") {
  return join(directory, "refinement-requests", `${sessionId}.json`);
}

async function queueManual(
  controller: ContinualRefinementController,
  directory: string,
  context: ExtensionContext,
  request: Record<string, unknown>,
) {
  writeJsonAtomic(requestPath(directory), request);
  await controller.turnEnded(context);
}

test("1. configuration defaults enable interval and compaction review", () => {
  assert.deepEqual(normalizeAutoRefinementConfig(undefined), {
    enabled: true,
    turnInterval: 25,
    compact: true,
    cooldownMs: 1_200_000,
  });
});

test("2. configuration validates booleans, finite values, and minimums", () => {
  assert.deepEqual(normalizeAutoRefinementConfig({ enabled: false, turnInterval: 0, compact: false, cooldownMs: -4 }), {
    enabled: false,
    turnInterval: 1,
    compact: false,
    cooldownMs: 0,
  });
  assert.equal(normalizeAutoRefinementConfig({ turnInterval: Number.NaN }).turnInterval, 25);
});

test("3. atomic JSON writes create parent directories, newline, and private files", () => {
  const path = join(temporaryDirectory(), "nested", "state.json");
  writeJsonAtomic(path, { ok: true });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { ok: true });
  assert.match(readFileSync(path, "utf8"), /\n$/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("4. missing and malformed harness files load as empty versioned state", () => {
  const directory = temporaryDirectory();
  assert.deepEqual(loadHarness(join(directory, "missing.json")), { version: 1, entries: [] });
  const malformed = join(directory, "malformed.json");
  writeFileSync(malformed, "not json");
  assert.deepEqual(loadHarness(malformed), { version: 1, entries: [] });
});

test("5. harness loading keeps only fully valid entries", () => {
  const path = join(temporaryDirectory(), "harness.json");
  writeJsonAtomic(path, { version: 99, entries: [entry(), { ...entry({ id: "bad" }), createdAt: 7 }, null] });
  assert.deepEqual(loadHarness(path), { version: 1, entries: [entry()] });
});

test("6. trajectory serialization is chronological across supported entry kinds", () => {
  const entries = [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
    { type: "compaction", summary: "compact summary" },
    { type: "branch_summary", summary: "branch summary" },
    { type: "custom_message", customType: "note", content: "custom text" },
    { type: "custom", customType: "state", data: { secret: "omitted" } },
    { type: "model_change", provider: "p", modelId: "m" },
    { type: "thinking_level_change", thinkingLevel: "high" },
    { type: "label", label: "checkpoint" },
    { type: "session_info", name: "work" },
  ] as unknown as SessionEntry[];
  const result = serializeTrajectory(entries);
  for (const expected of ["role=user", "compact summary", "branch summary", "custom text", "custom state type=state omitted", "p/m", "high", "checkpoint", "name=work"]) {
    assert.match(result, new RegExp(expected));
  }
  assert.ok(result.indexOf("hello") < result.indexOf("compact summary"));
});

test("7. trajectory serialization redacts common secrets", () => {
  const entries = [{ type: "message", message: { role: "user", content: "token=abc sk-supersecret password:xyz" } }] as unknown as SessionEntry[];
  const result = serializeTrajectory(entries);
  assert.doesNotMatch(result, /abc|supersecret|xyz/);
  assert.equal((result.match(/<redacted>/g) ?? []).length, 3);
});

test("8. trajectory serialization deterministically represents non-text and tool content", () => {
  const entries = [{
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private" },
        { type: "image", mimeType: "image/png", data: "bytes" },
        { type: "toolCall", name: "read", arguments: { z: 1, a: 2 } },
        { type: "audio", data: "bytes" },
      ],
    },
  }] as unknown as SessionEntry[];
  const result = serializeTrajectory(entries);
  assert.match(result, /assistant thinking omitted/);
  assert.match(result, /image image\/png omitted/);
  assert.match(result, /\[tool call read\] \{"a":2,"z":1\}/);
  assert.match(result, /audio content omitted/);
  assert.doesNotMatch(result, /private|bytes/);
});

test("9. disabled automatic refinement ignores assistant messages", () => {
  const { pi } = fakePi();
  const controller = new ContinualRefinementController(pi, { agentDirectory: temporaryDirectory, config: { enabled: false, turnInterval: 1 } });
  controller.assistantMessageEnded({ role: "assistant", stopReason: "stop" });
  assert.equal(controller.status().assistantTurnsSinceReview, 0);
  assert.equal(controller.status().pendingIntervalReview, false);
});

test("10. only eligible completed assistant messages increment the interval", () => {
  const directory = temporaryDirectory();
  const { pi } = fakePi();
  const controller = new ContinualRefinementController(pi, { agentDirectory: () => directory, config: { turnInterval: 10 } });
  for (const message of [
    null,
    { role: "user", stopReason: "stop" },
    { role: "assistant", stopReason: "error" },
    { role: "assistant", stopReason: "aborted" },
    { role: "assistant", stopReason: "pending" },
  ]) controller.assistantMessageEnded(message);
  controller.assistantMessageEnded({ role: "assistant", stopReason: "stop" });
  assert.equal(controller.status().assistantTurnsSinceReview, 1);
});

test("11. reaching the configured interval marks a review pending", () => {
  const directory = temporaryDirectory();
  const { pi } = fakePi();
  const controller = new ContinualRefinementController(pi, { agentDirectory: () => directory, config: { turnInterval: 2 } });
  controller.assistantMessageEnded({ role: "assistant", stopReason: "stop" });
  assert.equal(controller.status().pendingIntervalReview, false);
  controller.assistantMessageEnded({ role: "assistant", stopReason: "stop" });
  assert.equal(controller.status().pendingIntervalReview, true);
});

test("12. extension factory registers the canonical lifecycle events and commands", () => {
  const directory = temporaryDirectory();
  const { pi, events, commands } = fakePi();
  const controller = createPrimeParityExtension({ agentDirectory: () => directory })(pi);
  assert.ok(controller instanceof ContinualRefinementController);
  assert.deepEqual([...events.keys()], [
    "before_agent_start", "message_end", "turn_end", "agent_settled", "session_compact", "session_tree", "session_shutdown", "session_start",
  ]);
  assert.deepEqual([...commands.keys()], ["refine", "refine-status"]);
});

test("13. before_agent_start appends persisted harness content without replacing the base prompt", () => {
  const directory = temporaryDirectory();
  writeJsonAtomic(join(directory, "continual-harness.json"), { version: 1, entries: [entry()] });
  const { pi, events } = fakePi();
  createPrimeParityExtension({ agentDirectory: () => directory })(pi);
  const { context } = fakeContext();
  const result = events.get("before_agent_start")!({ systemPrompt: "BASE" }, context);
  assert.match(result.systemPrompt, /^BASE\n\n## Continual harness/);
  assert.match(result.systemPrompt, /Focused regression/);
  assert.match(result.systemPrompt, /Run the focused regression/);
});

test("14. /refine parses standalone --global and durably queues instructions", async () => {
  const directory = temporaryDirectory();
  const { pi, commands } = fakePi();
  createPrimeParityExtension({ agentDirectory: () => directory })(pi);
  const { context, notifications } = fakeContext();
  await commands.get("refine")!.handler("remember --global this tactic", context);
  assert.deepEqual(JSON.parse(readFileSync(requestPath(directory), "utf8")), {
    pending: true,
    instructions: "remember this tactic",
    global: true,
  });
  assert.match(notifications.at(-1)!.message, /queued/);
});

test("15. /refine-status reports queue, counts, and eligible turns", async () => {
  const directory = temporaryDirectory();
  writeJsonAtomic(requestPath(directory), { pending: true });
  writeJsonAtomic(join(directory, "continual-harness.json"), { version: 1, entries: [entry()] });
  writeJsonAtomic(localHarnessPath(directory), { version: 1, entries: [entry({ id: "local" })] });
  const { pi, commands } = fakePi();
  createPrimeParityExtension({ agentDirectory: () => directory })(pi);
  const { context, notifications } = fakeContext();
  await commands.get("refine-status")!.handler("", context);
  assert.equal(notifications.at(-1)!.message, "Refinement pending\nGlobal entries: 1\nSession entries: 1\nEligible turns: 0");
});

test("16. manual refinement creates session-local state and appends bounded history metadata", async () => {
  const directory = temporaryDirectory();
  const proposal = { rationale: "repeatable evidence", edits: [{ action: "create", kind: "skill", title: "Regression workflow", content: "Run the reproducer first." }] };
  const { pi, appended } = fakePi();
  const controller = new ContinualRefinementController(pi, { agentDirectory: () => directory, now: () => 123 });
  const { context, notifications, completions } = fakeContext({ responses: [textResponse(proposal)] });
  await queueManual(controller, directory, context, { pending: true, instructions: "capture workflow", global: false });
  const harness = loadHarness(localHarnessPath(directory));
  assert.equal(harness.entries.length, 1);
  assert.equal(harness.entries[0].kind, "skill");
  assert.equal(appended.length, 1);
  assert.equal(appended[0].type, "prime-parity.refinement");
  assert.match(notifications.at(-1)!.message, /applied 1 edit/);
  assert.match(completions[0].context.messages[0].content[0].text, /capture workflow/);
  assert.equal(completions[0].options.maxTokens, 32_000);
});

test("17. manual global refinement writes only the global harness", async () => {
  const directory = temporaryDirectory();
  const { pi } = fakePi();
  const controller = new ContinualRefinementController(pi, { agentDirectory: () => directory });
  const { context } = fakeContext({ responses: [textResponse({ edits: [{ action: "create", kind: "memory", title: "Global fact", content: "Stable fact." }] })] });
  await queueManual(controller, directory, context, { pending: true, global: true });
  assert.equal(loadHarness(join(directory, "continual-harness.json")).entries.length, 1);
  assert.equal(loadHarness(localHarnessPath(directory)).entries.length, 0);
});

test("18. empty evidence-backed proposal succeeds without writing history", async () => {
  const directory = temporaryDirectory();
  const { pi, appended } = fakePi();
  const controller = new ContinualRefinementController(pi, { agentDirectory: () => directory });
  const { context, notifications } = fakeContext({ responses: [textResponse({ rationale: "insufficient", edits: [] })] });
  await queueManual(controller, directory, context, { pending: true });
  assert.equal(loadHarness(localHarnessPath(directory)).entries.length, 0);
  assert.equal(appended.length, 0);
  assert.equal(notifications.at(-1)!.message, "No evidence-backed refinement was found");
});

test("19. malformed or truncated curator output does not mutate the harness", async () => {
  const directory = temporaryDirectory();
  const { pi, appended } = fakePi();
  const controller = new ContinualRefinementController(pi, { agentDirectory: () => directory });
  const { context } = fakeContext({ responses: [textResponse('{"edits":[', "length")] });
  await queueManual(controller, directory, context, { pending: true });
  assert.equal(loadHarness(localHarnessPath(directory)).entries.length, 0);
  assert.equal(appended.length, 0);
});

test("20. proposals can update and delete existing entries by id", async () => {
  const directory = temporaryDirectory();
  writeJsonAtomic(localHarnessPath(directory), { version: 1, entries: [entry(), entry({ id: "remove", title: "Old" })] });
  const { pi } = fakePi();
  const controller = new ContinualRefinementController(pi, { agentDirectory: () => directory });
  const { context } = fakeContext({ responses: [textResponse({ edits: [
    { action: "update", id: "entry-1", title: "Updated title" },
    { action: "delete", id: "remove" },
  ] })] });
  await queueManual(controller, directory, context, { pending: true });
  const entries = loadHarness(localHarnessPath(directory)).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, "Updated title");
});

test("21. automatic interval review that declines refinement resets eligible turns after one model call", async () => {
  const directory = temporaryDirectory();
  const { pi } = fakePi();
  const controller = new ContinualRefinementController(pi, { agentDirectory: () => directory, config: { turnInterval: 1, cooldownMs: 0 } });
  const { context, completions } = fakeContext({ responses: [textResponse({ shouldRefine: false, rationale: "one-off noise" })] });
  controller.assistantMessageEnded({ role: "assistant", stopReason: "stop" });
  await controller.settled(context);
  assert.equal(completions.length, 1);
  assert.equal(controller.status().assistantTurnsSinceReview, 0);
  assert.equal(controller.status().pendingIntervalReview, false);
});

test("22. approved automatic review runs a second, session-local refinement pass", async () => {
  const directory = temporaryDirectory();
  const { pi, appended } = fakePi();
  const controller = new ContinualRefinementController(pi, { agentDirectory: () => directory, config: { turnInterval: 1, cooldownMs: 0 }, now: () => 500 });
  const { context, completions } = fakeContext({ responses: [
    textResponse({ shouldRefine: true, rationale: "Repeated parser failure", instructions: "retain the regression" }),
    textResponse({ rationale: "supported", edits: [{ action: "create", kind: "memory", title: "Parser regression", content: "Run parser regression." }] }),
  ] });
  controller.assistantMessageEnded({ role: "assistant", stopReason: "stop" });
  await controller.settled(context);
  assert.equal(completions.length, 2);
  assert.match(completions[0].context.systemPrompt, /review gate/);
  assert.match(completions[1].context.systemPrompt, /harness curator/);
  assert.match(completions[1].context.messages[0].content[0].text, /Target scope: session-local/);
  assert.equal(loadHarness(localHarnessPath(directory)).entries.length, 1);
  assert.equal((appended[0].data as any).source, "turn_interval");
});

test("23. cooldown uses the injected clock and scheduler instead of reviewing early", async () => {
  const directory = temporaryDirectory();
  let now = 100;
  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  const { pi } = fakePi();
  const controller = new ContinualRefinementController(pi, {
    agentDirectory: () => directory,
    config: { turnInterval: 1, cooldownMs: 1_000 },
    now: () => now,
    schedule: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; },
  });
  const { context, completions } = fakeContext({ responses: [textResponse({ shouldRefine: false, rationale: "not durable" })] });
  controller.assistantMessageEnded({ role: "assistant", stopReason: "stop" });
  await controller.settled(context);
  now = 200;
  controller.assistantMessageEnded({ role: "assistant", stopReason: "stop" });
  await controller.settled(context);
  assert.equal(completions.length, 1);
  assert.equal(scheduled.at(-1)!.delay, 900);
  assert.equal(controller.status().pendingIntervalReview, true);
  now = 1_100;
  scheduled.at(-1)!.callback();
  await controller.settled(context);
  assert.equal(completions.length, 2);
});

test("24. completed compaction takes priority and can trigger an automatic review", async () => {
  const directory = temporaryDirectory();
  const { pi } = fakePi();
  const controller = new ContinualRefinementController(pi, {
    agentDirectory: () => directory,
    config: { compact: true, turnInterval: 99, cooldownMs: 0 },
    schedule: () => 1,
  });
  const { context, completions } = fakeContext({ responses: [textResponse({ shouldRefine: false, rationale: "summary has no lesson" })] });
  controller.compactionCompleted(context);
  assert.equal(controller.status().pendingCompactionReview, true);
  await controller.settled(context);
  assert.equal(completions.length, 1);
  assert.match(completions[0].context.messages[0].content[0].text, /Trigger reason: compact/);
  assert.equal(controller.status().pendingCompactionReview, false);
});

test("25. branch invalidation aborts stale in-flight evidence and prevents a refinement pass", async () => {
  const directory = temporaryDirectory();
  let resolveReview!: (value: unknown) => void;
  const deferred = new Promise((resolve) => { resolveReview = resolve; });
  const { pi, appended } = fakePi();
  const controller = new ContinualRefinementController(pi, { agentDirectory: () => directory, config: { turnInterval: 1, cooldownMs: 0 } });
  const { context, completions } = fakeContext({ responses: [deferred] });
  controller.assistantMessageEnded({ role: "assistant", stopReason: "stop" });
  const drain = controller.settled(context);
  await Promise.resolve();
  assert.equal(completions.length, 1);
  const oldSignal = completions[0].options.signal as AbortSignal;
  controller.branchChanged();
  assert.equal(oldSignal.aborted, true);
  resolveReview(textResponse({ shouldRefine: true, rationale: "stale evidence" }));
  await drain;
  assert.equal(completions.length, 1);
  assert.equal(appended.length, 0);
  assert.equal(controller.status().assistantTurnsSinceReview, 0);
});


function conversationWindow(call: { context: any }): string {
  const prompt = call.context.messages[0].content[0].text as string;
  const match = prompt.match(/<conversation>\n([\s\S]*?)\n<\/conversation>/);
  assert.ok(match, "curator prompt must contain a delimited conversation");
  return match[1];
}

test("26. eligible turns 1 through 24 do not review and turn 25 reviews exactly once", async () => {
  const directory = temporaryDirectory();
  const { pi } = fakePi();
  const { context, completions } = fakeContext();
  const controller = new ContinualRefinementController(pi, {
    agentDirectory: () => directory,
    config: { turnInterval: 25, cooldownMs: 0 },
  });
  for (let turn = 1; turn <= 24; turn += 1) {
    controller.assistantMessageEnded({ role: "assistant", stopReason: "stop" });
    await controller.settled(context);
    assert.equal(completions.length, 0, `turn ${turn} must not review`);
  }
  controller.assistantMessageEnded({ role: "assistant", stopReason: "stop" });
  await controller.settled(context);
  assert.equal(completions.length, 1);
});

test("27. review and refinement receive the exact 40K and 80K serialized suffixes", async () => {
  const directory = temporaryDirectory();
  const longText = `${"prefix-".repeat(15_000)}UNIQUE-SUFFIX`;
  const entries = [{
    type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: longText, timestamp: 1 },
  }] as unknown as SessionEntry[];
  const serialized = serializeTrajectory(entries);
  const { pi } = fakePi();
  const { context, completions } = fakeContext({ entries, responses: [
    textResponse({ shouldRefine: true, rationale: "Repeated evidence", instructions: "Keep only the durable lesson" }),
    textResponse({ rationale: "Supported", edits: [] }),
  ] });
  const controller = new ContinualRefinementController(pi, {
    agentDirectory: () => directory,
    config: { turnInterval: 1, cooldownMs: 0 },
  });
  controller.assistantMessageEnded({ role: "assistant", stopReason: "stop" });
  await controller.settled(context);
  assert.equal(conversationWindow(completions[0]).length, 40_000);
  assert.equal(conversationWindow(completions[0]), serialized.slice(-40_000));
  assert.equal(conversationWindow(completions[1]).length, 80_000);
  assert.equal(conversationWindow(completions[1]), serialized.slice(-80_000));
  assert.ok(conversationWindow(completions[0]).endsWith("UNIQUE-SUFFIX"));
  assert.ok(conversationWindow(completions[1]).endsWith("UNIQUE-SUFFIX"));
});

test("28. manual and threshold successful compactions each request review", async () => {
  for (const reason of ["manual", "threshold"] as const) {
    const directory = temporaryDirectory();
    const { pi, events } = fakePi();
    const { context, completions } = fakeContext();
    createPrimeParityExtension({
      agentDirectory: () => directory,
      config: { cooldownMs: 0 },
      schedule: (callback) => { callback(); return 1; },
    })(pi);
    await events.get("session_compact")?.({ reason, compactionEntry: { type: "compaction", summary: "done" } }, context);
    await events.get("agent_settled")?.({}, context);
    assert.equal(completions.length, 1, `${reason} compaction must review once`);
    assert.match(completions[0].context.messages[0].content[0].text, /Trigger reason: compact/);
  }
});

test("29. cancelled or failed compaction without session_compact causes no review", async () => {
  const directory = temporaryDirectory();
  const { pi, events } = fakePi();
  const { context, completions } = fakeContext();
  createPrimeParityExtension({ agentDirectory: () => directory, config: { cooldownMs: 0 } })(pi);
  assert.equal(events.has("session_before_compact"), false);
  await events.get("agent_settled")?.({}, context);
  assert.equal(completions.length, 0);
});

test("30. simultaneous interval and compaction triggers run one review and retain rejected interval work", async () => {
  const directory = temporaryDirectory();
  const { pi } = fakePi();
  const { context, completions } = fakeContext({ responses: [
    textResponse({ shouldRefine: false, rationale: "No compact lesson" }),
    textResponse({ shouldRefine: false, rationale: "No interval lesson" }),
  ] });
  const controller = new ContinualRefinementController(pi, {
    agentDirectory: () => directory,
    config: { turnInterval: 1, cooldownMs: 0 },
  });
  controller.assistantMessageEnded({ role: "assistant", stopReason: "stop" });
  controller.compactionCompleted(context);
  await controller.settled(context);
  assert.equal(completions.length, 1);
  assert.equal(controller.status().pendingCompactionReview, false);
  assert.equal(controller.status().pendingIntervalReview, true);
  assert.equal(controller.status().assistantTurnsSinceReview, 1);
  await controller.settled(context);
  assert.equal(completions.length, 2);
});

test("31. malformed review JSON mutates no harness and does not launch refinement", async () => {
  const directory = temporaryDirectory();
  const { pi } = fakePi();
  const { context, completions } = fakeContext({ responses: [textResponse("{not-json")] });
  const controller = new ContinualRefinementController(pi, {
    agentDirectory: () => directory,
    config: { turnInterval: 1, cooldownMs: 1_200_000 },
    now: () => 5_000,
    schedule: () => 1,
  });
  controller.assistantMessageEnded({ role: "assistant", stopReason: "stop" });
  await controller.settled(context);
  assert.equal(completions.length, 1);
  assert.equal(loadHarness(localHarnessPath(directory)).entries.length, 0);
});

test("32. a failed explicit curator call cannot save the instructions directly", async () => {
  const directory = temporaryDirectory();
  const { pi } = fakePi();
  const { context } = fakeContext({ responses: [new Error("provider unavailable")] });
  const controller = new ContinualRefinementController(pi, { agentDirectory: () => directory });
  await queueManual(controller, directory, context, {
    pending: true, instructions: "Persist this verbatim", global: false,
  });
  assert.equal(loadHarness(localHarnessPath(directory)).entries.length, 0);
});

test("33. direct curator completion does not recursively increment assistant turns", async () => {
  const directory = temporaryDirectory();
  const { pi } = fakePi();
  const { context, completions } = fakeContext({ responses: [textResponse({ rationale: "None", edits: [] })] });
  const controller = new ContinualRefinementController(pi, { agentDirectory: () => directory });
  await queueManual(controller, directory, context, { pending: true, instructions: null, global: false });
  assert.equal(completions.length, 1);
  assert.equal(controller.status().assistantTurnsSinceReview, 0);
});

test("34. session replacement invalidates a pending review before it can apply", async () => {
  const directory = temporaryDirectory();
  let resolveReview!: (value: unknown) => void;
  const pending = new Promise((resolve) => { resolveReview = resolve; });
  const { pi } = fakePi();
  const { context, completions } = fakeContext({ responses: [pending] });
  const controller = new ContinualRefinementController(pi, {
    agentDirectory: () => directory,
    config: { turnInterval: 1, cooldownMs: 0 },
  });
  controller.assistantMessageEnded({ role: "assistant", stopReason: "stop" });
  const settling = controller.settled(context);
  await Promise.resolve();
  controller.startSession();
  resolveReview(textResponse({ shouldRefine: true, rationale: "stale" }));
  await settling;
  assert.equal(completions.length, 1);
  assert.equal(loadHarness(localHarnessPath(directory)).entries.length, 0);
});



test("35. trigger raised during cooldown remains pending and becomes recoverable when the clock advances", async () => {
  const directory = temporaryDirectory();
  let now = 100;
  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  const { pi } = fakePi();
  const controller = new ContinualRefinementController(pi, {
    agentDirectory: () => directory,
    config: { turnInterval: 1, cooldownMs: 1_000 },
    now: () => now,
    schedule: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; },
  });
  const { context, completions } = fakeContext({ responses: [
    textResponse({ shouldRefine: false, rationale: "first rejection" }),
    textResponse({ shouldRefine: false, rationale: "later rejection" }),
  ] });
  controller.assistantMessageEnded({ role: "assistant", stopReason: "stop" });
  await controller.settled(context);
  now = 200;
  controller.assistantMessageEnded({ role: "assistant", stopReason: "stop" });
  await controller.settled(context);
  assert.equal(controller.status().pendingIntervalReview, true);
  assert.equal(scheduled.at(-1)!.delay, 900);
  now = 1_100;
  await controller.settled(context);
  assert.equal(completions.length, 2);
  assert.equal(controller.status().pendingIntervalReview, false);
});

test("36. malformed review is distinct from an evidence-backed rejection and keeps the trigger recoverable", async () => {
  const directory = temporaryDirectory();
  const scheduled: number[] = [];
  const { pi } = fakePi();
  const controller = new ContinualRefinementController(pi, {
    agentDirectory: () => directory,
    config: { turnInterval: 1, cooldownMs: 50 },
    schedule: (_callback, delay) => { scheduled.push(delay); return scheduled.length; },
  });
  const { context, completions } = fakeContext({ responses: [textResponse({ rationale: "missing boolean" })] });
  controller.assistantMessageEnded({ role: "assistant", stopReason: "stop" });
  await controller.settled(context);
  assert.equal(completions.length, 1);
  assert.equal(controller.status().assistantTurnsSinceReview, 1);
  assert.equal(controller.status().pendingIntervalReview, true);
  assert.equal(scheduled.length, 1);
});

test("37. failed review model call does not fall back to a direct refinement or write state", async () => {
  const directory = temporaryDirectory();
  const { pi, appended } = fakePi();
  const controller = new ContinualRefinementController(pi, {
    agentDirectory: () => directory,
    config: { turnInterval: 1, cooldownMs: 100 },
    schedule: () => 1,
  });
  const { context, completions, notifications } = fakeContext({ responses: [new Error("provider unavailable")] });
  controller.assistantMessageEnded({ role: "assistant", stopReason: "stop" });
  await controller.settled(context);
  assert.equal(completions.length, 1);
  assert.equal(appended.length, 0);
  assert.equal(loadHarness(localHarnessPath(directory)).entries.length, 0);
  assert.equal(controller.status().pendingIntervalReview, true);
  assert.match(notifications[0].message, /provider unavailable/);
});

test("38. session replacement shutdown plus start invalidates stale review evidence", async () => {
  const directory = temporaryDirectory();
  let resolveReview!: (value: unknown) => void;
  const deferred = new Promise((resolve) => { resolveReview = resolve; });
  const { pi, appended } = fakePi();
  const controller = new ContinualRefinementController(pi, { agentDirectory: () => directory, config: { turnInterval: 1, cooldownMs: 0 } });
  const { context, completions } = fakeContext({ responses: [deferred] });
  controller.assistantMessageEnded({ role: "assistant", stopReason: "stop" });
  const draining = controller.settled(context);
  await Promise.resolve();
  const staleSignal = completions[0].options.signal as AbortSignal;
  controller.invalidate();
  controller.startSession();
  assert.equal(staleSignal.aborted, true);
  resolveReview(textResponse({ shouldRefine: true, rationale: "belongs to old session" }));
  await draining;
  assert.equal(completions.length, 1);
  assert.equal(appended.length, 0);
  assert.equal(controller.status().invalidated, false);
  assert.equal(controller.status().assistantTurnsSinceReview, 0);
});

test("39. successful atomic replacement leaves one complete destination and no temporary siblings", () => {
  const directory = temporaryDirectory();
  const path = join(directory, "state.json");
  writeFileSync(path, '{"generation":0}\n');
  chmodSync(path, 0o644);
  writeJsonAtomic(path, { generation: 1, nested: { complete: true } });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { generation: 1, nested: { complete: true } });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const siblings = readdirSync(directory);
  assert.deepEqual(siblings, ["state.json"]);
});


test("40. trigger arriving during review is retained and automatically drained", async () => {
  const directory = temporaryDirectory();
  let resolveFirst!: (value: unknown) => void;
  const first = new Promise((resolve) => { resolveFirst = resolve; });
  const scheduled: Array<() => void> = [];
  const { pi } = fakePi();
  const { context, completions } = fakeContext({ responses: [
    first,
    textResponse({ shouldRefine: false, rationale: "second checkpoint reviewed" }),
  ] });
  const controller = new ContinualRefinementController(pi, {
    agentDirectory: () => directory,
    config: { turnInterval: 1, cooldownMs: 0 },
    schedule: (callback) => { scheduled.push(callback); return scheduled.length; },
  });
  controller.assistantMessageEnded({ role: "assistant", stopReason: "stop" });
  const settling = controller.settled(context);
  await Promise.resolve();
  controller.assistantMessageEnded({ role: "assistant", stopReason: "stop" });
  scheduled.at(-1)?.();
  resolveFirst(textResponse({ shouldRefine: false, rationale: "first checkpoint reviewed" }));
  await settling;
  assert.equal(completions.length, 2);
  assert.equal(controller.status().assistantTurnsSinceReview, 0);
});

test("41. nested tool credentials are redacted before curator serialization", () => {
  const entries = [{
    type: "message", id: "tool", parentId: null, timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "assistant", stopReason: "toolUse", timestamp: 1,
      content: [{ type: "toolCall", id: "call", name: "deploy", arguments: {
        nested: { password: "super-secret", api_key: "key-value" },
        authorization: "Bearer bearer-value",
      } }],
    },
  }] as unknown as SessionEntry[];
  const serialized = serializeTrajectory(entries);
  assert.doesNotMatch(serialized, /super-secret|key-value|bearer-value/);
  assert.match(serialized, /<redacted>/);
});

test("42. overflow recovery compaction completion requests review", async () => {
  const directory = temporaryDirectory();
  const { pi, events } = fakePi();
  const { context, completions } = fakeContext();
  createPrimeParityExtension({ agentDirectory: () => directory, config: { cooldownMs: 0 } })(pi);
  events.get("session_compact")?.({
    reason: "overflow", willRetry: true,
    compactionEntry: { type: "compaction", summary: "recovered" },
  }, context);
  await events.get("agent_settled")?.({}, context);
  assert.equal(completions.length, 1);
});

test("43. /refine command flows through turn_end into an applied local edit", async () => {
  const directory = temporaryDirectory();
  const { pi, events, commands } = fakePi();
  const { context } = fakeContext({ responses: [textResponse({
    rationale: "explicit evidence", edits: [{ action: "create", kind: "memory", title: "Explicit lesson", content: "Validated by the trajectory." }],
  })] });
  createPrimeParityExtension({ agentDirectory: () => directory })(pi);
  await commands.get("refine")!.handler("focus on the validated lesson", context);
  await events.get("turn_end")?.({}, context);
  assert.equal(loadHarness(localHarnessPath(directory)).entries[0].title, "Explicit lesson");
});

test("44. concurrent global manual refinements serialize without losing either edit", async () => {
  const directory = temporaryDirectory();
  const firstPi = fakePi();
  const secondPi = fakePi();
  const first = fakeContext({ sessionId: "session-a", responses: [textResponse({
    rationale: "first", edits: [{ action: "create", kind: "memory", title: "First", content: "First durable lesson." }],
  })] });
  const second = fakeContext({ sessionId: "session-b", responses: [textResponse({
    rationale: "second", edits: [{ action: "create", kind: "memory", title: "Second", content: "Second durable lesson." }],
  })] });
  const firstController = new ContinualRefinementController(firstPi.pi, { agentDirectory: () => directory });
  const secondController = new ContinualRefinementController(secondPi.pi, { agentDirectory: () => directory });
  writeJsonAtomic(requestPath(directory, "session-a"), { pending: true, global: true });
  writeJsonAtomic(requestPath(directory, "session-b"), { pending: true, global: true });
  await Promise.all([firstController.turnEnded(first.context), secondController.turnEnded(second.context)]);
  const titles = loadHarness(join(directory, "continual-harness.json")).entries.map((item) => item.title).sort();
  assert.deepEqual(titles, ["First", "Second"]);
});
