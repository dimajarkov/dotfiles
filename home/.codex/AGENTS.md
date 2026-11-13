# Dmitri's Codex instructions

Use Codex-native repo instructions and active `.agents/skills` guidance.
Do not route work through Claude Code, Claude docs adapters, Claude compatibility plugins, or `.claude` harnesses.

## Shared agent instructions

Read `~/AGENTS.md` for shared instructions.
For browser tasks, including local UI proof and PDF rendering, follow `~/.agents/skills/browser-routing/SKILL.md` before launching anything.

## Delegation

This is standing authorization to use subagents when independent investigation, substantial implementation, or independent review benefits the task.
Keep small tasks with the coordinator and use only as many concurrent agents as useful, within the configured limit.
The main agent owns planning, scope decisions, integration, and the final explanation.
Delegated agents return requests for additional work to the coordinator; they do not spawn further agents.

Use `scout`, `implementer`, `reviewer`, and `verifier` for their distinct responsibilities.
Use `docs_researcher` for authoritative documentation and `browser_debugger` for user-facing reproduction and acceptance.
Before dispatch, assign a bounded question or change, relevant context, permitted actions, acceptance criteria, and expected output.
Among subagents, only implementers edit application code; assign explicit file or module ownership and allow concurrent writers only with disjoint ownership.
Preserve existing changes and resolve ownership conflicts before editing shared files.

For meaningful behavior changes, have a reviewer inspect a stable diff and a verifier independently check acceptance criteria after implementation.
Review findings identify defects; verification results establish what was actually checked.
Use proportionate checks for small documentation or formatting changes rather than automatically spawning both roles.
Resolve routine failures and reassign work within the user's requested scope; ask the user when a decision changes intended behavior, materially expands scope, or needs new authority.

During this initial learning period, explain each assignment, meaningful progress, handoff results, and why the division of work helps.
Keep detailed tool output in the relevant agent thread and bring evidence, uncertainty, and decisions back to the main conversation.
Continue this visibility until the user asks for a more concise delegation style.

Prefer native selection of the configured role when the runtime exposes it.
If role selection is unavailable, read the matching `~/.codex/agents/<role>.toml`, include its instructions in the assignment, and explicitly select its model and reasoning effort with fresh context when supported.
Report this fallback and distinguish it from verified native role loading.
