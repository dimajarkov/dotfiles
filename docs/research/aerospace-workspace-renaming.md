# AeroSpace workspace renaming from SketchyBar

Research date: 2026-10-23.
This is a research proposal, not an implementation or an adopted architecture decision.

## Answer and recommendation

**Yes, the workspace right-click popup can offer a naming action without losing its application list, but the installed AeroSpace cannot rename workspace identities.**
The installed CLI and server both report `0.21.3-Beta`, commit `d56e1637c3a1ed660d0cadd7534e94fb3218d1c3`.
`aerospace rename-workspace --help` returns `Unrecognized subcommand 'rename-workspace'` with exit status 2, and `aerospace --help` contains no rename subcommand.
The matching source makes a workspace's name immutable and uses that name as its registry key and hash input, corroborating the capability boundary rather than merely a missing help page.[S1][S2][S3]

**Recommend a persistent SketchyBar display alias**, exposed as **Rename label…**, with a clear statement that shortcuts and AeroSpace workspace IDs stay unchanged.
Keep a stable canonical workspace name such as `os-finances`, and store a separate friendly label such as `Finances`.
This preserves Option-number shortcuts, window routing, monitor assignment, persistent-workspace membership, focus history and hashed bar identities by construction.[L1][L2][S3][S6]
If the user requires the name returned by `aerospace list-workspaces` to change, explicitly say that this version cannot do that atomically and do not silently substitute an alias or a window migration.

## Evidence and safety scope

Read-only commands executed were `aerospace --version`, `aerospace --help`, `aerospace rename-workspace --help`, `aerospace workspace --help`, `aerospace move-node-to-workspace --help`, `aerospace list-workspaces --help` and `aerospace subscribe --help`.
Version-matched official source and documentation were read at the exact installed commit, not inferred from unversioned web examples.[S1], [S2], [S3], [S4], [S5], [S6], [S7], [S8] and [S9]
Repository configuration, renderer, startup wiring, workspace tests and current SketchyBar documentation were inspected.[L1], [L2], [L3], [L4], [L5] and [L6]
No workspace was renamed or switched, no dialog was opened, no configuration was changed or reloaded, no service was installed or restarted, and no tests or builds were run.
Only this research document was written; concurrent trackpad and telemetry work was not modified.
Scoped native visual QA is unavailable in this session, so popup interaction, dialog placement, focus effects and appearance have **not** been tested.

## Verified command surface

These are the installed help signatures, recorded without executing their mutating forms.[S1][S4][S5][S7][S8]

```text
aerospace rename-workspace --help
  Unrecognized subcommand 'rename-workspace'   # exit 2

aerospace workspace [-h|--help] [--auto-back-and-forth] [--fail-if-noop] [--] <workspace-name>
aerospace workspace [-h|--help] [--wrap-around] [--stdin|--no-stdin] (next|prev)

aerospace move-node-to-workspace [-h|--help] [--focus-follows-window] [--wrap-around]
  [--stdin|--no-stdin] (next|prev)
aerospace move-node-to-workspace [-h|--help] [--focus-follows-window] [--fail-if-noop]
  [--window-id <window-id>] [--] <workspace-name>

aerospace list-workspaces [-h|--help] --monitor <monitor>... [--visible [no]]
  [--empty [no]] [--format <output-format>] [--count] [--json]
aerospace list-workspaces [-h|--help] --all [--format <output-format>] [--count] [--json]
aerospace list-workspaces [-h|--help] --focused [--format <output-format>] [--count] [--json]

aerospace subscribe [-h|--help] [--all] [--no-send-initial] [<event>...]
```

There is **no verified rename syntax**, whether for the focused workspace or an explicitly specified workspace, and no native rename collision, no-op or empty-destination semantics to promise on this version.
In particular, neither `rename-workspace NEW` nor `rename-workspace --workspace OLD NEW` is supported.
The `workspace` command focuses or creates a workspace with the requested name; it does not change the existing workspace's identity.[S3][S4]
The move command targets the focused window unless `--window-id` is supplied and moves that window into the named destination, which can already exist.[S5]
It is not a rename command and provides no all-or-nothing workspace migration.

### Real AeroSpace name validation

The matching `WorkspaceName.parse` rejects an empty string, any whitespace/newline, any comma, names beginning with `_` or `-`, and the following exact reserved strings.[S9]

```text
focused non-focused visible invisible non-visible
active non-active inactive back-and-forth back_and_forth
previous prev next monitor workspace monitors workspaces
all none mouse target
```

These are actual workspace-name constraints, not constraints on a proposed display alias.
Quotes, dollar signs and shell punctuation are not generally excluded by this parser, so real names cannot be assumed shell-safe.[S9]
For a future identity-migration tool, reject an existing destination rather than inadvertently merging windows into another workspace, and reject an unchanged name before doing any work.[S3][S5]
Such collision policy would belong to that tool, not to a nonexistent native rename operation.

## How this repository currently works

### Identity, shortcuts and bindings

`home/.aerospace.toml` declares the canonical workspaces `1`, `2`, `3`, `browse`, `os-finances`, `warrior-v2` and `jobs` in `persistent-workspaces` with `config-version = 2`.[L1]
The Option-1 through Option-7 bindings use those literal names, and the corresponding Option-Shift-number bindings move windows to the same names.[L1]
`workspace_shortcuts()` in `plugins/workspaces.py` scans only literal `alt-N = 'workspace NAME'` or double-quoted equivalents in `[mode.main.binding]` using a regular expression, not a TOML/command AST.[L2]
`WORKSPACE_SHORTCUTS` is built at module import and keyed by the **literal workspace name**, not by workspace position or a stable numeric identifier.[L2]
`workspace_badge()`, `workspace_label()` and `workspace_key()` depend on that map for numbers, labels and sort order.[L2]
**If a true identity change left those bindings unchanged, Option-5 would still focus/create `os-finances`, while the new identity would lose badge 5 and shortcut-order placement.**[L1][L2][S3][S4]
Rewriting bindings to helper scripts would also stop this regex from discovering their numbers unless shortcut discovery were redesigned.[L2]
A long-lived watcher retains its imported map until restarted; fresh controller invocations reread it.[L2][L3][L5]

### Routing, monitors and persistence

Both Chrome app-ID rules route new windows to literal `os-finances` and would continue routing there after a simulated identity change unless migrated.[L1]
The monitor force-assignment table is also keyed by literal names: 1-3 stay on the built-in display, while the four named workspaces prefer Samsung, then Lenovo, then the built-in display.[L1]
The server resolves force assignments by `config.workspaceToMonitorForceAssignment[name]`; a new identity does not inherit the old name's force assignment.[S6]
With version-2 configuration, persistent names are explicit rather than inferred from bindings.[S6]
The server recreates listed persistent workspaces during garbage collection and retains them even when empty, so leaving the old name in the list keeps the old workspace around.[S3]
An unlisted empty, invisible, unfocused workspace can be garbage-collected, so an empty newly created destination is not durable merely because it existed once.[S3]
`persistent-workspaces` is an existence/keep-alive policy, not a user-facing alias store or a promise to restore arbitrary runtime layout or identity changes across restarts.[S3][S6]

AeroSpace reload replaces parsed configuration and reinstalls bindings; the reload implementation is not a workspace-name migration or an alias persistence API.[S6]
For any attempted create/move/config migration, durable names would have to live in the authoritative TOML and cover both restart and future reload, rather than being runtime-only.
Here that TOML is an out-of-store link to the repository, with `auto-reload-config = true`, so writing it from a popup would edit tracked declarative configuration and may initiate reload before a multi-step migration finishes.[L1][L5]
`start-at-login = false` is deliberate; SketchyBar starts independently and must recover when AeroSpace becomes available.[L1][L4]
A display alias stored in a durable user-state file can survive bar reload, watcher restart, AeroSpace reload/restart and login without changing AeroSpace configuration, but it cannot make AeroSpace start at login.
Those are proposed storage guarantees that still require implementation and acceptance tests, not existing behavior.

### Popups, IDs and events

`plan()` currently makes right-click on a workspace header toggle its SketchyBar popup and makes other clicks focus the canonical AeroSpace workspace.[L2]
The popup is a set of SketchyBar items, not an operating-system context menu, and contains the complete deduplicated application-name/icon list with window-focus actions.[L2][L4]
Empty workspaces still have a header and can therefore receive an action row.[L2]
The very narrow-panel `+N` fallback uses a separate flat popup with workspace entries and application entries; an action available only on the normal header would be inaccessible there.[L2]

`header()` and `item_id()` derive display-local opaque IDs from the actual workspace name and bundle ID, while selection and viewport state store validated hashes/IDs rather than names.[L2]
The renderer removes old owned IDs not present in the desired topology and saves new topology after a successful structural apply.[L2]
A true identity change would require structural recreation and old-ID cleanup, correct new focus hashes, popup closure, bracket regeneration and viewport reconciliation, not a label-only update.
An alias must never replace the canonical key supplied to hashing, inventory, shortcut lookup, selection, click commands or routing.
It changes presentation text and width only.

The matching subscription API has focus, focused-monitor, focused-workspace, mode, window-detected and binding-triggered events, but no workspace-renamed event.[S7]
`exec-on-workspace-change` runs on focused-workspace changes, not arbitrary label edits.[S6]
The local callback sends `aerospace_workspace_change`, handled by the fast selection lane, while `aerospace_state_change` and the five-second refresh drive structural reconciliation.[L1], [L2] and [L3]
The watcher immediately handles selection for incoming events, but only window-detected events request debounced structural work before its periodic refresh.[L2]
A successful alias save should therefore request **structural** reconciliation explicitly and should not fabricate an AeroSpace focus event or wait for a rename event that does not exist.

## Recommended right-click and input UX

This section specifies a proposal, not a claim of tested native behavior.

1. Preserve the existing right-click popup and every current application row and focus action.
   Add a clearly separated `Rename label…` action, including on empty workspaces, and a `Reset label` action when an alias exists.
   Keep normal left-click workspace switching unchanged and retain monochrome, square-cornered styling.[L2][L4]
2. In the `+N` fallback, include a separately labeled rename action for each workspace, so every workspace remains manageable even when its header is hidden.
   Do not make application rows open the rename dialog or remove their existing window-focus behavior.
3. Capture the clicked **canonical workspace name**, close that popup, then open a prefilled native text dialog titled `Rename workspace label`.
   Explain `Display name only; AeroSpace ID and shortcuts stay unchanged`, showing the canonical ID and shortcut separately.
   Do not query the currently focused workspace as the target, because right-clicking an inactive workspace must not rename a different one or switch focus first.
4. A fixed AppleScript or JXA helper using Standard Additions `display dialog` with `default answer` can provide a native text field without installing a new service or UI framework.[S10]
   Pass the initial label and canonical ID as data arguments, not interpolated script source.
   Use explicit Save and Cancel buttons, and handle Escape/Command-Period as cancellation, as documented by Apple.[S11]
5. Cancellation, prompt failure or helper timeout makes no state change and does not trigger a render.
   Check cancellation explicitly rather than treating all nonzero helper exits as Cancel and hiding actual failures.
   Distinguish an empty successful answer from Cancel; recommend rejecting empty/whitespace-only labels and providing `Reset label` as the explicit way back to the canonical name.
6. Proposed alias policy: normalize Unicode consistently, trim surrounding whitespace, reject controls/newlines/NUL and impose a bounded length, initially 40 code points with rendered-width acceptance still required.
   Permit interior spaces, unlike AeroSpace identities.
   Reject labels that case-insensitively collide with another workspace's effective display label or canonical name, so friendly names do not conceal identity ambiguity.
   Unchanged effective labels are no-ops.
   Validation errors preserve the original state and let the user correct input.
7. Permit only one outstanding naming prompt, without holding the structural/apply lock while waiting for a human.
   Revalidate the canonical target and state generation before saving; if another change wins or the workspace disappears, report that conflict rather than writing stale intent.
   A Reset action for a numeric workspace restores the existing badge-only representation, while a custom alias must be visible alongside its unchanged number.

### Persistence and security design

Use one versioned owner-private durable JSON map keyed by canonical workspace names, for example under `~/.local/state/sketchybar/workspace-labels.json`, rather than the existing disposable topology/viewport cache.
Use a dedicated lock and atomic temporary-file replacement, validate ownership/permissions and symlink safety, bound file size and schema, and handle corrupt/unreadable state by preserving the file and falling back to canonical labels with an actionable error.
Follow the existing cache's no-symlink, owner-private design without adding plaintext labels to the topology/viewport caches, whose current privacy contract is opaque IDs and numeric geometry only.[L2][L4]
The label store necessarily contains user-authored names, which may be sensitive; do not log labels, dialog answers or raw state in service output.
Retain aliases for temporarily absent workspaces instead of deleting them on an unavailable inventory, but never create AeroSpace workspaces merely by loading saved aliases.

Use Python subprocess argument arrays for helper execution and SketchyBar writes, with `shell=False`.
For SketchyBar `click_script` strings, continue using `command()`/`shlex.join()` with a fixed executable/action plus canonical target, never concatenating user-entered text as code.[L2]
A display alias belongs only in a single `label=...` property argument and is never a command name, option, script, item ID or TOML fragment.
Test literal quotes, apostrophes, semicolons, dollar signs, backticks, `$()` and Unicode; do not mistake shell quoting for validation at a second interpreter boundary.
If a future true-name tool emits TOML or AeroSpace command strings, it must independently serialize those grammars instead of reusing shell escaping.

## Why not simulate a true rename now?

A workaround could create a destination workspace, enumerate the old workspace's windows, and issue `move-node-to-workspace --window-id ID -- NEW` for each, then update configuration references.[S3], [S4] and [S5]
This is **create-and-migrate**, not an identity rename.
The source binds each moved tiled window into the destination root tiling container or each floating window into its floating container, so it does not transfer the old workspace's container tree as a unit.[S5]
Existing destinations can merge unrelated content, focus/history and visibility need separate restoration, window lifetimes can race the enumeration, and intermediate failures can leave a partial move.
It would also have to migrate persistent names, both shortcut families, Chrome routing, monitor table keys, any future workspace conditions, the imported shortcut map, all hashed topology and viewport state, and documentation/tests.[L1], [L2], [L3], [L4], [L5] and [L6]
With automatic config reload, file and server state are not one atomic transaction.[L1][S6]
Do not offer this destructive and semantically weaker operation under a casual Rename action.
A genuine rename remains an upstream-version capability gate requiring a verified command, identity semantics, events, config-reference migration policy and persistence contract before implementation.

## Concrete implementation plan

1. Introduce a small label-state helper with read/validate/save/reset operations, canonical-name keys, concurrency checks and no AeroSpace mutations.
   Keep all existing inventory and selection data structures canonical.
2. Load a validated alias snapshot per structural pass, including when reconciliation originates in the long-running watcher, rather than importing aliases once for the process lifetime.
   Derive effective titles separately from `WORKSPACE_SHORTCUTS` and `workspace_key()`.
   Use aliases consistently in normal headers and overflow workspace/application labels, but retain canonical identity in target arguments and explanatory dialog text.
3. Add popup action IDs in a separate hashed item namespace, include them in desired-item cleanup and popup order, and keep action rows out of app counts, app icons and bracket membership calculations.
   Cover both normal and ultra-narrow popups.
4. Add fixed helper entry points for prompt/save/reset and explicitly trigger `aerospace_state_change` only after a successful durable change.
   Never run a native prompt while holding the short apply lock or blocking the event subscription loop.
5. Address label-dependent sizing deliberately: `header_width()` currently uses canonical text and item widths are normally set only when first created.[L2]
   Use effective labels for width/viewport budgets and update or recreate only the affected fixed-width header when its width changes, not every item every refresh.
   Do not send repeated unchanged `width` writes, since the documented SketchyBar width-animation problem is an existing stability constraint.[L4]
   Preserve canonical focus hashes and browse position where possible, recomputing valid viewport rows after a width change and closing any now-hidden popup.
6. Update shortcut/label and popup tests plus user documentation after the design is accepted, coordinating with concurrent trackpad work in the shared renderer and telemetry documentation work.
   No implementation file was edited during this research.

## Test plan and acceptance gates

### Automated, synthetic first

- Add pure state tests for missing/corrupt/oversized state, ownership, symlinks, atomic write failure, two writers, schema migration, reset and persistence across fresh processes.
- Add prompt-runner fakes for Save, Cancel, Escape, timeout, unchanged, empty, invalid, stale target and repeated invocation, verifying that no AeroSpace mutating command is ever emitted.
- Assert Option-number badge and sort keys remain canonical after aliases, including `1` becoming `Mail` and `os-finances` becoming `Finance notes`, with correct title visibility and widths.[L2][L6]
- Assert all workspace-click and app-focus targets, routing configuration and monitor associations stay unchanged, while both popup variants retain every app row and expose rename/reset for empty workspaces.
- Assert alias edits preserve hashed header/group/app identities, clear stale text correctly on reset and remove stale action rows when a workspace disappears.
- Cover hostile text at shell, AppleScript/JXA and SketchyBar boundaries without executing payloads, and assert labels never enter topology/viewport caches or logs.
- Extend viewport tests for longer and shorter labels, threshold changes between inline/scrolling/`+N`, multi-monitor independence, stable repeated renders, focus/structural races and selection while a prompt is open.
- Run the repository's workspace and configuration checks in the worker stage, not as part of this research, and avoid treating fake CLI tests as native visual proof.[L4][L6]

### Native acceptance after explicit rollout approval

- Use the approved Codex Computer Use route when available to verify the actual right-click popup, separation of actions from the complete app list, long names, sharp corners, badge alignment and no overlap at the notch.
- Right-click an inactive workspace on another display and confirm the dialog identifies that workspace without an AeroSpace workspace switch.
- Verify Save, Reset, Cancel, Escape, Command-Period, helper failure and dialog focus/return behavior with no unintended app/window moves.
- Verify unchanged Option-number and Option-Shift-number behavior, Chrome routing, visible-workspace highlighting and monitor fallback after display rearrangement.
- Verify alias survival through SketchyBar reload, watcher restart, AeroSpace reload/restart and login, with AeroSpace remaining manually started under the existing login policy.
- Confirm `aerospace list-workspaces` still returns the canonical names and that this display-only limitation is obvious to the user.

Native appearance and prompt focus/placement remain open acceptance gates, not validated results.
The exact alias length limit and duplicate-label policy are proposed product rules and need acceptance before implementation.
Future AeroSpace versions may add capabilities; re-run version/help checks and inspect the matching source rather than assuming this negative finding applies forever.
If true identity renaming is a requirement, stop at the current capability gate instead of implementing an alias without approval.

## Primary sources

[S1]: #evidence-and-safety-scope "Local installed CLI/server evidence, 2026-10-23"

[S2]: https://github.com/nikitabobko/AeroSpace/blob/d56e1637c3a1ed660d0cadd7534e94fb3218d1c3/Sources/Common/cmdArgs/parseCmdArgs.swift

[S3]: https://github.com/nikitabobko/AeroSpace/blob/d56e1637c3a1ed660d0cadd7534e94fb3218d1c3/Sources/AppBundle/tree/Workspace.swift

[S4]: https://github.com/nikitabobko/AeroSpace/blob/d56e1637c3a1ed660d0cadd7534e94fb3218d1c3/Sources/AppBundle/command/impl/WorkspaceCommand.swift

[S5]: https://github.com/nikitabobko/AeroSpace/blob/d56e1637c3a1ed660d0cadd7534e94fb3218d1c3/Sources/AppBundle/command/impl/MoveNodeToWorkspaceCommand.swift

[S6]: https://github.com/nikitabobko/AeroSpace/blob/d56e1637c3a1ed660d0cadd7534e94fb3218d1c3/docs/guide.adoc

[S7]: https://github.com/nikitabobko/AeroSpace/blob/d56e1637c3a1ed660d0cadd7534e94fb3218d1c3/docs/aerospace-subscribe.adoc

[S8]: https://github.com/nikitabobko/AeroSpace/blob/d56e1637c3a1ed660d0cadd7534e94fb3218d1c3/docs/aerospace-workspace.adoc

[S9]: https://github.com/nikitabobko/AeroSpace/blob/d56e1637c3a1ed660d0cadd7534e94fb3218d1c3/Sources/Common/model/WorkspaceName.swift

[S10]: https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/PromptforText.html

[S11]: https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/DisplayDialogsandAlerts.html

[L1]: ../../home/.aerospace.toml
[L2]: ../../home/.config/sketchybar/plugins/workspaces.py
[L3]: ../../home/.config/sketchybar/sketchybarrc
[L4]: ../sketchybar.md
[L5]: ../../home.nix
[L6]: ../../tests/sketchybar-workspaces.py

Additional version-matched implementation evidence: [force-assignment lookup](https://github.com/nikitabobko/AeroSpace/blob/d56e1637c3a1ed660d0cadd7534e94fb3218d1c3/Sources/AppBundle/tree/WorkspaceEx.swift), [reload behavior](https://github.com/nikitabobko/AeroSpace/blob/d56e1637c3a1ed660d0cadd7534e94fb3218d1c3/Sources/AppBundle/command/impl/ReloadConfigCommand.swift), [persistent-workspace parsing](https://github.com/nikitabobko/AeroSpace/blob/d56e1637c3a1ed660d0cadd7534e94fb3218d1c3/Sources/AppBundle/config/parseConfig.swift) and [server event model](https://github.com/nikitabobko/AeroSpace/blob/d56e1637c3a1ed660d0cadd7534e94fb3218d1c3/Sources/AppBundle/model/ServerEvent.swift).
