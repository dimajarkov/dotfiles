# Dmitri's agent instructions

These are common instructions for Dmitri's agents across all scenarios.

## General Guidelines

- Never use the em dash. Use plain dash "-" instead.
- When writing commit messages, NEVER auto-add your agent name as co-author.
- Never manually modify `CHANGELOG.md` files or any files that are marked as auto-generated.
  Use Pi's built-in tool rendering or a project-owned presentation extension instead.
- When writing or substantially editing long Markdown files, put each full sentence on its own line.
  Preserve normal Markdown structure, but avoid wrapping multiple sentences onto one physical line.
- When making technical decisions, do not give much weight to development cost.
  Instead, prefer quality, simplicity, robustness, scalability, and long-term maintainability.
- When doing bug fixes, always start by reproducing the bug in an E2E setting as closely aligned with how an end user experiences it as possible.
  This makes sure you find the real problem so your fix will actually solve it.
- When end-to-end testing a product, be picky about the UI you see and be obsessed with pixel perfection.
  If something clearly looks off, even if it is not directly related to what you are doing, try to get it fixed along with the requested work.
- Apply that same high standard to engineering excellence: lint failures, test failures, and test flakiness.
  If you see one, even if it is not caused by what you are working on right now, still get it fixed.

## Treehouse task lifecycle

- Keep task worktrees durably leased (`get --lease` for new work or `lease` for an existing slot) until Dmitri explicitly declares that specific job finished.
- A PR handoff, merge, passing CI, idle terminal, or agent exit is not completion approval.
- In the same message as a PR handoff, name the job and slot and include: "Please tell me when Treehouse job '<job>' (slot <slot>) is finished so I can return its worktree."
- After completion approval, verify the slot's identity and ownership and preserve uncommitted work and unmerged commits before returning it.
- Pruning or deleting worktrees requires separate explicit approval; prefer returning finished slots for reuse with their ignored caches intact.

## Browser tool routing

- Use Computer Use through the Codex harness for end-user testing, visual QA, native macOS or cross-app workflows, and pixel-only surfaces such as canvas, video, and PDFs.
- Keep Zen at `/Applications/Zen.app` for personal browsing, native workflows, and requested Zen compatibility checks; use its existing `development` space for localhost work in Zen.
  Approved application QA may use repository-managed Chrome with a fresh disposable task-owned profile and synthetic accounts, without personal profiles, Google sign-in, sync, or extensions.
  Read `~/.agents/skills/browser-routing/SKILL.md` before browser control or launch; it owns route selection and isolation checks.
- Chrome evidence proves Chrome behavior, not Zen behavior; separate Zen acceptance is required only when the task explicitly requires it.
  A missing Zen route is still a blocker for Zen-specific work, not permission for silent browser substitution.

## Software installation

- Follow repository policy, its declared manager, existing lockfile, and isolated environment; resolve conflicting evidence first.
- Default to Bun only for confirmed new personal JavaScript/TypeScript projects.
- Prefer project-local tools or one-off execution; avoid duplicate global installs and incidental manager migrations.
- Use project-local Oxc (`oxlint` and `oxfmt`) as the sole linting and formatting toolchain in new or user-owned JavaScript and TypeScript projects.

## Container runtime policy

- The OWC Envoy Ultra is the authoritative live store for OrbStack and local Docker data.
- Use `docker-start` to start OrbStack and `docker-stop` before ejecting or disconnecting the drive.
- Do not bypass the guarded `docker` and `docker-compose` commands or start a local container runtime when the verified OWC volume is unavailable.
- Treat the retained internal migration copies as rollback data and never delete them without explicit approval and a verified independent backup.

## Dmitri's Opinions

When you are working on something that would benefit from being informed by Dmitri's viewpoints, read `~/OPINIONS.md` to understand what Dmitri believes.
Treat it as living context, not a source of objective facts or a replacement for current evidence.
Preserve uncertainty and flag meaningful tension or opinion drift instead of silently forcing alignment.

## Settled Pi Policies

Read `~/.dotfiles/docs/agent-capability-policy.md` for approved Pi routing, data handling, and tool capability boundaries.
