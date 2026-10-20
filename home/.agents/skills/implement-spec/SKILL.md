---
name: implement-spec
description: "Implement the result of /to-spec and /to-tickets in code."
disable-model-invocation: true
---

You have been provided a spec. This spec should have tickets associated with it, describing how to implement the spec.

The issue tracker should have been provided to you. If not, tell the user to run `/setup-matt-pocock-skills`.

The goal is the entire spec implemented on a single **integration branch**, with each verified child ticket closed with completion evidence and the parent spec kept open until the PR is merged.

The tickets are not a list of steps. They are a **task graph** with blocking relationships between them. This means there is always a **frontier** of tickets which are ready to be grabbed.

Communication to and from subagents should be sparse. Communicate primarily through **context pointers**: to the spec, tickets, research notes, and previous commits. Don't duplicate information already available via pointers.

**Implementer subagents** should be run in the background where possible for maximum concurrency.

## Steps

1. Read the spec and tickets to understand the task graph.

2. (optional) Use an **exploration subagent** to conduct any exploration required by the tickets - relevant codebase files or external documentation. Ensure the exploration subagent can save files - it should save its markdown notes in a directory outside the repo, accessible by all future subagents. This lets **implementer subagents** focus on implementation rather than exploration.

3. Create the integration branch.
   If the issue tracker closes work through PRs, or the user asks for one, open a draft PR after the first merge in step 5 (a branch with no commits ahead of main can't open one), marked as closing the parent spec on merge and linking all child tickets.
   Opening the draft does not require all children to be complete or closed.
   Immediately after creating the draft PR, complete the initial PR review checkpoint below.

4. Use **implementer subagents** to implement each ticket, each in its own worktree on its own branch. Each implementer subagent:
   - confirms its worktree is based on the integration branch before starting, and resets onto it if not;
   - calls the Skill tool with `tdd` to build the ticket;
   - merges the integration branch tip into its own branch before reporting done

5. Once an **implementer subagent** completes, merge its work to the integration branch with a **merger subagent**.
   Verify the integrated acceptance criteria and resolve relevant review findings, then close that child using the ticket lifecycle below.
   A worker report or successful merge alone is not completion evidence.

6. If this changes the **frontier** of available tickets, kick off more **implementer subagents** to work on the new tickets. This allows for maximum concurrency.

7. Once all tickets are complete, call the Skill tool with `code-review` on the integration branch. Fix all issues raised by the code review in a single **implementer subagent**.
   Reopen any child whose completion is invalidated, then verify the correction and close it again with updated evidence.

8. If a draft PR exists, after the final code-review fixes, repeat the PR review checkpoint below before marking it ready for review.
   Otherwise, resolve each ticket the way the issue tracker closes work, and report the integration branch.

9. Handle **implementer subagent** worktrees according to repository ownership and retention rules.
   Closing a ticket does not authorize releasing a retained lease or deleting a worktree.

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

Load the generic model-invoked `plannotator` skill and use its documented PR code-review route for the actual PR URL: call the `plannotator` tool when available; otherwise run `plannotator review <PR_URL> --json`.
When using the CLI, classify the review outcome only by `decision`, never by exit-code success or message substrings.

Handle feedback and publish the Plannotator code-review outcome in the checkpoint against the reviewed base and head SHAs; refresh after feedback fixes as needed to obtain current approval.

The recorded outcome remains historical evidence for its snapshot, and approval may be reused only for the exact reviewed base/head; if either SHA changes, refresh the review before final readiness.

Before final readiness, require verified inclusion and acceptance-criteria completion for every ticket, addressed blocking feedback, and approval of the exact current base/head snapshot.

If review startup fails, is dismissed, returns no decision or feedback, or lacks approval for the current SHAs, leave the PR draft and report the blocker.

Before final readiness, reconcile every verified child to closed with completion evidence and keep the parent open until merge.
Closure status never substitutes for inclusion or acceptance proof, and closed children never substitute for approval of the exact PR snapshot.
