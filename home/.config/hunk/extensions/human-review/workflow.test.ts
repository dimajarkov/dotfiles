import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionReviewSnapshot } from "hunkdiff/extension";
import { Herdr, compatible, agentPrompt } from "./herdr";
import type { Agent } from "./herdr";
import { fence, unchanged, requireUnchanged } from "./index";
import {
  attempts,
  deliver,
  immutableFile,
  privateDirectory,
  rememberOrigin,
  stateDirectory,
  writeBatch,
} from "./storage";

const checkout = mkdtempSync(join(tmpdir(), "hunk-adapter-checkout."));
const target: Agent = {
  agent: "codex",
  agent_status: "idle",
  pane_id: "w1:p2",
  terminal_id: "term-one",
  cwd: checkout,
  foreground_cwd: checkout,
  agent_session: { agent: "codex", kind: "id", source: "herdr:codex", value: "session-one" },
};
const snapshot: ExtensionReviewSnapshot = {
  generation: "g1",
  stateRevision: 1,
  files: [],
  notes: [],
};

describe("authoritative revision guard", () => {
  test("generation, state revision and unavailable review refuse work", () => {
    expect(unchanged(snapshot, snapshot)).toBe(true);
    for (const current of [
      null,
      { ...snapshot, generation: "g2" },
      { ...snapshot, stateRevision: 2 },
    ]) {
      expect(unchanged(snapshot, current)).toBe(false);
      expect(() => requireUnchanged(snapshot, { review: { snapshot: () => current } })).toThrow(
        "Review changed",
      );
    }
  });
});

describe("private durable storage", () => {
  test("exclusive immutable JSON, Markdown, complete multiline text and checksum", () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-storage."));
    const text = "Quotes \" and '\n```danger```\nsecond line";
    const batch = writeBatch(root, { notes: [{ summary: text }] }, "fingerprint", fence(text));
    expect(JSON.parse(readFileSync(batch.json, "utf8")).notes[0].summary).toBe(text);
    expect(readFileSync(batch.markdown, "utf8")).toContain(text);
    expect(statSync(batch.json).mode & 0o777).toBe(0o400);
    expect(statSync(batch.directory).mode & 0o777).toBe(0o700);
    expect(() => immutableFile(batch.json, "replace")).toThrow();
    expect(agentPrompt(batch, checkout)).toContain(readFileSync(batch.json, "utf8"));
    expect(agentPrompt(batch, checkout)).toContain(batch.sha256);
  });
  test("original context cannot be overwritten after reconciliation", () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-origins."));
    const original = {
      note: { id: "one", anchor: { oldRange: [2, 2] } },
      file: { path: "file" },
      inventory: [],
      patch: "original",
      scope: "unstaged",
      capturedAt: "now",
    };
    rememberOrigin(root, checkout, "one", original);
    expect(rememberOrigin(root, checkout, "one", { ...original, patch: "later" })).toEqual(
      original,
    );
  });
  test("public state directories and paths in another Git checkout are rejected", () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-private."));
    const publicDir = join(root, "public");
    mkdirSync(publicDir, { mode: 0o755 });
    expect(() => privateDirectory(publicDir)).toThrow("owner-private");
    const repo = join(root, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, ".git"), "gitdir: whatever");
    const previous = process.env.HUNK_HUMAN_REVIEW_STATE_DIRECTORY;
    try {
      const repoExports = join(repo, "exports");
      process.env.HUNK_HUMAN_REVIEW_STATE_DIRECTORY = repoExports;
      expect(() => stateDirectory(checkout)).toThrow("Git checkouts");
      expect(existsSync(repoExports)).toBe(false);
      const checkoutExports = join(checkout, "exports");
      process.env.HUNK_HUMAN_REVIEW_STATE_DIRECTORY = checkoutExports;
      expect(() => stateDirectory(checkout)).toThrow("outside");
      expect(existsSync(checkoutExports)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.HUNK_HUMAN_REVIEW_STATE_DIRECTORY;
      else process.env.HUNK_HUMAN_REVIEW_STATE_DIRECTORY = previous;
    }
  });
  test("delivery failures retain uncertain receipts and explicit duplicate attempts", async () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-delivery."));
    const batch = writeBatch(root, {}, "same-content", "Review");
    await expect(
      deliver(root, batch, target, async () => {
        throw new Error("blocked");
      }),
    ).rejects.toThrow("blocked");
    expect(attempts(root, batch.fingerprint)).toContainEqual(
      expect.objectContaining({ state: "uncertain" }),
    );
    await deliver(root, batch, target, async () => {});
    expect(attempts(root, batch.fingerprint)).toContainEqual(
      expect.objectContaining({ state: "accepted" }),
    );
  });
  test("concurrent duplicate submission is blocked before any second prompt", async () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-concurrent."));
    const batch = writeBatch(root, {}, "same-content", "Review");
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = deliver(root, batch, target, () => gate);
    let secondSent = false;
    await expect(
      deliver(root, batch, target, async () => {
        secondSent = true;
      }),
    ).rejects.toThrow();
    expect(secondSent).toBe(false);
    release();
    await first;
  });
});

describe("validated Herdr adapter", () => {
  test("same canonical checkout, recognized session and settled agent required", () => {
    expect(compatible(target, checkout)).toBe(true);
    for (const agent of [
      { ...target, agent_status: "blocked" },
      { ...target, agent_status: "working" },
      { ...target, agent_status: "unknown" },
      { ...target, foreground_cwd: tmpdir() },
      { ...target, cwd: tmpdir() },
      { ...target, agent_session: undefined },
      { ...target, agent_session: { ...target.agent_session!, agent: "pi" } },
      { ...target, agent_session: { ...target.agent_session!, kind: "unknown" } },
      { ...target, agent: "claude" },
    ])
      expect(compatible(agent, checkout)).toBe(false);
  });
  test("missing/ambiguous Herdr sessions fail closed", async () => {
    for (const sessions of [
      [],
      [{ name: "review", running: false }],
      [
        { name: "review", running: true },
        { name: "review", running: true },
      ],
    ]) {
      const adapter = new Herdr("review", "/herdr", async () => JSON.stringify({ sessions }));
      await expect(adapter.list(checkout)).rejects.toThrow("missing or ambiguous");
    }
  });
  test("duplicate pane identities reject ambiguous agent inventories", async () => {
    const adapter = new Herdr("review", "/herdr", async (_binary, args) =>
      JSON.stringify(
        args[0] === "session"
          ? { sessions: [{ name: "review", running: true }] }
          : { result: { agents: [target, { ...target, name: "another label" }] } },
      ),
    );
    await expect(adapter.list(checkout)).rejects.toThrow("Ambiguous Herdr agent inventory");
  });
  test("replacement, disappearing, busy or blocked agents reject before delivery", async () => {
    for (const current of [
      { ...target, terminal_id: "other" },
      { ...target, agent_session: { ...target.agent_session!, value: "other" } },
      { ...target, agent_status: "blocked" },
    ]) {
      const adapter = new Herdr("review", "/herdr", async () =>
        JSON.stringify({ result: { agent: current } }),
      );
      await expect(adapter.validate(target, checkout)).rejects.toThrow("replaced");
    }
    await expect(
      new Herdr("review", "/herdr", async () => {
        throw new Error("missing");
      }).validate(target, checkout),
    ).rejects.toThrow("missing");
  });
  test("quote, newline and shell syntax remain one argument in the explicit named session", async () => {
    const mutableCalls: string[][] = [];
    const adapter = new Herdr("review", "/herdr", async (_binary, args) => {
      mutableCalls.push([...args]);
      return JSON.stringify({ result: { type: "agent_prompted" } });
    });
    const text = "Quotes \" '\n$(touch /never) `not-shell`; end";
    await adapter.prompt(target, text);
    expect(mutableCalls).toEqual([
      ["agent", "prompt", target.pane_id, text, "--session", "review"],
    ]);
  });
  test("unacknowledged delivery is an error, not success", async () => {
    for (const response of [{ error: { code: "agent_blocked" } }, { result: { type: "wrong" } }])
      await expect(
        new Herdr("review", "/herdr", async () => JSON.stringify(response)).prompt(target, "text"),
      ).rejects.toThrow("did not acknowledge");
  });
});
