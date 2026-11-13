# Herdr installation history

## Current selection: original upstream

The configuration now selects homebrew-core `herdr`, not `dimajarkov/dotfiles/herdr`.
The custom `dimajarkov/pi-interactive-subagents` package and its Pi delegation-skill link are intentionally unconfigured.
The retained project and former fork are historical sources, not active Pi integrations.
Pi's Nix package and unrelated extensions remain unchanged by this migration.
The former formula and tap remain available as rollback sources, not the selected installation.
Installing a replacement executable does not itself replace any running server.
The sections below document the former fork and its historical acceptance, not the current desired installation.

## Former compatible fork

Pi interactive subagents require Herdr's managed job ownership and cooperative native Pi control APIs.
The official v0.9.5 source and the installed Homebrew 0.9.3 binary do not contain these APIs.
The implementation lives in the [merged fork PR](https://github.com/dimajarkov/herdr/pull/1).
Homebrew remains the sole installation owner.

## Provisional nested-delegation prerequisite

The nested Pi candidate in dotfiles #60 additionally requires `terminal.job.branch_capabilities` and `terminal.job.launch_branch`.
The formula below remains the prior managed implementation and does not satisfy that new contract.
Exact candidate revisions, binary evidence, the still-open #59 native gate and the separate formula/server deployment procedure are recorded in [Pi installation and rollback](pi-interactive-subagents-installation.md#required-herdr-candidate).
This document's historical installation acceptance does not accept nested branch layouts.

## Declaration and maintenance

`configuration.nix` declares the `dimajarkov/dotfiles` tap with this repository's explicit clone URL and selects `dimajarkov/dotfiles/herdr`.
Homebrew requires trust at the tap level for this custom clone URL; the declaration trusts this owned repository and disables unsupported individual-formula trust.
`flake.nix` pins the Nix-owned Homebrew runtime to 7.0.9 so current dependency install steps are supported.
`Formula/herdr.rb` pins full source commit `e3a21bb0e8eded3c0b97b13083fc54f4c6ff7c6a` and archive SHA-256 `340f061b464148561256b76f97c1bf1306d0350e35bb4ebc16cf88157d4e161e`.
Its package version is `0.9.4_2`; its binary identifies itself as `0.9.4-pi.e3a21bb0`.
The source is fixed while Homebrew build dependencies remain managed by Homebrew.
Cargo uses the source's lockfile, and Zig 0.16 matches the vendored terminal library.
Installation builds from source and needs network access to fetch the locked Cargo and Zig dependencies.
The formula test checks the build identity and six required methods in the bundled schema without starting a server.
Run it through `nix run .#herdr-package-test`: this executes the installed formula's real test block with an isolated Nix minitest dependency.
The ordinary Homebrew developer test command tries to install gems into its read-only Nix store, so the runner disables that gem installation and explicitly supplies the test dependency.

This is a maintained fork pin, not an automatic subscription to upstream releases.
A normal Homebrew update can update this tap, but the Herdr source changes only when this formula's pin changes.
Review upstream changes in the separate Herdr repository, preserve the managed API contract, test the resulting build, then update the full commit, archive checksum, build identity and formula version or revision together.
Return to homebrew-core only after its actual server capabilities satisfy the same contract.
Herdr's self-updater detects Homebrew installations and delegates updates to Homebrew.

## Nested branch-column upgrade

The revision-2 formula adds the accepted branch-column source from [Herdr PR #2](https://github.com/dimajarkov/herdr/pull/2).
It retains Homebrew ownership and checks managed launch/control, both branch methods and live handoff in the bundled schema.
For an existing installation from this tap, publish the formula first, retain the old keg/receipt, then upgrade only the qualified formula with automatic cleanup disabled.
Do not repeat the historical core-to-tap uninstall procedure below for an already-owned tap installation.
The formula explicitly resolves the declared Rust and Zig opt-bin paths.
A Herdr-only build can reuse already-installed build dependencies with `brew install --formula --build-from-source --ignore-dependencies dimajarkov/dotfiles/herdr`, with automatic updates, cleanup and dependent checks disabled for that command.
Homebrew labels this a developer option; verify both declared build tools and the resulting installed-formula test rather than assuming missing dependencies are available.
Validate the new executable and its actual formula test before changing a running server.
Installing the executable leaves existing servers unchanged.

A compatible server exposes `server.live_handoff` with an explicit replacement executable, expected version and protocol.
Test the exact old-to-new transition on a disposable named session first and compare pane identities, layout, focus and shell/foreground process PIDs.
Terminal IDs are regenerated across server replacement; do not treat old terminal conditions as transferable authority.
A server with managed-job runtimes refuses handoff with `managed_handoff_unsupported`; settle or explicitly retire the owning resources first, without bypassing this guard.
For the authorized target, retain a snapshot and verify preserved pane identities, native sessions and processes after handoff, plus the actual branch capability response.
Handoff preserves PTYs/processes and durable session state; in-flight requests, waits and subscriptions are transient and clients must reconnect.
Never fall back automatically to stopping the target if handoff fails or its outcome is uncertain.
Preserve the original runtime and recovery evidence instead.

## One-time transition and activation

This candidate prepares installation; it does not change the installed Herdr or restart any server.
Publish and merge the formula into this repository before activating its tap declaration.
Otherwise Homebrew clones the published default branch and cannot find the candidate formula.
Do not point the production tap at a temporary worktree.

Homebrew refuses to install a formula with the same name from a different tap while the core formula remains installed.
The transition therefore needs a separately approved maintenance window with a recovery copy of the existing Cellar keg and receipt.
Record `brew info --json=v2 herdr`, `command -v herdr`, its resolved executable and `herdr --version` before replacing it.
Preserve `~/.config/herdr`, session history and all original pane processes.
Do not use `--zap`, delete state or kill servers to replace the executable.
Check that other users of Herdr, including Hunk review, remain compatible.

If the installed Nix-owned Homebrew predates the pinned runtime, update only its runtime before installing dependencies:

```sh
nix build .#homebrew-runtime-activation --out-link /private/tmp/homebrew-runtime-activation
sudo /private/tmp/homebrew-runtime-activation/bin/activate-homebrew-runtime
brew --version
```

This invokes nix-homebrew's generated setup directly and avoids broad Brewfile cleanup.
It requires administrator authentication to change the root-owned runtime links.
The regular rebuild installs the same runtime declaratively.

After the formula is published, inspect and fetch it before retiring the existing keg:

```sh
brew tap dimajarkov/dotfiles https://github.com/dimajarkov/dotfiles.git
brew trust dimajarkov/dotfiles
brew info dimajarkov/dotfiles/herdr
brew fetch --build-from-source --deps dimajarkov/dotfiles/herdr
```

Within the approved maintenance window, replace the core package with the qualified formula:

```sh
brew uninstall --formula herdr
brew install --build-from-source dimajarkov/dotfiles/herdr
nix run .#herdr-package-test
```

If installation fails, restore the recorded core keg through Homebrew before continuing.
Do not run the broad rebuild as a recovery shortcut.
Once the reviewed declaration is in the primary dotfiles checkout, apply it through the existing `rebuild.sh` workflow.
Read the README cleanup warning first: activation intentionally removes undeclared Homebrew packages and casks.
The formula and tap declarations make subsequent rebuilds retain this compatible package.

In a fresh shell, run `one-bin audit exe herdr`, check that `command -v herdr` resolves through the Homebrew prefix, and verify `herdr --version` and `nix run .#herdr-package-test`.
The installed receipt must identify `dimajarkov/dotfiles`, not homebrew-core.
Installing a CLI does not replace already-running Herdr servers.
Restart only explicitly approved sessions after their work is safely stopped or handed over, using the new binary.
Existing sessions retain the version they started with until that separate restart.

Inside the intended compatible session, starting Pi and launching one disposable subagent exercises the adapter's managed capability preflight.
It requires managed job/control v1, job ownership, cooperative control, matching frame bounds and the required native SDK features before allocating a child pane.
A version string or static schema check alone does not prove that the target server has those capabilities.
Do not use a bare `herdr` invocation or an unqualified server restart to probe an unrelated focused session.

## Rollback

Stop new delegation and preserve conversations and existing pane processes.
Revert only this packaging change in dotfiles and review the resulting declaration before rebuilding.
In an approved maintenance window, uninstall the qualified fork formula and restore the recorded Homebrew core keg, or install the then-current core formula if that deliberate version change is accepted.
Core Herdr will not satisfy this Pi adapter until it includes the required APIs.
Remove the custom tap only after no installed package uses it.
Leave the canonical Pi and Herdr repositories, their histories, native session storage and credentials intact.

## Arena activation, 2026-11-04

After the user resumed rollout, the recent managed child had finished; the remaining older idle worker showed an aborted command and an empty editor.
Its native history was retained and the idle runtime exited through `/quit`, removing the managed resource that blocked handoff.
No Arena implementation work was declared complete or changed as part of retiring that runtime.

The named `arena` handoff to Homebrew `0.9.4_2` succeeded and now reports `0.9.4-pi.e3a21bb0`, protocol 22.
All 21 remaining original panes, every original shell PID, 14 native session identities and focus were verified across the handoff.
Terminal IDs regenerated with the new server generation; stale terminal conditions were not reused.
The live branch-capability endpoint responds with managed ownership/control v1.

The clean primary dotfiles checkout was fast-forwarded to the reviewed merged changes, activating existing out-of-store settings and matching skill links.
No Home Manager mapping, flake or system configuration changed, so no broad rebuild or Homebrew cleanup was needed.
The normal Pi CLI explicitly installed package `9237ccff593181698f3b80dfb3562b1ff1bb3cad`; the active settings selection and installed Git cache HEAD both match that exact revision.
Reload was submitted only to the 14 idle native Pi conversations after checking empty editors and no outstanding child work.
Thirteen reload acknowledgements were observed; the remaining acknowledgement was obscured by the conversation's internal transcript scroll position and is not claimed as independently observed.
All native conversation identities were retained.

A fresh ordinary interactive Pi parent in arena used the normal active global resources, without a private package/settings override.
It launched a bundled worker that launched another bundled worker; both immediate-parent result messages recorded exit code zero and the top-level parent wrote the expected success marker after reconciliation.
The task-owned smoke workspace was retired only after its children had closed and its original parent returned to a quiet shell.
Original user panes and native histories remain retained, alongside the old Homebrew keg and verified rollback archive.
The runtime and global package activation are complete; the scrolled-view reload acknowledgement remains the stated observation limit.

## Nested-runtime installation receipt, 2026-11-03

The Homebrew source build installed `dimajarkov/dotfiles/herdr` revision `0.9.4_2`, reporting `0.9.4-pi.e3a21bb0` from the normal Homebrew executable path.
All 16 assertions in the actual installed formula test pass through `nix run .#herdr-package-test`.
The prior `0.9.4_1` keg remains installed; its executable and receipt were also verified against a private rollback archive.
The attempted broad dependency upgrade was cancelled before installation; the successful limited build retained the existing Rust, Zig and shared dependency versions.
The first limited attempt exposed the missing build-tool PATH, corrected by explicitly resolving the declared dependency opt-bin paths in the formula.

A disposable old-to-new live handoff preserved pane IDs, layout, focus, original shell PID and an actively running synthetic child PID.
Terminal IDs regenerated, as expected for a new server generation.
The actual bundled public Pi layout proof then passed on the installed release build in 85.1 seconds, including deeper descendants, later C, reversed removals, result delivery and unrelated-resource preservation.
Live branch capabilities were verified on that same test server.
Only exact-owned test servers were stopped after quiet-shell checks; private native histories and receipts remain retained.

The authorized `arena` handoff attempt was refused with `managed_handoff_unsupported` while managed children remained.
The guard prevented changing the running server; at this checkpoint arena still reported `0.9.4-pi.c8d5b8f0` and the active Pi selection/cache remained at the prior `116f5a6` pin.
The executable installation is complete; arena activation and existing-conversation reload remain pending settlement or explicitly approved retirement of those resources.
Do not bypass the guard or infer that installing the new CLI upgraded an existing server.

## Installation acceptance, 2026-10-15

The actual Homebrew source installation succeeded into `/opt/homebrew/Cellar/herdr/0.9.4_1`, and its receipt identifies `dimajarkov/dotfiles`.
A fresh shell resolves `/opt/homebrew/bin/herdr` to that keg and reports `0.9.4-pi.c8d5b8f0`.
The installed formula's real test block passes all ten assertions through the isolated Nix test runner.
The ordinary Homebrew developer test command remains incompatible with the read-only runtime's gem installation; use the declared runner instead.

Only the explicitly authorized `arena` session was reset.
Its new server reports the pinned build, compatible protocol 22 and managed job/control v1 with cooperative control, ownership and required native SDK features.
The unchanged `handovers` server still reports 0.9.1; installing a new CLI did not restart it.

Native Pi acceptance used the active global resource configuration and synthetic files in a private temporary directory:

- The bundled scout executed on `openai-codex/gpt-6.1-sol` with medium thinking.
- The bundled interactive planner executed on `openai-codex/gpt-6-astra` with medium thinking, returned its plan and closed through `subagent_done` after explicit acceptance.
- The parent continued before the scout completed and received both independent completion messages.
- `subagent_resume` continued the scout's identical native session file and returned a second successful result.
- All three results had exit code zero, completed child panes closed, parent focus remained intact and the synthetic fixture was unchanged.

A final normal interactive Pi session in the canonical Arena checkout also launched a bundled scout against the synthetic fixture and received its actual completion.
That parent used only `subagent`, the child used only `read`, and the parent displayed its expected final acknowledgement.
The completed test child closed, leaving one focused interactive Pi pane ready for use.

This establishes runtime delegation, model selection, completion, native resume and owned cleanup.
It does not repeat the earlier human-confirmed rendered keyboard/display acceptance or claim new browser visual evidence.
