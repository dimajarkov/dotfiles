# Manual Hunk review and exports

The standardized automatic workflow is [automatic Hunk review](hunk-turn-review-workflow.md).
Its installed feature profile owns the patched host, original-session binding, snapshots, native feedback admission, and private broker namespace.
Build, installation, rollback, and remaining activation checks are documented in [feature-only installation](hunk-turn-review-installation.md).
The retained standalone Hunk v0.23.0 remains available as rollback material, without restarting its existing daemon or windows.

## Manual review

An ordinary manual review can inspect unstaged, staged, commit, or revision-comparison changes independently of an automatic response snapshot.
LazyGit's selected row and filter are not passed to Hunk; a bare working-tree invocation reviews the checkout-wide unstaged scope.

```sh
hunk
hunk diff --staged
hunk show <full-commit-sha>
hunk diff <full-base-sha> <full-head-sha>
```

Navigate to a source line, use `v` to select a line or inclusive range, press `c`, and save the native human comment with `Ctrl-S`.
Saving never submits feedback.
Use `Ctrl-G` outside the editor to open human review actions and export saved human feedback.
Drafts are excluded, and agent-authored notes are contextual rather than actionable human requests.

An unbound manual view does not establish which native session owns its changes.
It therefore keeps inspection, comments, and immutable exports available while refusing unsafe terminal-paste delivery.
Use the original session's automatic review pane for session-bound native submission.
Previously opened legacy windows can retain their old extension instance; their old preflight checks do not provide the new native-session admission guarantees.

## Immutable exports

The legacy export directory defaults to `~/.local/state/hunk-human-review`.
An optional user-controlled `HUNK_HUMAN_REVIEW_STATE_DIRECTORY` must be absolute, owner-private, and outside Git checkouts.
Repository extension configuration cannot choose executables, destination sessions, commands, or storage paths.
Directories use mode `0700`, completed immutable files use mode `0400`, and exclusive writes sync files and parent directories.

Each `batches/<uuid>/` contains JSON, Markdown, and a SHA-256 record.
Exports preserve exact human text, native note IDs, full old/new anchors, original context, checkout identity, review generation/revision, and supplied source metadata.
An observed Git HEAD is an export-time observation, not an assertion that it was the reviewed revision.
Unknown source information stays unknown instead of being inferred from the current checkout.
Immutable exports remain available after cancellation or transport failure.

The automatic runtime owns durable checkpoints, review history, native feedback batches, and their delivery evidence separately from these legacy exports.
Queue admission does not prove consumption or resolution.
Original context and current code must be inspected before acting on older comments.
The retained API 28 host has known stale/orphaned and missing-file registration limitations; the patched API 29 host corrects those shared semantics.
An `active` note in an old legacy window is not proof that its anchor still applies to current code.

## Ownership and validation

Hunk remains Nix-owned.
Use `one-bin audit exe hunk` and a fresh shell to verify the actual executable after feature activation.
The feature installer avoids broad nix-darwin activation and its intentional Homebrew `zap` cleanup.
It preserves ordinary manual configuration, old windows, unrelated hooks, and durable review data.

The user-owned extension remains under `home/.config/hunk/extensions/human-review` with its existing Bun lock and project-local Oxc toolchain.
Its matching API declarations are generated from the actual packaged host, rather than edited by hand.
Follow the installation document's build and declaration-generation commands before checking a newly changed host interface.

```sh
cd home/.config/hunk/extensions/human-review
bun install --frozen-lockfile --ignore-scripts
bun test
bun run typecheck
bun run lint
bun run format:check
```

PTY fixtures provide supporting native-terminal integration evidence using owned temporary repositories and public Hunk session controls.
Native end-user visual or key proof follows the Codex Computer Use route.
If that route denies WezTerm, report the restriction and ask for direct human confirmation rather than substituting Chrome, AppleScript, or terminal-input automation against the user's window.
