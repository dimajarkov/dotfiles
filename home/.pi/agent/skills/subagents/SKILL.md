---
name: subagents
description: Use Pi interactive subagents for parallel specialist work, native child conversations, planning and full-context iteration in Herdr or another supported multiplexer.
---

# Interactive Pi subagents

This configuration uses the immutable `dimajarkov/pi-interactive-subagents` package declared in Pi settings.
Each child is an actual interactive Pi session in its own terminal pane.
Use the registered upstream tools and commands below; the old headless extension remains disabled.
For Codex's own native subagents, use the Codex harness tools instead of translating their arguments into this extension.

## Delegate and continue

Call `subagent` with `name` and a self-contained `task`.
Select a bundled `agent` when its defaults fit the work.
Optional `cwd`, `model`, comma-separated `tools` and comma-separated `skills` override that definition's corresponding defaults.
Configured skills are included in the initial child task before autonomous execution.
Missing models or skills are errors; report them instead of substituting another model or execution harness.

The call acknowledges launch immediately.
Continue independent parent work or end the turn; the native asynchronous result wakes the parent when ready.
Use only delivered results when reporting completion.
The parent status widget supplies ongoing supervision; `subagents_list` discovers available definitions, not running-task completion.
If launches fail immediately with the same infrastructure or lifecycle error, stop automatic retries and report delegated work as blocked with no findings.
Preserve the original error, native session paths and lifecycle receipt paths, then diagnose before retrying.
Do not replace requested delegated findings with local investigation unless the user approves that change of workflow.
Use `subagent_interrupt` with the exact running `id` or `name` to interrupt a turn while keeping its Pi session available.
Use `subagent_resume` with the delivered native `sessionPath` and optional follow-up `message` to continue an existing conversation.
Its `autoExit` option defaults to true; false keeps the resumed child interactive.

## Context and definitions

Project `.pi/agents/<name>.md` definitions take precedence over global agent definitions, then bundled specialists.
A hidden project definition still shadows a bundled name; explicit `/subagent` selection can use a hidden definition.
Inspect `subagents_list` for the effective definition before assuming a project has the bundled defaults.

- `standalone` starts a fresh native conversation without ancestry.
- `lineage-only` starts without copied turns but retains the native parent reference.
- `fork` copies the current conversation and links its ancestry.

The public `fork: true` argument forces the full-context fork; other context defaults come from definition `session-mode` frontmatter.
Agent frontmatter also controls `thinking`, `auto-exit`, `interactive`, `spawning`, `deny-tools`, `cwd` and system prompt mode.
`interactive: true` suppresses autonomous stall/recovery notifications; it does not itself override an `auto-exit: true` definition.
Nested delegation follows the effective definition's spawning and denied-tool controls.

## Commands and workflows

- `/subagent <agent> <task>` starts a named specialist through the public tool.
- `/iterate <task>` requests a full-context fork for focused iteration.
- `/plan <feature>` runs scout investigation, interactive planning, sequential workers and independent review.

The declared planning resources provide the `todo` tool and the `write-todos` and `commit` skills from the pinned HazAT configuration snapshot.
The planner produces its plan and todos; workers get, claim and close their own todos.
Finish an interactive planner explicitly so its result returns to the parent.

| Bundled role | Provider/model | Thinking |
| --- | --- | --- |
| planner | `openai-codex/gpt-6-astra` | medium |
| scout | `openai-codex/gpt-6.1-sol` | medium |
| worker | `openai-codex/gpt-6.1-sol` | medium |
| reviewer | `openai-codex/gpt-6.1-sol` | medium |
| visual-tester | `openai-codex/gpt-6.1-sol` | medium |

These five roles run Pi children, including the planner.
This is the interactive extension's specific routing exception; the parent's `openai-codex/gpt-6.1-sol` and `xhigh` defaults and unrelated Codex routing stay unchanged.
Keep the exact requested model when unavailable and report the blocker.

## Native interaction and completion

Navigate to a child using ordinary Herdr pane navigation.
Typing a later human prompt disables that child's autonomous auto-exit for the conversation.
An interrupted turn leaves the child open, and takeover remains in effect on later turns.
An untouched `auto-exit: true` child closes after autonomous completion and returns its summary.
For an interactive child, send the final assistant summary, then invoke `subagent_done` to close and return it explicitly.
Use `caller_ping` when guidance is needed; it notifies the parent and preserves the native session for `subagent_resume` with an answer.

The child tools widget expands and collapses with `Ctrl+J`.
Parent completion messages expand with `Ctrl+O` to show the full summary and native session reference.
Herdr operations target the actual calling pane and owned children, preserving unrelated panes and focus.
A zoomed parent must be unzoomed before delegation; a refused or incomplete visible launch is reported rather than replaced by headless execution.
Automatic selection uses Herdr's injected caller context; `PI_SUBAGENT_MUX=herdr` explicitly selects Herdr and fails when its prerequisites are absent.

## Visual work

Read `~/.agents/skills/browser-routing/SKILL.md` before browser tasks.
The visual-tester uses `codex_computer_use` only through an explicitly active Codex app host, its normal permissions and an exact bounded task target.
A role name, model choice or host lease alone does not prove Computer Use capability or a visual observation.
Use the returned evidence and provenance, and report absent or expired capability precisely.
Approved synthetic browser QA requires the supported isolated Chrome route, task-owned profile and target checks; personal browser work follows browser-routing.
Computer Use does not automate terminal apps or ChatGPT.
Browser CLI diagnostics do not replace the required native rendered observation.

For immutable updates, isolated validation, rollout gates and history-preserving rollback, read `~/.dotfiles/docs/agents/pi-interactive-subagents-installation.md`.
