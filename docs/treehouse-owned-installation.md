# Treehouse owned fork and installation

Nix owns the source pin and build recipe for `dimajarkov/treehouse`.
The immutable `treehouse-owned` input records the reviewed feature branch commit; it does not claim that branch is merged into either fork's default branch.
The input is source-only and uses this dotfiles flake's existing nixpkgs and Go dependency recipe.

The feature package contains the reviewed external-storage wrapper, backing executable, installer and a manifest with source revision and artifact hashes.
It exports only `treehouse-owned-install`, so building it does not introduce a second `treehouse` command on PATH.
The active command remains the existing regular file at `~/.local/bin/treehouse`, delegating to the regular file at `~/.local/libexec/treehouse-bin`.
Do not replace these files with Home Manager or Nix profile symlinks: Treehouse's admission policy deliberately requires regular executable files.

The existing installation-owner procedure remains in `~/.local/libexec/treehouse-versions/README.md`; this package preserves its regular-file and admission boundaries.
The initially accepted baseline is the independently verified PR #3430 installation, followed by the feature's own durable generation receipts.

There is no automatic Home Manager activation.
Use the feature app explicitly; do not use `rebuild.sh`, `darwin-rebuild switch` or a broad Home Manager switch for this update.
The repository's intentional Homebrew `zap` policy can remove unrelated undeclared software during a broad activation.

## Build and inspect

```sh
build_dir=$(mktemp -d /tmp/treehouse-owned-build.XXXXXX)
chmod 700 "$build_dir"
nix build path:.#treehouse-owned --out-link "$build_dir/profile"
nix build path:.#checks.aarch64-darwin.treehouse-owned-installation --no-link
cat "$build_dir/profile/share/treehouse-owned/manifest.json"
"$build_dir/profile/bin/treehouse-owned-install" plan > "$build_dir/plan.json"
```

`plan` reads the current owned installation, selected pool policy and existing gate/state identities without writing anything or invoking Treehouse lifecycle commands.
It requires the original mounted OWC pool and logical symlink, known installation provenance, regular executable routes, private existing admission files, matching policy hashes and unchanged artifact bytes.
Missing gates, unknown owners, unknown policy fields or symlinked executable routes cause refusal.
Initial installation and admission bootstrap are intentionally unsupported.

## Explicit update

Stop scheduled launchers and wait for existing Treehouse commands to finish before applying a reviewed plan.
The installer accounts for the actual existing wrapper/backing routes; it does not claim control over arbitrary separate source binaries invoked deliberately by other operators.

```sh
"$build_dir/profile/bin/treehouse-owned-install" apply --plan "$build_dir/plan.json"
```

Apply rechecks the exact plan, serializes feature installers, retains private original bytes/inodes and a Nix generation root, and temporarily blocks both installed routes.
Old executable users drain voluntarily without signals.
It then acquires the existing owner, admission and state locks exclusively, preserves the registry and gate files, and updates only the artifact hashes in the existing policy.
The wrapper and backing are copied as regular files with their existing ownership and modes.
The final installed hashes, owner/mode, policy, state and gate identities are verified before the durable provenance receipt is published.
The previous lease records and unfinished checkouts remain untouched.

A normal interrupted update rolls back the known prior files and policy when registry state is unchanged.
An unknown external edit or state change causes refusal and retains the private recovery archive; inspect it before further writes.
A process crash can leave a maintenance blocker installed, so use the archived originals and exact hashes for an explicitly reviewed recovery.
Recovery files are kept under `~/.local/libexec/treehouse-versions/nix-owned-*`; `~/.local/state/treehouse-owned/current.json` identifies the successfully installed generation.
No recovery archive is automatically deleted.

After activation, open a fresh shell and verify `command -v treehouse`, `one-bin audit exe treehouse`, `treehouse --version`, `treehouse completion zsh`, and the task-scoped strict lease query.
A build or installation receipt alone does not prove a running application or a completed browser journey.

For subsequent upgrades, update only the immutable personal-fork input, rebuild the feature, inspect the new plan and repeat this explicit update.
This installer never repairs registry aliases, allocates slots, returns leases, destroys worktrees, changes provider state or starts application runtimes.
