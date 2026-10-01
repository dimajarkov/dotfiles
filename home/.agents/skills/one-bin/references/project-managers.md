# Project-manager conflicts and migrations

Routine dependency additions and updates follow `~/AGENTS.md` and repository policy without this skill.
Use this reference for explicit manager migrations or conflicting ownership evidence, not simply because a lockfile changes.

## Resolve ownership evidence

Read repository instructions, `package.json#packageManager`, the existing lockfile, and CI commands.
Use `one-bin decide --cwd <directory>` for JavaScript/TypeScript manager evidence when routing is ambiguous.
Conflicting declarations or multiple lockfiles need an explicit resolution rather than whichever manager happens to be installed.
A manager-free directory is not evidence that it is a new personal project.

For pnpm, prefer the project's declared version or its Corepack workflow.
For Python, use the repository's uv or virtual-environment workflow and lockfile; never install project dependencies into an agent runtime environment.
For Rust, Go, Ruby, and other ecosystems, follow repository manifests, isolated environments, and native tooling.
The bundled decision CLI reads JavaScript lockfiles; inspect other ecosystems' native evidence directly.

## Explicit migration

1. Confirm migration intent and the target manager before changing ownership.
2. Inventory install commands, scripts, CI, caches, workspace settings, and resolution overrides tied to the old manager.
3. Update declarations and workflows consistently; regenerate the target lockfile and retire the superseded lockfile intentionally.
4. Perform a clean install in the project's normal environment and review dependency-resolution changes.
5. Run the relevant build, tests, lint, and application smoke test.
6. Report manager declarations, lockfile changes, validation, and any remaining old-manager assumptions.

Leave machine-wide manager installations in place unless their removal is separately intended and their dependents are known.
