---
name: browser-routing
description: "Choose Zen for personal/native work or isolated Chrome for approved synthetic QA. Load before browser launch, control, authentication, capture, or cleanup to verify routing, ownership, and task-owned shutdown."
---

# Browser tool routing

Choose the narrowest tool that exposes the evidence needed.

## Capability check before browser fallback

Before launching or controlling a browser, or asking the user to unlock the desktop, identify whether the task needs a service operation or rendered/native evidence.
For service operations such as publishing an artifact, editing a PR, or retrieving structured data:

1. Inspect the relevant connector or installed CLI's supported commands and flags.
2. When a preferred wrapper lacks the operation, check the upstream CLI's installed version/help and official API documentation before concluding that a browser is required.
   Follow the service's skill for the supported fallback; GitHub capability discovery and attachment delivery are owned by [`gh-axi`](../gh-axi/SKILL.md).
3. Prefer the supported CLI/API route within the existing authentication and authorization boundaries, and verify the result by readback.
4. Use Computer Use when rendered/native interaction is the requested evidence or the supported programmatic routes have an evidenced gap.
   Record the specific reason for that fallback before involving the user's desktop.

Uploading a video or PDF is a service operation; checking its rendered playback or appearance is a separate evidence step.
A CLI/API result does not substitute for required interactive journey or visual proof.
This routing check preserves all browser isolation, authentication, privacy, ownership, and cleanup requirements below.

## Computer Use through Codex

When rendered/native interaction is required, use Computer Use through the Codex harness for:

- End-user flows and visual QA.
- Layout, spacing, clipping, focus, hover, drag, animation, and responsive behavior.
- Native macOS dialogs, permissions, menus, other applications, and cross-app workflows.
- Canvas, video, PDF, and anything whose important state exists only in rendered pixels.

Choose the route from the task, not the system default browser:

- Personal browsing, job applications, native workflows, and explicitly requested Zen compatibility use Zen through Codex Computer Use.
- Approved application QA, including Arena CRM, may use repository-managed Chrome with a fresh disposable task-owned profile and fabricated synthetic accounts.
  This is a QA exception, not permission to access personal Chrome sessions or substitute Chrome for a Zen-specific task.
- Browser-independent API/database checks remain separate from browser evidence.
  Chrome evidence proves only observed Chrome behavior; add Zen checks when the task requires Zen behavior, not as an automatic second acceptance gate.

For Zen, select `/Applications/Zen.app` through Codex Computer Use (`cua.getApp("/Applications/Zen.app")`) and confirm the returned app before interacting.
If that installed application is unavailable, report the missing installation before choosing another copy.
For localhost work in Zen, acquire the existing space named exactly `development` before opening a task tab.
Prefer reusing a persistent normal Zen window kept on that space; a dedicated window is a routing target, not a separate workspace or proof of session isolation.
Zen's [window synchronization](https://docs.zen-browser.app/user-manual/window-sync) can mirror tabs across windows, so keeping a window dedicated does not replace identity checks.
For job applications, verify the intended account and task before taking an external action.

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

## Isolated Chrome application QA

For native Chrome QA, use the Nix-owned `~/Applications/Google Chrome for Testing.app` with a fresh disposable profile.
Select that exact app path through Computer Use; bundle ID `com.google.chrome.for.testing` alone can be ambiguous when cached testing builds are also installed.
Run one native Computer Use task against this testing app at a time and verify the expected task URL and rendered page before input.

Before launch or attachment, use the repository-owned QA/runtime/authentication commands and their existing safety checks.
Keep Herdr placement, worktree leases, local routing, provider guards, and approved mutation scope binding; choosing Chrome does not waive them.
A repository without a supported isolated route needs prerequisite tooling, not a raw browser launch or an arbitrary CDP endpoint.

### Browser lifecycle: preflight, reuse, close

1. **Preflight before launch.** Confirm the required tools and host are actually available, including Codex Computer Use when native interaction is needed.
   Confirm the runtime has an ownership-checked shutdown path; a helper that only stops its fixture and leaves Chrome running is not a complete lifecycle.
   If either prerequisite is missing, report the blocker before creating a browser.
2. **Own one instance per bounded task.** Create a fresh private disposable profile with no copied profile data, Google sign-in, synchronization, extensions, or personal keychain access.
   Record the task/repository, browser executable, PID and process birth identity, profile identity, endpoint, controller, and supported stop command in private task state.
   These records must be verifiable against the live process, not merely assertions by the caller.
3. **Reuse within the task.** Keep the same owned browser/profile across steps, retries, agent handoffs, and recoverable failures, revalidating ownership before attachment.
   Inspect the task's recorded instance before launching a replacement; closing a controller or losing its connection does not prove Chrome exited.
   A genuinely new proof run gets a fresh profile after retiring the previous owned instance, not an additional browser left beside it.
   Parallel tasks need separate ownership; another task's browser is neither reusable capacity nor a cleanup target.
4. **Close when the task ends.** On success, failure, blockage, cancellation, or replacement, use the supported graceful shutdown for that exact browser and its task-owned controllers/listeners.
   Verify exit and released endpoints before reporting cleanup complete or launching a replacement.
   A disconnected debugger, expired receipt, closed window, or stopped fixture alone is not proof of browser shutdown.
5. **Retain evidence, not running browsers.** Keep privacy-reviewed artifacts and any required profile/recovery files separately from the live processes.
   Keeping a browser alive for a later handoff requires explicit user approval, a named owner, and a clear end condition; report it as retained, not cleaned up.
   If shutdown fails or ownership becomes inconclusive, preserve the resources, report the exact blocker and recovery metadata privately, and stop automatic relaunches.

### Verify isolation and preserve other work

Before connecting or reusing a bridge, verify the actual live process/profile, loopback endpoint, task/repository identity, and target page.
A session name, caller flag, profile pathname, or self-reported receipt alone does not establish isolation.
The repository runtime owner is responsible for verifying the private profile, process, endpoint and target page.
The upstream CLI does not enforce dotfiles-specific task receipts, Herdr caller binding or a browser-target allowlist.
An isolated profile is not browser-network confinement.
Use the repository's authentication, tenancy, provider and approved-operation boundaries to protect application state; a task needing enforced egress containment requires a separately validated sandbox and is outside this QA exception.
Fail closed on stale, foreign, missing, or inconclusive ownership; preserve siblings and their sessions.
Cleanup revalidates process birth, executable, profile, and task ownership before stopping only exact-owned resources, then re-probes survivors.
Age, inactivity, an expired allocation, or an exited parent is a reason to investigate, not permission to stop another task's browser.
Preserve personal/default profiles, unrelated browsers, active QA sessions, retained app data, and worktree leases; never use kill-all or broad process-name matching.

Use Codex Computer Use for end-user visual/native interaction, with the verified private QA window as its target.
Apply repository-specific authentication, interactive proof, capture, and review rules through their owning commands; CDP diagnostics are not a substitute for observing the rendered state.
Capture only the verified task page through supported tooling, not unrelated tabs, another profile, or the desktop.
Use fabricated synthetic accounts and the repository's supported authentication boundary; profile isolation is not authorization.
Production/customer/provider operations still require their existing separate approvals.

`chrome-devtools-axi` and Chrome DevTools MCP use Chrome's CDP for DOM, CSS, auth, network, storage, console, and performance diagnostics; they cannot control Zen.
`chrome-devtools-axi` forwards directly to the existing npm-owned upstream CLI.
Read its `--help` for supported isolated launch, named-session and explicit endpoint options.
Use the repository-approved disposable profile and verify the target before commands; browser connection alone does not establish task ownership.
For interactive Zen debugging, use native Computer Use and Zen's own Developer Tools on task-owned pages; report unsupported programmatic inspection rather than substituting Chrome.
Do not print tokens, cookie values, passwords, or complete storage/session objects.
Inspect only the claims, keys, headers, or fields needed to prove the hypothesis.

## Shared Zen lifecycle

Reuse the existing personal Zen application and its `development` space rather than creating disposable Zen sessions.
Track which tabs/windows the task created; close those when finished only if they still belong exclusively to the task and contain no user work or unsaved input.
Preserve pre-existing tabs/windows and report uncertain ownership instead of closing them.
Ending a task never authorizes quitting the shared Zen app or changing its profiles, spaces, or synchronization.

## PDF rendering and browser launch safety

The job-application HTML-to-PDF script currently invokes headless Chrome and is not a Zen renderer.
Do not run it under a Zen-only request; report a rendering blocker until a replacement is validated, or use previously validated unchanged PDFs when their exact-file evidence remains current.
Do not pass the Zen executable to a Chrome CLI, construct a raw browser command outside the approved owner, use Puppeteer/Playwright to bypass isolation or task routing, or disable a browser sandbox to bypass macOS launch restrictions.
For job-application package approval, follow the job-application skill's exact-file text and rendered-page image checks for existing PDFs using an available non-Chrome local PDF-to-image tool and the image-reading tool.
These checks require no native Computer Use, unlocked desktop, personal browser session, or browser lock.
For other PDF workflows requiring interactive viewer inspection, use Codex Computer Use in Zen, keeping unrelated windows and profiles untouched.
Instruction routing and the upstream CLI are not an OS sandbox.
Repository ownership and authorization boundaries apply to every executable or SDK used for the task.
Codex pre-execution hooks are supplemental and require host support and hook trust; SessionStart guidance cannot enforce later calls.

## Diagnosis in Zen

Use native Computer Use to reproduce the user-facing problem in Zen's `development` space, then inspect Zen's Developer Tools in that same task tab when browser internals matter.
Do not treat evidence from an isolated Chrome run as proof of Zen behavior.
Keep the same target and session identity during reproduction and verification.
Confirm state after every interaction instead of treating a successful command as proof of behavior.
