# Internal-only container runtime storage

OrbStack and local Docker use internal physical storage only.
Home Manager owns the guarded entrypoints in `home/.local/bin`; `owc-container-ready` retains its legacy name solely for compatibility with already loaded callers.
The vendor application and its supporting CLI files remain installed under their existing ownership.

## Blocked preserving migration

`~/.orbstack/internal-only-migration.pending` blocks guarded startup.
The configured destination `~/.orbstack-internal-live` is intentionally a regular-file interlock while migration is pending, so a direct vendor launch also fails before creating an empty data image.
It is not a completed migration or an error to fix by initializing a fresh runtime.
The source image and all old internal rollback locations must remain untouched.
The private execution receipt is `/tmp/arena-spec-3418/internal-only-orbstack-migration.md`.

Before resuming migration, require stable readable source storage and enough internal free bytes for the allocated sparse image, swap, metadata and at least 10 GiB headroom.
Recalculate the requirement from the stopped source rather than its logical length or stale free-space measurements.
Inventory preserved runtime resources without inspecting environment values, credentials or customer identifiers.
Use a supported sparse-preserving, metadata-safe migration while OrbStack is cleanly stopped, verify copy integrity and inventories, and preserve the source and rollback copies.
A missing source, insufficient capacity or uncertain copy leaves startup blocked.

Only after verification may the destination interlock be replaced by the verified internal data directory.
Keep the pending marker until the actual configuration, canonical directory and image paths positively resolve to writable physical storage reporting `Internal=true`.
The guard additionally requires `~/.orbstack/internal-only-verified.json` with `verified: true` and `data_dir` equal to the exact destination, issued only after the preservation checks.
That receipt is an operator attestation, not a substitute for copy verification or a template to fabricate around a blocker.
Keep login startup disabled until guarded startup, actual open-image path, Docker health and preserved inventories are verified.

## Verification

Run `/usr/bin/python3 tests/container-internal-storage.py` on macOS for synthetic guard cases.
A fresh login shell must resolve `docker`, `docker-compose`, `docker-start`, `orb` and `orbctl` to the Home Manager guarded entrypoints.
While blocked, each startup path must return 78 without starting a runtime.
Use `docker-stop` for supported shutdown.
Restore code or configuration from scoped backups only in a way that retains internal-only startup and preservation interlocks; external-backed startup is no longer an authorized rollback.
