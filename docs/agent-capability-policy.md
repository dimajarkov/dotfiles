# Settled Agent Routing and Capability Policies

Use `/goal` only for Codex subagent feature implementation, and use plain prompts for planning, research, reviews, debugging, testing, maintenance, and all other non-feature work regardless of duration.
Route small changes through Pi with `openai-codex/gpt-6-luna` at `xhigh`, and route planning and long-running work through Codex `gpt-6.1-sol` at `xhigh`.
Keep Claude compatibility-only unless it is explicitly requested, and keep Pi's default provider and model at `openai-codex/gpt-6.1-sol` with `xhigh` reasoning.
Use `openai-codex/*` for Pi's enabled-model filter so newly published Codex model IDs remain selectable while provider enforcement remains Codex-only.
Keep the submitted `OPINIONS.md` byte-unchanged even where its older viewpoints differ from current operational routing guidance.
Automatic summaries may transmit serialized user and tool transcript content, including non-credential personal or customer data, to the configured remote summary model after credential redaction.
Credential redaction covers recognized provider secrets, Stripe secret and restricted test or live keys, Stripe webhook signing secrets, PEM private keys, and armored OpenPGP private-key blocks without removing non-credential personal or customer data.
Keep the generic Composio route enabled for connected-app reads and writes, connection management, Gmail operations, and remote sandbox tools.
Keep Codex child agents on `approvalPolicy: "never"` with `sandbox: "danger-full-access"`, including when the selected working directory is untrusted.
Allow file-search to use absolute and home-directory paths outside the project while preserving literal leading `@` path names.
Successful full-output file-search spills remain in owner-private temporary directories for later reads, including results from absolute and home-directory paths, while incomplete or failed searches clean up their temporary directories.
Keep GitHub pull-request lookup branch-aware and retryable after lookup failures.
Keep the Ctrl+M shortcut opening `/mcp` without discarding an unsent editor draft.
Keep the legacy ask-user extension and built-in MCP exclusions recorded in `home/.pi/agent/settings.json`.
These capability choices describe available tools and data access, and they do not authorize unrelated external actions.
