# Native Codex subagent role recommendations

Research date: 2026-11-13.
Scope: native Codex TUI subagents, with Astra medium as the coordinator, Sol 6.1 medium for subagents, and four concurrent subagent slots.
This note proposes configurations; it does not install agents or change the live configuration.

## Recommendation and evidence quality

Start with four reusable roles: `scout`, `implementer`, `reviewer`, and `verifier`.
Add `docs_researcher` and `browser_debugger` for tasks that need them.
This is a recommendation based on distinct responsibilities and the user's workflow, not a benchmarked ranking or a claim about the most popular agent roster.
Keep planning, scope decisions, integration, and final explanation with the Astra coordinator.
An additional permanent planner would add a handoff without an established need in this setup.

| Role | Assigned question | Expected result | Boundary |
| --- | --- | --- | --- |
| `scout` | Where does this behavior live, and what constrains it? | Relevant paths, execution flow, local conventions, uncertainties | Exploration only |
| `implementer` | Can you implement this bounded change? | Patch, rationale, relevant verification, remaining risks | Own an explicit file/module scope |
| `reviewer` | What concrete defects could this change introduce? | Findings with impact, evidence, reproduction or triggering conditions | Review without edits |
| `verifier` | Does the claimed behavior actually hold? | Reproduced results, commands, supported/unsupported claims, gaps | Independently check; do not repair failures |
| `docs_researcher` | What does the authoritative current documentation say? | Primary links, version applicability, uncertainty | Research only |
| `browser_debugger` | What does the user actually see and experience? | Reproduction steps, visible behavior, relevant UI/network evidence | Follow approved browser routing; no application edits |

Separating reviewer and verifier is deliberate.
The reviewer searches for failure modes in the change; the verifier checks the acceptance claims through observation and meaningful checks.
A verifier can run tests without becoming the agent that writes every test.
Specialized security, database, performance, or accessibility review can be an assignment to the reviewer until repeated use demonstrates a need for a permanent distinct role.

## What published examples actually configure

OpenAI documents a review team comprising `pr_explorer`, `reviewer`, and `docs_researcher`.
Its frontend investigation example uses `code_mapper`, `browser_debugger`, and `ui_fixer`.
The examples use Luna high for lighter exploration/research/implementation roles and Sol 6.1 medium for review and browser debugging.
These are documented examples, not evidence that those model allocations are optimal for this user.
OpenAI also recommends beginning with parallel exploration, triage, tests, and summarization, while coordinating simultaneous edits carefully.
[Source: OpenAI Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents).

Ray Fernando's published `waves-codex` configuration defines `parallel_explorer`, `docs_researcher`, `parallel_worker`, `reviewer`, and `verifier`.
Its model examples use the older GPT-5.6 family: Terra low for exploration, Terra medium for documentation, and Sol high for implementation/review/verification.
The useful transferable pattern is bounded ownership plus an evidence-bearing handoff, not its historical model names.
Some examples set agent-local `sandbox_mode` and MCP settings; do not copy those assumptions into this setup.
The document contains historical runtime caveats and conflicting statements about custom-role behavior, so it is evidence of a published workflow rather than the authority for current compatibility.
[Source: owner's recommended configuration](https://github.com/RayFernando1337/rayfernando-skills/blob/main/plugins/waves-codex/skills/waves-codex/references/recommended-config.md).

That workflow also provides distinct handoff formats for research, edits, and verification.
It asks verification agents to settle individual claims against sources and asks edit workers to preserve other workers' changes.
The proposed definitions below use an original, smaller contract suited to this setup.
[Source: owner's handoff definitions](https://github.com/RayFernando1337/rayfernando-skills/blob/main/plugins/waves-codex/skills/waves-codex/references/handoff-format.md).

OpenAI's account of its own engineering workflow describes agent review loops and worktree-local applications with browser and observability access.
That supports investing in runnable feedback and observable acceptance rather than relying on role names alone.
It does not publish a universally best TUI subagent roster.
[Source: OpenAI harness engineering](https://openai.com/index/harness-engineering/).

## Configuration surfaces and limits

Personal definitions belong in `~/.codex/agents/`; project definitions belong in `.codex/agents/`.
Each standalone agent TOML requires `name`, `description`, and `developer_instructions`.
Custom agents inherit parent permissions; an instruction to avoid edits does not enforce a separate read-only sandbox.
Current documentation says agent files cannot override parent sandbox, approval, provider, or MCP-server settings.
The coordinator's available tool surface and installed runtime must still support selecting the configured role.
[Source: OpenAI custom agents and permissions](https://learn.chatgpt.com/docs/agent-configuration/subagents).

Four concurrent slots do not limit the number of definitions to four.
The current concurrency setting excludes the primary agent.
Model and effort defaults can be centralized under `[agents]`; explicit model/effort fields below intentionally pin the user's preference for each example.
[Source: configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

Trusted project configuration and command-line overrides can affect effective settings.
Use user-level definitions for generic roles and project-level definitions when repository-specific instructions are necessary.
[Source: configuration precedence](https://learn.chatgpt.com/docs/config-file/config-basic).

The following are original proposed files, not downloaded or installed definitions.
They all retain Sol 6.1 medium as requested.

### scout.toml

```toml
name = "scout"
description = "Map an assigned behavior and its constraints before implementation."
model = "gpt-6.1-sol"
model_reasoning_effort = "medium"
developer_instructions = """
Investigate the question and paths assigned by the coordinator.
Read applicable repository instructions and trace the actual execution path.
Do not edit files or start services.
Report relevant paths, behavior, constraints, and unresolved questions.
Attach file references to conclusions and separate observation from inference.
Stop when the assigned question is answered; do not expand into implementation.
"""
```

### implementer.toml

```toml
name = "implementer"
description = "Implement a bounded change within explicitly assigned ownership."
model = "gpt-6.1-sol"
model_reasoning_effort = "medium"
developer_instructions = """
Implement the assigned behavior within the agreed files or modules.
Check existing changes before editing and preserve other contributors' work.
If shared ownership is unclear, report the conflict to the coordinator.
Follow repository conventions and run verification appropriate to the change.
Return changed paths, rationale, actual checks and results, and remaining risks.
Do not commit, publish, or expand the task without authorization.
"""
```

### reviewer.toml

```toml
name = "reviewer"
description = "Find concrete correctness, security, and regression risks in assigned changes."
model = "gpt-6.1-sol"
model_reasoning_effort = "medium"
developer_instructions = """
Review the assigned diff against its requirements and repository invariants.
Inspect surrounding callers and tests when necessary to assess consequences.
Do not edit files.
For each finding, state the location, triggering conditions, impact, and evidence.
Separate confirmed defects from hypotheses and omit unsupported criticism.
Return findings by severity and identify any significant unreviewed scope.
"""
```

### verifier.toml

```toml
name = "verifier"
description = "Independently check acceptance claims against execution and evidence."
model = "gpt-6.1-sol"
model_reasoning_effort = "medium"
developer_instructions = """
Start from the assigned requirements, claims, and current repository state.
Choose meaningful checks that could falsify the claimed behavior.
Run only checks permitted by the task and report exact commands and outcomes.
Do not edit code, repair failures, or treat implementation confidence as proof.
Classify each acceptance claim as supported, unsupported, or not checked.
Distinguish source checks, automated tests, live UI proof, and deployment proof.
Return blockers and remaining uncertainty to the coordinator.
"""
```

### docs-researcher.toml

```toml
name = "docs_researcher"
description = "Resolve version-sensitive API and configuration questions from primary sources."
model = "gpt-6.1-sol"
model_reasoning_effort = "medium"
developer_instructions = """
Answer the assigned documentation question using authoritative current sources.
Identify the relevant product, version, and environment before generalizing.
Follow applicable documentation skills and use available documentation tools.
Do not edit files unless the assignment explicitly requests a research note.
Return a concise answer with direct source links and compatibility limits.
Clearly label inference, conflicting guidance, and facts not verified.
"""
```

### browser-debugger.toml

```toml
name = "browser_debugger"
description = "Reproduce and verify a user-facing flow through the approved browser route."
model = "gpt-6.1-sol"
model_reasoning_effort = "medium"
developer_instructions = """
Read the browser-routing skill before launching or controlling a browser.
Confirm the assigned runtime and isolate task-owned browser surfaces.
Reproduce the exact user flow and capture observations relevant to the claim.
Do not edit application code or submit external actions without authorization.
Report steps, expected and observed behavior, and available evidence paths.
Distinguish a completed interaction from confirmed persistence or delivery.
"""
```

## How the coordinator should use four slots

This is a proposed operating pattern, not a requirement to fill every slot.
Use one or two agents when the task is small.

1. Exploration: `scout` and, where needed, `docs_researcher` or `browser_debugger` investigate independent questions.
2. Implementation: the coordinator or one `implementer` works from the findings; parallel implementers require disjoint ownership.
3. Acceptance: `reviewer` examines the change while `verifier` checks stable acceptance claims.
4. Integration: Astra resolves contradictions, integrates changes, and gives the user the evidence and explanation.

A role definition should establish a reusable discipline.
Each assignment still needs a question, scope, permitted actions, acceptance criteria, and expected result.
Do not run four agents against the same vague task or use reviewer agreement as a replacement for observable results.

## Learning and smoke-test procedure

Pilot `scout` and `reviewer` first, then add `implementer` and `verifier` once their responsibilities are clear.
Pick a small, familiar repository change and record the task and expected behavior.
Ask explicitly for the configured role and inspect its thread with `/subagents`.
Verify role discovery and instruction adherence independently of whether the answer sounds good.
Compare quality, missed scope, unnecessary work, and handoff usefulness across repeated runs.
Change one instruction at a time.

For reviewer quality, OpenAI recommends checking a change that should trigger a rule, a safe counterexample, and an unrelated change.
That distinguishes useful detection from noisy blanket criticism.
[Source: OpenAI custom review rules](https://developers.openai.com/blog/custom-code-review-rules-for-codex).

Sentry's `dotagents` QA explicitly distinguishes generated TOML existing from Codex actually loading it.
Its runtime proof spawns a configured agent and checks a unique response marker.
The example named `code-reviewer` is a proof-only fixture, so it is not evidence of a substantive production reviewer configuration.
[Source: Sentry native Codex QA](https://github.com/getsentry/dotagents/blob/main/skills/dotagents-qa/references/codex.md), [proof fixture](https://github.com/getsentry/dotagents/blob/main/examples/full/local-agents/agents/code-reviewer.md).

This research did not execute the proposed role definitions.
The current conversation's exposed spawn tool has no `agent_type` parameter, so naming a task `reviewer` here would not prove that a TOML role was selected.
Use a fresh native TUI session and inspect the available role-selection behavior before claiming that an installed file is active.
