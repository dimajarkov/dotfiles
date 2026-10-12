/**
 * Browser extension - Playwright-driven headless Chromium pi can drive.
 *
 * Exposes a small set of tools the LLM can call to debug a live web app:
 *   - browser_goto         navigate
 *   - browser_eval         run JS in the page (read localStorage, decode JWTs,
 *                          inspect the DOM, etc.)
 *   - browser_console      drain buffered console + pageerror entries
 *   - browser_network      drain buffered network requests (status, headers)
 *   - browser_fill         fill an input
 *   - browser_click        click an element
 *   - browser_screenshot   write a PNG to /tmp and return the path
 *   - browser_close        close the current disposable browser context
 *
 * Plus a /browser command for quick status / close from the TUI.
 *
 * Browser state is a singleton within one disposable profile, shared across
 * tool calls and removed only after a confirmed context close. No browser
 * state or login session is carried across browser lifecycles.
 *
 * Home Manager provisions the locked dependencies and Chromium binary.
 *
 * Tweaks:
 *   PI_BROWSER_HEADFUL=1   launch a visible window (useful when debugging
 *                          the extension itself).
 *   PI_BROWSER_PROFILE     rejected; profiles are always private and disposable
 */

import { mkdtempSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { sanitizeMetadata, sanitizeOutput } from "../lib/terminal-safety.ts";
import {
  redactBrowserDiagnostic,
  redactBrowserUrl,
  serializeNetworkEntries,
  type NetworkEntry,
} from "./network-serialization.ts";
import type { BrowserContext, ConsoleMessage, Page, Request } from "playwright-core";

const DEFAULT_BROWSERS_DIR = join(homedir(), ".pi", "agent", "extensions", "browser", ".browsers");
const BROWSER_ARGS = [
  "--disable-extensions",
  "--disable-sync",
  "--password-store=basic",
  "--use-mock-keychain",
];
process.env.PLAYWRIGHT_BROWSERS_PATH ??= DEFAULT_BROWSERS_DIR;

type NavigationDetails = {
  status: number | undefined;
  finalUrl: string;
  error?: string;
};

type ConsoleEntry = {
  ts: number;
  type: string;
  text: string;
  location?: string;
};

const MAX_BUF = 1000;
const BROWSER_TOOL_NAMES = [
  "browser_goto",
  "browser_eval",
  "browser_console",
  "browser_network",
  "browser_fill",
  "browser_click",
  "browser_screenshot",
  "browser_close",
];
const PAGE_TOOL_NAMES = BROWSER_TOOL_NAMES.filter((name) => name !== "browser_close");
const ENABLED_ENTRY_TYPE = "browser-enabled";
const KEEP_HEADERS = new Set([
  "authorization",
  "apikey",
  "content-type",
  "x-client-info",
  "accept-profile",
  "content-profile",
  "prefer",
  "location",
  "www-authenticate",
  "retry-after",
]);

function pushBounded<T>(buf: T[], entry: T): void {
  buf.push(entry);
  if (buf.length > MAX_BUF) buf.splice(0, buf.length - MAX_BUF);
}

/**
 * Serialize all tool executions against the single shared Page.
 *
 * Playwright's Page is not concurrent-safe: if pi fires multiple browser_*
 * tools in one block (which it does by default for independent calls), two
 * `fill`s will race into the same field, and a `goto` followed by an `eval`
 * in the same batch will hit "Execution context was destroyed" because the
 * eval lands during the navigation teardown.
 *
 * Wrapping every execute body in this queue costs the latency we should be
 * paying anyway and removes the entire class of race from the LLM's mental
 * model.
 */
let opQueue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = opQueue.then(fn, fn).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redactBrowserDiagnostic(message));
  });
  opQueue = next.catch(() => {});
  return next;
}

export default function browserExtension(pi: ExtensionAPI) {
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let profileDir: string | null = null;
  let contextCloseConfirmed = false;
  let closeFailed = false;
  let restoringBranch = false;
  const consoleBuf: ConsoleEntry[] = [];
  const netBuf: NetworkEntry[] = [];

  const browsersDir = process.env.PLAYWRIGHT_BROWSERS_PATH ?? DEFAULT_BROWSERS_DIR;
  const headless = !process.env.PI_BROWSER_HEADFUL;

  function requirePageOperations(): void {
    if (closeFailed) {
      throw new Error("Browser cleanup is pending after a failed close; retry browser_close first");
    }
    if (!enabled) {
      throw new Error("Browser tools are disabled; run /browser on before using them");
    }
  }

  async function ensurePage(): Promise<Page> {
    requirePageOperations();
    if (process.env.PI_BROWSER_PROFILE !== undefined) {
      throw new Error("PI_BROWSER_PROFILE is unsupported; browser profiles are always disposable");
    }
    if (page && !page.isClosed()) return page;

    if (!context) {
      if (profileDir && !contextCloseConfirmed) {
        throw new Error(
          "Browser context was not confirmed closed; its disposable profile was retained",
        );
      }
      if (contextCloseConfirmed) await removeClosedProfile();
      process.env.PLAYWRIGHT_BROWSERS_PATH = browsersDir;
      profileDir = await mkdtemp(join(tmpdir(), "pi-browser-profile-"));
      contextCloseConfirmed = false;
      try {
        const { chromium } = await import("playwright-core");
        context = await chromium.launchPersistentContext(profileDir, {
          headless,
          chromiumSandbox: true,
          viewport: { width: 1280, height: 800 },
          args: BROWSER_ARGS,
        });
      } catch {
        throw new Error("Browser launch failed; its disposable profile was retained");
      }
    }

    page = context.pages()[0] ?? (await context.newPage());

    page.on("console", (msg: ConsoleMessage) => {
      const loc = msg.location();
      const locationUrl = loc?.url ? redactBrowserUrl(loc.url) : undefined;
      pushBounded(consoleBuf, {
        ts: Date.now(),
        type: msg.type(),
        text: redactBrowserDiagnostic(msg.text()),
        location: locationUrl ? `${locationUrl}:${loc.lineNumber}` : undefined,
      });
    });
    page.on("pageerror", (err) => {
      pushBounded(consoleBuf, {
        ts: Date.now(),
        type: "pageerror",
        text: redactBrowserDiagnostic(`${err.name}: ${err.message}`),
      });
    });
    page.on("requestfinished", async (req: Request) => {
      try {
        const res = await req.response();
        pushBounded(netBuf, {
          ts: Date.now(),
          method: req.method(),
          url: req.url(),
          status: res?.status(),
          statusText: res?.statusText(),
          resourceType: req.resourceType(),
          // Capture all headers; the renderer decides what to surface based
          // on the caller's `verbose` / `includeHeaders` opt-in.
          requestHeaders: req.headers(),
          responseHeaders: res ? res.headers() : undefined,
        });
      } catch {
        // request may have been aborted; ignore
      }
    });
    page.on("requestfailed", (req: Request) => {
      pushBounded(netBuf, {
        ts: Date.now(),
        method: req.method(),
        url: req.url(),
        resourceType: req.resourceType(),
        failure: req.failure()?.errorText,
      });
    });

    return page;
  }

  async function removeClosedProfile(): Promise<void> {
    if (!contextCloseConfirmed) {
      throw new Error(
        "Browser context was not confirmed closed; its disposable profile was retained",
      );
    }
    if (profileDir) {
      try {
        await rm(profileDir, { recursive: true, force: true });
      } catch {
        throw new Error(
          "Browser context closed, but disposable profile cleanup could not be confirmed",
        );
      }
      profileDir = null;
    }
    contextCloseConfirmed = false;
  }

  async function teardown(): Promise<void> {
    const closingContext = context;
    if (!closingContext) {
      page = null;
      if (profileDir) await removeClosedProfile();
      return;
    }

    try {
      await closingContext.close();
    } catch {
      closeFailed = true;
      setEnabled(false);
      pi.appendEntry("browser-lifecycle", { state: "close-failed" });
      pi.appendEntry(ENABLED_ENTRY_TYPE, { on: false });
      throw new Error("Browser context close failed; its disposable profile was retained");
    }

    context = null;
    page = null;
    closeFailed = false;
    consoleBuf.length = 0;
    netBuf.length = 0;
    contextCloseConfirmed = true;
    await removeClosedProfile();
  }

  // Default-off gate. The browser tools collectively cost ~800 system-prompt
  // tokens (snippets + guidelines), but are needed in a small minority of
  // sessions. We keep all 8 tools registered so they appear in
  // pi.getAllTools() and command discovery stays normal. Page tools leave
  // the active set while disabled; browser_close stays active only while an
  // open or unconfirmed context/profile still needs cleanup.
  let enabled = false;

  function setEnabled(on: boolean): void {
    const active = new Set(pi.getActiveTools());
    if (on) {
      for (const name of BROWSER_TOOL_NAMES) active.add(name);
    } else {
      for (const name of PAGE_TOOL_NAMES) active.delete(name);
      if (context || profileDir) active.add("browser_close");
      else active.delete("browser_close");
    }
    pi.setActiveTools(Array.from(active));
    enabled = on;
  }

  async function enable(): Promise<void> {
    if (closeFailed || restoringBranch) {
      throw new Error(
        "Browser cleanup or branch restoration is pending; retry browser_close first",
      );
    }
    setEnabled(true);
    pi.appendEntry(ENABLED_ENTRY_TYPE, { on: true });
  }

  async function disable(): Promise<void> {
    setEnabled(false);
    pi.appendEntry(ENABLED_ENTRY_TYPE, { on: false });
    await serialize(async () => {
      await teardown();
      if (!enabled) setEnabled(false);
    });
  }

  // Pi 1.1 emits session_tree after changing the active leaf. Close the old
  // branch's context in the page queue before restoring the new branch's opt-in.
  // Action methods are unavailable during extension factory initialization.
  async function restoreBranch(ctx: ExtensionContext): Promise<void> {
    let want = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === ENABLED_ENTRY_TYPE) {
        const data = entry.data as { on?: boolean } | undefined;
        if (data && typeof data.on === "boolean") want = data.on;
      }
    }
    restoringBranch = true;
    setEnabled(false);
    try {
      await serialize(async () => {
        await teardown();
        setEnabled(want);
      });
    } finally {
      restoringBranch = false;
    }
  }
  pi.on("session_start", async (_event, ctx) => restoreBranch(ctx));
  pi.on("session_tree", async (_event, ctx) => restoreBranch(ctx));

  pi.on("session_shutdown", async () => {
    setEnabled(false);
    await serialize(() => teardown());
  });

  pi.registerTool({
    name: "browser_goto",
    label: "Browser Goto",
    description:
      "Navigate the current disposable headless Chromium context to a URL. Returns final URL and HTTP status. Cookies + localStorage persist only until this context closes.",
    promptSnippet:
      "Open a URL in a temporary headless browser context to inspect an approved test app's DOM, storage, network, and console instead of asking the user to copy from devtools",
    promptGuidelines: [
      "Follow repository-owned runtime, authentication, and proof rules. Use this optional Chromium route only when approved for synthetic application QA; never use personal browser profiles or present its evidence as Zen or native-app behavior.",
      "When repository-owned instructions approve this route for synthetic application QA, use browser_goto + browser_eval + browser_console + browser_network to inspect frontend issues instead of asking the user to copy-paste from devtools.",
      "When repository-owned instructions approve this route for synthetic application QA, use browser_goto to reproduce the reported flow before forming a hypothesis from source alone.",
      "After a frontend change, use browser_goto plus browser_click / browser_fill for end-to-end verification only when repository-owned instructions approve this isolated synthetic QA route; do not replace another required proof route.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "URL to navigate to" }),
      waitUntil: Type.Optional(
        Type.Union([
          Type.Literal("load"),
          Type.Literal("domcontentloaded"),
          Type.Literal("networkidle"),
          Type.Literal("commit"),
        ]),
      ),
      timeoutMs: Type.Optional(Type.Number()),
    }),
    async execute(_id, params) {
      return serialize(async () => {
        const p = await ensurePage();
        try {
          const resp = await p.goto(params.url, {
            waitUntil: params.waitUntil ?? "domcontentloaded",
            timeout: params.timeoutMs ?? 30_000,
          });
          const status = resp?.status();
          const finalUrl = redactBrowserUrl(p.url());
          const details: NavigationDetails = { status, finalUrl };
          return {
            content: [{ type: "text", text: `${status ?? "?"} ${finalUrl}` }],
            details,
          };
        } catch (error) {
          const message = redactBrowserDiagnostic(
            error instanceof Error ? error.message : String(error),
          );
          const finalUrl = redactBrowserUrl(p.url());
          return {
            content: [
              { type: "text", text: `navigation error: ${message}\nfinal URL: ${finalUrl}` },
            ],
            details: { status: undefined, finalUrl, error: message },
            isError: true,
          };
        }
      });
    },
  });

  pi.registerTool({
    name: "browser_eval",
    label: "Browser Eval",
    description:
      "Evaluate JS in the current page. Pass an expression ('localStorage.length'), a function ('() => Object.keys(localStorage)', 'async () => { ... }'), or an already-called IIFE — all three forms work. Return value must be JSON-serializable; for DOM nodes return primitive properties (.outerHTML, .textContent, .value) rather than the node itself.",
    promptSnippet:
      "Run JS in the live page to read localStorage / cookies, decode a JWT, inspect form or component state, or fire a fetch with custom headers",
    promptGuidelines: [
      "Use browser_eval to inspect runtime state (localStorage, cookies, in-page variables, JWT contents, computed styles) instead of guessing from source.",
    ],
    parameters: Type.Object({
      expression: Type.String({ description: "Expression or function source" }),
    }),
    async execute(_id, params) {
      return serialize(async () => {
        const p = await ensurePage();
        // Playwright's evaluate(string) treats the string as an expression.
        // A user-written `() => foo` therefore evaluates to a function *value*
        // rather than calling it.
        //
        // Previous attempt: a regex that detected arrow/function shapes and
        // wrapped them in `(<src>)()`. That double-wrapped already-called
        // IIFEs like `(() => 42)()` into `((() => 42)())()` → `42()` → TypeError.
        //
        // Robust approach: ask the page itself. Evaluate the source once,
        // and if the result is a function, call it. This handles all three
        // forms (plain expr, function value, IIFE) without ambiguity.
        const src = params.expression;
        const wrapped = `(() => { const __v = (${src}); return typeof __v === 'function' ? __v() : __v; })()`;
        try {
          const result = await p.evaluate(wrapped);
          const text =
            typeof result === "string"
              ? result
              : (JSON.stringify(result, null, 2) ?? String(result));
          return { content: [{ type: "text", text: sanitizeOutput(text) }], details: { result } };
        } catch (e) {
          const msg = redactBrowserDiagnostic(e instanceof Error ? e.message : String(e));
          // Keep the success/error result shape identical so the tool's
          // inferred return type stays a single union member — the error
          // text already lives in `content[].text`, no need to duplicate it
          // into details.
          return {
            content: [{ type: "text", text: `eval error: ${msg}` }],
            details: { result: undefined },
            isError: true,
          };
        }
      });
    },
  });

  pi.registerTool({
    name: "browser_console",
    label: "Browser Console",
    description:
      "Drain buffered console + pageerror entries (oldest first). With clear=true (default) the ENTIRE buffer is wiped after read, not just the entries returned — this is intentional, so subsequent calls observe a fresh window of activity rather than re-walking the same noise. Pass clear=false to peek without draining.",
    promptSnippet:
      "Read JS errors and console output captured since last drain — reach for this whenever a page seems broken without an obvious network cause",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Max entries (default 100)" })),
      filter: Type.Optional(
        Type.String({ description: "Only entries whose text/location contains this substring" }),
      ),
      clear: Type.Optional(
        Type.Boolean({
          description:
            "Clear the entire buffer after read (not just returned entries). Default true.",
        }),
      ),
    }),
    async execute(_id, params) {
      return serialize(async () => {
        const limit = params.limit ?? 100;
        requirePageOperations();
        const filter = params.filter;
        const filtered = filter
          ? consoleBuf.filter((e) => e.text.includes(filter) || (e.location ?? "").includes(filter))
          : consoleBuf.slice();
        const out = filtered.slice(-limit);
        if (params.clear ?? true) consoleBuf.length = 0;
        const text =
          out
            .map(
              (e) =>
                `[${new Date(e.ts).toISOString()}] ${e.type}: ${e.text}${e.location ? `  @ ${e.location}` : ""}`,
            )
            .join("\n") || "(empty)";
        return { content: [{ type: "text", text }], details: { entries: out } };
      });
    },
  });

  pi.registerTool({
    name: "browser_network",
    label: "Browser Network",
    promptSnippet:
      "Inspect the actual HTTP requests the page made - status, method, URL, and (with verbose=true) redacted Authorization / apikey / content-type headers. Use for 401 / 403 / CORS debugging",
    promptGuidelines: [
      "For auth or CORS issues, use browser_network with verbose=true (and urlFilter to narrow scope) only on an approved synthetic QA route. Sensitive header values are redacted while their presence remains visible.",
    ],
    description:
      "Drain buffered network requests. Default text output is one terse line per request ('<status> <method> <url>') to keep context small.\n\nOpt-in for headers: set verbose=true to inline a curated set of request/response headers on each returned row (authorization, apikey, content-type, x-client-info, accept-profile, content-profile, prefer, location, www-authenticate, retry-after). Sensitive values are always redacted. Pass includeHeaders=['cookie','cache-control',...] to add more header names for this call only (case-insensitive); sensitive values remain redacted. Best paired with urlFilter / status so headers only appear on the rows you care about.\n\nClear semantics: with clear=true (default) the ENTIRE buffer is wiped after read, not just the returned entries. This is intentional, so subsequent calls observe a fresh activity window rather than re-walking the same subresource noise. Pass clear=false to peek without draining.\n\nCaveat: fetches whose body is never consumed (e.g. `await fetch(url)` without `.text()`/`.json()`) often appear here as 'ERR ... net::ERR_ABORTED' even though the JS side saw a successful response. Chromium cancels the body stream and Playwright reports requestfailed. Consume the body if you want a clean status row.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number()),
      urlFilter: Type.Optional(Type.String({ description: "Substring filter on URL" })),
      status: Type.Optional(Type.Number({ description: "Exact HTTP status to match" })),
      verbose: Type.Optional(
        Type.Boolean({
          description:
            "Inline a curated set of request/response headers on each row. Off by default to keep context small.",
        }),
      ),
      includeHeaders: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Extra header names (case-insensitive) to surface alongside the curated default set. Sensitive values remain redacted. Implies verbose=true.",
        }),
      ),
      clear: Type.Optional(
        Type.Boolean({
          description:
            "Clear the entire buffer after read (not just returned entries). Default true.",
        }),
      ),
    }),
    async execute(_id, params) {
      return serialize(async () => {
        requirePageOperations();
        let entries = netBuf.slice();
        if (params.urlFilter) {
          const needle = params.urlFilter;
          entries = entries.filter((e) => e.url.includes(needle));
        }
        if (params.status != null) {
          const wanted = params.status;
          entries = entries.filter((e) => e.status === wanted);
        }
        const out = entries.slice(-(params.limit ?? 100));
        if (params.clear ?? true) netBuf.length = 0;

        const extra = (params.includeHeaders ?? []).map((h: string) => h.toLowerCase());
        const showHeaders = params.verbose === true || extra.length > 0;
        const allow = new Set([...KEEP_HEADERS, ...extra]);

        const result = serializeNetworkEntries(out, showHeaders, allow);
        return {
          content: [{ type: "text", text: result.text }],
          details: { entries: result.entries },
        };
      });
    },
  });

  pi.registerTool({
    name: "browser_fill",
    label: "Browser Fill",
    description: "Type a value into the input matching the selector.",
    promptSnippet:
      "Type into an input on the live page (dispatches input / change events properly, unlike a raw .value= assignment)",
    parameters: Type.Object({
      selector: Type.String(),
      value: Type.String(),
    }),
    async execute(_id, params) {
      return serialize(async () => {
        const p = await ensurePage();
        await p.fill(params.selector, params.value);
        return {
          content: [{ type: "text", text: `filled ${sanitizeMetadata(params.selector)}` }],
          details: {},
        };
      });
    },
  });

  pi.registerTool({
    name: "browser_click",
    label: "Browser Click",
    description:
      "Click the element matching the selector. CSS selectors and Playwright text= / role= selectors supported. Note: CSS attribute selectors match HTML attributes, not DOM properties — e.g. `button[type=submit]` will NOT match `<button>Submit</button>` even though that button's DOM `.type === 'submit'` by default. For semantic matching prefer `text=Submit` or `role=button[name=Submit]`.",
    promptSnippet:
      "Click an element on the live page — drives the app the way a user would, including form submits and SPA navigations",
    parameters: Type.Object({
      selector: Type.String(),
    }),
    async execute(_id, params) {
      return serialize(async () => {
        const p = await ensurePage();
        await p.click(params.selector);
        return {
          content: [{ type: "text", text: `clicked ${sanitizeMetadata(params.selector)}` }],
          details: {},
        };
      });
    },
  });

  pi.registerTool({
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description:
      "Save a PNG screenshot to a temp file and return its path. Use the read tool on that path to view it (separate step so vision-token cost is paid only when you choose).",
    promptSnippet:
      "Capture a PNG of the current page when DOM / state inspection isn't enough and you need to see the visual",
    parameters: Type.Object({
      fullPage: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params) {
      return serialize(async () => {
        const p = await ensurePage();
        const dir = mkdtempSync(join(tmpdir(), "pi-browser-"));
        const file = join(dir, "screenshot.png");
        await p.screenshot({ path: file, fullPage: params.fullPage ?? false, type: "png" });
        return {
          content: [{ type: "text", text: file }],
          details: { path: file },
        };
      });
    },
  });

  pi.registerTool({
    name: "browser_close",
    label: "Browser Close",
    description:
      "Close the current browser context and remove its temporary profile after confirmed closure. The next browser_* call starts with a fresh profile.",
    promptSnippet:
      "Close the current headless browser and request removal of its temporary profile.",
    parameters: Type.Object({}),
    async execute() {
      return serialize(async () => {
        await teardown();
        if (!enabled) setEnabled(false);
        return { content: [{ type: "text", text: "browser closed" }], details: {} };
      });
    },
  });

  pi.registerCommand("browser", {
    description:
      "Browser tools: '/browser on' to enable, '/browser off' to disable + close, bare '/browser' for status",
    handler: async (args, ctx) => {
      const cmd = (args || "").trim().toLowerCase();
      if (cmd === "on" || cmd === "enable") {
        if (enabled) {
          ctx.ui.notify("browser tools already enabled", "info");
          return;
        }
        await enable();
        ctx.ui.notify("browser tools enabled", "info");
        return;
      }
      if (cmd === "off" || cmd === "disable" || cmd === "close" || cmd === "kill") {
        const wasRunning = !!(page && !page.isClosed());
        await disable();
        ctx.ui.notify(
          wasRunning ? "browser tools disabled, browser closed" : "browser tools disabled",
          "info",
        );
        return;
      }
      // Bare /browser — status.
      const toolState = closeFailed
        ? "disabled (cleanup pending; retry browser_close)"
        : enabled
          ? "enabled"
          : "disabled (run /browser on)";
      const procState = page && !page.isClosed() ? `, open at ${redactBrowserUrl(page.url())}` : "";
      ctx.ui.notify(`browser tools: ${toolState}${procState}`, "info");
    },
  });

  // Default-off gate: page tools stay registered (visible in pi.getAllTools(),
  // command discovery normal) but their promptSnippet / promptGuidelines
  // drop out of the system prompt and they're not callable until /browser on
  // adds them back. browser_close remains active only for pending cleanup.
  // The actual setActiveTools call happens in the session_start handler
  // above, because pi forbids action methods during the factory.
}
