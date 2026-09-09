import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import extension, { cleanTitle } from "../index.ts";

function response(title = "Fix checkout login") {
  return { stopReason: "stop", content: [{ type: "text", text: title }] };
}

function user(content) {
  return { type: "message", message: { role: "user", content } };
}

function saved(title) {
  return { type: "custom", customType: "herdr-pane-name", data: { title } };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness({
  mode = "tui",
  entries = [],
  complete,
  exec,
  env = "1",
  pane = "w1:p1",
  model = { id: "selected-model" },
} = {}) {
  const handlers = new Map();
  const calls = [];
  const models = [];
  const notices = [];
  const ctx = {
    mode,
    model,
    sessionManager: { getEntries: () => entries },
    modelRegistry: {
      complete: async (...args) => {
        models.push(args);
        return complete ? complete(...args) : response();
      },
    },
    ui: { notify: (...args) => notices.push(args) },
  };
  const api = {
    on: (name, handler) => handlers.set(name, handler),
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    exec: async (...args) => {
      calls.push(args);
      if (exec) return exec(...args);
      return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w2:p9" } } }) };
    },
  };
  const previous = { HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID };
  process.env.HERDR_ENV = env;
  process.env.HERDR_PANE_ID = pane;
  try {
    extension(api);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const emit = async (name, event = {}) => {
    await handlers.get(name)?.(event, ctx);
    await setImmediate();
  };
  const prompt = async (text) => {
    await emit("input", { text, source: "interactive" });
    await emit("before_agent_start", { prompt: text });
  };
  return { emit, prompt, calls, models, notices, entries };
}

function renames(h) {
  return h.calls.filter(([, args]) => args[1] === "rename").map(([, args]) => args);
}

test("first request names only the caller's resolved pane and persists the title", async () => {
  const h = harness();
  await h.emit("session_start");
  assert.equal(h.calls.length, 0);
  await h.prompt("Please fix the login after checkout");
  assert.deepEqual(renames(h), [["pane", "rename", "w2:p9", "Fix checkout login"]]);
  assert.deepEqual(h.calls[0][1], ["pane", "current", "--current"]);
  assert.deepEqual(h.entries, [saved("Fix checkout login")]);
  assert.equal(h.models[0][0].id, "selected-model");
  assert.equal(h.models[0][1].messages[0].content, "Please fix the login after checkout");
  assert.equal(h.models[0][1].tools, undefined);
  assert.equal(h.models[0][2].maxTokens, 256);
  assert.ok(h.models[0][2].signal instanceof AbortSignal);
  assert.ok(h.models[0][2].sessionId);
  await h.prompt("Actually also change the search page");
  assert.equal(h.models.length, 1);
  assert.equal(renames(h).length, 1);
});

test("generation runs in the background and ignores followups while pending", async () => {
  const pending = deferred();
  const h = harness({ complete: () => pending.promise });
  await h.prompt("First task");
  await h.prompt("Second task");
  assert.equal(h.models.length, 1);
  assert.equal(h.calls.length, 0);
  pending.resolve(response());
  await setImmediate();
  assert.equal(renames(h).length, 1);
});

test("input alone does not name an extension-handled request", async () => {
  const h = harness();
  await h.emit("input", { text: "ping" });
  assert.equal(h.models.length, 0);
  await h.prompt("Real request");
  assert.equal(h.models[0][1].messages[0].content, "Real request");
});

for (const mode of ["rpc", "json", "print"]) {
  test(`${mode} subprocesses cannot rename their parent's pane`, async () => {
    const h = harness({ mode, entries: [saved("Old title")] });
    await h.emit("session_start");
    await h.prompt("Nested task");
    assert.equal(h.models.length, 0);
    assert.equal(h.calls.length, 0);
  });
}

for (const options of [{ env: "0" }, { env: "" }, { pane: "" }]) {
  test(`missing Herdr context is a no-op: ${JSON.stringify(options)}`, async () => {
    const h = harness(options);
    await h.emit("session_start");
    await h.prompt("Do something");
    assert.equal(h.models.length, 0);
    assert.equal(h.calls.length, 0);
  });
}

for (const reason of ["startup", "resume", "reload", "fork"]) {
  test(`${reason} restores a saved title without another model call`, async () => {
    const h = harness({
      entries: [user("Original task"), saved("Stored title"), user("Different followup")],
    });
    await h.emit("session_start", { reason });
    await h.prompt("New followup");
    assert.equal(h.models.length, 0);
    assert.equal(renames(h)[0][3], "Stored title");
    assert.equal(h.entries.length, 3);
  });
}

test("resuming an old/compacted session uses its first user message, not the latest", async () => {
  const h = harness({
    entries: [
      { type: "custom_message", content: "Harness instructions" },
      user([
        { type: "image", data: "not-sent" },
        { type: "text", text: "Original request" },
      ]),
      { type: "compaction", summary: "Summary" },
      user("Latest request"),
    ],
  });
  await h.emit("session_start");
  assert.equal(h.models[0][1].messages[0].content, "Original request");
});

test("first image-only request gets a stable fallback, never the later text request", async () => {
  const h = harness({ entries: [user([{ type: "image", data: "secret" }]), user("Followup")] });
  await h.emit("session_start");
  assert.equal(h.models.length, 0);
  assert.equal(renames(h)[0][3], "Image request");
});

test("new sessions name their new first request", async () => {
  const first = harness();
  await first.prompt("Old request");
  await first.emit("session_shutdown");
  const next = harness({ complete: () => response("New task") });
  await next.emit("session_start", { reason: "new" });
  await next.prompt("New request");
  assert.equal(renames(next)[0][3], "New task");
});

test("late model completion after shutdown cannot persist or rename", async () => {
  const pending = deferred();
  const h = harness({ complete: () => pending.promise });
  await h.prompt("Old request");
  await h.emit("session_shutdown");
  assert.equal(h.models[0][2].signal.aborted, true);
  pending.resolve(response("Stale title"));
  await setImmediate();
  assert.equal(h.entries.length, 0);
  assert.equal(h.calls.length, 0);
});

test("shutdown between caller resolution and rename cancels the old write", async () => {
  const pending = deferred();
  const h = harness({ exec: () => pending.promise });
  await h.prompt("Task");
  const shutdown = h.emit("session_shutdown");
  pending.resolve({ code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w9:p9" } } }) });
  await shutdown;
  assert.equal(renames(h).length, 0);
});

for (const complete of [
  () => {
    throw new Error("provider down");
  },
  () => ({ stopReason: "error", content: [] }),
  () => response(""),
]) {
  test("model failure uses a bounded fallback without disrupting the request", async () => {
    const h = harness({ complete });
    await h.prompt("authorization=Bearer private-token");
    assert.equal(renames(h).length, 1);
    assert.equal(renames(h)[0][3], "Coding task");
    assert.doesNotMatch(JSON.stringify(h.entries), /private-token/);
    assert.equal(h.notices.length, 1);
  });
}

test("missing model uses a generic fallback", async () => {
  const h = harness({ model: null });
  await h.prompt("password=private-password");
  assert.equal(renames(h)[0][3], "Coding task");
  assert.doesNotMatch(JSON.stringify(h.entries), /private-password/);
});

for (const exec of [
  () => {
    throw new Error("ENOENT");
  },
  () => ({ code: 1, stdout: "" }),
  () => ({ code: 0, killed: true, stdout: "{}" }),
  () => ({ code: 0, stdout: "not json" }),
  () => ({ code: 0, stdout: "{}" }),
]) {
  test("Herdr resolution failures never fall back to a focused pane", async () => {
    const h = harness({ exec });
    await h.prompt("Task");
    assert.equal(renames(h).length, 0);
    assert.equal(h.entries.length, 1);
    assert.equal(h.notices.length, 1);
  });
}

test("rename failure is visible and can be retried on reload without regeneration", async () => {
  const h = harness({
    exec: (_command, args) =>
      args[1] === "current"
        ? { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w2:p9" } } }) }
        : { code: 1 },
  });
  await h.prompt("Task");
  assert.equal(h.notices.length, 1);
  const retry = harness({ entries: h.entries });
  await retry.emit("session_start", { reason: "reload" });
  assert.equal(retry.models.length, 0);
  assert.equal(renames(retry).length, 1);
});

test("raw skill request wins over expansion; resumed skills omit their instruction body", async () => {
  const h = harness();
  await h.emit("input", { text: "/skill:review Fix login" });
  await h.emit("before_agent_start", {
    prompt: '<skill name="review">Lots of instructions</skill>\nFix login',
  });
  assert.equal(h.models[0][1].messages[0].content, "/skill:review Fix login");
  const resumed = harness({
    entries: [user('<skill name="review">Lots of instructions</skill>\nFix login')],
  });
  await resumed.emit("session_start");
  assert.equal(resumed.models[0][1].messages[0].content, "Fix login");
});

test("model prompt is bounded and title text is not interpreted as shell syntax", async () => {
  const h = harness({ complete: () => response("Fix $(touch /tmp/not-executed)") });
  await h.prompt("x".repeat(20_000));
  assert.equal(h.models[0][1].messages[0].content.length, 8_000);
  assert.equal(renames(h)[0][3], "Fix $(touch /tmp/not-executed)");
  assert.equal(h.calls[1][0], "herdr");
});

test("title cleanup removes controls and decorations and preserves Unicode", () => {
  assert.equal(cleanTitle('\x1b]0;bad\x07\x1b[31m**"Fix\n login"**\x1b[0m'), "Fix login");
  assert.equal(cleanTitle("Fix\u202e login\u2014flow."), "Fix login-flow");
  assert.equal(cleanTitle("😀".repeat(60)), "😀".repeat(48));
  assert.equal(cleanTitle("--clear"), "clear");
  assert.equal(cleanTitle("\u2014clear"), "clear");
});
