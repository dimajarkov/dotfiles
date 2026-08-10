# Codex-compatible Goals for Pi

This Pi extension ports Codex CLI's `/goal` workflow to Pi.
It was reverse engineered against OpenAI Codex commit [`61a3dd4387dabbbc9725bfac0b99dec1d902cfb3`](https://github.com/openai/codex/commit/61a3dd4387dabbbc9725bfac0b99dec1d902cfb3) and Codex CLI 0.147.0.

## Commands

- `/goal <objective>` creates an active, session-scoped goal and starts pursuing it.
- `/goal` shows the current objective, lifecycle status, elapsed time, token use, and budget.
- `/goal edit` edits the objective while preserving Codex's lifecycle semantics.
- `/goal pause` pauses automatic continuation.
- `/goal resume` resumes automatic continuation.
- `/goal clear` removes the goal.

## Behavior

The extension persists goal snapshots in Pi's session tree, injects Codex's continuation, objective-update, budget-limit, completion-audit, and blocked-audit instructions, and continues only at idle boundaries.
An automatic continuation that makes no tool call is deferred to prevent a spin loop.
Interrupting an agent run pauses its active goal.
Goals restore on session resume, stay paused when appropriate, and are copied in a deferred state when a Pi session is forked.
The footer reports the same lifecycle labels and compact elapsed-time or token-budget usage as Codex.
Objectives longer than Codex's 4,000-character backend limit are materialized under Pi's agent attachment directory and replaced with a file reference.

The model receives `get_goal`, `create_goal`, and `update_goal` tools with the same authority split as Codex.
The model may create a goal only when explicitly asked and may mark it complete or genuinely blocked.
Pause, resume, clear, budget-limit, and interruption transitions remain controlled by the user or harness.
Goal token accounting follows Codex's non-cached input plus output rule by summing Pi's `usage.input` and `usage.output` fields.

## Source map

- [Official Goals guide](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex)
- [Official Follow a goal use case](https://developers.openai.com/codex/use-cases/follow-goals)
- [Goal tool contracts](https://github.com/openai/codex/blob/61a3dd4387dabbbc9725bfac0b99dec1d902cfb3/codex-rs/ext/goal/src/spec.rs)
- [Continuation runtime](https://github.com/openai/codex/blob/61a3dd4387dabbbc9725bfac0b99dec1d902cfb3/codex-rs/ext/goal/src/runtime.rs)
- [Continuation prompt](https://github.com/openai/codex/blob/61a3dd4387dabbbc9725bfac0b99dec1d902cfb3/codex-rs/ext/goal/templates/goals/continuation.md)
- [Slash-command dispatch](https://github.com/openai/codex/blob/61a3dd4387dabbbc9725bfac0b99dec1d902cfb3/codex-rs/tui/src/chatwidget/slash_dispatch.rs)
- [Goal menu and edit semantics](https://github.com/openai/codex/blob/61a3dd4387dabbbc9725bfac0b99dec1d902cfb3/codex-rs/tui/src/chatwidget/goal_menu.rs)
- [Goal status indicator](https://github.com/openai/codex/blob/61a3dd4387dabbbc9725bfac0b99dec1d902cfb3/codex-rs/tui/src/chatwidget/goal_status.rs)

## Validation

Run the pure behavior tests with Node 24 or newer:

```sh
node --experimental-strip-types --test core.test.ts
```

Load the extension through Pi to validate the integration:

```sh
pi -e ./index.ts
```
