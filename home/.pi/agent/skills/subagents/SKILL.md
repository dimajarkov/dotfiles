---
name: subagents
description: invoke this skill when the user asks you to use subagents
---

# Subagents

Each subagent is headless, has its own context window, cannot see the parent conversation, cannot ask the user, and cannot spawn subagents or workflows.
Give every child a self-contained prompt with paths, constraints, and the expected report.

## Routing

- Small changes use the Pi harness with `openai-codex/gpt-5.6-luna` and `xhigh` reasoning.
- Planning uses the Codex harness with `gpt-5.6-sol` and `xhigh` reasoning.
- Long-running grunt work uses the Codex harness with `gpt-5.6-sol` and a `/goal` prompt.
- Computer-use work uses Codex Computer Use rather than this headless extension.
- Select Pi or Codex for Dmitri's work.
- The Claude harness remains available for compatibility but is selected only if Dmitri explicitly revises this routing preference.

## Pi Harness

**Harness:** `pi`
**Prompt nicknames:** “pi”, “pi agent”, “pi subagent”
**Best default:** `openai-codex/gpt-5.6-luna` with `xhigh` reasoning for small changes.

Pi can use any model shown by `pi --list-models`.
Prefer `provider/model-id`; a bare model id only works when unambiguous.
Pi inherits the parent model and thinking level when `model` or `reasoning_effort` is omitted.

**Thinking budgets:** `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
These map directly to Pi thinking levels.

## Codex Harness

**Harness:** `codex`
**Prompt nicknames:** “codex”, “Codex CLI”, “codex agent”, “codex subagent”
**Planning default:** `gpt-5.6-sol` with `xhigh` reasoning.
**Long-running default:** `gpt-5.6-sol` with `xhigh` reasoning and a self-contained `/goal` prompt.

**Thinking budgets accepted by the extension:** `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
Codex maps these to the nearest effort supported by the selected model; `off` and `minimal` become `minimal`, while `max` becomes the highest extension-supported Codex effort.

Requires the Codex CLI to be installed and authenticated.

## Claude Code Harness

**Harness:** `claude`
**Status:** compatibility only, not part of the normal routing policy.

## Spawn and Manage

Call `subagent_spawn` with a complete `prompt`, short `name`, chosen `harness`, and optional `working_dir`, `model`, and `reasoning_effort`. At most four subagents run concurrently.

- `subagent_check({ id })`: peek without blocking.
- `subagent_list()`: list all runs.
- `subagent_wait({ ids })`: block only when results are required to proceed.
- `subagent_cancel({ ids })`: stop runs while preserving partial transcripts.
- `/subagents`: inspect or take over a run interactively.

Results return automatically. After spawning, continue useful parent work instead of immediately waiting.
