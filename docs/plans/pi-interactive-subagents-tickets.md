# Interactive subagents: published tickets

## Publication status

Dmitri approved this breakdown, and all 23 tickets are published in `dimajarkov/dotfiles`.
Issue bodies, acceptance criteria, labels, open states, and all 30 native blocking relationships were verified against GitHub.
Every ticket has the `ready-for-agent` label.
Publication does not start implementation, live proofs, or deployment.
The source is the [accepted specification](pi-interactive-subagents-spec.md).
The numbers below remain plan identifiers; the published issue index maps them to GitHub issue numbers.
Blocking lists contain direct prerequisites; transitive edges are omitted.
Every implementation slice includes its own isolated end-to-end demonstration and focused regression/race checks.
All work remains isolated from active configuration, installed extension links, unrelated panes, and private proof evidence.
A feasibility gate passes only with evidence of its mandatory invariants; a negative or inconclusive result is a blocker, not permission to unlock dependent implementation.

## 1. Preserve compatibility while separating lifecycle responsibilities

**Blocked by:** None.

**What it delivers:** Existing headless and Claude workflows continue unchanged through an orchestration seam suitable for independently owned native conversations.

- [ ] Separate conversation ownership, execution, controller connection, and terminal attachment responsibilities without adding native behavior.
- [ ] Preserve compatibility spawning, takeover, sending, waiting, cancellation, scoped teardown, and existing tool names.
- [ ] Preserve routing, reasoning defaults, trust decisions, permissions, and the feature-only Codex goal policy.
- [ ] Align development types with the installed Pi runtime and verify existing behavior before and after the prefactor.

**Demo:** Compare the existing compatibility workflow before and after the change, using mocked Claude coverage without changing provider routing.

## 2. Prove native Pi shared-conversation control and restrictions

**Blocked by:** None.

**What it delivers:** An isolated feasibility proof establishes whether one native Pi conversation can safely serve human input and master control.

- [ ] Verify one native session identity and writer for human and controller instructions in an owned disposable session.
- [ ] Demonstrate pre-execution admission, acknowledged input correlation, settlement, and structured interruption/shutdown.
- [ ] Prevent nested orchestration, direct question tools, recursive commands, and conversation replacement after reload and capability changes.
- [ ] Preserve resolved model, effort, working directory, project-resource trust, and host permission policy.
- [ ] Record current-version evidence, unsupported boundaries, and owned-resource cleanup without modifying the active installation or user panes.

**Demo:** Submit human/controller turns, deny admission, attempt forbidden routes, and stop only proof-owned execution.

## 3. Prove native Codex shares the exact controlled thread

**Blocked by:** None.

**What it delivers:** An isolated proof establishes native Codex attachment and acknowledged control of the assigned conversation.

- [ ] Connect the native interface and controller to one private execution host and the same verified thread.
- [ ] Observe human-started turns without assuming the controller started the active run.
- [ ] Demonstrate queue, steering, finish signaling, interruption, and shutdown with request receipt distinguished from observed effects.
- [ ] Reconcile history/notification overlap and exclude auxiliary threads from assigned-thread activity and outcomes.
- [ ] Preserve permission/model/working-directory settings and record current-version ownership, failure, and complete cleanup evidence.

**Demo:** Alternate native/controller input, compare identities and history, then interrupt and stop the owned host.

## 4. Prove Codex hard pre-start admission and child policy enforcement

**Blocked by:** None.

**What it delivers:** A separate go/no-go proof establishes whether native Codex can satisfy mandatory execution and orchestration restrictions.

- [ ] Gate every native/controller execution-starting route before model or tool execution, rather than detecting violations afterward.
- [ ] Prove denied concurrent starts and unavailable admission authority produce no hidden work.
- [ ] Remove forbidden delegation, workflows, direct question tools, and recursive command routes from effective managed-child capabilities.
- [ ] Reject conversation replacement, switching, and forking through reload/resume, model/tool changes, and collaboration-mode changes.
- [ ] Preserve broad host permissions and one policy owner for unexpected interactive requests.
- [ ] Establish supported enforcement and bypass boundaries, or report an explicit blocker without weakening the specification.

**Demo:** Exercise competing native starts, authority loss, forbidden capabilities, and session-replacement attempts in a self-contained disposable setup.

## 5. Prove safe Herdr targeting, navigation, and attachment ownership

**Blocked by:** None.

**What it delivers:** An isolated proof determines whether pane operations can meet ownership and navigation requirements through existing Herdr interfaces.

- [ ] Follow terminal identity, current pane handles, attachment generation, and original-master identity through moves.
- [ ] Demonstrate single-client focus/zoom restoration and refuse ambiguous multi-client navigation.
- [ ] Demonstrate prefix-Enter return from terminal applications/editors with visible unavailable-master failure.
- [ ] Establish serialized ownership or conservative refusal for concurrent moves, replacement, repurposing, and direct-entry/close races.
- [ ] Honor protected-close rejection and expose uncertain visit/ownership state rather than trusting a fresh lookup alone.
- [ ] Use no Herdr source patch and clean up only owned disposable resources.

**Demo:** Move and repurpose test panes, race entry against close, attach another client, and remove the original master.

## 6. Launch a managed native Pi child with hard admission

**Blocked by:** 1, 2, 5.

**What it delivers:** A master launches a fresh native Pi child, observes its work, and sees human continuations in the same conversation.

- [ ] Validate parent/child/native identity, policy, bridge readiness, and attachment before reporting running.
- [ ] Persist task/run identities and human/master provenance.
- [ ] Apply one durable admission authority across native, headless, and compatibility execution with at most four active runs.
- [ ] Gate human starts before execution; idle panes/history use no execution slot and authority loss fails closed.
- [ ] Preserve defaults/overrides and enforce managed-child restrictions from initial launch.
- [ ] Expose unavailable capacity/presentation and partial-launch diagnostics, release reservations only after confirmed stop, and avoid hidden fallback.

**Demo:** Launch and continue a native Pi child, then attempt simultaneous starts against four occupied execution slots.

## 7. Launch a managed native Codex child through the shared lifecycle

**Blocked by:** 3, 4, 6.

**What it delivers:** Codex gains native launch and observation through the shared admission and orchestration path established by the Pi slice.

- [ ] Attach native/controller connections to the exact assigned thread and adopt admitted human-started turns.
- [ ] Correlate activity/outcomes and enforce the existing durable cross-harness admission authority before native starts.
- [ ] Filter auxiliary activity and recognize explicit terminal statuses without treating unknown statuses as success.
- [ ] Revalidate effective restrictions and permission/model/working-directory policy before readiness.
- [ ] Report bridge/startup failures explicitly and clean up only verified owned resources.

**Demo:** Run Pi and Codex together, start a Codex turn natively, and verify observation and fifth-run rejection.

## 8. Inspect granular durable native histories

**Blocked by:** 7.

**What it delivers:** `/subagents` provides detailed live and archived inspection without starting execution.

- [ ] Keep Enter for transcript details and prevent archive viewing or ordinary text entry from restarting work.
- [ ] Retain native finalized history and durable activity, task/run correlation, queues, metadata, usage, lifecycle, and cleanup records.
- [ ] Retain exposed messages, reasoning/redaction, tool arguments/results/errors, and available output artifacts.
- [ ] Honestly mark source truncation, missing tails, and unavailable reasoning.
- [ ] Page detail and bound memory/rendering/indexing independently of durable retention.
- [ ] Use owner-private storage and authenticated control without leaking credentials or private endpoint material.

**Demo:** Inspect large histories for both harnesses after controlled shutdown and dashboard restart, including tool details and source limitations.

## 9. Send queued follow-ups and explicit live steering

**Blocked by:** 8.

**What it delivers:** Humans and the master instruct the same managed conversation with clear delivery semantics.

- [ ] Add a master-send control under the existing naming convention and preserve human dashboard sending.
- [ ] Default management sends to queued follow-up and expose supported steering explicitly.
- [ ] Reject unsupported steering instead of silently changing its mode.
- [ ] Distinguish receipt, queue admission, rejection, observed insertion, and execution correlation.
- [ ] Preserve actor attribution and obtain admission before any new execution run.

**Demo:** Send follow-ups and steering while each harness is busy, then compare receipts, order, and native history.

## 10. Finish assigned tasks without confusing completion with idle

**Blocked by:** 9.

**What it delivers:** A child or human explicitly completes an assignment while preserving later work in the same conversation.

- [ ] Provide acknowledged finish actions carrying a final result for child and human use.
- [ ] Require correlated execution/queues to settle without inferring completion from idle, exit, disconnection, or Herdr status.
- [ ] Revoke pending finish when new instructions are admitted before closure starts.
- [ ] Preserve a persisted terminal outcome and create a new task for subsequent instructions, cancelling stale pending closure.
- [ ] Reject input after attachment closure starts and expose the explicit resume path.
- [ ] Persist task outcome, retained-history cutoff, and delivery intent independently of cleanup outcome.

**Demo:** Exercise idle without finish, queued work, late input, and follow-up after an already retained terminal outcome.

## 11. Request guidance and wait for assigned-task outcomes

**Blocked by:** 10.

**What it delivers:** A child requests clarification without direct question tools, and the master receives truthful waiting results.

- [ ] Record a needs-guidance state and notification intent without closing the conversation.
- [ ] Release capacity only after execution stops and re-admit either human or master guidance.
- [ ] Wait for native assigned-task outcomes rather than intermediate idle states.
- [ ] End a wait with action-needed for guidance, report other requested children, and leave them working.
- [ ] Abort only waiting when a wait is interrupted; keep child cancellation separately acknowledged.
- [ ] Preserve headless and Claude waiting/completion behavior.

**Demo:** Wait on two children, obtain guidance from one, continue the other, answer through both routes, and abort a separate wait.

## 12. Tile children and queue starts under crowding or zoom

**Blocked by:** 7.

**What it delivers:** Native children start in a readable region below the master without disrupting existing work.

- [ ] Tile managed attachments without stealing focus or rearranging unrelated panes.
- [ ] Use configurable readability thresholds validated against both native interfaces.
- [ ] Show capacity, space, and presentation reasons for waiting-to-start without hidden execution.
- [ ] Start queued work when conditions permit and defer disruptive splits during zoomed visits.
- [ ] Pause new starts after crowding resizes without killing/moving children or creating overflow tabs.
- [ ] Keep child identity/management intact through manual pane movement.

**Demo:** Queue work under occupied capacity, insufficient geometry, and zoom, then restore each condition and observe safe starts.

## 13. Visit native panes, hold them open, and return to the original master

**Blocked by:** 10.

**What it delivers:** Dashboard, mouse, and Herdr navigation visits preserve management and native interaction.

- [ ] Preserve Enter inspection and add a distinct Open pane action.
- [ ] Treat direct entry as a visit, temporarily zoom, and restore prior presentation on return without stopping the master/siblings.
- [ ] Add one declarative prefix-Enter binding and an identity-aware return helper covering native interfaces and terminal editors.
- [ ] Preserve native Escape/Ctrl+] and visibly refuse ambiguous multi-client or unavailable-master navigation.
- [ ] Separate visit and Keep open holds, expose pending closure, and explain draft protection before departure.
- [ ] Return after pane/master moves using original identity rather than neighbor position or focus history.

**Demo:** Visit through all entry routes, move panes, retain a hold, and exercise editor return and multi-client refusal.

## 14. Close completed or cancelled panes without losing history or unrelated work

**Blocked by:** 11, 13.

**What it delivers:** Successful completion and acknowledged cancellation remove owned panes safely while retaining inspectable outcomes.

- [ ] Close successful tasks only when visit/Keep open state is safely clear; defer shutdown itself for holds or uncertainty.
- [ ] Freeze admission, settle/stop work, retain history/outcome/delivery intent, and confirm owned execution is stopped before closure.
- [ ] Revalidate attachment identity/generation and navigation safety with idempotent retries and protected-close handling.
- [ ] Retain failed diagnostic panes and close cancellations only after confirmed stop and retained partial history.
- [ ] Record manual-close interruption and the durable cutoff without overwriting retained outcomes or fabricating an unconfirmed tail.
- [ ] Protect shared/pre-existing processes and stale/moved/reopened/repurposed targets; uncertain cleanup remains attention-needed without stranded waits.

**Demo:** Cover normal/held close, cancellation, manual close, entry races, replaced occupants, bridge loss, and protected-close rejection.

## 15. Explicitly hand off intentionally persistent servers

**Blocked by:** 14.

**What it delivers:** A child intentionally leaves a server running only through acknowledged ownership transfer.

- [ ] Require an explicit recipient and acknowledgement before exempting execution from child cleanup.
- [ ] Retain exact process ownership, handoff state, and ongoing responsibility.
- [ ] Keep refused/incomplete transfers child-owned and subject to ordinary cleanup.
- [ ] Make acknowledgement replay idempotent and reject reused or unrelated process identities.
- [ ] Keep task completion, server ownership, and pane cleanup outcomes distinct.

**Demo:** Hand off an owned test server before closing its pane, then reject another handoff and verify ordinary cleanup.

## 16. Keep unfinished children alive through master loss

**Blocked by:** 8.

**What it delivers:** Native children survive master reload, exit, and crash, reconnecting only to their original master session.

- [ ] Disconnect management without terminating unfinished native execution and visibly report management unavailability.
- [ ] Preserve native input/history and independently owned execution while offline.
- [ ] Reconnect only the same validated parent identity with one active management controller.
- [ ] Reject labels, reused PIDs, stale handles, and different parent sessions as authority.
- [ ] Enforce the durable four-run authority for offline continuations, visibly queueing/rejecting starts when unavailable.
- [ ] Reconstruct associations/attachments and revalidate policy without setting drift.

**Demo:** Reload, exit, and crash the master during work, continue offline, reconnect the same session, and refuse a different one.

## 17. Recover significant notifications with durable task/run receipts

**Blocked by:** 11, 16.

**What it delivers:** Completion, failure, and guidance reach the master without losing earlier outcomes or multiplying notifications.

- [ ] Key receipts by task/run and preserve multiple pending outcomes from one child.
- [ ] Deliver eligible significant events as idle-delayed follow-ups while retaining intermediate runs without automatic waking.
- [ ] Distinguish outcome recording, pending delivery, queue admission, observed parent insertion, and wait consumption.
- [ ] Reconcile parent history after crashes around admission/insertion and deduplicate event/history replay.
- [ ] Keep cleanup independent of parent consumption and avoid treating a send call or queue acknowledgement as crash-safe completion.

**Demo:** Produce multiple busy/offline outcomes, crash at delivery boundaries, replay duplicates, and explicitly consume one result through a wait.

## 18. Resume archived conversations without creating replacements

**Blocked by:** 14, 16.

**What it delivers:** Resume in pane reopens the exact archived conversation under its original association.

- [ ] Distinguish opening an idle interface from admitting execution.
- [ ] Preserve child/native identity and origin with a new attachment generation and new execution identities when work begins.
- [ ] Enforce one Pi writer and the exact Codex thread, refusing conflicting live ownership.
- [ ] Restore intended model/effort/working-directory/trust/restrictions without shell-default drift.
- [ ] Apply admission and reject stale controls/close requests against the reopened generation.
- [ ] Preserve historical outcomes and pending delivery records.

**Demo:** Resume both harnesses, inspect without execution, admit follow-up, and attempt competing resume and stale cleanup.

## 19. Optionally copy selected parent branch context

**Blocked by:** 7.

**What it delivers:** A master explicitly seeds a new child with a branch-aware context snapshot.

- [ ] Keep fresh self-contained tasks as the default.
- [ ] Copy only selected parent-model-visible context, excluding private aside content/metadata and unrelated branches.
- [ ] Preserve relevant available summaries/context boundaries and record snapshot provenance.
- [ ] Create a distinct child instead of switching an existing managed conversation.
- [ ] Demonstrate that later parent changes do not synchronize into the child.

**Demo:** Create divergent branches/private entries, seed each native harness from one branch, and inspect the copied context.

## 20. Run private `/btw` conversations in native Pi panes

**Blocked by:** 17, 18.

**What it delivers:** Human-only asides gain the native lifecycle without entering or waking the master model.

- [ ] Use shared admission, holds, finish, cleanup, archive, and resume inside Herdr.
- [ ] Preserve private origin across continuation, reload, recovery, and resume.
- [ ] Exclude content and metadata from all model-facing controls, guessed-ID access, reconstructed archives, and replay.
- [ ] Deliver results/guidance through human-only UI paths without master-model messages.
- [ ] Preserve outside-Herdr behavior and prohibit recursive `/btw` from managed children.

**Demo:** Complete, continue, archive, recover, and resume an aside while probing model controls with its known identifier.

## 21. Separate dashboard forgetting from permanent archive deletion

**Blocked by:** 18.

**What it delivers:** Humans remove archived associations or explicitly delete owned history with distinct, truthful effects.

- [ ] Forget an association without deleting native history by default.
- [ ] Require confirmation and verified stopped/owned artifacts for permanent deletion.
- [ ] Refuse deletion while execution, a live writer, or ownership uncertainty remains.
- [ ] Protect project files, worktrees, shared artifacts, and live work; cache pruning cannot delete archives.
- [ ] Explain that archive deletion does not erase results already recorded in the parent conversation.

**Demo:** Forget one archive, confirm deletion of another, and refuse deletion of a resumed live child.

## 22. Teach and verify the complete native and compatibility workflow

**Blocked by:** 12, 15, 19, 20, 21.

**What it delivers:** The subagents skill, emitted prompts, tool descriptions, and human instructions accurately guide the completed behavior.

- [ ] Replace blanket headless claims with actual native-Herdr/compatibility routing.
- [ ] Explain context copying, sending modes, admission, guidance, finish versus idle, waits/cancellation, holds/resume, and significant notifications.
- [ ] Explain dashboard actions, return/native keys, drafts, privacy, archive access, forgetting, and deletion.
- [ ] Preserve routing/defaults and the feature-only Codex goal policy, distinguishing native terminal interaction from Computer Use.
- [ ] Test emitted prompts and effective child tools/commands in both modes after reload/resume, not merely documentation strings.
- [ ] Correct obsolete descriptions and pass deterministic tests, typechecking, lint/format checks, and compatibility regressions.

**Demo:** Follow the revised skill in isolated native and ordinary-terminal sessions and inspect actual prompts/capabilities.

## 23. Complete isolated end-user visual and key acceptance

**Blocked by:** 22.

**What it delivers:** Reviewable end-user evidence establishes whether the whole feature meets its accepted native-interface standard.

- [ ] Use Codex Computer Use under approved routing in owned isolated sessions without changing the active installation or unrelated panes.
- [ ] Verify readable native interfaces, detailed archives, tiling/queue/crowding feedback, focus/zoom restoration, and editor presentation.
- [ ] Exercise end-user key paths for Tab then Enter, Escape, Ctrl+], typing, Unicode, paste, editors, and resize instead of relying only on synthetic PTY bytes.
- [ ] Cover both harnesses, contention/offline continuations, guidance, finish/input and direct-entry/closure races, cancellation, and server handoff.
- [ ] Verify recovery/replay, same-conversation resume, privacy/context copying, deletion refusal, moved/repurposed/protected panes, and multi-client refusal.
- [ ] Trace every spec acceptance item to evidence and passing checks, retaining cleanup receipts and treating failed/unproven requirements as rollout blockers.

**Demo:** Perform the complete human workflow and review visual/key evidence alongside lifecycle/race tests.
Passing this ticket does not itself authorize active deployment.

## Dependency rationale

Tickets 1-5 can start independently in isolated work.
Ticket 1 is the behavior-preserving prefactor exception, while tickets 2-5 are independently verifiable go/no-go experiments rather than implementation-layer slices.
Native integration requires passed relevant proof gates, and Codex requires both its conversation and enforcement proofs.
Ticket 6 establishes shared durable admission as part of a real Pi launch path; ticket 7 reuses it for Codex rather than introducing a horizontal coordinator-only ticket.
Ticket 12 needs both native launch paths but does not require durable archive inspection, so it depends on 7 rather than 8.
Layout and native visits can evolve independently after their stated prerequisites.
Safe closure needs persisted delivery intent, not completed parent notification delivery, so ticket 17 does not block 14.
Archive resume requires prior safe ownership release and same-parent recovery, not optional context copying.
Ticket 22 closes the skill/prompt/documentation requirement after all relevant behaviors exist.
Ticket 23 is an integration evidence gate, not a substitute for per-ticket end-to-end demonstrations.

## Published issue index

| Plan ID | GitHub issue | Blocked by |
| --- | --- | --- |
| 1 | [#11](https://github.com/dimajarkov/dotfiles/issues/11) | None |
| 2 | [#12](https://github.com/dimajarkov/dotfiles/issues/12) | None |
| 3 | [#13](https://github.com/dimajarkov/dotfiles/issues/13) | None |
| 4 | [#14](https://github.com/dimajarkov/dotfiles/issues/14) | None |
| 5 | [#15](https://github.com/dimajarkov/dotfiles/issues/15) | None |
| 6 | [#16](https://github.com/dimajarkov/dotfiles/issues/16) | #11, #12, #15 |
| 7 | [#17](https://github.com/dimajarkov/dotfiles/issues/17) | #13, #14, #16 |
| 8 | [#18](https://github.com/dimajarkov/dotfiles/issues/18) | #17 |
| 9 | [#19](https://github.com/dimajarkov/dotfiles/issues/19) | #18 |
| 10 | [#20](https://github.com/dimajarkov/dotfiles/issues/20) | #19 |
| 11 | [#21](https://github.com/dimajarkov/dotfiles/issues/21) | #20 |
| 12 | [#22](https://github.com/dimajarkov/dotfiles/issues/22) | #17 |
| 13 | [#23](https://github.com/dimajarkov/dotfiles/issues/23) | #20 |
| 14 | [#24](https://github.com/dimajarkov/dotfiles/issues/24) | #21, #23 |
| 15 | [#25](https://github.com/dimajarkov/dotfiles/issues/25) | #24 |
| 16 | [#26](https://github.com/dimajarkov/dotfiles/issues/26) | #18 |
| 17 | [#27](https://github.com/dimajarkov/dotfiles/issues/27) | #21, #26 |
| 18 | [#28](https://github.com/dimajarkov/dotfiles/issues/28) | #24, #26 |
| 19 | [#29](https://github.com/dimajarkov/dotfiles/issues/29) | #17 |
| 20 | [#30](https://github.com/dimajarkov/dotfiles/issues/30) | #27, #28 |
| 21 | [#31](https://github.com/dimajarkov/dotfiles/issues/31) | #28 |
| 22 | [#32](https://github.com/dimajarkov/dotfiles/issues/32) | #22, #25, #29, #30, #31 |
| 23 | [#33](https://github.com/dimajarkov/dotfiles/issues/33) | #32 |

The initial unblocked frontier is #11, #12, #13, #14, and #15.
