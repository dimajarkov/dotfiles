# Removal safety

A duplicate executable is a finding, not permission to delete it.
Show every candidate's canonical path and owner, then obtain explicit cleanup intent after the replacement passes acceptance.

## Before removal

1. Identify the exact owner and its documented uninstall behavior, including hooks, cask zap, services, helpers, and shared dependencies.
2. Inventory configuration, sessions, plugins, data directories, running processes, and consumers of the installation.
3. Verify that any replacement works through the user's normal command or launch path.
4. For data-bearing software, runtimes, databases, container stores, or software with unknown dependents, obtain explicit approval and verify a recovery plan before removal.
   Name the backup or rollback source, its integrity check, and the restore procedure; an unverified copy is insufficient.
5. State whether removal preserves user data and separate optional data cleanup from package removal.

## Remove and verify

Use the confirmed owner's lifecycle command or declarative configuration instead of deleting files that only appear redundant.
Preserve unrelated owners and shared data.
Check that services and orphan processes from the old installation are gone where intended, then verify the replacement again in a fresh shell.
Report removed owners, preserved configuration/data, canonical executable paths, service state, and any deliberately retained rollback copies.

Container data remains subject to the container-runtime policy in `~/AGENTS.md`.
