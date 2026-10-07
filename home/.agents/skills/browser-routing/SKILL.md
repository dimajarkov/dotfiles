---
name: browser-routing
description: "Route Zen Browser work through Codex Computer Use for end-user visual QA and native macOS flows; identify when Chrome-only CDP, authentication, or PDF tools cannot be used with Zen. Load before browser control or local Arena CRM UI proof."
---

# Browser tool routing

Choose the narrowest tool that exposes the evidence needed.

## Computer Use through Codex

Use Computer Use through the Codex harness for:

- End-user flows and visual QA.
- Layout, spacing, clipping, focus, hover, drag, animation, and responsive behavior.
- Native macOS dialogs, permissions, menus, other applications, and cross-app workflows.
- Canvas, video, PDF, and anything whose important state exists only in rendered pixels.

Use Zen Browser for interactive browser work, including Arena CRM localhost and visual QA.
Resolve the native macOS app by bundle identifier `app.zen-browser.zen` through Codex Computer Use; confirm the returned app is Zen before interacting.
Do not rely on the default browser or select `"chrome"` in a browser API.
For development automation, browser testing, and localhost work, switch to Zen's space named exactly `Development` before opening a task tab.
Verify the selected space is `Development` and the returned app is Zen before navigating or interacting; keep task-owned tabs there and observe the target URL and state after each action.
Do not create a separate workspace or use an unrelated space as a substitute.
If the Development space or native Zen access is unavailable, stop and report the blocker rather than opening Chrome or Arc.
For job applications, follow the personal-browser procedure below before selecting any window.

## Personal browser for job applications

Read [the personal connector procedure](references/job-browser.md) before browser discovery or execution.
`job-policy.json` owns the expected personal account and window identity.
The current personal-browser gate requires a Chrome-only extension and cannot attest a Zen window or profile.
Until a Zen-compatible connector and identity gate have been implemented and verified, stop before external job-application browser actions.
Never bypass the gate through native Zen, the support profile, generic browser selection, Chrome, or Axi.
Only the exclusive browser executor performs external actions; preparation and local PDF validation require no personal browser access.
The gate is supplemental to host permissions and cannot intercept arbitrary raw Computer Use calls.

## Chrome-only debugging (disabled)

`chrome-devtools-axi` and Chrome DevTools MCP use Chrome's CDP for DOM, CSS, auth, network, storage, console, and performance diagnostics; they cannot control Zen.
Do not use them as a Zen debugging route or set their executable path to Zen; this is not a supported migration.
For interactive Zen debugging, use native Computer Use and Zen's own Developer Tools where visible; inspect only task-owned pages.
When network, storage, performance, or DOM proof needs programmatic access beyond that route, report the gap rather than silently using a different browser.

Do not print tokens, cookie values, passwords, or complete storage/session objects.
Inspect only the claims, keys, headers, or fields needed to prove the hypothesis.

## PDF rendering and browser launch safety

The job-application HTML-to-PDF script currently invokes headless Chrome and is not a Zen renderer.
Do not run it under a Zen-only request; report a rendering blocker until a replacement is validated, or use previously validated unchanged PDFs when their exact-file evidence remains current.
Do not pass the Zen executable to a Chrome CLI, construct a raw browser command, use a Puppeteer/Playwright workaround, or disable a browser sandbox to bypass macOS launch restrictions.
For job-application package approval, follow the job-application skill's exact-file text and rendered-page image checks for existing PDFs using an available non-Chrome local PDF-to-image tool and the image-reading tool.
These checks require no native Computer Use, unlocked desktop, personal browser session, or browser lock.
For other PDF workflows requiring interactive viewer inspection, use Codex Computer Use in Zen, keeping unrelated windows and profiles untouched.
Instruction routing is not a hard execution guard.
Codex pre-execution hooks are supplemental and require host support and hook trust; they cannot intercept every SDK subprocess or dynamically constructed launch.

## Diagnosis in Zen

Use native Computer Use to reproduce the user-facing problem in Zen's `Development` space, then inspect Zen's Developer Tools in that same task tab when browser internals matter.
Do not treat evidence from an isolated Chrome run as proof of Zen behavior.
Keep the same target and session identity during reproduction and verification.
Confirm state after every interaction instead of treating a successful command as proof of behavior.
