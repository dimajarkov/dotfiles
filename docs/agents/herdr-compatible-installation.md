# Compatible Herdr installation

Pi interactive subagents require Herdr's managed job ownership and cooperative native Pi control APIs.
The official v0.9.5 source and the installed Homebrew 0.9.3 binary do not contain these APIs.
The implementation lives in the [merged fork PR](https://github.com/dimajarkov/herdr/pull/1).
Homebrew remains the sole installation owner.

## Declaration and maintenance

`configuration.nix` declares the `dimajarkov/dotfiles` tap with this repository's explicit clone URL and selects `dimajarkov/dotfiles/herdr`.
Homebrew requires trust at the tap level for this custom clone URL; the declaration trusts this owned repository and disables unsupported individual-formula trust.
`flake.nix` pins the Nix-owned Homebrew runtime to 7.0.9 so current dependency install steps are supported.
`Formula/herdr.rb` pins full source commit `c8d5b8f0d1b0ab9c7e98d05b1ed5b9606f87599f` and archive SHA-256 `593fe63aa223f7a64e92cfda6f6fec99cf7c60e5c045d6095a436446db9ddc9e`.
Its package version is `0.9.4_1`; its binary identifies itself as `0.9.4-pi.c8d5b8f0`.
The source is fixed while Homebrew build dependencies remain managed by Homebrew.
Cargo uses the source's lockfile, and Zig 0.16 matches the vendored terminal library.
Installation builds from source and needs network access to fetch the locked Cargo and Zig dependencies.
The formula test checks the build identity and three required methods in the bundled schema without starting a server.

This is a maintained fork pin, not an automatic subscription to upstream releases.
A normal Homebrew update can update this tap, but the Herdr source changes only when this formula's pin changes.
Review upstream changes in the separate Herdr repository, preserve the managed API contract, test the resulting build, then update the full commit, archive checksum, build identity and formula version or revision together.
Return to homebrew-core only after its actual server capabilities satisfy the same contract.
Herdr's self-updater detects Homebrew installations and delegates updates to Homebrew.

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
brew test dimajarkov/dotfiles/herdr
```

If installation fails, restore the recorded core keg through Homebrew before continuing.
Do not run the broad rebuild as a recovery shortcut.
Once the reviewed declaration is in the primary dotfiles checkout, apply it through the existing `rebuild.sh` workflow.
Read the README cleanup warning first: activation intentionally removes undeclared Homebrew packages and casks.
The formula and tap declarations make subsequent rebuilds retain this compatible package.

In a fresh shell, run `one-bin audit exe herdr`, check that `command -v herdr` resolves through the Homebrew prefix, and verify `herdr --version` and `brew test dimajarkov/dotfiles/herdr`.
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
