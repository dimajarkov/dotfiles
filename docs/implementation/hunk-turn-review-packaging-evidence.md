# Historical Hunk packaging evidence

This record preserves the packaging and safety handoffs collected before the recovery of the interrupted implementation session.
Its store paths, pending actions, and ownership notes are historical, not current activation instructions or evidence of completed workflow acceptance.
Use [feature-only installation](../hunk-turn-review-installation.md) for the current procedure and [native acceptance](hunk-turn-review-live-acceptance.md) for current integration evidence.

This slice owns the declarative packages and the feature-only installer.
Main owns integration approval, existing policy/docs, source transfer, commits, activation authorization, and native acceptance.
No activation, live configuration write, daemon restart, commit, or staging has been performed by this slice.

## Integration notes for source owners

- The packaging consumer uses `docs/implementation/hunk-turn-review-interface.md` and the leased Hunk `docs/turn-review-host-interface.md`.
- The Hunk package emits `share/hunk/extension-api/types.d.ts` from the exact patched source with TypeScript 5.9.3.
  The UI build copies this artifact to its `.host-types/types.d.ts` before typechecking.
  No source-worktree path or copied hand-maintained types belong in deployment.
  `nix run path:.#hunk-review-host-types -- <extension/.host-types>` repeats generation from the packaged host artifact independently of the UI build.
  This remains available when a changed host API requires the source owner to update the UI before its build can pass.
- The runtime compilation currently emits `dist/src/runtime.js`.
  Packaging normalizes these modules to the documented installed `dist/runtime.js` entrypoint.
  Production contains the compiled JS and dependency-free `client.mjs`, without development `node_modules`.
- Codex exports `hook.mjs`, `observer.mjs`, `adapter.mjs`, `transport.mjs`, and `hooks.fragment.json`.
  Packaging consumes that actual fragment and renders its inspected Node/script argv to exact immutable Nix paths.
  The normal `codex` entrypoint delegates to `/opt/homebrew/bin/codex`, preserving Homebrew's binary ownership.
  For interactive Git-checkout sessions inside Herdr, its feature helper starts a new private native Unix listener and connects the unchanged TUI with `--remote`.
  The exact listener endpoint is supplied to the source-owned hooks and observer before SessionStart.
  The CLI's local help and [official app-server documentation](https://learn.chatgpt.com/docs/app-server#connect-the-cli-terminal-ui) both describe the Unix listener and remote TUI route.
  It never connects the observer to a guessed default endpoint or restarts the shared Codex daemon.
  Utilities, noninteractive commands, explicit remote connections, sessions outside Herdr, and `HUNK_TURN_REVIEW_DISABLED=1` retain native invocation.
  Listener failure warns and continues in native Codex without automatic review.
  The packaging helper records only its own listener lifecycle and exit codes; it does not copy native stdout/stderr or conversation payloads into its log.
- Nix owns the deployment-only Herdr manifest in `nix/modules/hunk-turn-review-profile.nix`.
  Its schema and split argv match the source-owned live Herdr seam and the installed native plugin interface.
  It declares plugin ID `hunk-turn-review`, entrypoint `review`, minimum Herdr 0.9.3, and the exact packaged review executable.
  The runtime requires protocol 22 and controls right-placement and `focus:false`.
  No Herdr plugin source subtree or generated native integration shim is rewritten.
- The built artifact check runs the actual source-owned `hunk turn-review status` against the packaged runtime after an isolated Git-checkout response.
  This proves CLI registration and extension/client loading against the compiled host API.
  Host and runtime sources remain separately owned, and their broader persistence/feedback/native acceptance belongs to main.
- Pi currently requires `HUNK_TURN_REVIEW_STATE`, `HUNK_TURN_REVIEW_SOCKET`, and `HUNK_TURN_REVIEW_CLIENT` in ordinary shell sessions.
  Feature activation adds the inspected extension to global discovery and an additive shell environment fragment.
  Native Pi host capability and queued external request grouping remain source-owner integration obligations.

## Ownership and preservation

The live pre-change audit resolves Hunk through the Nix per-user profile and Pi through the Nix-owned `~/.local/bin/pi`.
Herdr and Codex retain their declared Homebrew owners.
The stale Codex npm duplicate is retained.
The existing standalone Hunk release remains rollback material.

This installation uses `packages.aarch64-darwin.hunk-turn-review`, the declared feature Nix profile including the patched Hunk and exact assets.
The same profile is the Home Manager Hunk owner after a separately authorized broader activation.
Feature activation retains a private Nix GC root for each generation, including rollback generations.
Do not run `darwin-rebuild` or `rebuild.sh` to install this feature.
The intentional Homebrew `zap` cleanup, npm migrations, Playwright provisioning, and unrelated Home Manager activation are outside the feature scope.
`home-manager.useUserPackages = true` remains unchanged.
Activating a standalone Home Manager user activation package does not replace the system-managed user packages on this machine.

The installer preflights the complete transaction before changing configuration.
It appends Codex hook groups while preserving existing event groups and unrelated JSON keys.
It never rewrites `config.toml` or the native hook trust database.
Native Codex hooks must already be enabled and the user must approve the exact new commands in Codex's own trust workflow.
Production does not use `--dangerously-bypass-hook-trust`.

New owned assets use exact immutable Nix targets.
Existing manually installed feature directories are collisions, not evidence of permission to remove them.
The additive `.zshenv` and `.zshrc` updates preserve original content, restrictive modes, and original symlink identities without editing their immutable targets.
Materializing a `0600` shell symlink keeps the replacement `0600`; rollback also checks the original target's content and mode before restoring the link.
The final interactive-shell fragment puts the feature profile before earlier startup PATH additions.
An isolated fresh-shell test verifies normal `codex` resolution.
Main must still verify the actual user's fresh login shell after authorized activation.
Home Manager's declared shell source also conditionally reads the installed environment fragment, keeping that dependency declared for any separately authorized future broader activation.
The broader activation itself remains outside this slice.
Roll back the feature before any broader activation that replaces journalled shell files; otherwise rollback correctly refuses to overwrite changed configuration.
Configuration replacements use same-directory atomic renames through a pinned directory descriptor, a serialized durable recovery receipt, and private backups.
Every configuration merge derives from one captured snapshot, including symlink target bytes and modes.
The journal records the canonical parent destination and every parent symlink reached during resolution, preserving intentional Home Manager mappings.
Activation, recovery, and rollback revalidate these mappings and the exact expected snapshot immediately before replacement.
A parent redirected to another checkout is a collision even when its registry bytes and permissions are identical.
The installer never changes unrelated parent permissions.
Herdr's native CLI generates the additive registry entry in a temporary private HOME/config/session namespace with inherited Herdr socket and pane variables removed.
Only its generated registry result joins the atomic configuration transaction, preserving unrelated plugins.
The service is bootstrapped only after configuration is installed.
Both logs are created exclusively as owned `0600` regular files before launchd can open them.
Their device/inode identities are retained in private `logs.json` and checked again before bootstrap and reactivation.
Unverified existing files, symlinks, hardlinks, replacement inodes, and changed permissions are collisions; the installer never truncates or adopts them.
Verified feature logs and their data survive rollback and reactivation.
Activation waits for the private runtime's versioned read-only protocol acknowledgement before reporting installation success.
The installer refuses an existing feature service without a matching receipt and does not restart any existing daemon.

`plan` and `activate` require an explicit `--herdr-socket` for the intended existing server.
The manifest exports the minimum version from the packaged native plugin, currently `0.9.3`, and required protocol `22`.
Preflight reads the injected target's own version, protocol, session/layout shape, registry capability, and `pane.layout` response rather than inferring compatibility from the CLI version or private runtime health.
Missing or incompatible targets block installation without creating another production session or initiating a handoff.
Status reports `installation: installed`, the recorded Herdr preflight, `runtimeHealth: healthy-at-installation`, and `workflowAcceptance: pending native acceptance` separately.
These are installation observations, not current health or complete native workflow acceptance.

The read-only original-session check observed Homebrew CLI `0.9.3` and the existing `handovers` server `0.9.1` with protocol `22`.
A retained native `0.9.1` binary in an owned isolated server rejected the actual packaged plugin with `plugin_requires_newer_herdr`: `plugin requires Herdr 0.9.3 or newer; current Herdr is 0.9.1`.
The minimum therefore remains unchanged.
Main must obtain and review the exact owner-approved manual server upgrade or handoff procedure for `handovers`, preserving its existing sessions; no self-update, automatic stop, owner bypass, or replacement named production session is authorized here.
After that separately authorized action, `herdr status server --session handovers` must show a compatible server before repeating preflight against its explicit socket.
The isolated `0.9.3` test exercises argv, registry, right-placement without focus changes, layout, metadata, tab fallback, and closure through real native APIs using an ordinary test process.
It does not establish native Pi/Codex session identity, any new `nativeRoot` contract, or end-user Hunk acceptance; those remain with main and the native adapter owners.

Rollback verifies every installed path, canonical parent, and original symlink referent before restoring its original bytes or symlink.
User edits after installation cause collision refusal before stopping the service.
Durable reviews, human notes, pending batches, outbox data, logs, private backups, and Nix generation roots remain after rollback.
Recovery uses the full durable backup journal, cross-checking the receipt against it, rather than only writes whose calls returned successfully.
A rename followed by a directory-fsync failure is therefore recoverable.
The receipt is retained until every restored snapshot and parent mapping is verified, restored directories are synced, and an archived rollback receipt is durable.
An `installing` receipt supports public `activate` recovery before a fresh transaction, or explicit public `rollback`.
If a user edit, redirected parent, changed referent, service owner, durability error, or mismatched backup blocks restoration, the installer preserves the receipt and all data for review.
Reconcile only the named collision against the private journal and current owner before retrying; do not delete the receipt, adopt foreign logs, or overwrite the newer configuration to force progress.

### Deployment safety maintenance verification

The following public tests were red before their corresponding fixes and passed afterward:

```sh
python3 nix/tests/hunk-turn-review-installation.py \
  Installation.test_postrename_fsync_failure_restores_every_configuration_path \
  Installation.test_public_reactivation_recovers_interrupted_durable_journal
python3 nix/tests/hunk-turn-review-installation.py \
  Installation.test_rollback_refuses_redirected_parent_with_identical_registry
python3 nix/tests/hunk-turn-review-installation.py \
  Installation.test_activation_preserves_private_shell_modes_and_symlink_target
python3 nix/tests/hunk-turn-review-installation.py \
  Installation.test_logs_refuse_foreign_symlinks \
  Installation.test_logs_refuse_hardlinks
python3 nix/tests/hunk-turn-review-installation.py \
  Installation.test_edit_while_preparing_atomic_replacement_is_not_overwritten \
  Installation.test_rollback_refuses_changed_materialized_symlink_target_before_stopping
python3 nix/tests/hunk-turn-review-installation.py \
  Installation.test_failed_restoration_retains_receipt_until_public_rollback_verifies_it
```

The prior immutable installer also lost an edit between reading hooks and capturing its before-state, and accepted public activation with an injected `0.9.1` target without checking that server.
The current tests reproduce concurrent filesystem edits at the read and fsync seams and exercise explicit server-version/capability rejection.
No installer internals or method-call counts are mocked.
The fixture-only final run passed 26 tests with three native-only skips.
The full native run passed all 29 tests using current installer source and the actual built runtime/assets from `/nix/store/dy3cl8m6m7jd8wgasp45xdfc39szadsi-hunk-turn-review-profile-1.0.0`:

```sh
HUNK_REVIEW_TEST_PROFILE=/nix/store/dy3cl8m6m7jd8wgasp45xdfc39szadsi-hunk-turn-review-profile-1.0.0 \
HUNK_REVIEW_TEST_HERDR=/opt/homebrew/bin/herdr \
HUNK_REVIEW_TEST_HERDR_OLD=/opt/homebrew/Cellar/herdr/0.9.1/bin/herdr \
HUNK_REVIEW_TEST_NIX_STORE=/nix/var/nix/profiles/default/bin/nix-store \
HUNK_REVIEW_TEST_PI=/nix/store/dy3cl8m6m7jd8wgasp45xdfc39szadsi-hunk-turn-review-profile-1.0.0/bin/pi \
python3 nix/tests/hunk-turn-review-installation.py
ruff check nix/runtime/hunk-turn-review-install.py nix/runtime/hunk-turn-review-manifest.py nix/tests/hunk-turn-review-installation.py
ruff format --check nix/runtime/hunk-turn-review-install.py nix/runtime/hunk-turn-review-manifest.py nix/tests/hunk-turn-review-installation.py
```

The launchd adapter applies the declared `Umask`, matching launchd's private socket creation rather than inheriting the test runner's permissions.
The current source's read-only `plan --herdr-socket /Users/dmitrijarkov/.config/herdr/sessions/handovers/herdr.sock` returned the expected `Herdr incompatible` blocker; a subsequent `herdr status server --session handovers` still reported the original running `0.9.1` server.
The installed CLI's public API schema contains neither `nativeRoot` nor `native_root`, so no nativeRoot compatibility claim is made.

An intermediate declared-package installation check passed, but the final-source command below was blocked by the separately owned Pi derivation's test `all-mode context contributions accompany one distinct queued request` (`4 !== 3`, `nix/tests/pi-user-request-lifecycle.mjs:277`).
No Pi source, patch, package, flake, or lifecycle test was changed by the installer safety work.
Main must settle that dependency and refresh the final immutable profile and Nix check evidence; the source-plus-built-runtime test above does not substitute for that rebuild.

```sh
nix build path:.#checks.aarch64-darwin.hunk-turn-review-installation --no-link --print-out-paths
nix log /nix/store/dh41h0iral8zdgw4gm9249xqhrpflx7h-pi-coding-agent-1.1.0.drv
```

## Hunk process isolation

Both packaged Hunk entrypoints use a feature-private `XDG_RUNTIME_DIR` and loopback port 47658, separate from the retained manual Hunk broker's default 47657.
Both settings are supported by the pinned host.
Automatic review uses the feature's user-owned `hunk-config` directory and an explicit absolute inspected extension path.
Its source-owned CLI selects the turn-review VCS adapter explicitly.
The user can retain preferences in this private configuration without writing the immutable package or the ordinary Hunk configuration.
No existing manual Hunk daemon or window is restarted or closed by activation.
Main must check the feature port for conflicts and verify the exact daemon protocol after approval.
The refreshed host snapshot speaks session wire revision 17, while the retained upstream baseline uses 16.
Keep the existing manual daemon and windows in their original namespace.
Any migration of those windows or daemon is a separate user action.

## Build and verification

The release baseline is exactly `7991d3034af1d2116e9c77db31265e409a73bd9f` (v0.23.0).
The upstream bun2nix recipe and hash-pinned archived Bun 1.4.2 compiler are reused.
Runtime/UI package installation uses isolated Bun 1.3.14 and their declared frozen Bun locks.
The repository's machine-wide Bun owner is unchanged.

```sh
python3 nix/runtime/generate-hunk-review-patch.py /Users/dmitrijarkov/.treehouse/hunk-8e8c02/1/hunk
nix build path:.#hunk-review-host --no-link --print-out-paths
nix build path:.#hunk-turn-review-assets --no-link --print-out-paths
nix build path:.#hunk-turn-review --no-link --print-out-paths
nix flake check path:.
python3 nix/tests/hunk-turn-review-installation.py
python3 nix/tests/hunk-turn-review-codex-launch.py
ruff check nix/runtime nix/tests/hunk-review-host.py nix/tests/hunk-turn-review-*.py
```

Patch generation reads the exact release-relative tracked diff plus non-ignored untracked files, including new source files.
It neither modifies nor stages the leased Hunk worktree.
The generated provenance records the baseline, source HEAD, and patch SHA-256.
The packaging patch was regenerated after the host owner's final verification record contained terminal results.
Regenerate and rebuild if the leased source changes again before main's final approval.
Package verification does not establish native end-user acceptance.

Successful checks include the patched host binary/skills/API 29 declarations, runtime and UI compilation with matching packaged declarations, built review CLI observation/status, installer tests against real built runtime/assets and isolated launchd/Herdr/Nix adapters, and native-binary launch orchestration tests.
The installer tests cover additive hooks and unchanged trust, manual-install collision refusal, original symlink restoration, durable-data retention, post-install user edit refusal, launchd/bootstrap-health failure recovery, and fresh interactive-shell resolution.
The native Pi CLI also loads the installed extension through ordinary global discovery in an isolated HOME, without an explicit extension flag.
The test checks its public command inventory through RPC without sending a model request.
It proves package discovery/loading, while native interactive request grouping and feedback remain main's acceptance obligations.
The earlier declared-package check ran eight installer cases.
The safety-maintenance suite adds public filesystem fault injection, durable recovery/retry, canonical-parent collisions, restrictive modes, log ownership, and explicit target-server compatibility.
Native Pi inventory and native Herdr tests require the corresponding `HUNK_REVIEW_TEST_*` inputs; fixture-only runs skip those native cases.
The launcher checks also exercise a command-named profile and `--cd=<checkout>` from outside Git while preserving native argv.
An additional plan check used the actual Homebrew Herdr CLI in isolated staging and passed.
The built installer also passed `activate`, `status`, and `rollback` with the real Herdr CLI and real Nix GC-root creation against an isolated HOME and launchd adapter.
No system or live user activation was performed by that test.
The native staging transaction can be repeated with the actual package and retained binaries while launchd remains an isolated process adapter:

```sh
profile=$(nix build path:.#hunk-turn-review --no-link --print-out-paths)
HUNK_REVIEW_TEST_PROFILE="$profile" \
HUNK_REVIEW_TEST_INSTALLER="$profile/share/hunk-turn-review/install.py" \
HUNK_REVIEW_TEST_HERDR=/opt/homebrew/bin/herdr \
HUNK_REVIEW_TEST_NIX_STORE=/nix/var/nix/profiles/default/bin/nix-store \
HUNK_REVIEW_TEST_PI="$HOME/.local/bin/pi" \
python3 nix/tests/hunk-turn-review-installation.py \
  Installation.test_activation_preserves_existing_hooks_and_native_trust \
  Installation.test_rollback_restores_symlink_and_hooks_but_retains_durable_reviews \
  Installation.test_native_pi_discovers_global_extension_without_extension_flags
```

Static evaluation retains `home-manager.useUserPackages = true`.
All existing root flake inputs retain their exact locked sources; main's upstream addition renamed the existing root nixpkgs node without changing its source.

During red/green work, the initial host artifact test failed because the unpatched baseline lacks declarations.
The first patched build failed its API assertion because this bun2nix release overrides `patchPhase` without applying `patches`.
The override now uses the standard Nix patch phase, preserving the hook's isolated build HOME.
The first built runtime CLI check also caught realpath resolution through a symlink-joined asset tree.
Shipping one real asset tree corrected both CLI entrypoint detection and relative client imports.
The native Herdr staging plan initially failed with `local socket name length exceeds capacity of sun_path of sockaddr_un`.
A short private `/tmp` staging directory and session identifier fixed that failure.
No failure was worked around by restarting an existing daemon, bypassing native trust, or activating broader system changes.

| Command | Final result | Earlier failed check and correction |
| --- | --- | --- |
| `nix build path:.#hunk-review-host --no-link --print-out-paths` | Passed | API 28 artifact exposed ignored patches; restored the standard patch phase |
| `nix build path:.#hunk-turn-review --no-link --print-out-paths` | Passed | Built CLI exposed symlink realpath/client import failures; combined assets into one real tree |
| `python3 nix/tests/hunk-turn-review-codex-launch.py` | Passed | Command-named option value bypassed review; parse native option positions and support `--cd=<checkout>` |
| `nix flake check path:.` | Passed | Final host/artifact/installation/launcher checks all passed |
| `ruff check nix/runtime nix/tests/hunk-review-host.py nix/tests/hunk-turn-review-*.py` | Passed | No remaining lint findings |
| `ruff format --check nix/runtime nix/tests/hunk-review-host.py nix/tests/hunk-turn-review-*.py` | Passed | All eight Python files formatted |

End-user visual acceptance is pending with main.
Fresh Codex Computer Use acquisition of WezTerm was denied with `Computer Use is not allowed to use the app com.github.wez.wezterm for safety reasons`.
There is no bypass or browser substitute in this slice.
Main will use the approved PTY/manual route and distinguish it from end-user visual acceptance.

## Activation and remaining actions

The feature-only app has explicit `plan`, `activate`, `status`, and `rollback` commands.
The following are commands for main after review and source transfer; activation is not authorized for this packaging slice.

```sh
# Build/check the transferred source on the original master first.
nix flake check path:.
# This exact existing server is currently incompatible until main's manual action.
herdr_socket="$HOME/.config/herdr/sessions/handovers/herdr.sock"
nix run path:.#hunk-turn-review-install -- plan --herdr-socket "$herdr_socket"

# Main only, after the independent review and exact activation approval.
nix run path:.#hunk-turn-review-install -- activate --herdr-socket "$herdr_socket"
nix run path:.#hunk-turn-review-install -- status

# Explicit feature-only rollback through the installed generation.
"$HOME/.local/state/hunk-turn-review/profile/bin/hunk-turn-review-install" rollback
```

Native Codex trust remains an explicit user action for the exact newly appended commands.
The launcher uses the existing Homebrew Codex binary for both the new listener and its TUI/proxy, avoiding a mixed-version transport inside that new session.
The pre-change audit observed Homebrew CLI 0.160.1 and a separately retained shared daemon 0.162.1.
The source owner's isolated native acceptance test used the separate daemon binary, so main must verify the actual normal Homebrew TUI/listener route after approval.
Main must also verify Pi's native host events and queued external-request grouping, original-session resume, persisted draft/sent-note invariants, real Herdr focus/fallback/closure behavior, the feature port, and the user's normal fresh-shell `command -v`/realpath/version/smoke checks.
Feedback after exit or reconnect must remain bound to the original native identity, with unavailable or uncertain admission retained rather than reassigned.
These are integration acceptance obligations, not packaging or simulated end-user proof.
The packaging owner regenerated the source snapshot after the host owner's final regular, PTY, typecheck, lint, format, and packed-consumer checks were recorded.
Main owns independent Standards and Spec reviews, commits/transfer, final activation authorization, and existing policy/documentation integration.
Treehouse dotfiles slot 13 and the leased Hunk source worktree remain retained for this job.

## Packaging handoff files

Changed existing files are `flake.nix` and `home.nix`.
The pre-existing `flake.lock` change remains main's pinned upstream/transitive input addition; this slice did not edit the lock.
New files are the host/runtime/type packages and generated bun2nix locks under `nix/packages/`, the declared feature profile under `nix/modules/`, four feature helpers under `nix/runtime/`, four public artifact/installer checks under `nix/tests/`, the automatically generated host patch/provenance under `nix/patches/`, and this installation document.
The owned new files are:

- `nix/packages/hunk-review-host.nix`, `hunk-review-host-types.nix`, and `hunk-turn-review.nix`.
- `nix/packages/hunk-turn-review/bun-compiler.nix`, `runtime-bun.lock.nix`, and `ui-bun.lock.nix`.
- `nix/modules/hunk-turn-review-profile.nix`.
- `nix/runtime/generate-hunk-review-patch.py`, `hunk-turn-review-codex.py`, `hunk-turn-review-install.py`, and `hunk-turn-review-manifest.py`.
- `nix/tests/hunk-review-host.py`, `hunk-turn-review-artifact.py`, `hunk-turn-review-codex-launch.py`, and `hunk-turn-review-installation.py`.
- `nix/patches/hunk-review-persistence.patch` and `hunk-review-persistence.json`.
- `docs/hunk-turn-review-installation.md`.

All changes remain unstaged and uncommitted.

The final recorded source snapshot has patch SHA-256 `ff291040bca94b341e6c60829f2c347de0354b6070408d6785e318867465cef7`.
The source owner's `docs/turn-review-host-verification.md` records 4,555 regular tests passed, 53 skipped, zero failures, and 209 PTY tests passed with zero failures, alongside passing typecheck, lint, format, and packed-consumer checks.
These are the source owner's recorded results, not a claim that this packaging slice independently reran those host suites or accepted the complete native workflow.
The generated `sourceState` remains `review-required-snapshot` because main still owns independent integration review and activation authorization.
Main must compare the integration to this tested snapshot and repeat patch generation/build checks if any source changes before committing.

The earlier packaging handoff recorded `/nix/store/rf3cn5kgw5x09phjn3hz6lkhwcn2j97c-hunk-turn-review-profile-1.0.0`.
That older path was absent during the safety review and is not current deployment evidence.
The following whole-flake and three native staging results are historical handoff evidence; main must refresh exact paths and final-source checks after the installer, core/UI, launcher, and Pi changes settle.
The earlier `nix flake check path:.` finished successfully with all four feature checks, including eight installer cases.
The three earlier isolated native staging tests passed against the recorded artifact with the real Herdr/Nix/Pi executables and the launchd adapter.
The generated patch reproduced identically after the final build.
The artifact's provenance matches the patch record, its UI declaration bytes match the packaged host declarations, its independent type-generation command reproduces those bytes, and production assets contain no development `node_modules`.
Ruff lint/format and `git diff --check -- flake.nix home.nix` passed.
These results establish packaging and isolated installation behavior; main still owns the separately listed live integration, trust, review, commit, and activation gates.

## Packaging requirement audit

| Requirement | Current evidence | Status |
| --- | --- | --- |
| Exact release-relative Hunk source and pinned upstream compiler | Generated patch/provenance, upstream override, host artifact check | Passing final snapshot |
| Automatically include new source and exclude ignored artifacts | Generator reads the baseline diff and non-ignored untracked files without staging | Implemented |
| Ship the binary, skills, and exact public API declarations | Real host CLI checks and matching packaged declaration files | Passing |
| Repeat declaration generation without a source-worktree dependency | Independent `hunk-review-host-types` Nix app | Passing |
| Respect declared runtime/UI managers and locks | Isolated Bun 1.3.14, frozen installs, tool-generated bun2nix locks | Passing |
| Node 22 production runtime without development dependencies | Compiled installed runtime, dependency-free client, no shipped `node_modules` | Passing |
| One declared feature executable owner, preserving other managers | Shared feature profile and Home Manager input; retained Homebrew Codex/Herdr and original Pi owner | Implemented; actual fresh-shell acceptance belongs to main |
| Global Pi extension discovery | Native Pi command inventory after isolated installation, without extension flags | Passing package-loading proof |
| Ordinary Herdr Codex entrypoint supplies the exact native endpoint | Native-binary adapter, preserved argv, same listener/TUI endpoint, failure continuation | Passing orchestration proof; actual native acceptance belongs to main |
| Exact inspected Hunk extension and native Herdr manifest | Built review CLI and actual Herdr registry staging test | Passing |
| Additive configuration transaction, backups, and collision refusal | Public installer tests, real built runtime, atomic replacements and recovery receipt | Passing |
| Preserve native trust and original hooks | Additive hook tests; installer has no trust/config writer or production bypass | Passing installation boundary; native approval remains a user action |
| Feature-only launchd process, health acknowledgement, and retained GC roots | Isolated activation/rollback with real Herdr/Nix and launchd adapter | Passing; no live activation |
| Explicit rollback preserves durable review/outbox state | Public rollback/restoration and user-edit refusal tests | Passing |
| Preserve existing manual Hunk process | Private runtime/config namespace and port in exact wrappers | Implemented; conflict and live protocol checks belong to main |
| No broad rebuild, old-install removal, generated-shim edits, commits, or staging | Scoped changes and empty staged diff | Preserved |
| Final Hunk source snapshot after its owner settles | Terminal owner verification record and regenerated release-relative patch, reproduced unchanged after final checks | Passing |
