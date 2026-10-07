import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  buildFallbackRecap,
  createRunBoundary,
  getRunEntries,
  serializeRunTranscript,
  TRANSCRIPT_MAX_BYTES,
} from "./src/transcript.ts";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function entry(
  id: string,
  message: Extract<SessionEntry, { type: "message" }>["message"],
): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    message,
  };
}

test("run boundaries replace stale starts and settle exactly once", () => {
  const boundary = createRunBoundary();
  boundary.begin("before-run");
  boundary.begin("new-top-level-run");

  assert.deepEqual(boundary.settle(), {
    baselineLeafId: "new-top-level-run",
  });
  assert.equal(boundary.settle(), undefined);
});

test("run slicing starts after the before_agent_start leaf", () => {
  const entries = [
    entry("old", { role: "user", content: "old", timestamp: 0 }),
    entry("new", { role: "user", content: "new", timestamp: 1 }),
  ];
  assert.deepEqual(
    getRunEntries(entries, "old").map((item) => item.id),
    ["new"],
  );
  assert.deepEqual(getRunEntries(entries, "missing"), []);
});

test("transcript omits thinking, images, and recap entries while redacting tool data", () => {
  const entries: SessionEntry[] = [
    entry("user", {
      role: "user",
      content: [
        { type: "text", text: "Update the client" },
        { type: "image", data: "base64-image-bytes", mimeType: "image/png" },
      ],
      timestamp: 0,
    }),
    entry("assistant", {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hidden chain of thought" },
        {
          type: "toolCall",
          id: "call-1",
          name: "bash",
          arguments: {
            command: "curl -H 'Authorization: Bearer very-secret-token' https://example.test",
            apiKey: "sk-super-secret-value",
            secretary: "Alice Smith",
            tokenizer: "bpe-vocabulary",
            payload: "x".repeat(10_000),
          },
        },
        { type: "text", text: "Updated the client." },
      ],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      usage,
      stopReason: "toolUse",
      timestamp: 1,
    }),
    entry("result", {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "token=another-secret\nfinished" }],
      isError: false,
      timestamp: 2,
    }),
    {
      type: "custom",
      id: "old-recap",
      parentId: "result",
      timestamp: new Date(0).toISOString(),
      customType: "summary-recap",
      data: { recap: "old recap" },
    },
  ];

  const transcript = serializeRunTranscript(entries);
  assert.match(transcript, /Update the client/);
  assert.match(transcript, /TOOL CALL bash/);
  assert.match(transcript, /Updated the client/);
  assert.match(transcript, /Alice Smith/);
  assert.match(transcript, /bpe-vocabulary/);
  assert.doesNotMatch(transcript, /hidden chain of thought/);
  assert.doesNotMatch(transcript, /base64-image-bytes/);
  assert.doesNotMatch(transcript, /very-secret-token/);
  assert.doesNotMatch(transcript, /another-secret/);
  assert.doesNotMatch(transcript, /old recap/);
  assert.match(transcript, /\[REDACTED\]/);
  assert.match(transcript, /tool arguments capped/);
});

test("serialized transcripts redact complete and truncated PEM and OpenPGP private keys", () => {
  const completeKey = [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "synthetic-complete-key-material",
    "-----END OPENSSH PRIVATE KEY-----",
  ].join("\n");
  const truncatedKey = ["-----BEGIN RSA PRIVATE KEY-----", "synthetic-truncated-key-material"].join(
    "\n",
  );
  const completeArmoredKey = [
    "-----BEGIN PGP PRIVATE KEY BLOCK-----",
    "synthetic-complete-armored-key-material",
    "-----END PGP PRIVATE KEY BLOCK-----",
  ].join("\n");
  const truncatedArmoredKey = [
    "-----BEGIN PGP PRIVATE KEY BLOCK-----",
    "synthetic-truncated-armored-key-material",
  ].join("\n");
  const transcript = serializeRunTranscript([
    entry("key-output", {
      role: "toolResult",
      toolCallId: "call-key-output",
      toolName: "bash",
      content: [
        {
          type: "text",
          text: [completeKey, truncatedKey, completeArmoredKey, truncatedArmoredKey].join("\n"),
        },
      ],
      isError: false,
      timestamp: 0,
    }),
  ]);

  assert.match(transcript, /\[REDACTED\]/);
  assert.doesNotMatch(transcript, /synthetic-(?:complete|truncated)(?:-armored)?-key-material/);
  assert.doesNotMatch(transcript, /-----BEGIN|-----END/);
});

test("serialized transcripts redact known provider secrets but preserve publishable Stripe keys", () => {
  const credentials = [
    "github_pat_0123456789abcdef",
    "ghp_0123456789abcdef",
    "glpat-0123456789abcdef",
    "xoxb-12345678-abcdefgh",
    "sk_live_0123456789abcdef",
    "sk_test_0123456789abcdef",
    "rk_live_0123456789abcdef",
    "rk_test_0123456789abcdef",
    "whsec_0123456789abcdef",
    "sk-proj-0123456789abcdef",
    "AIza0123456789abcdef",
    "AKIA12345678",
    "pypi-0123456789abcdef",
    "npm_0123456789abcdef",
    "hf_0123456789",
    "dop_v1_0123456789abcdef",
    "shpat_0123456789abcdef",
    "SG.0123456789abcdef.abcdef0123456789",
  ];
  const publishableKeys = ["pk_live_0123456789abcdef", "pk_test_0123456789abcdef"];
  const transcript = serializeRunTranscript([
    entry("credentials", {
      role: "toolResult",
      toolCallId: "call-credentials",
      toolName: "bash",
      content: [{ type: "text", text: [...credentials, ...publishableKeys].join("\n") }],
      isError: false,
      timestamp: 0,
    }),
  ]);

  for (const credential of credentials) assert.ok(!transcript.includes(credential));
  for (const key of publishableKeys) assert.ok(transcript.includes(key));
});

test("serialized transcripts redact database URL credentials across message sources", () => {
  const passwords = [
    "synthetic-user-content-password",
    "synthetic-tool-argument-password",
    "synthetic-tool-output-password",
    "synthetic-shell-command-password",
    "synthetic-shell-output-password",
  ];
  const transcript = serializeRunTranscript([
    entry("db-user-content", {
      role: "user",
      content: `Please check DATABASE_URL=postgres://fixture-user:${passwords[0]}@db.example.test/demo`,
      timestamp: 0,
    }),
    entry("db-tool-call", {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-db",
          name: "connect",
          arguments: {
            databaseUrl: `postgresql://fixture-user:${passwords[1]}@db.example.test/demo`,
            customerName: "Ada Example",
            customerEmail: "ada@example.test",
          },
        },
      ],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      usage,
      stopReason: "toolUse",
      timestamp: 1,
    }),
    entry("db-tool-result", {
      role: "toolResult",
      toolCallId: "call-db",
      toolName: "connect",
      content: [
        {
          type: "text",
          text: `DATABASE_URL=mysql://fixture-user:${passwords[2]}@db.example.test/demo`,
        },
      ],
      isError: false,
      timestamp: 2,
    }),
    entry("db-shell", {
      role: "bashExecution",
      command: `psql postgresql://fixture-user:${passwords[3]}@db.example.test/demo`,
      output: `DATABASE_URL=postgres://fixture-user:${passwords[4]}@db.example.test/demo`,
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 3,
    }),
  ]);

  for (const password of passwords) assert.ok(!transcript.includes(password));
  assert.match(transcript, /Ada Example/);
  assert.match(transcript, /ada@example\.test/);
});

test("URI userinfo redaction consumes embedded at-signs without crossing JSON fields", () => {
  const password = "synthetic-password-with@signs";
  const transcript = serializeRunTranscript([
    entry("uri-userinfo", {
      role: "toolResult",
      toolCallId: "call-uri-userinfo",
      toolName: "inspect",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            url: `postgres://fixture-user:${password}@db.example.test/demo`,
            customerEmail: "ada@example.test",
          }),
        },
      ],
      isError: false,
      timestamp: 0,
    }),
  ]);

  assert.ok(!transcript.includes(password));
  assert.ok(!transcript.includes("signs@db.example.test"));
  assert.ok(transcript.includes("ada@example.test"));
  assert.ok(transcript.includes("db.example.test/demo"));
});

test("credential field matching preserves ordinary words in serialized output", () => {
  const fields = {
    secretary: "Alice Smith",
    secretariat: "Operations team",
    monkey: "Capuchin",
    keynote: "Main stage",
    tokenizer: "BPE vocabulary",
    clientSecret: "synthetic-client-secret-value",
    api_key: "synthetic-api-key-value",
    refreshToken: "synthetic-refresh-token-value",
    access_key: "synthetic-access-key-value",
    privateKey: "synthetic-private-key-value",
    passwd: "synthetic-passwd-value",
    authorization: "synthetic-authorization-value",
  };
  const transcript = serializeRunTranscript([
    entry("credential-fields", {
      role: "toolResult",
      toolCallId: "call-credential-fields",
      toolName: "bash",
      content: [{ type: "text", text: JSON.stringify(fields) }],
      isError: false,
      timestamp: 0,
    }),
  ]);

  for (const [key, value] of Object.entries(fields).slice(0, 5)) {
    assert.ok(transcript.includes(`"${key}":"${value}"`));
  }
  for (const value of Object.values(fields).slice(5)) {
    assert.ok(!transcript.includes(value));
  }
  assert.match(transcript, /"clientSecret":"\[REDACTED\]"/);
  assert.match(transcript, /"api_key":"\[REDACTED\]"/);
});

test("fallback recap derives a short title from the run request", () => {
  const entries = [
    entry("user", {
      role: "user",
      content:
        "I want you to add semantic titles to the run recap extension instead of a generic heading.",
      timestamp: 0,
    }),
    entry("assistant", {
      role: "assistant",
      content: [{ type: "text", text: "Added semantic recap titles." }],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      usage,
      stopReason: "stop",
      timestamp: 1,
    }),
  ];

  assert.equal(buildFallbackRecap(entries).title, "Add semantic titles to the run recap extension");
});

test("transcript enforces per-result and total byte caps", () => {
  const entries = Array.from({ length: 20 }, (_, index) =>
    entry(`result-${index}`, {
      role: "toolResult",
      toolCallId: `call-${index}`,
      toolName: "bash",
      content: [{ type: "text", text: `${index}:${"x".repeat(10_000)}` }],
      isError: false,
      timestamp: index,
    }),
  );

  const transcript = serializeRunTranscript(entries);
  assert.ok(Buffer.byteLength(transcript, "utf8") <= TRANSCRIPT_MAX_BYTES);
  assert.match(transcript, /transcript capped/);
  assert.match(transcript, /tool result capped/);
});
