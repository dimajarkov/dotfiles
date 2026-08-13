---
name: one-bin
description: Route, audit, install, update, migrate, or remove software and dependencies without package-manager drift. Always use this skill whenever a task involves installing, uninstalling, upgrading, pinning, or globally exposing any CLI, runtime, application, extension, library, package, Homebrew formula or cask, Nix package, Python dependency, JavaScript dependency, PATH entry, lockfile, or executable provenance, even when installation is only an incidental step. Also use it for duplicate commands, "command not found", version conflicts, package-manager selection, and deciding between Nix, Homebrew, Bun, npm, pnpm, uv, or project-local tooling.
compatibility: macOS, Nix, Home Manager, Node.js, and the read-only one-bin CLI bundled with this skill.
---

# One Bin

Treat installation as an ownership and lifecycle decision, not as a command to run quickly.
Choose one authoritative owner for every executable or dependency, preserve repository reproducibility, and verify what the shell will actually execute.

## Start with evidence

Before changing anything:

1. Read the nearest repository instructions and relevant documentation.
2. Run `one-bin decide --cwd [directory]` for project dependencies.
   If the project is confirmed to be genuinely new, personal, and JavaScript or TypeScript, pass `--intent new-personal-js`.
3. Run `one-bin audit exe <command>` before installing or replacing a CLI.
4. Inspect existing lockfiles, `package.json#packageManager`, PATH order, symlink targets, versions, and current package ownership.
5. Identify configuration, sessions, data directories, plugins, and services that removal or migration could affect.

Do not assume that a missing command means the software is absent.
It may be installed under another manager or hidden later in PATH.

## Ownership hierarchy

Apply this order unless repository instructions explicitly require something else.

### Stable machine-wide tools

Prefer declarative Nix and the user's dotfiles for stable CLIs, runtimes, and system utilities.
A Nix-managed command should be installed once, exposed ahead of legacy global package directories, and updated through the declarative configuration.
Do not run a self-updater for an immutable Nix installation.

### Existing repositories

Use the manager declared by repository instructions, `package.json#packageManager`, and the existing lockfile.
Treat these files as authoritative:

| Evidence | Manager |
| --- | --- |
| `bun.lock` or `bun.lockb` | Bun |
| `pnpm-lock.yaml` | pnpm |
| `package-lock.json` or `npm-shrinkwrap.json` | npm |
| `yarn.lock` | Yarn |

Do not introduce a second lockfile or migrate managers incidentally.
A manager migration requires an explicit decision, regenerated lockfile, clean install, test validation, and review of dependency-resolution changes.

### New personal JavaScript and TypeScript projects

Default to Bun only after confirming the project is genuinely new, personal, and JavaScript or TypeScript.
Unknown or manager-free directories require context instead of an inferred Bun decision.
Use Bun for installs, scripts, tests, and one-off package execution in those projects.

### npm and pnpm compatibility

Keep npm because it ships with Node and is required by repositories that use npm lockfiles.
Use pnpm for repositories with `pnpm-lock.yaml`, preferably through the version declared by the project or Corepack.
Do not treat either manager as the default for a new personal project without contrary evidence.

### Python and other ecosystems

Use the project's native isolated environment and lockfile.
For Python, prefer the repository's uv or virtual-environment workflow and never install project dependencies into an agent runtime environment.
For Rust, Go, Ruby, and other ecosystems, follow repository manifests and native tooling while keeping machine-wide utilities declarative where practical.

### macOS applications

Choose exactly one owner: Homebrew cask, Mac App Store, vendor auto-updater, or Nix when suitable.
Do not make Homebrew adopt an independently installed protected app bundle without a deliberate migration plan.
Preserve application data and confirm App Management, provenance, services, and cleanup behavior before moving or removing an app.

## Global installation rules

Avoid global npm, Bun, pnpm, pip, cargo, or similar installs when a project-local dependency, `bunx`, `npx`, `pnpm dlx`, `uvx`, or declarative Nix package is appropriate.
Never install the same CLI through multiple global managers.
Do not hide an ownership conflict by merely prepending another PATH directory.
Retire obsolete owners after the replacement is verified, subject to removal safety.

Never pipe network content into a shell, use `curl | sh`, or use `sudo` as an installation or ownership shortcut.
Inspect and verify the source, package, signature, or declared manager instead.
Never auto-delete duplicate owners.
Show their canonical paths and obtain explicit cleanup intent after the replacement has passed acceptance.

A data-bearing application, runtime, database, container store, or package with unknown dependents must not be removed without explicit approval and a verified recovery plan.

## Change workflow

1. State the selected owner and why it is authoritative.
2. Reproduce the current failure or ambiguity through the user's real command path.
3. Inspect duplicates with `one-bin audit exe <command>`.
4. Use the selected manager through the target project's normal environment.
5. Keep lockfile changes intentional and limited to the chosen manager.
6. Run the relevant build, tests, lint, and application smoke test.
7. Open a fresh shell when PATH or Home Manager changed.
8. Re-run `one-bin audit exe <command>` and confirm the desired executable is first.
9. Verify version, real path, service health, configuration preservation, and absence of orphan processes.
10. Remove superseded duplicate owners only after the replacement passes acceptance.

## Reporting

Report:

- Selected owner and routing evidence
- Commands or declarative files changed
- Lockfiles changed or deliberately preserved
- Previous duplicate owners
- Final `command -v` and resolved real path
- Version and smoke-test result
- Data or configuration migration result
- Remaining manual action or accepted limitation

Do not call an installation complete merely because an install command exited successfully.
The user-facing command must resolve to the intended owner in a fresh shell and the installed software must work end to end.

## Bundled audit CLI

The read-only CLI is installed globally as `one-bin`.
It never installs or removes packages.

```sh
one-bin policy
one-bin decide --cwd .
one-bin decide --cwd . --intent new-personal-js
one-bin audit exe pi
```

Use the script directly from this skill if the global link is not active yet:

```sh
~/.agents/skills/one-bin/scripts/one-bin.mjs audit exe pi
```
