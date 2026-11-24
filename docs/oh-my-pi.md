# Oh My Pi

`omp` is installed alongside `pi`, not as a replacement.
Nix owns the official Apple Silicon standalone binary, pinned by build ID and SHA-256 in `nix/packages/oh-my-pi.nix`.
Home Manager declares `~/.local/bin/omp` in `home.nix`; `flake.nix` also exposes `packages.aarch64-darwin.oh-my-pi` for independent builds.

## Use

Run `omp` in a trusted project directory.
Use `/login` and select OpenAI Codex to authenticate, then `/model` to select another model if needed.
OMP uses its own credential storage; this installation does not copy Pi or Codex credentials.
Authentication, sessions, databases, caches, and other runtime data stay under OMP's local directories, outside this public repo.
Opening a repository trusts its project configuration, extensions, hooks, and MCP definitions, so do not launch OMP in an untrusted checkout.

## Configuration

- `home/.omp/agent/config.yml` is linked to `~/.omp/agent/config.yml`.
- `home/AGENTS.md` is linked to the native `~/.omp/agent/AGENTS.md` instruction file.
- OMP discovers the shared `~/.agents/skills` directory through its enabled Agents user provider.
- OMP defaults to `openai-codex/gpt-6.2-sol` for the main session and task-agent overrides; Pi separately defaults to `openai-codex/gpt-6.2-astra`.
  Both keep medium thinking, hidden thinking blocks, and all-message steering/follow-up queues.
  OMP's lightweight `smol` role remains `openai-codex/gpt-6-luna`.
- The built-in `titanium` and `light` themes follow the terminal's detected appearance.
- Startup update checks and automatic binary updates are disabled because Nix owns the executable.

OMP preserves the writable config symlink when `/settings` or `omp config set` saves changes, so those changes appear directly in Git.
Never enter credentials into this tracked configuration; use `/login` instead.
Pi's extensions and MCP configuration are not copied into OMP because their APIs and configuration formats differ.
OMP can discover its own supported project inputs independently.

## Build, apply, and test

```sh
nix build .#oh-my-pi
nix build .#checks.aarch64-darwin.oh-my-pi
python3 tests/oh-my-pi.py
```

Use `./rebuild.sh` for normal Home Manager activation after reviewing the README's Homebrew cleanup warning.
The initial installation was activated narrowly with a Nix GC root at `~/.local/state/omp/package` and the three declared executable/config/instruction links, without running a system rebuild.
The existing `pi` installation and configuration remain unchanged.

To update, resolve the desired stable release through the official build service, update the immutable artifact URL, version, and published SHA-256 in `nix/packages/oh-my-pi.nix`, and update the version assertion in `tests/oh-my-pi.py`.
Build and test before activation; do not use `omp update` or install a second Bun/Homebrew copy.
