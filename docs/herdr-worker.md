# Herdr worker account

Herdr's saved `Yuri` machine connects through the `yuri-herdr` SSH alias as `ci-runner`, using the `arena-worker` session.
That account has its own dotfiles checkout at `/Users/ci-runner/dotfiles`, linked from `~/.dotfiles`.
It is separate from Yuri's `yurijarkov` desktop account and system configuration.

`flake.nix` exposes `homeConfigurations.ci-runner` for this account.
The [worker module](../nix/modules/herdr-worker.nix) imports the shared `home.nix` shell, editor, development tools, Pi resources, and agent skills.
It excludes desktop services, browser installation, machine-specific container wrappers, and Claude configuration.
It preserves the account's Git identity and credential configuration rather than copying Dmitri's identity.
The worker excludes inherited Homebrew completion paths because that installation belongs to Yuri's desktop account.
The existing Herdr configuration directory retains its session state; only `config.toml` is linked to the shared source.

## Installation and updates

Review and synchronize the desired source changes into the worker checkout before rebuilding.
The initial installation used a snapshot of the local checkout, including its pending shared configuration changes, rather than pretending those changes were already upstream.
Credentials, authentication files, runtime state, and dependency directories are not part of that source transfer.

Run as `ci-runner` on the worker:

```sh
cd ~/.dotfiles
nix build path:.#homeConfigurations.ci-runner.activationPackage \
  -o ~/.local/state/dotfiles-generation
HOME_MANAGER_BACKUP_EXT="before-dotfiles-$(date +%Y%m%d%H%M%S)" \
  ~/.local/state/dotfiles-generation/activate
```

Fresh interactive shells also expose this build and activation command through `rebuild`.
This is a user activation and does not run `darwin-rebuild` or Homebrew cleanup.
The worker's upstream Herdr 0.9.5 executable is Nix-managed, pinned to the release asset and its published SHA-256 in [the worker package](../nix/packages/herdr-worker.nix).
The desktop Mac continues to use Homebrew for Herdr.

The managed package set lives in `~/.local/state/nix/profiles/dotfiles`, ahead of the existing user profile in fresh shell PATH.
The existing `~/.nix-profile` and its Node, Bun, and Treehouse packages remain available.
Older generations of the dedicated profile remain available through `nix-env --profile ~/.local/state/nix/profiles/dotfiles --list-generations`.
Home Manager also retains its configuration generations under `~/.local/state/nix/profiles/home-manager`.

Verify through a newly created remote Herdr pane, checking command resolution, versions, shared skill links, and editor startup.
Existing shells need `exec zsh -l` to read the new configuration.
Installing a new executable does not upgrade an already running Herdr server.
Do not stop a session to apply an executable update without first checking its live processes and ownership.

## Verified installation

On 2026-11-13 the worker profile built and activated successfully on Yuri's machine.
A fresh remote Herdr pane resolved Herdr 0.9.5, Codex 0.169.0, Pi 1.5.2, and the managed editor and search tools.
The remote Pi build passed its 16 request lifecycle checks.
Neovim started with the shared configuration, and Pi loaded its extensions without dependency errors after the worker activation linked web-fetch's runtime dependencies back to its source directory.
The existing Herdr server accepted the shared configuration without diagnostics and remained running on its older fork binary.
Codex retained its existing ChatGPT login.
Pi's separate authentication check reported `credentials_not_configured`; complete `pi auth login openai-codex` in the worker account before using Pi with that provider.
