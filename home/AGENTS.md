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

## Software installation

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
