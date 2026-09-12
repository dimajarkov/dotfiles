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
  let currentUrl =
    "https://app.test/callback?access_token=goto-secret#refresh_token=fragment-secret";
  let navigationError;
  const page = {
    isClosed: () => false,
    on: (event, handler) => pageHandlers.set(event, handler),
    click: async () => {
      throw Object.assign(
        new Error("click failed at https://app.test/button?code=click-secret"),
        { cause: new Error("cause https://app.test/?token=cause-secret") },
      );
    },
    goto: async () => {
      if (navigationError) throw navigationError;
      return { status: () => 302 };
    },
    url: () => currentUrl,
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
    text: () =>
      "GET /callback?access_token=console-text-secret\x1b]52;c;CONSOLE-CONTROL\x07 failed",
    type: () => "error",
  });
  pageHandlers.get("pageerror")({
    name: "Error",
    message: "boom\x1b]52;c;PAGEERROR-CONTROL\x07 after",
  });
  const consoleResult = await tools.get("browser_console").execute("call", {});
  assert.equal(
    consoleResult.details.entries[0].location,
    "https://app.test/source.ts?code=%5BREDACTED%5D:17",
  );
  assert.equal(
    consoleResult.details.entries[0].text,
    "GET /callback?access_token=%5BREDACTED%5D failed",
  );
  assert.equal(consoleResult.details.entries[1].text, "Error: boom after");
  assert.doesNotMatch(
    JSON.stringify(consoleResult),
    /console(?:-text)?-secret|(?:CONSOLE|PAGEERROR)-CONTROL|\x1b\]52;/u,
  );

  const notifications = [];
  await commands.get("browser").handler("", {
    ui: { notify: (message) => notifications.push(message) },
  });
  assert.equal(
    notifications[0],
    "browser tools: disabled (run /browser on), open at https://app.test/callback?access_token=%5BREDACTED%5D#refresh_token=%5BREDACTED%5D",
  );
  assert.doesNotMatch(notifications[0], /(?:goto|fragment)-secret/);

  currentUrl = "https://dead.invalid/callback?access_token=redirect-secret";
  navigationError = Object.assign(
    new Error(
      "page.goto: net::ERR_NAME_NOT_RESOLVED at https://dead.invalid/callback?access_token=error-secret",
    ),
    { cause: new Error("redirect cause https://dead.invalid/?code=cause-secret") },
  );
  const failureResult = await tools.get("browser_goto").execute("call", {
    url: "https://app.test/start",
  });
  assert.equal(failureResult.isError, true);
  assert.equal(
    failureResult.details.finalUrl,
    "https://dead.invalid/callback?access_token=%5BREDACTED%5D",
  );
  assert.match(failureResult.details.error, /access_token=%5BREDACTED%5D/);
  assert.doesNotMatch(JSON.stringify(failureResult), /(?:redirect|error|cause)-secret/);
  assert.equal("cause" in failureResult.details, false);

  await assert.rejects(
    tools.get("browser_click").execute("call", { selector: "button" }),
    (error) => {
      assert.match(error.message, /code=%5BREDACTED%5D/);
      assert.doesNotMatch(error.stack, /(?:click|cause)-secret/);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
});
