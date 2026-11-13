---
name: implement-spec
description: "Implement the result of /to-spec and /to-tickets in code."
disable-model-invocation: true
---

You have been provided a spec. This spec should have tickets associated with it, describing how to implement the spec.

The issue tracker should have been provided to you. If not, tell the user to run `/setup-matt-pocock-skills`.

The goal is the entire spec implemented on a single **integration branch**, with each verified child ticket closed with completion evidence and the parent spec kept open until the PR is merged.

The tickets are not a list of steps. They are a **task graph** with blocking relationships between them. This means there is always a **frontier** of tickets which are ready to be grabbed.

## Execution lane

Use one accountable implementation lane in the current harness unless the user explicitly requests delegation.
In Codex, execute directly using Codex tools; Pi interactive subagents, terminal panes and completion notifications are not prerequisites.
Preserve existing worker sessions, checkouts, datasets and evidence when resuming work from another harness.
Verify whether an existing execution still owns the write lane before editing; a completed report and an unresolved execution are different states.

Optional independent review supplements delivery of a coherent execution path.
Read its actual result before deciding it remains pending; track findings to resolution rather than repeatedly launching reviews of small internal checkpoints.
If delegation is explicitly requested, pass context pointers, exact ownership, scope and a completion condition using tools supported by the current harness.
A missing delegation tool or pane capacity does not block authorized direct execution.

## Steps

1. Read the spec and tickets to understand the task graph and select the requested dependency-ready ticket.
   Complete its actual user journey before expanding into downstream source work unless the user requests a scheduling exception.

2. Resolve the existing canonical integration branch and checkout using the repository's checkout owner.
   Create them only when no owner exists; resume never creates another copy.
   Verify branch, lease, holder, base, head, dirty work, published state and runtime ownership before acting.

3. Resolve the selected ticket's canonical branch and checkout by stable ticket identity.
   Reuse that checkout for implementation, proof, review fixes, retries and recovery.
   Preserve existing work and merge required integration updates rather than resetting retained history.
   Reproduce the reported failure through the ordinary user-facing command before fixing it.
   Use the repository's testing owners and exercise real launcher, environment, process and persistence boundaries where acceptance requires them.
   External-effect doubles do not establish actual runtime or browser completion.

4. Review the coherent changed execution path, resolve blocking findings and run relevant checks.
   Merge the integration tip into the ticket branch before integration through the repository's guarded lifecycle.
   Integrate into the existing integration checkout, verify the composed result and publish authorized reviewed work promptly for CI feedback.
   Ordinary authorized source/test publication requires no invented per-commit approval gate.
   Explicit task-specific holds and independent operational approvals remain binding.
   If a PR is required and none exists, open a draft after the first integration commit and run the initial PR review checkpoint below.

5. Verify the selected ticket's acceptance criteria against the actual integrated source and runtime, then apply the ticket lifecycle below.
   A worker report, green CI, merge, HTTP response or redirect alone does not establish completion.
   Record remaining blockers and unverified claims without silently narrowing scope.

6. Refresh the frontier after completing a ticket.
   Continue only within the requested scope; a scheduling exception does not waive dependencies or acceptance.
   For interrupted execution, inspect current process and ownership state before continuing the same lane.
   Preserve uncertain claims and unresolved evidence instead of launching a competing writer or clearing ownership markers.

7. Once all requested implementation is complete, review the combined diff from the recorded base and resolve blocking findings in the existing canonical checkouts.
   Reopen any child whose completion is invalidated and verify its correction before closing again.
   If a draft PR exists, repeat the PR review checkpoint before marking it ready for review.
   Otherwise, resolve tickets using the tracker's delivery criteria and report the integration branch.

8. Complete the repository's guarded return after verified delivery into the recorded integration target or merged PR, preserving runtime data and evidence.
   No second human completion prompt is required unless the repository has an explicit task-specific hold.
   Closing a ticket alone is not landing proof; report retained ownership and the exact blocker when guarded return refuses.
   Returning reusable capacity is separate from pruning or deleting a checkout, which still requires explicit approval.

## Ticket lifecycle

Close each child as soon as its work is integrated in the linked PR, its agreed acceptance criteria are verified, and relevant review findings are resolved.
Do not defer a verified child's closure until PR merge.
Before closing, publish a completion comment with the PR link, exact verified head, reachable implementation commits, acceptance results and evidence links, review and validation outcomes, and any explicitly unproven or out-of-scope behavior.
Record approved scope changes so superseded criteria are not silently claimed as satisfied.
Keep children with unmet criteria open; identify the missing evidence or blocker.
Read back the tracker status after each transition and reconcile the published ticket ledger.

A closed child means implemented and verified in the linked PR; it does not mean merged, deployed, or approved by the human reviewer.
If later review or integration invalidates that evidence, reopen the affected child and explain what must be corrected.
Keep the parent spec open through draft creation, child completion, and review readiness; close it only after confirming the PR is merged.
Use the tracker's merge-closing reference when supported, and verify the parent state after merge rather than assuming automation ran.
Never merge a PR merely to close the parent.
For workflows without a PR, use the tracker's explicit delivery criterion for parent closure.

## PR review checkpoint

At each checkpoint, refresh the complete ticket set associated with the spec and each ticket's current tracker status, applying the ticket lifecycle above.

Confirm the PR head is the integration branch tip being reviewed, then record the PR URL, integration branch, and base and head commit SHAs.

For every ticket, verify inclusion from commits reachable at the integration/PR head or other inspectable evidence, never from closure status or worker reports.

Publish the checkpoint in the PR description or review handoff, not only a private file, with separate all-children-closed and all-included yes/no/unknown answers, the parent status and merge state, total/closed/open/unknown and included/missing/unverified counts, a complete per-ticket ledger of tracker status, inclusion status, and evidence, and missing or unverified work or blockers.

Label the initial draft checkpoint partial whenever the all-included answer is not yes.

Record code-review findings and their resolution against the reviewed base and head SHAs.
If either SHA changes, assess the new diff and refresh affected review and acceptance evidence before final readiness.

Before final readiness, require verified inclusion and acceptance-criteria completion for every ticket and resolution of blocking code-review findings.
Keep the PR draft while implementation, required verification or blocking findings remain incomplete.

Before final readiness, reconcile every verified child to closed with completion evidence and keep the parent open until merge.
Closure status never substitutes for inclusion, acceptance proof or code review.

## Evidence format

Use tests, API/database receipts, operational readback and direct browser checks suited to each acceptance criterion.
Video recording, upload and playback are not completion gates for this workflow; record videos only when the user explicitly requests them.
Continue functional and visual verification where relevant, and report unproven behavior honestly.
