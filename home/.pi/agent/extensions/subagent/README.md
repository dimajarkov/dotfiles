# Herdr subagents

This extension owns subagent model resolution, placement, and lifecycle.
Herdr supplies terminal surfaces and agent controls; it does not select models or decide which tasks belong together.

## Model selection

Role definitions live in [`../../agents/`](../../agents/).
Each role's `model` and `thinking` frontmatter overrides the calling Pi session's corresponding setting.
An omitted field inherits that field from the caller.
Use the full `provider/model-id` form to make model selection unambiguous.
The configured roles use `xhigh`; consult their frontmatter for the current model pins.

Definitions are discovered on each spawn.
Changing a role affects new children, not already-running agents or the saved launch configuration of a reactivated child.
`agentScope` chooses user or trusted project role definitions, not terminal placement.
The default is `user`; `both` allows a same-named project definition to override the user definition.

The bundled worker delegates to scout and researcher, matching its upstream role definition.
Planner and reviewer remain available for direct parent delegation.
For compatibility, custom worker definitions and saved legacy worker loadouts may still allow planner or reviewer; the bundled worker's `spawn-targets` remains scout and researcher.
These read-only roles cannot delegate through the subagent tool.
See the [role provenance and compatibility notes](../../agents/README.md) for the upstream source and local adaptations.

## Named work scopes

Choose one short `workScope` slug per workstream and reuse it for every related root-level spawn.
Different roles and direct parents in one conversation share the master Pi agent's current Herdr tab, with each child in its own pane.
Work scopes remain durable child metadata and descendants inherit them, but they do not create tabs or isolate panes from other scopes in the same conversation.
The main conversation remains in its master pane.

```json
{
  "action": "spawn",
  "agent": "worker",
  "name": "auth-implementation",
  "workScope": "auth-refresh",
  "task": "Implement and validate the authentication refresh."
}
```

A related root-level reviewer uses a different `name` but the same `workScope`.
`name` identifies an individual agent for subsequent controls; `workScope` identifies the shared logical workstream.
Root spawns require `workScope`.
Unscoped descendants may inherit no work scope, but cannot opt into one.
Descendants inherit their parent's scope and cannot choose another one.
Lineage identity includes conversation lineage, Herdr runtime session, workspace, master pane, and immutable master tab rather than tab title or working directory.
Matching labels in unrelated sessions do not merge their agents.

Spawns run asynchronously and preserve user focus.
Splitting a zoomed pane may clear its zoom.
The extension does not restore zoom automatically because the current Herdr zoom operation can change focus and has no atomic non-focusing precondition.
This prevents a concurrent pane or tab switch from being pulled back; restore zoom manually when wanted.
Every child is created by splitting a pane in the master Pi agent's current Herdr tab.
The master pane is used for root and unscoped children; later placement selects the largest currently live, ownership-verified child pane when one exists.
Human panes and panes from other conversations are never placement candidates.
Every spawn and saved-session reactivation uses a horizontal split (`--direction down`), stacking panes top-to-bottom while preserving the selected pane's full width.
Pane dimensions never switch placement to a vertical, side-by-side split, even when the terminal is short.
More simultaneous agents therefore share the available height.
Completion messages return to the spawning parent.

## Live widget

Children and their descendants appear as a tree in a rounded, theme-aware panel above the editor, separate from the footer.
The layout is inspired by [Amos's interactive-subagent widget](https://github.com/amosblomqvist/pi-interactive-subagents/tree/main/pi-extension/subagents), while Herdr remains responsible for orchestration.
Each row shows the child's name, role, and right-aligned lifecycle state, including green `● done` for completed agents.
Finished agents remain visible after their panes close, including when no work remains active.
Blocked and active subtrees take priority over completed history, but descendants always stay beneath their ancestors.
The five-row limit keeps the editor usable; overflow and `/subagents` open the complete tree, including older finished agents.
Long names truncate to keep the state visible, including on narrow terminals.
The panel is cleared only when the current lineage has no children.

Click a row in fullscreen mode to open its complete initial delegation prompt in a scrollable modal.
Click a completed agent's `[output]` button to read its saved final response, not a summary or terminal tail.
The modal displays literal text, preserving Markdown source, and strips unsafe terminal controls.
Output URLs and asset links are clickable; relative file links resolve against the child's working directory and use the system's default handler, such as the associated text editor.
Trailing `:line` and `:line:column` references stay visible but are removed from the file target before opening.
Fullscreen Pi opens links on click; regular terminals use their native hyperlink gesture.
Only HTTP, HTTPS, and local file targets become links, and nothing opens until clicked.

`/subagents [name]` opens the prompt picker or a uniquely named agent's prompt in fullscreen and regular mode.
`/subagent-output [name]` opens the corresponding output picker or response directly.
In either picker, use arrows to select an agent; Enter opens the mode requested by the command, `p` opens the prompt, and `o` opens output.
In a detail modal, use arrows, Page Up/Down, or Home/End to navigate; `p` and `o` switch between prompt and output, and Escape closes it.
The mouse wheel also scrolls the modal in fullscreen mode.
The displayed prompt is the exact saved initial task, not a reconstructed system prompt or a concatenation of later steering messages.
Inspection is read-only and never resumes an agent, focuses its pane, or submits another model turn.

## Lifecycle

Completed children retain Pi session history while their owned terminal panes are cleaned up.
Before acknowledging delivery, the extension saves the full completion in an outbox entry on the parent's active Pi session branch, then queues its model-visible follow-up.
Exact final output and failure diagnostics remain separate fields so an empty failed response still shows its error.
Completion messages retain native Markdown formatting, but terminal controls are removed and metadata stays on one line.
The final rendered links, including Markdown reference links, are restricted to HTTP, HTTPS, and local files without changing saved response text.
Lifecycle controls never wait for the parent model to consume that follow-up.
Unconsumed outbox entries replay after restart or a cleared message queue; consumed completions are not replayed.
`deliveredAt` means the completion was durably enqueued, not necessarily consumed by the parent model.
A parent child cannot auto-exit while its branch still has unconsumed completions.
Cleanup preserves sibling agents and user-owned panes.
Child pane cleanup leaves the master tab and its main pane intact.
A later stage reuses that same tab by splitting the largest ownership-verified pane, so sequential workflows do not create background tabs or idle placeholder tabs.
If only user-owned panes remain among the old scope's children, the next stage splits the current master pane rather than splitting those human panes.
If an owned child pane has moved to another tab, placement refuses the new allocation rather than creating a duplicate tab or regrouping human surfaces.
The moved agent remains intact, and a new stage can allocate normally after it finishes.

Pane IDs alone do not establish ownership.
Cleanup verifies the pane's workspace and current Pi session, or positively establishes that its only foreground process is its shell.
A different session, agent, or identifiable foreground command is preserved, and the original claim becomes durably `released` rather than closed.
Released claims cannot reclaim that pane after its replacement exits, but their original saved sessions can reactivate on new managed surfaces.
Uncertain observations remain `cleanup-pending` with a diagnostic and can be retried without discarding findings.
Placement validates every recorded child pane before selecting a target and ignores retired or unproven panes.
New allocations publish their pending owner under the lineage lock, and a persistent placement lock serializes layout observation and splitting across concurrent parents.
Active message, focus, cancellation, and rejected-prompt stop paths validate runtime identity before sending controls.
Failed control preflights do not abandon completion monitoring for children still working in the current Herdr session.

Active message and cancellation requests cross a generation-scoped control interface owned by the child extension.
The child admits or rejects each request in the same event loop that observes session persistence and publishes settlement evidence, then writes a receipt before the parent changes lifecycle state.
Message admission checks receipt writability, reserves the nonce, dispatches a hidden custom message, and only then publishes acceptance.
Private message admission requires the synchronous `enqueueMessage()` capability shipped by `nix/packages/pi-coding-agent.nix` on the pinned Pi `0.85.0` runtime.
Its maintained patch returns `{ status: "queued" }` only after native insertion and propagates native rejection directly to the caller.
Stock Pi's void `sendMessage()` cannot prove queue admission, so unsupported runtimes fail closed without a compatibility fallback.
An admission receipt is not proof of model consumption or successful completion; later run failures are reported separately as `enqueue_message_run` runtime errors.
If queue insertion succeeds but acceptance publication fails, the unaccepted reservation remains a durable settlement guard, consumption aborts before another provider call, and the preceding response cannot become a successful completion.
Native insertion rejection withdraws the reservation because no message entered the queue.
Only the matching awaited `message_start` can consume a reservation, so an interleaved ordinary user message cannot claim or release it.
The persisted pending-control count protects parent preflight during lock contention, and consumption advances the running frontier to the preceding response before another provider call can begin.
Consumption never overwrites a newer request's receipt, and consumed nonces cannot be replayed within that child process.
An admitted cancellation aborts the active low-level run directly instead of entering the model queue.
If Herdr blocks the request or the five-second receipt deadline expires, cancellation returns an error without raw terminal input, lifecycle mutation, or surface cleanup.
Resolve blocked input before retrying cancellation.
Real Pi RPC coverage verifies receipt-before-provider-release admission, consumption locking, successive steering, and model-visible content without exposing the control envelope.
Pane placement, cleanup, and focus checks remain observational because the current Herdr interface has no expected-session or revision precondition for those operations.
Lineage locks serialize cooperating controllers but cannot prevent an external actor from replacing a runtime between verification and a later pane operation.

Use `inspect`, `message`, `cancel`, or `resume` with the agent's semantic `name`.
`message` can reactivate a finished child with its saved session and launch settings.
Cancelling an already-terminal child only finishes its surface cleanup and preserves its outcome and saved result.
`resume` and `/subagent-focus <name>` intentionally focus that child.
`/subagents` inspects the current parent's complete descendant tree.

Existing records retain their saved pane and tab identities rather than migrating live agents.
Legacy scope metadata files are ignored by the current loader.
Updating or reloading this extension does not regroup existing panes or tabs.
Use new spawns for the master-tab placement behavior.

## Registry locking

Registry allocation requires macOS `/usr/bin/lockf` with descriptor-mode support.
The parent retains the locked file descriptor throughout each operation, so helper exit does not release ownership and process death does.
Lineage lockfiles retain a persistent inode; never unlink or rename them to clear a lock.
Unsupported platforms fail rather than falling back to age-based lock stealing.
Old directory-format locks are waited on for a bounded interval and then fail closed, with instructions to reload their owner.
Reload old controllers before reusing their registries; do not manually rewrite live registry records or steal directory locks.

## Regression checks

From the dotfiles root, build the deployment runtime without activating it:

```bash
export PI_E2E_RUNTIME="$(nix build --impure --no-link --print-out-paths --expr \
  "let f = builtins.getFlake \"path:$PWD\"; pkgs = import f.inputs.nixpkgs { system = builtins.currentSystem; }; in pkgs.callPackage $PWD/nix/packages/pi-coding-agent.nix {}")"
export PI_TEST_PACKAGES="$PI_E2E_RUNTIME/lib/pi-coding-agent/packages"
export PATH="$PI_E2E_RUNTIME/bin:$PATH"
export PI_OFFLINE=1
node nix/tests/pi-message-admission.mjs
node home/.pi/agent/extensions/subagent/e2e-native-queue-rejection.mjs
```

The package install check tests the real public extension binding and native queues, including idle and busy steering/follow-ups, post-run continuation, awaited consumption, compaction-state rejection, and later run failures.
The SDK protocol regression injects native rejection and receipt publication failures while an offline provider is blocked, then verifies receipts, durable pending state, provider counts, cancellation authorization, and completion markers.
These are deliberate fault injections, not claims of naturally occurring provider failures.

Then run the extension regressions:

```bash
npm --prefix home/.pi/agent/extensions/subagent ci --ignore-scripts
npm --prefix home/.pi/agent/extensions/subagent test
npm --prefix home/.pi/agent/extensions/subagent run lint
npm --prefix home/.pi/agent/extensions/subagent run format:check
uv run --script home/.pi/agent/extensions/subagent/e2e-widget.py
node home/.pi/agent/extensions/subagent/e2e-roles.mjs
node home/.pi/agent/extensions/subagent/e2e-control-admission.mjs
```

The widget suite starts real Pi TUI processes in isolated PTYs with seeded child records, the Prime editor, and the custom footer.
It verifies placement above the editor, lineage filtering, descendant ordering, retained done states, blocked-subtree overflow, full prompt and output paging, modal switching, mouse input, keyboard selection, narrow-width alignment, empty-state clearing, and reload cleanup in fullscreen and regular modes.
Fullscreen hyperlink clicks run Pi's real opener against an intercepted system command, proving URL and encoded local-asset targets without launching applications.
It does not access credentials, prompt a model, or call Herdr, and it saves screen captures and ANSI transcripts in the printed evidence directory.
Renderer unit tests also exercise theme colors, Unicode, control-sequence sanitization, and widths from one to 160 columns.
Oxc and Pi TUI dependencies are local development tools; the live extension uses Pi's bundled packages.

The role smoke starts real Pi RPC processes with the installed linked role definitions and checks model pins, `xhigh`, exact active tools, and the actual spawn handler's resolved launch permissions.
It strips Herdr caller identity, mocks only the final orchestrator spawn boundary, and never prompts a model or creates terminal surfaces.
It validates role wiring, not placement.

Inside Herdr:

```bash
node home/.pi/agent/extensions/subagent/e2e-active-cancellation.mjs
node home/.pi/agent/extensions/subagent/e2e-lifecycle.mjs
node home/.pi/agent/extensions/subagent/e2e-scopes.mjs
```

Both live suites use actual extension/tool handlers, persistent Pi sessions, and Herdr controls with offline scripted models rather than provider inference.
They create isolated test configurations and background surfaces, retain their evidence directories, and clean up only test-owned surfaces.
With `PI_E2E_RUNTIME`, a test-only Herdr wrapper pins PATH on every created surface, including descendants; it delegates all controls to the real Herdr CLI without changing live configuration or production environment propagation.
Each actual Pi process records its executable path, native-admission capability, and session path, which the suites verify against their saved sessions.
Focus checks reject test surfaces taking focus while allowing unrelated human focus changes.

The lifecycle suite covers nonblocking messaging/cancellation, generation-specific completion delivery, saved-session crash/replay, and continued parent usability.
Its publisher-crash cases kill actual test-owned child processes immediately after candidate publication, before or after settlement attestation, but always before marker publication.
They verify exact concatenated output recovery, conservative crashed status without attestation, successful completion only with attestation, once-only delivery, and ownership-safe cleanup.
The scope suite covers concurrent descendant spawns from different workers, role permissions, inherited scopes, equal-label conversation isolation, horizontal full-width geometry at each count from three through eight agents, master-tab placement, sibling and human-pane preservation, saved-session reactivation, sequential stages, moved-pane safe rejection, and blocked cancellation.
Its ownership case replaces an actual test child with another Pi session and verifies rejected stale controls, refused moved placement, durable release, fresh allocation, original-session reactivation, and preservation of the replacement's later shell.
Run `SCOPE_CASES=ownership node home/.pi/agent/extensions/subagent/e2e-scopes.mjs` for that focused case.
Run `SCOPE_CASES=blocked node home/.pi/agent/extensions/subagent/e2e-scopes.mjs` to verify blocked cancellation fails without interruption and preserves the eventual conclusion.
Independent-process lock tests cover descriptor retention, contenders, holder death, inode stability, exceptional release, and legacy-directory preservation.
Ownership unit tests explicitly cover uncertain observations, foreground commands, pending-cleanup recovery, moved panes, and failed-preflight monitoring.
`e2e-herdr.sh` is a compatibility entry point for the offline scope suite.
Tests and fixtures under this directory are not auto-loaded as production extensions.

## Applying changes

These files are linked into `~/.pi/agent/` through Home Manager's out-of-store symlinks.
Ordinary edits to the linked extension, role definitions, or workflow prompts do not require a Nix rebuild.
This version's private message-admission protocol additionally requires the packaged native-admission patch; rebuild and install the matching Nix runtime before loading it in production.
A stock `0.85.0` executable is not sufficient, and `/reload` cannot add the runtime capability.
Run `/reload` in an existing Pi session, or start a new Pi session, to load extension and prompt changes.
Already-running child processes retain their loaded extension until they reload or restart.

The workflow prompts in [`../../prompts/`](../../prompts/) pass one shared work-scope slug through their stages.
