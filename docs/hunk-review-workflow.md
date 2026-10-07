# Hunk human review to agent

Hunk v0.23.0 is pinned to the official Apple Silicon release in `nix/packages/hunk.nix` and owned by Nix/Home Manager.
The user-owned extension is `home/.config/hunk/extensions/human-review` and uses API 28 from that exact release.
It has no runtime npm dependencies and uses Hunk's own comment editor.
LazyGit and its configuration are independent of this workflow.

## Use

Launch Hunk in a shell pane of the existing named Herdr session, with the checkout you want to review as its working directory.
Keep the intended receiving Codex or Pi agent in that same checkout, with its live agent session detected by Herdr.

After Home Manager activation, bare `hunk` opens every unstaged and untracked change in the current checkout.
From LazyGit, focus the Files pane, press `:`, enter `hunk`, and press Enter to review that full working-tree diff in Hunk.
LazyGit's selected row or UI filter is not passed through; Hunk reviews the checkout-wide unstaged scope.
Staged changes are a separate scope, opened with `hunk diff --staged`.

```sh
hunk
hunk diff --staged
hunk show <full-commit-sha>
hunk diff <full-base-sha> <full-head-sha>
```

Navigate to a source line, press `v`, and use Hunk's normal movement keys to select a line or inclusive range.
Press `c`, enter the human request, and press `Ctrl-S` to save it.
Hunk owns selection, old-side deletion anchors, the editor, and its modal keys.
Saving a note never sends a message to an agent.

Press `Ctrl-G` outside the editor to open **Human review actions**.
The same command is discoverable in Hunk's **Extensions** menu and can be remapped as `human-review.actions` in the user's Hunk `[keybindings]` table.
Choose **Export saved human feedback** to save JSON and Markdown without contacting an agent.
Choose **Send saved human feedback to agent**, select an existing compatible agent, inspect its pane and named session, and confirm **Send**.
Escape cancels the menu, destination selection, or confirmation.
An exported batch survives cancellation.

Only idle/done Codex and Pi agents with an observed live session, matching canonical `cwd` and `foreground_cwd`, are offered.
The sending pane is excluded.
Missing, ambiguous, replaced, blocked, busy, and unknown targets fail closed at validation.
Herdr's injected socket identity is checked against its public named-session inventory, including when Hunk has a different XDG configuration directory.
The adapter uses argument-safe `execFile` calls and `herdr agent prompt`, rather than terminal text injection or a clipboard.

After the agent reports addressed and unresolved note IDs, press `r` or choose **Refresh / re-review**.
Review the new diff and the retained human notes before deciding whether the requests are addressed.
Delivery never deletes notes or marks them resolved.

## Stored feedback

The default state directory is `~/.local/state/hunk-human-review`.
An optional user-controlled `HUNK_HUMAN_REVIEW_STATE_DIRECTORY` must be absolute, owner-private, and outside Git checkouts.
Repository extension config cannot choose executables, destinations, commands, or the state path.
Directories are mode `0700`, completed files are mode `0400`, writes are exclusive, and files and parent directories are synced.

Each `batches/<uuid>/` contains `feedback.json`, `feedback.md`, and `SHA256`.
The JSON schema is `hunk-human-review`, version `1`.
It retains checkout/common-directory identity, batch/session identity, current scope metadata, startup arguments with their validity flag, timestamps, generation/state revision, stable file/content identities, paths and previous paths, exact human text, parent IDs, full old/new anchors, original diff inventory, and Hunk's supplied resolution.
The observed Git HEAD is explicitly an export-time observation, rather than an assertion that it was the reviewed revision.
Immutable provider metadata is retained when Hunk supplies it.
The native fixture suite verifies full commit revisions and immutable comparison endpoints independently of the checkout's observed HEAD.
Unknown revision or source information is not guessed.

Original context is captured from saved-note events and the loaded public changeset, then persisted under `origins/` on export.
An authoritative command snapshot supplies the actionable notes and current anchors.
If original file association is unavailable, the complete original inventory is retained and the gap remains explicit.
Agent-authored notes are included only as contextual records, outside `actionableIds`.
Human notes are retained regardless of their supplied active/stale/orphaned resolution.
Drafts are excluded by Hunk and cannot trigger this command while their editor owns input.

Generation and state revision are rechecked after asynchronous preparation and immediately before sending.
The immutable JSON checksum is checked before constructing the self-contained prompt.
Batches above the conservative 64 KiB subprocess prompt limit remain exported but cannot be sent through this adapter.
Review a smaller scope to send such feedback without truncating it.

Delivery evidence lives under `deliveries/<content-fingerprint>/`.
An accepted receipt means Herdr acknowledged input, rather than that the agent addressed a request.
A failed or interrupted attempt is recorded conservatively as uncertain.
Prior evidence requires an explicit **Resubmit** confirmation, and a per-content lock prevents concurrent submissions.
There is no automatic retry.
If a process crashes with an `in-flight` file, inspect the destination and receipts before removing that exact lock to permit an explicit retry.
Do not remove it while the recorded process is still delivering.

## Build and activation

Build only Hunk, using the existing flake lock:

```sh
nix build --impure --no-link --print-out-paths --expr 'let f = builtins.getFlake (toString ./.); pkgs = import f.inputs.nixpkgs { system = "aarch64-darwin"; }; in pkgs.callPackage ./nix/packages/hunk.nix {}'
```

Until Home Manager activation, use the returned store path's `bin/hunk` and pass the inspected extension explicitly:

```sh
/nix/store/zbqz9rwhvsp7nbrj4wld7wja8jyivfid-hunk-0.23.0/bin/hunk diff \
  --extension /Users/dmitrijarkov/dotfiles/home/.config/hunk/extensions/human-review
```

Home Manager declares a short `hunk` wrapper and the user config symlink at `~/.config/hunk/config.toml`.
The wrapper defaults to `hunk diff` and forwards explicit Hunk arguments unchanged.
That config explicitly loads `~/.dotfiles/home/.config/hunk/extensions/human-review`, since Hunk v0.23.0 skips directory symlinks in global discovery.
Neither was activated by this task, so a fresh shell still reports `hunk` missing on PATH.
A normal approved activation will install both declarations.
Do not run `darwin-rebuild switch` or `./rebuild.sh` solely for this feature while unrelated configuration is dirty without separate approval.
The intentional Homebrew `zap` policy remains in effect during a broader activation.

## Validation

The extension has an isolated Bun package and generated `bun.lock`.
Its only lint/format tools are project-local Oxc.

```sh
cd home/.config/hunk/extensions/human-review
bun install --frozen-lockfile --ignore-scripts
bun test
bun run typecheck
bun run lint
bun run format:check
```

The repeatable PTY suite uses the actual binary and Hunk's native `v`/`c`/`Ctrl-S` editor for every human note.
Its Python dependencies are pinned in the script and run in uv's isolated script environment.
It uses the public authenticated session CLI for inspection/navigation and task-owned temporary Git fixtures.
The simulated delivery phase injects its own fake Herdr session, socket identity, and executable, so it runs outside Herdr without contacting a live agent.
Its first window verifies user-config extension loading through an isolated config symlink matching the Home Manager declaration, without `--extension`.
It also verifies old-side inclusive ranges and two concurrent native windows in the same checkout, keeping their notes, process identities, and commit/comparison scopes separate.

```sh
uv run tests/hunk-review-workflow.py --hunk /path/to/pinned/hunk
```

The optional live proof requires an explicitly authorized, existing task-related agent destination and a task-owned `tests/fixtures/hunk-review/live.txt` beginning with `first = 10`.
It does not create an agent, pane, tab, worktree, or Herdr session.
It changes the fixture to `first = 11` by sending the human note through the production extension's native confirmation UI.
For a Pi destination, it reads only the matching assistant response from the exact session path attested by Herdr, because a terminal snapshot can remain scrolled to older output.

```sh
uv run tests/hunk-review-live.py --hunk /path/to/pinned/hunk --target <related-existing-pane-id>
```

Use the repository README's no-activation validation with a `path:` flake reference while these files remain untracked, so Nix includes them without staging:

```sh
nix flake check --no-build path:/Users/dmitrijarkov/dotfiles
nix build path:/Users/dmitrijarkov/dotfiles#darwinConfigurations.mac.system --dry-run
```

## Verified limits

The pinned release retains human note IDs and anchors after a same-review refresh, but it leaves missing-file notes labeled `active` and can reject its own broker registration after an annotated file leaves the review.
The exporter preserves that supplied status and separately records `filePresentInReview`, `patchChangedSinceOriginal`, and `session.registrationCurrent`.
It retains missing-file notes and original context using the previously verified identity only while the host directory and loaded source still match.
A newly opened session with no verified identity cannot use that fallback.
Native stale/orphaned classification is therefore not validated as correct in this release.
Do not assume an `active` note still applies without inspecting its anchors and original context.
The pinned [reload reducer](https://github.com/modem-dev/hunk/blob/v0.23.0/packages/hunk/src/core/review/reducer.ts#L123) replaces the document without recomputing saved-note verdicts.
The public [snapshot and reload controls](https://github.com/modem-dev/hunk/blob/v0.23.0/packages/hunk/src/extension-api/types.ts#L1877) offer no saved-note reconciliation setter or resolver.
On 2026-10-06, v0.23.0 remained the latest public release, and [current main](https://github.com/modem-dev/hunk/compare/v0.23.0...a3321c829d8bd8b39fe1c41e1b2537e41e82354c) contained no changes to that review implementation.
Correcting native classification therefore requires an upstream host change rather than an extension-side status guess or note replacement.

The installed Herdr CLI is 0.9.3, while the existing named-session server reports 0.9.1 with protocol 22.
Both versions expose no atomic expected-agent-session argument on `agent prompt`.
The adapter rechecks pane, terminal, session, checkout, and readiness immediately before sending, and Herdr itself rejects a blocked live target.
A replacement between the final check and the public prompt call remains a host API limitation.
The bundled public schema exposes only `target`, `text`, and optional `wait` in [AgentPromptParams](https://github.com/herdrdev/herdr/blob/v0.9.3/src/api/schema/agents.rs#L179).
The latest public preview and [current main](https://github.com/herdrdev/herdr/blob/3d9d2b18dab139ba226ebc5a1c9a9f2c9c3ee4df/src/api/schema/agents.rs#L179) retain that contract.
The [agent target resolver](https://github.com/herdrdev/herdr/blob/v0.9.3/src/app/terminal_targets.rs#L74) accepts a pane ID or live agent name, without binding the request to the confirmed native session or terminal ID.
The optional wait guards the occupant resolved during submission, rather than the identity confirmed earlier by the human.
No available public release or resolver closes that final-check race within this adapter.

Codex Computer Use denied access to WezTerm during validation.
The user subsequently focused Hunk pane `w3Z:p1S` in tab `w3Z:tB`, pressed `Ctrl-G`, saw **Human review actions**, and successfully exported the saved human note.
The resulting immutable JSON and Markdown were independently checked for matching text, checksum, checkout identity, and owner-private permissions.
This direct end-user proof verifies shortcut forwarding through the actual Herdr pane and supersedes the earlier unverified-shortcut finding.
The Computer Use denial remains a tool limitation, without adding a product blocker.
No private Hunk daemon endpoint was used, and no daemon restart or unrelated session mutation was performed to bypass these limits.

Primary authority is the pinned binary's `hunk skill path` and `hunk skill path hunk-extensions`, plus the matching [v0.23.0 public types](https://github.com/modem-dev/hunk/blob/v0.23.0/packages/hunk/src/extension-api/types.ts) and [keybindings](https://github.com/modem-dev/hunk/blob/v0.23.0/docs/keybindings.md).
