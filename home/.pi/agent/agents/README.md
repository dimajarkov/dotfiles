# Pi agent definitions

`scout.md`, `researcher.md`, and `worker.md` are adapted from [amosblomqvist/pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents/tree/c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7/agents), revision `c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7`.
The upstream MIT notice is preserved in [`LICENSE.pi-interactive-subagents`](LICENSE.pi-interactive-subagents).
`planner.md` and `reviewer.md` are retained local roles.

## Local adaptations

- Model and thinking pins live in each role's frontmatter and use the agreed GPT models at `xhigh`.
- Upstream `subagent_agents` becomes this extension's `spawn-targets`.
  The worker delegates only to scout and researcher; planner and reviewer are still available to the main session.
- Spawn and message examples use the local `subagent` action API, stable names, and inherited work scopes.
- Researcher uses the existing web search, extraction, stored-content, and source-check tools rather than the upstream-only `safe_bash` tool.
  It also has `read` for instructions and local context, but no shell or file-writing tools.
- Scout retains the upstream read-only `read`, `grep`, `find`, and `ls` allowlist.
  Worker retains the upstream implementation tools and the extension-granted `subagent` tool.
- Upstream `system-prompt: append` and `auto-exit: true` fields are omitted because the local orchestrator always appends the role prompt and handles completion itself.
- Removed stale model descriptions and adjusted Markdown to local writing conventions.

These are maintained local adaptations, not an automatically updated package installation.
Home Manager declares each live role in `home.nix`.
For model precedence, reload behavior, and placement, see the [Herdr subagent extension](../extensions/subagent/README.md).
