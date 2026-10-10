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
Select the installed macOS application by its full path `/Applications/Zen.app` through Codex Computer Use (`cua.getApp("/Applications/Zen.app")`); confirm the returned app is Zen before interacting.
If that installed application is unavailable, report the missing installation before choosing another copy.
Do not rely on the default browser or select `"chrome"` in a browser API.
For development automation, browser testing, and localhost work, acquire Zen's existing space named exactly `development` before opening a task tab.
Prefer reusing a persistent normal Zen window kept on that space; a dedicated window is a routing target, not a separate workspace or proof of session isolation.
Zen's [window synchronization](https://docs.zen-browser.app/user-manual/window-sync) can mirror tabs across windows, so keeping a window dedicated does not replace identity checks.

For job applications, use Zen through Codex Computer Use and verify the intended account and task before taking an external action.

### Acquire and recover the development window

1. Read the native capability's documented window enumeration and activation methods, then discover and activate the matching existing Zen window yourself.
   When explicit window handles are unavailable, use Zen's native Window menu and fresh chrome/space observations; the first returned window is not evidence that another space is absent.
2. Select the existing `development` space using its confirmed native control and reread the selected-space state.
   App selection and window Raise are not by themselves proof of foreground activation; duplicate titles and changing menu ordinals are not durable window identities.
3. Verify app, selected space, target URL, and rendered task state agree before page interaction or accepting capture evidence.
   Confirm the actual foreground target before keyboard input; if accessibility state and screenshot identify different windows, stop input and report the native routing/capture mismatch rather than proceeding blindly.
4. Reacquire and revalidate after focus changes, title changes, or restart instead of trusting cached selectors.
   Keep task-owned tabs in the verified space and observe the target URL and state after each action.

Routine human foregrounding is a fallback only after supported native acquisition paths have been exhausted and the exact capability or permission gap is evidenced.
Do not create or rename spaces/profiles, change synchronization preferences, or use an unrelated space as a substitute.
If the required space or native Zen access genuinely remains unavailable, report the blocker rather than opening Chrome or Arc.

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

Use native Computer Use to reproduce the user-facing problem in Zen's `development` space, then inspect Zen's Developer Tools in that same task tab when browser internals matter.
Do not treat evidence from an isolated Chrome run as proof of Zen behavior.
Keep the same target and session identity during reproduction and verification.
Confirm state after every interaction instead of treating a successful command as proof of behavior.
