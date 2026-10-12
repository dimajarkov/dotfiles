# Hunk turn-review installation

## Ownership and scope

Nix owns the patched Hunk host, patched Pi, repaired Darwin Bash, review runtime, extensions, and feature wrappers.
The Codex wrapper delegates to the existing `/opt/homebrew/bin/codex` entrypoint and starts only its own native listener for covered interactive sessions.
That entrypoint is currently a credential-injection wrapper delegating to the npm Codex installation; its `app-server` branch bypasses credential injection.
This differs from the earlier Homebrew-native audit and is preserved, not silently migrated or bypassed in production.
Herdr remains Homebrew-owned.
Retain the old manual Hunk installation and all existing Codex installations until separate cleanup approval.

Install only this feature profile.
Do not run `darwin-rebuild` or `rebuild.sh` for this task: the intentional Homebrew `zap` policy and unrelated system activation are outside scope.
The installer adds journalled configuration with private backups, a launchd service, and retained Nix generation roots.
It preserves existing hook groups, shell content, native hook trust, and unrelated plugins.
Collisions and concurrent user edits cause refusal rather than overwriting another owner.

The approved target is the separately created `hunk-turn-review-acceptance` Herdr session.
The existing `handovers` server is 0.9.1 and cannot load this plugin; its panes and processes must remain untouched.
The plugin requires Herdr 0.9.3 or newer and protocol 22.
Approval of the separate acceptance session is not approval to restart or migrate `handovers`.

## Build and inspect

From the feature checkout, retain a build link so local garbage collection cannot remove an artifact during validation.
Use a new private directory rather than replacing another task's build link.

```sh
build_dir=$(mktemp -d /tmp/hunk-turn-review-build.XXXXXX)
chmod 700 "$build_dir"
nix build path:.#hunk-turn-review --out-link "$build_dir/profile"
profile=$(realpath "$build_dir/profile")
nix flake check path:.
herdr status server --session hunk-turn-review-acceptance
herdr_socket="$HOME/.config/herdr/sessions/hunk-turn-review-acceptance/herdr.sock"
"$profile/bin/hunk-turn-review-install" plan --herdr-socket "$herdr_socket"
```

`plan` checks the exact live server's compatibility and prepares the additive transaction without changing user configuration.
It does not establish current runtime health or complete workflow acceptance.
Native Codex hooks must already be enabled through `[features] hooks = true`; the installer does not edit `config.toml` or the native trust database.
The exact packaged hook commands can be inspected in `$profile/share/hunk-turn-review-install.json` before approval.
Do not use `--dangerously-bypass-hook-trust` in production.

## Activate after review

Activation follows independent Standards and Spec reviews, passing final-source checks, and native integration validation.
Only the feature-specific installation is authorized.
Check that loopback port 47658 is available before activation; do not terminate an existing listener to make room.

```sh
lsof -nP -iTCP:47658 -sTCP:LISTEN
"$profile/bin/hunk-turn-review-install" activate --herdr-socket "$herdr_socket"
"$profile/bin/hunk-turn-review-install" status
```

A successful installation waits for the private runtime's versioned protocol acknowledgement.
Status distinguishes installation, health observed at installation, and pending workflow acceptance.
It never claims that queue admission proves processing or that installed configuration proves native hook approval.

Open a fresh login shell after activation.
Check executable ownership, resolution, versions, and normal behavior:

```sh
for tool in hunk pi codex herdr; do
  command -v "$tool"
  one-bin audit exe "$tool"
done
hunk --version
pi --version
```

The feature profile must precede earlier shell PATH additions.
Pi discovers the installed extension globally.
Codex uses the existing native entrypoint for both its new listener and its unchanged remote TUI.
Synthetic backend fixtures invoke its credential-free `app-server` branch; they do not establish the credential-injection wrapper's complete production TUI flow.
Noninteractive utilities, explicit remote connections, sessions outside Git or Herdr, and `HUNK_TURN_REVIEW_DISABLED=1` retain native invocation.
Listener startup failure warns and continues without automatic review.

Open `/hooks` in Codex to inspect the new user-level hooks and approve only their exact current definitions.
Codex binds trust to each definition's hash, so changed package paths require renewed approval; see the [official hook trust documentation](https://learn.chatgpt.com/docs/hooks).
This approval remains a human action and is not supplied by the installer.
Start fresh Git-checkout Pi and Codex sessions in the compatible Herdr session to check automatic first-edit placement, preserved focus, completed response diffs, and explicit feedback delivery.
Existing sessions do not acquire new lifecycle capabilities retroactively.
See [review workflow](hunk-turn-review-workflow.md) for review selection, task reset, comment intent, and uncertain delivery.

## Isolation, recovery, and rollback

Automatic Hunk review uses a feature-private runtime/config namespace and loopback broker port 47658.
The retained manual Hunk daemon uses its original namespace and port 47657.
Do not restart or migrate manual Hunk windows as part of feature activation.
Review state, checkpoints, pending batches, logs, and installation journals remain owner-private outside Git checkouts.

If activation is interrupted, retain the receipt and backups.
Public `activate` recovers an unfinished transaction before attempting a new installation.
If ownership or user edits prevent recovery, inspect the named collision rather than deleting the receipt or forcing an overwrite.

Rollback uses the installed generation:

```sh
"$HOME/.local/state/hunk-turn-review/profile/bin/hunk-turn-review-install" rollback
```

Rollback verifies installed paths, original symlink targets, modes, and canonical parent mappings before stopping the feature-owned service.
It refuses post-install user edits and preserves durable reviews, human notes, pending batches, logs, backups, and generation roots.
Roll back before a separately authorized broader activation replaces journalled shell files.
Keep Treehouse job `hunk-turn-review`, dotfiles slot 13, and the leased Hunk source worktree until explicit completion approval.

## Verification evidence

The final Hunk source remains committed locally as `7924812b`, and the repaired profile is `/nix/store/cqra6c74xz47xgdlcn8jlbfpzj65jnpr-hunk-turn-review-profile-1.0.0`.
It is retained at `/private/tmp/hunk-bash-repair-hx0gli5g/roots/profile` and passes all eight rooted Nix checks plus the whole-flake check.
Bash 5.3p16 uses official GNU patches 010-016 while retaining the locked original source and downstream recipe.
The profile provides `bin/bash`; Home Manager omits its separate Bash package when this profile is supplied and uses the same repair recipe in standalone mode.
The Codex wrapper and installed PATH hook select repaired Bash for unchanged generated Herdr hooks.
The 48 heredoc cases, 31 core, 40 UI, 29 SDK/Codex, 29 native installer, 26 migration cases, and all four native Codex/Pi direct/default workflows pass.
See [current finalization evidence](implementation/hunk-turn-review-finalization.md) and [Bash source/owner evidence](implementation/hunk-bash-heredoc-diagnosis.md) for exact paths, hashes, commands, and preservation receipts.
This was source-only package maintenance; dotfiles staging, commits, transfer, production activation, and global PATH writes have not occurred.
The existing p9 routes and old installations are retained for rollback, and both Treehouse leases remain held.
The earlier [native acceptance record](implementation/hunk-turn-review-live-acceptance.md) preserves historical joint-workflow results separately.
[Historical packaging evidence](implementation/hunk-turn-review-packaging-evidence.md) retains earlier red/green checks, host provenance, and safety-maintenance records.
Historical store paths are not deployable evidence unless they still exist and identify the final source.

End-user rendered approval remains separate from protocol and PTY evidence.
Codex Computer Use denied access to WezTerm; do not bypass that restriction or substitute browser screenshots for terminal acceptance.
Native hook approval and direct human confirmation of terminal appearance remain required where automated native visual access is unavailable.
