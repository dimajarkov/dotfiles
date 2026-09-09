---
name: web-debug
description: "Debug or verify frontend behavior in a live page using chrome-devtools-axi. Use for broken login/auth, failed or 401/403/CORS requests, JWT/session issues, forms or buttons doing nothing, blank screens, hydration mismatches, stale data, local/production differences, and end-to-end verification of frontend changes."
---

# Web debugging via the live page

First read `~/.agents/skills/chrome-devtools-axi/SKILL.md` for the browser backend, invocation, session ownership, and fallback policy.
Reproduce the user's failing flow in Axi before theorizing from source or asking the user to inspect devtools.

## Core loop

1. `chrome-devtools-axi open <url>` and inspect the snapshot.
2. Reproduce with `fill @<uid> <text>`, `click @<uid>`, or other commands using refs from the current snapshot.
3. Inspect `console --type error --limit 20` and `network --limit 50`.
4. Use `network-get <id>` or `console-get <id>` for relevant details and `eval '<expression>'` for runtime state.
5. Form a falsifiable hypothesis, change the code, and replay the same flow with an observable pass/fail assertion.

Keep the same cwd and session identity between calls.
Do not stop the browser between reproduction and verification.
Use `<command> --help` rather than translating Playwright selectors or buffer flags into unsupported Axi options.

## Playbooks

### Login, requests, and storage

Navigate to the login page, fill the fields using current snapshot refs, submit, and inspect the auth request and console.
Check whether expected storage keys exist without dumping credentials:

```sh
chrome-devtools-axi eval 'Object.keys(localStorage)'
chrome-devtools-axi network --type fetch --limit 50
# Use the actual request ID from the network list:
chrome-devtools-axi network-get <id>
```

A 200 auth response without the expected session is evidence to investigate client storage, timing, and SDK state, not proof of one cause.
For a 400/401/403, inspect the actual response and relevant request headers before attributing it to credentials, authorization, RLS, or server configuration.
For CORS, inspect the preflight and response CORS headers as well as the console error.
A persistent-profile login from another browser is not automatically present in Axi's isolated browser.

For Supabase, inspect only the needed claims from the expected `sb-<projectref>-auth-token` entry:

```sh
chrome-devtools-axi eval '() => {
  const raw = localStorage.getItem("sb-<projectref>-auth-token");
  if (!raw) return null;
  const token = JSON.parse(raw).access_token;
  if (!token) return { hasAccessToken: false };
  const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(part.padEnd(Math.ceil(part.length / 4) * 4, "=")), c => c.charCodeAt(0));
  const claims = JSON.parse(new TextDecoder().decode(bytes));
  return { role: claims.role, aud: claims.aud, exp: claims.exp, expiresIn: claims.exp - Math.floor(Date.now() / 1000) };
}'
```

Decoding is not signature verification.
Do not print raw tokens, cookie values, or entire storage/session objects.

### Forms and buttons doing nothing

```sh
chrome-devtools-axi eval '[...document.forms].map(f => ({action: f.action, method: f.method, valid: f.checkValidity()}))'
chrome-devtools-axi snapshot
# Click the submit button using its current @<uid>, then:
chrome-devtools-axi console --type error --limit 20
chrome-devtools-axi network --limit 50
```

Inspect validation constraints, disabled state, handler errors, and hydration before deciding why no request fired.
Confirm the resulting UI state after clicking; command success is not behavioral success.

### Blank screens and hydration

Inspect console errors, take and read a screenshot, and check `document.body.innerHTML.length` with `eval`.
If the DOM is empty, compare the served HTML with `web_fetch`; if populated, inspect rendering and styles rather than assuming a server or router failure.

### Local versus production

Run the same flow in both environments and compare the specific failing request, response, and runtime state.
Check the active origin and authenticated user without exposing credentials.
Respect production side effects: prefer read-only or disposable test data and do not submit destructive actions merely to reproduce a bug.

### Verify a frontend change end-to-end

Reload the changed page with `open`, drive the changed behavior, and assert the expected result using `eval` or a fresh snapshot.
For visual changes, save and read a screenshot and inspect layout, spacing, clipping, and error states.
Report what you actually exercised and any remaining coverage gaps.

## Pitfalls

- Return JSON-serializable properties from `eval`, not DOM nodes.
- Use an arrow function for multi-statement logic, not a top-level `return`.
- Consume response bodies in diagnostic `fetch` calls to avoid misleading aborted-request observations.
- Do not assume Pi's `browser_network` filters, `verbose`, or clear-on-read semantics apply to Axi.
- Use fetch/search for static public content; use repository-owned browser tests for repeatable large-scale verification.
