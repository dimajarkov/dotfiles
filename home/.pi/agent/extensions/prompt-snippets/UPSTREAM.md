# Prompt snippets provenance

The initial managed copy of `index.ts`, `README.md`, and the six files in `snippets/` is byte-for-byte identical to [amosblomqvist/pi-config](https://github.com/amosblomqvist/pi-config/tree/f82da563ab05d66729492d64c7ed4e96db3663f3/extensions/prompt-snippets) at revision `f82da563ab05d66729492d64c7ed4e96db3663f3`.
Git blob hashes were checked before moving the previously unmanaged local installation into dotfiles.
This provenance file is local documentation, not an upstream file.

`home.nix` links this directory into `~/.pi/agent/extensions/prompt-snippets/` through Home Manager.
Pi discovers `index.ts` automatically; this extension does not need a separate settings package entry.
Use `/snippets` or Alt+S in interactive Pi, with the detailed controls and snippet format documented in [README.md](README.md).
Snippet edits are reread automatically; extension code changes require `/reload` or a new session.

Updates are deliberate, not automatic: compare the upstream extension directory at a chosen revision, preserve intentional snippet customizations, and record the new revision here.
The inspected upstream tree contained no license file; do not assume the dotfiles repository's license grants rights to upstream code.
