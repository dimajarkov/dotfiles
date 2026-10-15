---
name: web-debug
description: "Diagnose live frontend auth, requests, forms, rendering, or stale-state failures through the approved browser route. Use isolated Chrome diagnostics for synthetic QA and Codex Computer Use for rendered/native behavior; preserve Zen-specific routing."
---

# Web debugging via the live page

First read `~/.agents/skills/browser-routing/SKILL.md` for browser selection, task/profile ownership, and evidence scope.
For approved synthetic Chrome QA, use the upstream `chrome-devtools-axi` CLI and the repository's supported runtime/authentication commands.
Verify the disposable profile and target page before diagnostics; use fabricated accounts and preserve repository authorization boundaries.
For a Zen-specific failure, reproduce in Zen through Codex Computer Use and inspect Zen's own Developer Tools; Chrome results do not establish Zen behavior.
Use Codex Computer Use for rendered end-user behavior and visual/native checks, with any narrower repository proof mechanism applied through its owner.

## Upstream session invocation

Read `chrome-devtools-axi --help` and use the repository's approved isolated launch or explicit task-owned endpoint.
Keep the same shell-local `CHROME_DEVTOOLS_AXI_SESSION` value for the bounded proof, with repository-approved connection settings.
A named session identifies the bridge, not browser ownership or authentication.
The public launcher delegates to the installed upstream CLI; there are no dotfiles `--repo-qa`, receipt or target-type admission commands.

```sh
qa() {
  chrome-devtools-axi "$@"
}
```

## Core loop

1. Establish the isolated task-owned Chrome session before `qa open <url>` and inspect the expected synthetic page.
2. Reproduce interactively through the approved route and verify the rendered state after each action.
   Where the repository explicitly permits CDP interaction, use fresh snapshot refs for `fill`, `click`, and other commands.
3. Inspect bounded `console --type error --limit 20` and `network --limit 50` diagnostics.
4. Inspect only necessary privacy-safe request details or non-secret runtime claims through the supported diagnostic commands.
5. Form a falsifiable hypothesis, change the code, and replay the real flow with an observable pass/fail assertion.
   Label the observed browser; do not add an unrelated Zen acceptance gate to a Chrome QA task.

Keep the same cwd and session identity between calls.
Do not stop the browser between reproduction and verification.
Use `<command> --help` rather than translating Playwright selectors or buffer flags into unsupported Axi options.

## Playbooks

### Login, requests, and storage

Use the repository-owned authentication flow for its approved synthetic subject and target; preserve normal application authorization.
For Arena CRM, load the owner `docs/references/tools/browser-tools/auth-and-local-state.md` before authenticating.
A failed helper is a blocker, not permission for manual QA-password entry, generic cookie signing, or reuse of an existing session.
Inspect the auth request's safe status and console, then check expected storage keys without dumping credentials:

```sh
qa eval 'Object.keys(localStorage)'
qa network --type fetch --limit 50
```

A 200 auth response without the expected session is evidence to investigate client storage, timing, and SDK state, not proof of one cause.
For a 400/401/403, inspect the actual response status and necessary non-secret request/response fields before attributing it to credentials, authorization, RLS, or server configuration.
For CORS, inspect the preflight and response CORS headers as well as the console error.
A persistent-profile login from another browser is not automatically present in Axi's isolated browser.

For Supabase, inspect only the needed claims from the expected `sb-<projectref>-auth-token` entry:

```sh
qa eval '() => {
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
qa eval '[...document.forms].map(f => ({action: f.action, method: f.method, valid: f.checkValidity()}))'
qa snapshot
# Click the submit button using its current @<uid>, then:
qa console --type error --limit 20
qa network --limit 50
```

Inspect validation constraints, disabled state, handler errors, and hydration before deciding why no request fired.
Confirm the resulting UI state after clicking; command success is not behavioral success.

### Blank screens and hydration

Inspect console errors, take and read a screenshot, and check `document.body.innerHTML.length` with `eval`.
If the DOM is empty, compare the served HTML with `web_fetch`; if populated, inspect rendering and styles rather than assuming a server or router failure.

### Local versus production

Compare local synthetic evidence with an explicitly approved read-only production investigation when a supported production session mechanism exists.
The isolated Chrome QA exception does not authorize production/customer account access or a production browser session.
Check the active origin and authenticated identity without exposing credentials; stop when the approved environment/session boundary is unavailable.
Do not submit production mutations merely to reproduce a bug.

### Verify a frontend change end-to-end

Reload the changed task page, drive the behavior through the approved interaction route, and assert the observed result with matching UI plus API/database proof where required.
For visual changes, use permitted task-page capture, open each artifact, and inspect layout, spacing, clipping, error states, and privacy.
Report what actually ran, the exact source/runtime identity and browser, and every remaining coverage gap.

## Pitfalls

- Return JSON-serializable properties from `eval`, not DOM nodes.
- Use an arrow function for multi-statement logic, not a top-level `return`.
- Consume response bodies in diagnostic `fetch` calls to avoid misleading aborted-request observations.
- Do not assume Pi's `browser_network` filters, `verbose`, or clear-on-read semantics apply to Axi.
- Use fetch/search for static public content; use repository-owned browser tests for repeatable large-scale verification.
