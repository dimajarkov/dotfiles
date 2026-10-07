# Machine-wide tools

## Select an owner

Prefer declarative Nix in the user's dotfiles for new stable CLIs, runtimes, and system utilities unless repository instructions require another owner.
Inspect existing Nix and Homebrew declarations first; preserve an intentional existing owner unless a migration is explicitly selected.
Homebrew changes belong in the dotfiles' declarative formula or cask lists, not an ad-hoc installation.
Read the dotfiles' activation cleanup warning before a rebuild that can remove undeclared Homebrew packages or application data.
Update Nix-managed tools through their declarative configuration; immutable installations cannot use self-updaters.
Keep npm because it ships with Node and supports npm-owned repositories; keep pnpm available for repositories that require it, using the declared version or Corepack where appropriate.
A repository's need for a manager does not make that manager the owner of machine-wide tools.

Before installing a CLI, audit its executable and inspect the selected manager's inventory for installations outside PATH.
Use `one-bin audit globals` when global package roots or competing managers are involved.
Inspect versions, PATH order, symlink chains, shell aliases/functions, and startup files when shell resolution differs from the audit.
The CLI audit inspects executable files, not shell aliases or functions.

For a tool needed only by a repository, prefer a project-local dependency or the repository manager's one-off execution instead of a global installation.
Global npm, Bun, pnpm, pip, or cargo installation needs a deliberate reason when a project-local dependency, one-off runner, or declarative Nix package would work.
Never install the same CLI through multiple global managers.

## Change and verify

1. Edit the selected owner's declarative files or use its documented lifecycle command.
2. For Nix changes, follow the dotfiles' documented build and activation procedure; validate the build before activation.
3. Open a fresh shell after activation or PATH changes and verify the expected executable is first in the audit.
4. Check its canonical path, version, normal command behavior, and any associated service health.
5. When replacing an owner, read [removal safety](removal.md) before proposing cleanup of superseded installations.

Expose the selected owner ahead of obsolete global package directories, but retain unresolved duplicates in the report until cleanup is approved and verified.
An install command exiting successfully is not proof that the user's shell uses the replacement.
