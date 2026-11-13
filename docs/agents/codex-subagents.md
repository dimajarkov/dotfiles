# Personal Codex subagents

Edit role definitions in `home/.codex/agents/` and orchestration policy in `home/.codex/AGENTS.md`.
Model and concurrency defaults remain in the private `~/.codex/config.toml`.

Home Manager refreshes the six managed roles through `installCodexAgents` after linking its generation.
The installer leaves other role names untouched.
For a scoped refresh without a system rebuild, run from this repository:

```sh
python3.11 scripts/install-codex-agents.py \
  --source home/.codex/agents \
  --destination ~/.codex/agents
```

Installed TOMLs must be regular files.
Codex 0.169.0 advertised symlinked roles in a fresh native TUI session but rejected `agent_type = "scout"` with `agent type is currently not available`.
The same TUI diagnostic dispatched the scout successfully after replacing its symlink with a regular file; the child recorded role `scout`, model `gpt-6.1-sol`, and medium reasoning.
Keep the tracked files authoritative and refresh the installed copies after editing them.
The upstream [role loader](https://github.com/openai/codex/blob/main/codex-rs/core/src/agent/role.rs) uses a sensitive-file reader; the [symlink compatibility report](https://github.com/openai/codex/issues/40131) describes this restriction.

Start a fresh Codex session after refreshing roles.
Use `/subagents` to inspect delegated threads.
For a smoke test, explicitly request a named scout on a harmless file, wait for its result, and verify the recorded spawn selected `agent_type = "scout"` and the child used the expected model and effort.
An available-role listing alone does not prove dispatch succeeded.
