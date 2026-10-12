import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { access, mkdtemp, rm } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

let playwrightImportCount = 0;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "typebox") return { url: "browser-test:typebox", shortCircuit: true };
    if (specifier === "playwright-core") {
      playwrightImportCount += 1;
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
        source: [
          "export const chromium = {",
          "  launchPersistentContext: (...args) =>",
          "    globalThis.__browserTestChromium.launchPersistentContext(...args),",
          "};",
        ].join("\n"),
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const { default: browserExtension } = await import("../index.ts");

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function createBrowserHarness(launchPersistentContext) {
  const tools = new Map();
  const commands = new Map();
  const events = new Map();
  const entries = [];
  let activeTools = ["read"];
  globalThis.__browserTestChromium = { launchPersistentContext };
  browserExtension({
    appendEntry: (type, data) => entries.push({ type, data }),
    getActiveTools: () => activeTools,
    on: (name, handler) => events.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    registerTool: (tool) => tools.set(tool.name, tool),
    setActiveTools: (next) => {
      activeTools = next;
    },
  });
  await commands.get("browser").handler("on", { ui: { notify: () => {} } });
  return { tools, commands, events, entries, getActiveTools: () => activeTools };
}

test("browser tools stay off for a new session until explicitly enabled", async () => {
  const tools = new Map();
  const commands = new Map();
  const events = new Map();
  const browserTools = [
    "browser_goto",
    "browser_eval",
    "browser_console",
    "browser_network",
    "browser_fill",
    "browser_click",
    "browser_screenshot",
    "browser_close",
  ];
  let activeTools = ["read", ...browserTools];
  browserExtension({
    appendEntry: () => {},
    getActiveTools: () => activeTools,
    on: (name, handler) => events.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    registerTool: (tool) => tools.set(tool.name, tool),
    setActiveTools: (next) => {
      activeTools = next;
    },
  });

  await events.get("session_start")({}, { sessionManager: { getBranch: () => [] } });
  assert.deepEqual(activeTools, ["read"]);
  await commands.get("browser").handler("on", { ui: { notify: () => {} } });
  assert.deepEqual(activeTools, ["read", ...browserTools]);
  assert.equal(tools.size, browserTools.length);
});

test("session opt-in follows the active branch instead of abandoned entries", async () => {
  const events = new Map();
  const tools = new Map();
  const browserTools = [
    "browser_goto",
    "browser_eval",
    "browser_console",
    "browser_network",
    "browser_fill",
    "browser_click",
    "browser_screenshot",
    "browser_close",
  ];
  const abandonedEnable = {
    type: "custom",
    customType: "browser-enabled",
    data: { on: true },
  };
  const branchEnable = {
    type: "custom",
    customType: "browser-enabled",
    data: { on: true },
  };
  const branchDisable = {
    type: "custom",
    customType: "browser-enabled",
    data: { on: false },
  };
  let activeBranch = [];
  let activeTools = ["read", ...browserTools];
  browserExtension({
    appendEntry: () => {},
    getActiveTools: () => activeTools,
    on: (name, handler) => events.set(name, handler),
    registerCommand: () => {},
    registerTool: (tool) => tools.set(tool.name, tool),
    setActiveTools: (next) => {
      activeTools = next;
    },
  });
  const ctx = {
    sessionManager: {
      getEntries: () => [branchEnable, branchDisable, abandonedEnable],
      getBranch: () => activeBranch,
    },
  };
  await events.get("session_start")({}, ctx);
  assert.deepEqual(activeTools, ["read"], "abandoned branch opt-in must not enable browser tools");
  assert.equal(tools.size, browserTools.length);

  activeBranch = [branchEnable];
  await events.get("session_tree")(
    { type: "session_tree", oldLeafId: null, newLeafId: "enabled" },
    ctx,
  );
  assert.deepEqual(
    activeTools,
    ["read", ...browserTools],
    "active branch opt-in must restore tools",
  );

  activeBranch = [branchEnable, branchDisable];
  await events.get("session_tree")(
    { type: "session_tree", oldLeafId: "enabled", newLeafId: "disabled" },
    ctx,
  );
  assert.deepEqual(activeTools, ["read"], "active branch opt-out must override earlier opt-in");
});

test("failed close blocks enabled, queued and re-enabled page calls until cleanup retry", async () => {
  let closeCount = 0;
  let navigationCount = 0;
  const profiles = [];
  const page = {
    isClosed: () => false,
    on: () => {},
    goto: async () => {
      navigationCount += 1;
      return { status: () => 200 };
    },
    url: () => "https://app.test/",
  };
  const harness = await createBrowserHarness(async (profile) => {
    profiles.push(profile);
    return {
      pages: () => [page],
      close: async () => {
        closeCount += 1;
        if (closeCount <= 2) throw new Error("close failed");
      },
    };
  });
  const goto = () =>
    harness.tools.get("browser_goto").execute("call", { url: "https://app.test/" });
  const close = () => harness.tools.get("browser_close").execute("call", {});
  const command = (value) =>
    harness.commands.get("browser").handler(value, { ui: { notify: () => {} } });
  try {
    await goto();
    const closing = close();
    const pending = goto();
    await assert.rejects(closing, /context close failed/);
    await assert.rejects(pending, /cleanup|disabled|confirmed closed/i);
    assert.deepEqual(harness.getActiveTools(), ["read", "browser_close"]);
    assert.ok(
      harness.entries.some(
        (entry) => entry.type === "browser-lifecycle" && entry.data.state === "close-failed",
      ),
    );
    assert.equal(await pathExists(profiles[0]), true);
    for (const name of [
      "browser_console",
      "browser_network",
      "browser_eval",
      "browser_click",
      "browser_fill",
      "browser_screenshot",
    ]) {
      await assert.rejects(
        harness.tools.get(name).execute("call", {}),
        /cleanup|disabled|confirmed closed/i,
      );
    }
    await assert.rejects(command("on"), /cleanup|confirmed closed/i);
    await assert.rejects(goto(), /cleanup|disabled|confirmed closed/i);
    await assert.rejects(command("off"), /context close failed/);
    await assert.rejects(command("on"), /cleanup|confirmed closed/i);
    await close();
    assert.equal(await pathExists(profiles[0]), false);
    await command("on");
    await goto();
    assert.equal(navigationCount, 2);
    assert.equal(profiles.length, 2);
    assert.notEqual(profiles[0], profiles[1]);
    await close();
  } finally {
    for (const profile of profiles) await rm(profile, { recursive: true, force: true });
  }
});

test("actual post-navigation session_tree closes abandoned auth state before restoring opt-in", async () => {
  const profiles = [];
  let activeBranch = [{ type: "custom", customType: "browser-enabled", data: { on: true } }];
  let release;
  let started;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const navigationStarted = new Promise((resolve) => {
    started = resolve;
  });
  let closeCount = 0;
  const page = {
    isClosed: () => false,
    on: () => {},
    url: () => "https://app.test/",
    goto: async () => {
      started();
      await gate;
      return { status: () => 200 };
    },
  };
  const harness = await createBrowserHarness(async (profile) => {
    profiles.push(profile);
    return {
      pages: () => [page],
      close: async () => {
        closeCount += 1;
      },
    };
  });
  const ctx = { sessionManager: { getBranch: () => activeBranch } };
  try {
    const navigating = harness.tools
      .get("browser_goto")
      .execute("call", { url: "https://app.test/" });
    await navigationStarted;
    // Pi 1.1 changes the active leaf before emitting session_tree.
    activeBranch = [];
    assert.equal(typeof harness.events.get("session_tree"), "function");
    const changed = harness.events.get("session_tree")(
      { type: "session_tree", oldLeafId: "old", newLeafId: "off" },
      ctx,
    );
    const pending = harness.tools
      .get("browser_goto")
      .execute("call", { url: "https://app.test/stale" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closeCount, 0, "teardown must wait for the in-flight operation");
    release();
    await navigating;
    await changed;
    await assert.rejects(pending, /disabled/i);
    assert.equal(await pathExists(profiles[0]), false);
    activeBranch = [{ type: "custom", customType: "browser-enabled", data: { on: true } }];
    await harness.events.get("session_tree")(
      { type: "session_tree", oldLeafId: "off", newLeafId: "on" },
      ctx,
    );
    await harness.tools.get("browser_goto").execute("call", { url: "https://app.test/fresh" });
    assert.equal(profiles.length, 2);
    assert.notEqual(profiles[0], profiles[1]);
    // Both branches can opt in, but the previous branch's auth profile still closes.
    await harness.events.get("session_tree")(
      { type: "session_tree", oldLeafId: "on", newLeafId: "another-on" },
      ctx,
    );
    assert.equal(await pathExists(profiles[1]), false);
    await harness.tools
      .get("browser_goto")
      .execute("call", { url: "https://app.test/another-fresh" });
    assert.equal(profiles.length, 3);
    assert.notEqual(profiles[1], profiles[2]);
    await harness.tools.get("browser_close").execute("call", {});
  } finally {
    release();
    for (const profile of profiles) await rm(profile, { recursive: true, force: true });
  }
});

test("disabled and queued page calls cannot relaunch after browser off, but cleanup remains available", async () => {
  const originalProfile = process.env.PI_BROWSER_PROFILE;
  delete process.env.PI_BROWSER_PROFILE;
  const tools = new Map();
  const commands = new Map();
  const events = new Map();
  const profiles = [];
  let closeCount = 0;
  let signalNavigationStarted;
  let releaseNavigation;
  const navigationStarted = new Promise((resolve) => {
    signalNavigationStarted = resolve;
  });
  const navigationGate = new Promise((resolve) => {
    releaseNavigation = resolve;
  });
  const page = {
    isClosed: () => false,
    on: () => {},
    goto: async (url) => {
      if (url.endsWith("/first")) {
        signalNavigationStarted();
        await navigationGate;
      }
      return { status: () => 200 };
    },
    url: () => "https://app.test/",
  };

  try {
    globalThis.__browserTestChromium = {
      launchPersistentContext: async (userDataDir) => {
        profiles.push(userDataDir);
        return {
          pages: () => [page],
          close: async () => {
            closeCount += 1;
          },
        };
      },
    };
    browserExtension({
      appendEntry: () => {},
      getActiveTools: () => [],
      on: (name, handler) => events.set(name, handler),
      registerCommand: (name, command) => commands.set(name, command),
      registerTool: (tool) => tools.set(tool.name, tool),
      setActiveTools: () => {},
    });

    await assert.rejects(
      tools.get("browser_goto").execute("call", { url: "https://app.test/disabled" }),
      /browser tools are disabled/i,
    );
    assert.equal(profiles.length, 0, "disabled tools must not launch Chromium");

    await commands.get("browser").handler("on", { ui: { notify: () => {} } });
    const firstNavigation = tools.get("browser_goto").execute("call", {
      url: "https://app.test/first",
    });
    await navigationStarted;
    const queuedNavigation = tools.get("browser_goto").execute("call", {
      url: "https://app.test/queued",
    });
    const disable = commands.get("browser").handler("off", { ui: { notify: () => {} } });
    releaseNavigation();

    await firstNavigation;
    await assert.rejects(queuedNavigation, /browser tools are disabled/i);
    await disable;
    assert.equal(profiles.length, 1, "queued calls after disable must not create another profile");
    assert.equal(closeCount, 1, "disable must close the existing context");

    await tools.get("browser_close").execute("call", {});
    assert.equal(closeCount, 1, "browser_close remains safe and callable while disabled");
  } finally {
    releaseNavigation?.();
    for (const profile of profiles) {
      if (profile.startsWith(tmpdir())) await rm(profile, { recursive: true, force: true });
    }
    if (originalProfile === undefined) delete process.env.PI_BROWSER_PROFILE;
    else process.env.PI_BROWSER_PROFILE = originalProfile;
  }
});

test("a supplied browser profile override is rejected before Playwright loads without leaking it", async () => {
  const originalProfile = process.env.PI_BROWSER_PROFILE;
  const secretProfile = await mkdtemp(join(tmpdir(), "pi-browser-existing-profile-"));
  const profiles = [];
  process.env.PI_BROWSER_PROFILE = secretProfile;

  try {
    const harness = await createBrowserHarness(async (profile) => {
      profiles.push(profile);
      throw new Error("unexpected launch");
    });
    const importsBefore = playwrightImportCount;

    await assert.rejects(
      harness.tools.get("browser_goto").execute("call", { url: "https://app.test/" }),
      (error) => {
        assert.match(error.message, /PI_BROWSER_PROFILE is unsupported/);
        assert.equal(`${error.message}\n${error.stack ?? ""}`.includes(secretProfile), false);
        return true;
      },
    );
    assert.equal(playwrightImportCount, importsBefore);
    assert.equal(profiles.length, 0);
    assert.equal(
      await pathExists(secretProfile),
      true,
      "pre-existing profile must remain untouched",
    );
  } finally {
    if (secretProfile.startsWith(tmpdir()))
      await rm(secretProfile, { recursive: true, force: true });
    if (originalProfile === undefined) delete process.env.PI_BROWSER_PROFILE;
    else process.env.PI_BROWSER_PROFILE = originalProfile;
  }
});

test("each browser lifecycle uses a fresh disposable profile", async () => {
  const originalProfile = process.env.PI_BROWSER_PROFILE;
  delete process.env.PI_BROWSER_PROFILE;
  const profiles = [];

  try {
    const page = {
      isClosed: () => false,
      on: () => {},
      goto: async () => ({ status: () => 200 }),
      url: () => "https://app.test/",
    };
    const harness = await createBrowserHarness(async (profile) => {
      profiles.push(profile);
      return { pages: () => [page], close: async () => {} };
    });

    await harness.tools.get("browser_goto").execute("call", { url: "https://app.test/" });
    await harness.tools.get("browser_close").execute("call", {});
    await harness.tools.get("browser_goto").execute("call", { url: "https://app.test/" });

    assert.equal(profiles.length, 2);
    assert.notEqual(profiles[0], profiles[1], "a relaunch must not reuse browser state");
    assert.ok(
      profiles.every((profile) => profile.startsWith(tmpdir())),
      "browser profiles must be private disposable temp directories",
    );
    await harness.tools.get("browser_close").execute("call", {});
  } finally {
    for (const profile of profiles) {
      if (profile.startsWith(tmpdir())) await rm(profile, { recursive: true, force: true });
    }
    if (originalProfile === undefined) delete process.env.PI_BROWSER_PROFILE;
    else process.env.PI_BROWSER_PROFILE = originalProfile;
  }
});

test("session shutdown waits for an in-flight browser operation before closing its context", async () => {
  const originalProfile = process.env.PI_BROWSER_PROFILE;
  delete process.env.PI_BROWSER_PROFILE;
  let profile;
  let signalNavigationStarted;
  let releaseNavigation;
  let closeCount = 0;
  const navigationStarted = new Promise((resolve) => {
    signalNavigationStarted = resolve;
  });
  const navigationGate = new Promise((resolve) => {
    releaseNavigation = resolve;
  });

  try {
    const page = {
      isClosed: () => false,
      on: () => {},
      goto: async () => {
        signalNavigationStarted();
        await navigationGate;
        return { status: () => 200 };
      },
      url: () => "https://app.test/",
    };
    const harness = await createBrowserHarness(async (userDataDir) => {
      profile = userDataDir;
      return {
        pages: () => [page],
        close: async () => {
          closeCount += 1;
        },
      };
    });

    const navigation = harness.tools.get("browser_goto").execute("call", {
      url: "https://app.test/",
    });
    await navigationStarted;
    const shutdown = harness.events.get("session_shutdown")();
    await new Promise((resolve) => setImmediate(resolve));
    const closeCountWhileNavigating = closeCount;
    releaseNavigation();
    await navigation;
    await shutdown;

    assert.equal(closeCountWhileNavigating, 0, "shutdown must not race the active page operation");
    assert.equal(closeCount, 1);
    assert.equal(await pathExists(profile), false, "shutdown must clean up after confirmed close");
  } finally {
    if (profile?.startsWith(tmpdir())) await rm(profile, { recursive: true, force: true });
    if (originalProfile === undefined) delete process.env.PI_BROWSER_PROFILE;
    else process.env.PI_BROWSER_PROFILE = originalProfile;
  }
});

test("a failed launch retains its profile and blocks relaunch until closure is confirmed", async () => {
  const originalProfile = process.env.PI_BROWSER_PROFILE;
  delete process.env.PI_BROWSER_PROFILE;
  const profiles = [];

  try {
    let attempts = 0;
    const page = {
      isClosed: () => false,
      on: () => {},
      goto: async () => ({ status: () => 200 }),
      url: () => "https://app.test/",
    };
    const harness = await createBrowserHarness(async (userDataDir) => {
      profiles.push(userDataDir);
      attempts += 1;
      if (attempts === 1) throw new Error(`launch failed at ${userDataDir}`);
      return { pages: () => [page], close: async () => {} };
    });

    await assert.rejects(
      harness.tools.get("browser_goto").execute("call", { url: "https://app.test/" }),
      (error) => {
        assert.match(error.message, /Browser launch failed/);
        assert.equal(`${error.message}\n${error.stack ?? ""}`.includes(profiles[0]), false);
        return true;
      },
    );
    assert.equal(await pathExists(profiles[0]), true, "failed launch profile must be retained");
    await assert.rejects(
      harness.tools.get("browser_close").execute("call", {}),
      /context was not confirmed closed/,
    );
    await assert.rejects(
      harness.commands.get("browser").handler("off", { ui: { notify: () => {} } }),
      /context was not confirmed closed/,
    );
    assert.equal(
      harness.getActiveTools().includes("browser_close"),
      true,
      "browser_close must remain exposed while cleanup is unconfirmed",
    );
    assert.equal(
      await pathExists(profiles[0]),
      true,
      "disable must retain the unconfirmed profile",
    );
    await assert.rejects(
      harness.tools.get("browser_close").execute("call", {}),
      /context was not confirmed closed/,
    );

    await harness.commands.get("browser").handler("on", { ui: { notify: () => {} } });
    await assert.rejects(
      harness.tools.get("browser_goto").execute("call", { url: "https://app.test/" }),
      /context was not confirmed closed/,
    );
    assert.equal(profiles.length, 1, "an unconfirmed launch must block every new profile");
    assert.equal(
      await pathExists(profiles[0]),
      true,
      "blocked relaunch must preserve profile evidence",
    );
  } finally {
    for (const profile of profiles) {
      if (profile.startsWith(tmpdir())) await rm(profile, { recursive: true, force: true });
    }
    if (originalProfile === undefined) delete process.env.PI_BROWSER_PROFILE;
    else process.env.PI_BROWSER_PROFILE = originalProfile;
  }
});

test("a failed context close retains its profile, reports failure, and keeps tools disabled", async () => {
  const originalProfile = process.env.PI_BROWSER_PROFILE;
  delete process.env.PI_BROWSER_PROFILE;
  let profile;

  try {
    const page = {
      isClosed: () => false,
      on: () => {},
      goto: async () => ({ status: () => 200 }),
      url: () => "https://app.test/",
    };
    const harness = await createBrowserHarness(async (userDataDir) => {
      profile = userDataDir;
      return {
        pages: () => [page],
        close: async () => {
          throw new Error("close failed");
        },
      };
    });
    await harness.commands.get("browser").handler("on", { ui: { notify: () => {} } });

    await harness.tools.get("browser_goto").execute("call", { url: "https://app.test/" });
    await assert.rejects(harness.tools.get("browser_close").execute("call", {}), (error) => {
      assert.match(error.message, /context close failed/);
      assert.match(error.message, /profile was retained/);
      assert.equal(error.message.includes(profile), false);
      return true;
    });
    assert.equal(
      await pathExists(profile),
      true,
      "failed close must preserve its profile evidence",
    );
    await assert.rejects(
      harness.commands.get("browser").handler("off", { ui: { notify: () => {} } }),
      /context close failed/,
    );
    assert.deepEqual(harness.entries.at(-1), {
      type: "browser-enabled",
      data: { on: false },
    });
  } finally {
    if (profile?.startsWith(tmpdir())) await rm(profile, { recursive: true, force: true });
    if (originalProfile === undefined) delete process.env.PI_BROWSER_PROFILE;
    else process.env.PI_BROWSER_PROFILE = originalProfile;
  }
});

test("a confirmed context close removes its internally allocated profile", async () => {
  const originalProfile = process.env.PI_BROWSER_PROFILE;
  delete process.env.PI_BROWSER_PROFILE;
  let profile;

  try {
    const page = {
      isClosed: () => false,
      on: () => {},
      goto: async () => ({ status: () => 200 }),
      url: () => "https://app.test/",
    };
    const harness = await createBrowserHarness(async (userDataDir) => {
      profile = userDataDir;
      return { pages: () => [page], close: async () => {} };
    });

    await harness.tools.get("browser_goto").execute("call", { url: "https://app.test/" });
    assert.ok(profile.startsWith(tmpdir()), "the profile must be internally allocated");
    assert.equal(await pathExists(profile), true);
    await harness.tools.get("browser_close").execute("call", {});
    assert.equal(await pathExists(profile), false, "confirmed close must remove the profile");
  } finally {
    if (profile?.startsWith(tmpdir())) await rm(profile, { recursive: true, force: true });
    if (originalProfile === undefined) delete process.env.PI_BROWSER_PROFILE;
    else process.env.PI_BROWSER_PROFILE = originalProfile;
  }
});

test("browser launch disables sync, extensions, and OS keychains without disabling sandboxing", async () => {
  const originalProfile = process.env.PI_BROWSER_PROFILE;
  delete process.env.PI_BROWSER_PROFILE;
  let profile;

  try {
    let launchOptions;
    const page = {
      isClosed: () => false,
      on: () => {},
      goto: async () => ({ status: () => 200 }),
      url: () => "https://app.test/",
    };
    const harness = await createBrowserHarness(async (userDataDir, options) => {
      profile = userDataDir;
      launchOptions = options;
      return { pages: () => [page], close: async () => {} };
    });

    await harness.tools.get("browser_goto").execute("call", { url: "https://app.test/" });
    const args = launchOptions.args;
    for (const flag of [
      "--disable-extensions",
      "--disable-sync",
      "--password-store=basic",
      "--use-mock-keychain",
    ]) {
      assert.ok(args.includes(flag), `missing isolation flag ${flag}`);
    }
    assert.equal(args.includes("--no-sandbox"), false);
    assert.equal(args.includes("--disable-setuid-sandbox"), false);
    assert.equal(launchOptions.chromiumSandbox, true);
    assert.equal("ignoreDefaultArgs" in launchOptions, false);
    await harness.tools.get("browser_close").execute("call", {});
  } finally {
    if (profile?.startsWith(tmpdir())) await rm(profile, { recursive: true, force: true });
    if (originalProfile === undefined) delete process.env.PI_BROWSER_PROFILE;
    else process.env.PI_BROWSER_PROFILE = originalProfile;
  }
});

test("passive browser URL outputs redact credentials", async (t) => {
  const originalProfile = process.env.PI_BROWSER_PROFILE;
  delete process.env.PI_BROWSER_PROFILE;
  let profile;
  t.after(async () => {
    if (profile?.startsWith(tmpdir())) await rm(profile, { recursive: true, force: true });
    if (originalProfile === undefined) delete process.env.PI_BROWSER_PROFILE;
    else process.env.PI_BROWSER_PROFILE = originalProfile;
  });

  const tools = new Map();
  const commands = new Map();
  const pageHandlers = new Map();
  let currentUrl =
    "https://app.test/callback?access_token=goto-secret#refresh_token=fragment-secret";
  let navigationError;
  const evaluationResult = "page output\x1b]52;c;EVAL-CONTROL\x07 after";
  const page = {
    isClosed: () => false,
    on: (event, handler) => pageHandlers.set(event, handler),
    click: async () => {
      throw Object.assign(new Error("click failed at https://app.test/button?code=click-secret"), {
        cause: new Error("cause https://app.test/?token=cause-secret"),
      });
    },
    goto: async () => {
      if (navigationError) throw navigationError;
      return { status: () => 302 };
    },
    evaluate: async () => evaluationResult,
    url: () => currentUrl,
  };
  const context = {
    pages: () => [page],
    close: async () => {},
  };
  globalThis.__browserTestChromium = {
    launchPersistentContext: async (userDataDir) => {
      profile = userDataDir;
      return context;
    },
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
  await commands.get("browser").handler("on", { ui: { notify: () => {} } });

  const gotoResult = await tools.get("browser_goto").execute("call", {
    url: "https://app.test/start",
  });
  assert.equal(
    gotoResult.details.finalUrl,
    "https://app.test/callback?access_token=%5BREDACTED%5D#refresh_token=%5BREDACTED%5D",
  );
  assert.doesNotMatch(JSON.stringify(gotoResult), /(?:goto|fragment)-secret/);

  const evalResult = await tools.get("browser_eval").execute("call", {
    expression: "document.body.textContent",
  });
  assert.equal(evalResult.content[0].text, "page output after");
  assert.equal(evalResult.details.result, evaluationResult);
  assert.doesNotMatch(evalResult.content[0].text, /EVAL-CONTROL/u);
  assert.equal(evalResult.content[0].text.includes("\x1b]52;"), false);

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
  const serializedConsoleResult = JSON.stringify(consoleResult);
  assert.doesNotMatch(
    serializedConsoleResult,
    /console(?:-text)?-secret|(?:CONSOLE|PAGEERROR)-CONTROL/u,
  );
  assert.equal(serializedConsoleResult.includes("\x1b]52;"), false);

  const notifications = [];
  await commands.get("browser").handler("", {
    ui: { notify: (message) => notifications.push(message) },
  });
  assert.equal(
    notifications[0],
    "browser tools: enabled, open at https://app.test/callback?access_token=%5BREDACTED%5D#refresh_token=%5BREDACTED%5D",
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
  await tools.get("browser_close").execute("call", {});
});
