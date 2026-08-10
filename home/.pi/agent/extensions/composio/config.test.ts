import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadComposioConfig, parseConfigFile } from "./config.js";

test("parseConfigFile normalizes toolkit slugs", () => {
  assert.deepEqual(
    parseConfigFile({
      userId: " user-123 ",
      toolkits: ["GitHub", "gmail", "github"],
      sandbox: false,
    }),
    {
      userId: "user-123",
      toolkits: ["github", "gmail"],
      sandbox: false,
      callbackUrl: undefined,
    },
  );
});

test("parseConfigFile rejects unknown keys", () => {
  assert.throws(() => parseConfigFile({ apiKey: "do-not-store-secrets-here" }), /unknown config key: apiKey/);
});

test("loadComposioConfig lets environment user ID override the file", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-composio-config-"));
  const configDirectory = join(home, ".config", "pi-composio");
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(
    join(configDirectory, "config.json"),
    JSON.stringify({ userId: "file-user", sandbox: false }),
  );

  assert.deepEqual(loadComposioConfig({ COMPOSIO_USER_ID: "env-user" }, home), {
    userId: "env-user",
    toolkits: undefined,
    sandbox: false,
    callbackUrl: undefined,
  });
});
