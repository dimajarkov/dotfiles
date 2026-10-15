# Settled Agent Routing and Capability Policies

Route small changes through Pi with `openai-codex/gpt-6-luna` at `xhigh`, and route planning and long-running work through Codex `gpt-6.1-sol` at `medium`.
Keep Claude compatibility-only unless it is explicitly requested, and keep Pi's default provider and model at `openai-codex/gpt-6.1-sol` with `medium` reasoning.
Keep the submitted `OPINIONS.md` byte-unchanged even where its older viewpoints differ from current operational routing guidance.
Keep the generic Composio route enabled for connected-app reads and writes, connection management, Gmail operations, and remote sandbox tools.
Keep Codex child agents on `approvalPolicy: "never"` with `sandbox: "danger-full-access"`, including when the selected working directory is untrusted.
Allow file-search to use absolute and home-directory paths outside the project while preserving literal leading `@` path names.
Successful full-output file-search spills remain in owner-private temporary directories for later reads, including results from absolute and home-directory paths, while incomplete or failed searches clean up their temporary directories.
Keep GitHub pull-request lookup branch-aware and retryable after lookup failures.
Use `home/.agents/skills/browser-routing/SKILL.md` as the owner of the Zen-personal/chrome testing.
These capability choices describe available tools and data access, and they do not authorize unrelated external actions.
