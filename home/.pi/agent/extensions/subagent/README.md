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
Every child is created by splitting a pane in the master Pi agent's current Herdr tab.
The master pane is used for root and unscoped children; later placement selects the largest currently live, ownership-verified child pane when one exists.
Human panes and panes from other conversations are never placement candidates.
Every spawn and saved-session reactivation uses a horizontal split (`--direction down`), stacking panes top-to-bottom while preserving the selected pane's full width.
Pane dimensions never switch placement to a vertical, side-by-side split, even when the terminal is short.
More simultaneous agents therefore share the available height.
Completion messages return to the spawning parent.

## Lifecycle

Completed children retain Pi session history while their owned terminal panes are cleaned up.
Before acknowledging delivery, the extension saves the full completion in an outbox entry on the parent's active Pi session branch, then queues its model-visible follow-up.
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

These checks are observational, not atomic fencing.
The current Herdr API has no expected-session or revision precondition for closing, splitting, prompting, or focusing.
Lineage locks serialize cooperating controllers but cannot prevent an external actor from replacing a runtime between verification and a subsequent Herdr command.

Use `inspect`, `message`, `cancel`, or `resume` with the agent's semantic `name`.
`message` can reactivate a finished child with its saved session and launch settings.
Cancelling an already-terminal child only finishes its surface cleanup and preserves its outcome and saved result.
`resume` and `/subagent-focus <name>` intentionally focus that child.
`/subagents` lists the current parent's children.

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

From the dotfiles root:

```bash
node --experimental-strip-types --test home/.pi/agent/extensions/subagent/*.test.ts
node home/.pi/agent/extensions/subagent/e2e-roles.mjs
```

The role smoke starts real Pi RPC processes with the installed linked role definitions and checks model pins, `xhigh`, exact active tools, and the actual spawn handler's resolved launch permissions.
It strips Herdr caller identity, mocks only the final orchestrator spawn boundary, and never prompts a model or creates terminal surfaces.
It validates role wiring, not placement.

Inside Herdr:

```bash
node home/.pi/agent/extensions/subagent/e2e-lifecycle.mjs
node home/.pi/agent/extensions/subagent/e2e-scopes.mjs
```

Both live suites use actual extension/tool handlers, persistent Pi sessions, and Herdr controls with offline scripted models rather than provider inference.
They create isolated test configurations and background surfaces, retain their evidence directories, and clean up only test-owned surfaces.
Focus checks reject test surfaces taking focus while allowing unrelated human focus changes.

The lifecycle suite covers nonblocking messaging/cancellation, generation-specific completion delivery, saved-session crash/replay, and continued parent usability.
The scope suite covers concurrent descendant spawns from different workers, role permissions, inherited scopes, equal-label conversation isolation, horizontal full-width geometry at each count from three through eight agents, master-tab placement, sibling and human-pane preservation, saved-session reactivation, sequential stages, moved-pane safe rejection, and blocked cancellation.
Its ownership case replaces an actual test child with another Pi session and verifies rejected stale controls, refused moved placement, durable release, fresh allocation, original-session reactivation, and preservation of the replacement's later shell.
Run `SCOPE_CASES=ownership node home/.pi/agent/extensions/subagent/e2e-scopes.mjs` for that focused case.
Independent-process lock tests cover descriptor retention, contenders, holder death, inode stability, exceptional release, and legacy-directory preservation.
Ownership unit tests explicitly cover uncertain observations, foreground commands, pending-cleanup recovery, moved panes, and failed-preflight monitoring.
`e2e-herdr.sh` is a compatibility entry point for the offline scope suite.
Tests and fixtures under this directory are not auto-loaded as production extensions.

## Applying changes

These files are linked into `~/.pi/agent/` through Home Manager's out-of-store symlinks.
No Nix rebuild is needed for edits to the linked extension, role definitions, or workflow prompts.
Run `/reload` in an existing Pi session, or start a new Pi session, to load extension and prompt changes.
Already-running child processes retain their loaded extension until they reload or restart.

The workflow prompts in [`../../prompts/`](../../prompts/) pass one shared work-scope slug through their stages.
