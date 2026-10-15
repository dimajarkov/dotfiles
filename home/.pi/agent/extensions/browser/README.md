# pi browser extension

Playwright-driven headless Chromium that pi can drive directly for approved synthetic application QA.\
It can navigate, inspect the DOM and storage, watch the console and network, fill forms, and click through test flows.

## Why it exists

When a frontend bug reduces to "what's in localStorage?" or "did supabase-js attach an `Authorization` header?", the agent currently has to ask the user to paste console output and curls.
With this extension it can answer those questions itself without exposing credential values in network output.

## Install

Home Manager installs the locked dependencies and Chromium binary during activation.
To repair an installation manually:

```bash
cd ~/.pi/agent/extensions/browser
npm ci --ignore-scripts
PLAYWRIGHT_BROWSERS_PATH="$PWD/.browsers" ./node_modules/.bin/playwright-core install chromium
```

Then `/reload` inside pi (or restart).
The new tools (`browser_goto`, `browser_eval`, ...) appear in `pi.getAllTools()` automatically because the folder is under `~/.pi/agent/extensions/`.

## Default off, opt in per session

The browser tools collectively cost ~800 tokens in the system prompt (snippets + guidelines) but are only useful in the small minority of sessions that involve driving a live SPA.
They're therefore registered but **inactive** by default: invisible to the agent, not callable, no prompt snippets or guidelines emitted.

Flip them on explicitly with `/browser on` when a repository-approved QA task requires this route:

```
/browser on        # enable
/browser           # status
/browser off       # disable and close the headless browser
```

After an explicit `/browser on`, the enable bit persists on the active Pi session branch via a custom session entry, so `/reload` and resuming that branch preserve the deliberate opt-in.\
Pi 1.1 emits `session_tree` after changing the active leaf.\
That event disables page operations immediately, waits for in-flight operations and closes the abandoned branch's context, then restores opt-in from `getBranch()` on the selected branch.\
This teardown also runs when both branches opted in; `/new` resets to off.\
This does not restore browser cookies, localStorage, or a previous browser profile.\
Disabling also tears down the Chromium context (`browser_close` semantics) so no background browser is left running.\
If closure or profile removal cannot be confirmed, `browser_close` remains available for cleanup retries without re-enabling page tools.

## Tools

(Only visible to the agent while `/browser on`, except `browser_close` while cleanup is pending.)

| Tool                 | Purpose                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser_goto`       | Navigate to a URL. Returns `{ status, finalUrl }`.                                                                                                                                          |
| `browser_eval`       | Run JS in the page. Expression, function source, or already-called IIFE - all three work. Return value must be JSON-serializable.                                                           |
| `browser_console`    | Drain buffered console + pageerror entries (filterable, bounded to 1000).                                                                                                                   |
| `browser_network`    | Drain buffered network requests. Default output is terse (`status method url`); pass `verbose: true` and/or `includeHeaders: [...]` to inline curated request/response headers on each row. |
| `browser_fill`       | Type a value into an input matched by selector.                                                                                                                                             |
| `browser_click`      | Click an element (CSS, `text=...`, `role=...`).                                                                                                                                             |
| `browser_screenshot` | Save a PNG to a tempdir and return its path; pi can `read` it to view.                                                                                                                      |
| `browser_close`      | Close the current context and remove its temporary profile after confirmed closure.                                                                                                         |

All page-touching tools serialize through a single internal queue, so it's safe to fire several `browser_*` calls in one batch - they run in submission order against the shared Page rather than racing each other.

The `/browser` command also controls the enable gate (`on` / `off` / bare for status; `close` and `kill` are aliases for `off`).

## State and profile lifecycle

- Each browser context gets one newly allocated private temporary user-data directory.
  The directory is shared across tool calls only while that context is open.
- Fixed Chromium launch flags disable extensions and sync, isolate OS keychains, and explicitly keep the browser sandbox enabled.
- `browser_close`, `/browser off`, and `session_shutdown` remove only that internally allocated directory after `context.close()` resolves.
- If launch fails before a context is returned or `context.close()` rejects, the profile is left in place and cleanup is not reported as successful.
  Further launches are blocked until closure is genuinely confirmed, so the unconfirmed profile evidence cannot be orphaned by allocating a replacement.
- A failed close records a `browser-lifecycle` entry with state `close-failed` and a branch opt-out, disables every page operation (including already queued calls and buffer reads), and leaves only `browser_close` available.
  `/browser on` refuses until a cleanup retry confirms closure.
  After successful cleanup, explicit opt-in starts a fresh profile.
- If profile removal fails after a confirmed context close, cleanup is reported as unconfirmed and retried before the next launch.
- Cookies and browser storage can persist between calls in one open context, but are never automatically reused across context launches or pi restarts.
  A failed launch or close may leave disposable profile data on disk.
- `PI_BROWSER_PROFILE` is unsupported and rejected before Playwright is imported or Chromium is launched.
  Its value is never included in the error message.
- Historical `~/.pi/agent/extensions/browser/.profile` data is not read, migrated, or removed.
- Console and network events are captured into in-memory ring buffers (max 1000 entries each).
  `browser_console` and `browser_network` drain them by default.

## Knobs

| Env var                    | Default                                    | Effect                                                                                                                                              |
| -------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_BROWSER_HEADFUL`       | unset                                      | If set, launch a visible Chromium window. Useful when debugging the extension itself.                                                               |
| `PI_BROWSER_PROFILE`       | unset                                      | Unsupported. If set, operations that would launch Chromium fail without exposing its value. Profiles are always privately allocated and disposable. |
| `PLAYWRIGHT_BROWSERS_PATH` | `~/.pi/agent/extensions/browser/.browsers` | Override the Home Manager-provisioned browser binary directory.                                                                                     |

## Network output: terse by default, headers on opt-in

`browser_network` keeps the default text payload minimal - one line per request, `status method url` - because a single SPA page load fires 30-100 subresource requests and inlining headers on all of them would drown the agent's context window in noise.

When you actually want headers (the auth-debugging use case), opt in:

- `verbose: true` - inline a curated set of request/response header names on
  each returned row. Sensitive values are replaced with `[REDACTED]`. The
  curated set is small on purpose:

  ```
  authorization, apikey, content-type, x-client-info, accept-profile,
  content-profile, prefer, location, www-authenticate, retry-after
  ```

- `includeHeaders: ["cookie", "cache-control", ...]` - extend the curated set
  for this call only (case-insensitive). Implies `verbose: true`; sensitive
  values remain redacted.

All headers are captured into the ring buffer regardless; the shared output serializer redacts sensitive values from both rendered text and structured details.
`verbose` / `includeHeaders` only affect what's rendered into the text output.
Best paired with `urlFilter` / `status` so headers only appear on the rows you actually care about.

Clear-on-read drains the **entire** buffer by default, not just the rows returned.
This is intentional: subsequent calls observe a fresh activity window rather than re-walking the same subresource noise.
Pass `clear: false` to peek without draining.

## Approved use and evidence limits

- This optional extension remains default-off.
  Use it only when repository-owned runtime, authentication, and proof instructions explicitly approve isolated Chromium for synthetic application QA.
- Do not use personal browser profiles, personal accounts, real user data, or production authentication through this extension.
- The extension does not authorize or replace a repository-required runtime, authentication flow, test, or proof route.
  If the required route is unavailable, do not substitute this extension.
- Report observations as headless Chromium evidence only.
  They do not prove branded Chrome, Zen, native-app, or other browser behavior, and must not be described as Zen compatibility.
- The separate public `chrome-devtools-axi` launcher delegates to the installed upstream CLI.
  Read its `--help` for isolated launch, named sessions and explicit endpoint attachment.
  Repository runtime and authentication instructions establish task ownership; neither CLI nor this optional extension provides an egress-containment guarantee.
  Neither route authorizes substituting for an unavailable repository-required authentication or proof mechanism.

## Caveats and known limits

- `playwright-core` ships without browser binaries; Home Manager provisions the
  matching Chromium build into the ignored `.browsers` runtime directory.
- The page object is a singleton — there's no tab/window management. If you
  need multiple tabs, extend `ensurePage` to accept a tab id.
- `browser_eval` evaluates the source once and, if the result is a function,
  calls it. So expressions (`localStorage.length`), function values
  (`() => doStuff()`), and already-called IIFEs (`(() => 42)()`) all do what
  you'd expect. Note: top-level `return` and multi-statement bodies aren't
  valid expressions — wrap them in `(() => { ... })()`.
- For DOM nodes, return primitive properties (`.outerHTML`, `.textContent`,
  `.value`) rather than the node itself; Playwright serializes nodes as the
  opaque sentinel `"ref: <Node>"`.
- `browser_eval` returns `undefined` as `null` after JSON serialization. Wrap
  expressions in a function that returns a sentinel if you care.
- `browser_click`: CSS attribute selectors match HTML attributes, not DOM
  properties. `button[type=submit]` will NOT match `<button>Submit</button>`
  even though that button's `.type === "submit"` by default. Prefer
  `text=Submit` or `role=button[name=Submit]` for semantic matching.
- `browser_network` shows `ERR net::ERR_ABORTED` for fetches whose body was
  never consumed (e.g. `await fetch(url)` without `.text()` / `.json()`).
  Chromium cancels the body stream and Playwright reports `requestfailed`
  even though the JS side saw a successful response. Consume the body if you
  want a clean status row.
- Network buffer captures headers but not bodies. Add `request.postData()` /
  `response.text()` capture if you need bodies (will eat context fast — gate
  it behind a flag).
- No download / file-upload helpers yet. Add when needed.
- OTP / 2FA: the extension has no mail integration. Human still has to paste the code into `browser_fill`.

## Possible next features

- `browser_wait_for(selector|url)` for explicit synchronization.
- `browser_request_body` to expose request/response bodies on demand without
  ballooning the default network buffer.
- Mail-fetch tool (Gmail API or Mailpit) so OTP logins can be fully automated.
- `fly_logs` companion tool — `flyctl logs -a <app>` tailed into a similar
  ring buffer — so the agent can correlate frontend behavior with backend
  errors without context switching.
