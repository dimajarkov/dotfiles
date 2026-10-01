# macOS applications

Choose exactly one application owner: declarative Homebrew cask, Mac App Store, vendor auto-updater, or Nix when suitable.
Inspect the existing bundle's provenance, signature, current updater, package receipts, permissions, and running processes before choosing a replacement.
Read the dotfiles' Homebrew activation and cleanup policy before adding or removing a cask.

## Ownership migration

1. Inventory settings, sessions, plugins, data directories, login items, helpers, and background services.
2. Identify whether App Management permissions, protected bundles, or sandbox/container locations affect migration.
3. Propose a deliberate migration that preserves data and names the old and new owners.
4. Read [removal safety](removal.md) before removing or moving the existing bundle or its supporting files.
5. Install through the selected owner without forcing Homebrew to adopt an independently installed protected bundle.
6. Launch the application normally and verify its version, settings, plugins, stored data, and background services.
7. Confirm updates now belong to the selected owner and report any remaining manual permission or cleanup step.

Use executable audits only when the application exposes a CLI; normal application launch is the primary acceptance check.
Keep data cleanup separate from bundle replacement so uninstall or cask zap behavior cannot silently erase user state.
