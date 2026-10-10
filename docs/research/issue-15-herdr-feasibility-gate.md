# Issue #15 Herdr feasibility gate result

Research date: 2026-10-10.

Scope: mandatory feasibility gate #15 for spec #35, using existing Herdr interfaces only.

**Result: NOT PASSED. Keep dependent integration blocked.**

The inspected Herdr 0.9.3 API does not expose the conditional ownership, visit fencing, or initiating-client controls required to safely close and navigate an attachment amid concurrent human actions.
This is a concrete blocker in the supported interface inspected, not proof that no future Herdr version or uninspected supported mechanism could satisfy the specification.
No Herdr patch or specification relaxation is warranted.

## Criterion results

| Criterion | Status | Evidence and limit |
| --- | --- | --- |
| Follow terminal identity, current pane handles, attachment generation, and original master through moves | Inconclusive | `PaneInfo` exposes terminal identity and current handles, and move responses/events include the prior handles and new pane info. The API has no managed attachment-generation field or authenticated original-master relation; local generation tracking and move recovery were not implemented or runtime-tested. |
| Single-client focus/zoom restoration and refusal when client scope is ambiguous | Fail on inspected API | Public `pane.focus` has a pane target but no initiating-client selector. Its handler projects the selected target to all attached shell clients. The session snapshot exposes global focus and topology, not attached-client cardinality. No supported way to detect a second attachment or target one client was found. |
| `prefix+enter` returns from terminal applications/editors and visibly reports an unavailable master | Inconclusive | The normal terminal prefix dispatcher supports a shell-command binding, but the helper receives no native conversation, attachment generation, or client identity. Herdr discards helper stdout/stderr. A notification route exists, but visible delivery, including unavailable/suppressed cases, is unproven. No binding, helper, or physical-key test was performed. |
| Serialize ownership or conservatively refuse concurrent move/replacement/repurpose/direct-entry versus close races | Fail on inspected API | `pane.close` accepts only a pane handle. It has no expected terminal, owner, generation, visit token, or focus predicate. Direct-entry focus observation is asynchronous, and repeated focus on an already-focused pane is not a new visit receipt. A controller lock or fresh lookup cannot fence Herdr UI actions that do not participate in that lock. |
| Honor protected-close rejection and expose uncertain ownership/visit state | Inconclusive | The close handler can reject a protected worktree-group close with `confirmation_required`. No managed helper or reporting path was implemented or runtime-tested. The conditional-close gap means an uncertain attachment cannot safely be closed based on a fresh lookup. |
| No Herdr source patch; clean up only owned disposable resources | Pass for this investigation | No Herdr source/config changes or disposable Herdr runtime resources were created, so there was nothing to clean up. |

The decisive P0 blocker is the absence of a server-enforced close/visit ownership condition combined with absent client cardinality and targeting.
Conservatively retaining every uncertain attachment would avoid destructive races, but would not prove the required automatic closure/navigation behavior and cannot be reported as a pass.

## Evidence boundary

Version-matched static evidence is Herdr 0.9.3 at upstream commit `7b116c05bfda646af39d2524c54e70c751f57ee8`, API protocol 22, schema version 1.
The inspected schema gives `PaneTarget` only `pane_id`, and `SessionSnapshot` only global focused workspace/tab/pane plus topology.
`PaneInfo` includes `terminal_id`, pane/workspace/tab IDs, focus state, agent metadata, and a revision, but the revision is not an attachment ownership epoch.
The close handler resolves a pane handle, checks the existing protected-worktree condition, and closes that pane; it does not compare a caller-supplied owner or generation.
The public focus handler's result is applied to all attached shell clients.

Read-only Herdr help/version/schema inspection was previously performed only after verifying `HERDR_ENV=1`.
No live-session API request, session inventory, pane mutation, runtime race reproduction, model launch, or CUA/physical-key proof was performed for this gate.
No disposable process, socket, pane, or isolated Herdr session was started, so there are no runtime cleanup receipts.
No TDD test was added or run because the gate failed before a safe production behavior could be specified; a controller-only test cannot establish that external Herdr actions participate in its lock.

Detailed version-matched source pointers are in the repository's [return-shortcut research](pi-herdr-return-shortcut.md) and [current-capabilities assessment](pi-herdr-interactive-current-capabilities.md).

## Changes and next step

No production declaration, helper, active Herdr configuration, or Herdr source was changed.
Only this sanitized research result is authored for the repository.
No issue tracker, push, live deployment, or worktree cleanup operation was performed.

Do not unlock dependent issue #35 integration from this result.
Revisit the gate only with a supported Herdr mechanism that fences pane close against attachment ownership and visit state, establishes or targets one initiating client, and surfaces helper failure reliably, then repeat isolated runtime and physical-key acceptance without touching unrelated sessions.
