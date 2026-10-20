# External container runtime storage

The user explicitly restored OWC Envoy Ultra storage authority on 2026-10-19.
Home Manager owns the guarded entrypoints in `home/.local/bin`; the existing OrbStack vendor application remains installed.
The guard requires the known volume UUID, exact mount and existing store, writable external APFS, an existing non-symlink image and matching filesystem.
Missing or redirected storage fails closed rather than creating a fresh runtime.

The aborted internal migration copied no image.
Its pending marker and regular-file destination interlock are retained as historical rollback evidence, not active startup policy.
Never fabricate an internal-migration attestation or delete source/rollback data.
Login startup remains disabled.

Use `docker-stop` before disconnecting the drive.
After an unexpected disconnect, verify the exact volume and image before guarded startup; successful presence checks do not establish crash recovery or filesystem integrity.
Do not repair or replace the image without separate authority.

Run `/usr/bin/python3 tests/container-external-storage.py` for synthetic guard cases, then verify fresh-shell entrypoints, Docker health and the actual open image path.
