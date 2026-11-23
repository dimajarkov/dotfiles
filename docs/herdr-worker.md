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

## Opt-in Arena CI startup reliability

This feature is independent of the worker Home Manager activation above.
Build `packages.aarch64-darwin.arena-ci-runner`; do not run `darwin-rebuild`, broad activation, update runner dependencies, or re-register the existing runner.
The feature installer is exposed as `apps.aarch64-darwin.arena-ci-install`.
It changes only the existing `com.arenacrm.local-first-runner` daemon definition and new root-owned files under `/Library/ArenaCI`.

### Runtime contract

The daemon still runs as `ci-runner:staff`, with its original registration, runner executable, `RUNNER_ROOT`, `ARENA_RUNNER_LEASE_PATH`, work directory and environment.
The only added environment key is `ACTIONS_RUNNER_HOOK_JOB_STARTED=/Library/ArenaCI/job-start.sh`.
The unchanged runner's source admission remains authoritative.

The daemon command becomes `/bin/sh /Library/ArenaCI/bootstrap.sh`.
Both bootstrap and job hook are root-owned regular files with Apple's `/bin/sh` shebang.
Neither launchd nor the hook needs a Nix interpreter just to spawn.
They wait up to 180 seconds for the pinned Python runtime, probe its standard library, then run packaged readiness code.
A missing runtime exits 75, so the existing KeepAlive service retries at a 30-second throttle instead of entering launchd's missing-executable penalty box.
Working directory and log paths are on the unlocked system disk, not in a checkout, runner profile, external drive, or Nix store.

Before the single headless `orb start` invocation, readiness verifies UID, account HOME, the original image's regular-file type, owner, inode and minimum size, and the mounted internal storage volume's UUID and device.
It never initializes, copies, resets, moves, deletes or substitutes a datastore.
It then verifies the explicitly configured `orbstack` context and local Unix socket, socket owner, pinned engine ID and `linux/aarch64/OrbStack` platform.
`lsof` must show the original image open by a worker-owned OrbStack process.
It execs the existing runner only after readiness passes.
The job-start hook repeats all admission checks without starting/restarting OrbStack or supervising an existing job.
Failure rejects the new job rather than killing work already running.

Dependency and engine readiness waits use a bounded 180-second window; individual subprocesses time out at 15 seconds (`orb start`: 60 seconds).
The native-shell wait precedes this window, and an in-flight probe can extend it by its timeout.
Failures name the dependency or identity check, without printing command output or credentials.
Logs are `/Library/ArenaCI/logs/{stdout,stderr}.log`, initially mode 0600 owned by the worker.
Log rotation is not installed by this feature; monitor disk usage.

### Private configuration

The operator captures and validates one root-owned mode-0600 JSON file outside the source tree, for example `/var/root/arena-ci-private.json`.
Do not transfer credentials, `.env`, `.credentials`, or authentication files.
All fields below are required, unknown fields are rejected, and there are no environment overrides or shell-sourced configuration commands:

| Key | Value |
| --- | --- |
| `schema` | `arena-ci.v1` |
| `user`, `uid`, `home` | `ci-runner`, the existing numeric account UID, `/Users/ci-runner` |
| `runner` | Exact original daemon runner executable path, unchanged |
| `runner_store` | `/nix/store/<existing-closure>` containing the resolved original runner executable |
| `runner_root`, `lease_path` | Exact original `RUNNER_ROOT` and `ARENA_RUNNER_LEASE_PATH` |
| `work_folder` | Existing absolute `.runner` metadata `workFolder`, outside `runner_root` |
| `image` | `/Users/ci-runner/Library/Group Containers/HUAQ24HBR6.dev.orbstack/data/data.img.raw` |
| `image_inode`, `image_min_bytes` | Original numeric inode and observed minimum byte size; allow growth, reject truncation |
| `volume`, `volume_uuid` | Original internal APFS mount point and VolumeUUID |
| `orb`, `docker` | Existing absolute OrbStack CLI and Docker CLI paths |
| `context`, `socket` | `orbstack`, `/Users/ci-runner/.orbstack/run/docker.sock` |
| `engine_id` | Existing Docker engine ID, captured only after original datastore verification |
| `expected_daemon_sha256` | SHA-256 of the exact original root-owned daemon plist bytes |

The installed configuration is root-owned mode 0644 because the worker must read these non-secret identity bindings.
Root-owned bootstrap/hook/config and their parent directory are not writable by the worker or pull-request code.
The installer reads only `.runner` public registration metadata, never credentials.
Capture identities locally on the worker; do not paste private config into source or issue comments.

### Preview, apply and activation

Build from reviewed source as the worker, retaining the build result:

```sh
nix build path:.#arena-ci-runner -o ./arena-ci-feature
sudo ./arena-ci-feature/bin/arena-ci-install --config /var/root/arena-ci-private.json
sudo ./arena-ci-feature/bin/arena-ci-install --config /var/root/arena-ci-private.json apply
```

The default action is a read-only plan.
Apply refuses a changed/foreign daemon, unknown loaded program/account, an existing job hook, unsafe ownership/permissions, or any `Runner.Worker` in the worker account, including orphaned workers.
It serializes mutations with a root-owned lock, retains exact original/installed plist backups and a private receipt under `/Library/ArenaCI`, pins both the feature package closure and original runner closure using indirect Nix GC roots, and atomically replaces each managed file.
It does not start OrbStack or mutate launchd.
A staged `prepared` receipt is recoverable if pinning/staging fails.

**Apply means installed on disk, pending activation.**
The running service is unchanged until an operator reloads it.
A worker may become active after the installer's idle inspection, so immediately inspect active work again at the point of reload.
Never use a blind kickstart or reload during CI work.
After an explicit idle/ownership check, the operator performs:

```sh
sudo /bin/launchctl bootout system/com.arenacrm.local-first-runner
sudo /bin/launchctl bootstrap system /Library/LaunchDaemons/com.arenacrm.local-first-runner.plist
```

If bootout fails, inspect the actual loaded state before proceeding.
If bootstrap fails, retain the receipt and logs; do not register another runner.
Verify the loaded program is `/bin/sh`, UID is the worker, the existing runner returns online with unchanged registration/work folder, and the original engine and image remain in use.
Exercise a trusted existing CI job to verify the job hook.

### Rollback and interrupted apply

Using the retained feature package and the same private original config:

```sh
sudo ./arena-ci-feature/bin/arena-ci-install --config /var/root/arena-ci-private.json rollback
```

Rollback refuses active workers, changed managed files, changed daemon bytes, or changed backup identity.
It restores the exact original plist bytes and marks the retained receipt `rolled-back`.
**Rollback is also pending activation**: the operator must repeat the idle check and explicit bootout/bootstrap sequence above before the running service uses the original definition again.
It never deletes bootstrap files, logs, backups or GC roots, so a currently loaded definition remains usable until reload and interrupted transactions remain inspectable.
Existing feature state blocks a second apply; upgrades require operator review, rollback/activation, and deliberate archival of the retained state before a fresh preview.
Do not remove GC roots while a loaded service still depends on them.
No installer operation edits the image, runner profile, registration, working directory, unrelated launch agents, or old profiles.

### Checks and reboot proof

Focused deterministic check, run by the integrating operator:

```sh
nix build path:.#checks.aarch64-darwin.arena-ci-startup
```

It exercises late/missing dependencies with a fake clock, storage/account/engine identity failures, original image preservation, job-boundary behavior, active-worker and unknown-owner refusal, apply/rollback and interrupted-pin recovery.
One small `/bin/sh` fixture proves a late interpreter can appear without losing the original runner PATH.
No live runner, OrbStack, launchctl mutation, Nix daemon call or native test suite is part of that regression test.

Yuri has FileVault enabled.
This design can recover services **after disk unlock without desktop login**, not bypass FileVault's preboot authentication after an unattended cold boot.
Do not disable encryption, configure autologin, or configure `authrestart` to make a proof pass.
A reboot requires fresh human authorization, an identified person able to unlock FileVault, an idle runner, and operator-owned recovery access.
Distinguish the unlock step from desktop login in the evidence.
OrbStack headless behavior and macOS mount/launchd ordering still require that controlled real-host proof; deterministic tests do not establish them.
