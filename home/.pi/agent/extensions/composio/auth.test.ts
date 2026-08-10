import assert from "node:assert/strict";
import test from "node:test";
import { resolveComposioApiKey } from "./auth.js";

test("environment API key takes precedence over Keychain", () => {
  let keychainRead = false;
  const apiKey = resolveComposioApiKey({
    environment: { COMPOSIO_API_KEY: " environment-key " },
    platform: "darwin",
    account: "test-user",
    readKeychain: () => {
      keychainRead = true;
      return "keychain-key";
    },
  });

  assert.equal(apiKey, "environment-key");
  assert.equal(keychainRead, false);
});

test("API key file takes precedence over Keychain", () => {
  let keychainRead = false;
  const apiKey = resolveComposioApiKey({
    environment: {},
    platform: "darwin",
    apiKeyFile: "/test/api-key",
    readApiKeyFile: (path) => (path === "/test/api-key" ? " file-key " : undefined),
    readKeychain: () => {
      keychainRead = true;
      return "keychain-key";
    },
  });

  assert.equal(apiKey, "file-key");
  assert.equal(keychainRead, false);
});

test("macOS falls back to the configured Keychain account", () => {
  let requestedAccount: string | undefined;
  const apiKey = resolveComposioApiKey({
    environment: {},
    platform: "darwin",
    account: "test-user",
    readApiKeyFile: () => undefined,
    readKeychain: (account) => {
      requestedAccount = account;
      return " keychain-key ";
    },
  });

  assert.equal(apiKey, "keychain-key");
  assert.equal(requestedAccount, "test-user");
});

test("non-macOS systems require the environment variable", () => {
  const apiKey = resolveComposioApiKey({
    environment: {},
    platform: "linux",
    readApiKeyFile: () => undefined,
    readKeychain: () => "must-not-be-used",
  });

  assert.equal(apiKey, undefined);
});
