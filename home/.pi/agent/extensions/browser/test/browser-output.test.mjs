import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "typebox") return { url: "browser-test:typebox", shortCircuit: true };
    if (specifier === "playwright-core") {
      return { url: "browser-test:playwright-core", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "browser-test:typebox") {
      return {
        format: "module",
        source: "export const Type = new Proxy({}, { get: () => (...args) => ({}) });",
        shortCircuit: true,
      };
    }
    if (url === "browser-test:playwright-core") {
      return {
        format: "module",
        source: "export const chromium = globalThis.__browserTestChromium;",
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const { default: browserExtension } = await import("../index.ts");

test("passive browser URL outputs redact credentials", async () => {
  const tools = new Map();
  const commands = new Map();
  const pageHandlers = new Map();
  const finalUrl =
    "https://app.test/callback?access_token=goto-secret#refresh_token=fragment-secret";
  const page = {
    isClosed: () => false,
    on: (event, handler) => pageHandlers.set(event, handler),
    goto: async () => ({ status: () => 302 }),
    url: () => finalUrl,
  };
  const context = {
    pages: () => [page],
    close: async () => {},
  };
  globalThis.__browserTestChromium = {
    launchPersistentContext: async () => context,
  };
  const pi = {
    appendEntry: () => {},
    getActiveTools: () => [],
    on: () => {},
    registerCommand: (name, command) => commands.set(name, command),
    registerTool: (tool) => tools.set(tool.name, tool),
    setActiveTools: () => {},
  };
  browserExtension(pi);

  const gotoResult = await tools.get("browser_goto").execute("call", {
    url: "https://app.test/start",
  });
  assert.equal(
    gotoResult.details.finalUrl,
    "https://app.test/callback?access_token=%5BREDACTED%5D#refresh_token=%5BREDACTED%5D",
  );
  assert.doesNotMatch(JSON.stringify(gotoResult), /(?:goto|fragment)-secret/);

  pageHandlers.get("console")({
    location: () => ({
      url: "https://app.test/source.ts?code=console-secret",
      lineNumber: 17,
    }),
    text: () => "failure",
    type: () => "error",
  });
  const consoleResult = await tools.get("browser_console").execute("call", {});
  assert.equal(
    consoleResult.details.entries[0].location,
    "https://app.test/source.ts?code=%5BREDACTED%5D:17",
  );
  assert.doesNotMatch(JSON.stringify(consoleResult), /console-secret/);

  const notifications = [];
  await commands.get("browser").handler("", {
    ui: { notify: (message) => notifications.push(message) },
  });
  assert.equal(
    notifications[0],
    "browser tools: disabled (run /browser on), open at https://app.test/callback?access_token=%5BREDACTED%5D#refresh_token=%5BREDACTED%5D",
  );
  assert.doesNotMatch(notifications[0], /(?:goto|fragment)-secret/);
});
