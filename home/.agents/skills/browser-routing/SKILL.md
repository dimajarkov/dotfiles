---
name: browser-routing
description: "Route browser work between Codex Computer Use and chrome-devtools-axi: use Computer Use for end-user visual QA, native macOS or cross-app flows, and pixels, canvas, video, or PDF; use chrome-devtools-axi for DOM, CSS, JavaScript, auth/session, network, console, storage, or performance debugging; combine them when symptom and cause both matter."
---

# Browser tool routing

Choose the narrowest tool that exposes the evidence needed.

## Computer Use through Codex

Use Computer Use through the Codex harness for:

- End-user flows and visual QA.
- Layout, spacing, clipping, focus, hover, drag, animation, and responsive behavior.
- Native macOS dialogs, permissions, menus, other applications, and cross-app workflows.
- Canvas, video, PDF, and anything whose important state exists only in rendered pixels.

Operate only Arc Browser in the workspace named exactly `computer use`.
Use its dedicated Arc window as agent-controlled UI.

## chrome-devtools-axi

Use `chrome-devtools-axi` for:

- DOM, accessibility tree, CSS, JavaScript, and event-handler inspection.
- Auth and session debugging.
- Network requests, response bodies, headers, CORS, cookies, and storage inspection.
- Console errors, runtime state, and performance traces.

The global Axi configuration launches Arc, not Google Chrome.
Keep the Arc target in the `computer use` workspace when attaching to an existing browser session.

Do not print tokens, cookie values, passwords, or complete storage/session objects.
Inspect only the claims, keys, headers, or fields needed to prove the hypothesis.

## Combine both

Use Computer Use first when the failure is visual or end-user-facing.
Use Axi next when the pixels need a browser-internal explanation.
Use Axi first when the failure is auth, session, network, DOM, or runtime state.
Use Computer Use afterward to verify the user-visible result.

Keep the same target and session identity during reproduction and verification.
Confirm state after every interaction instead of treating a successful command as proof of behavior.
