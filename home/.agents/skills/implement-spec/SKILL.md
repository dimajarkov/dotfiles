---
name: implement-spec
description: "Implement the result of /to-spec and /to-tickets in code."
disable-model-invocation: true
---

You have been provided a spec. This spec should have tickets associated with it, describing how to implement the spec.

The issue tracker should have been provided to you. If not, tell the user to run `/setup-matt-pocock-skills`.

The goal is the entire spec implemented on a single **integration branch**, with every ticket resolved the way the issue tracker closes work.

The tickets are not a list of steps. They are a **task graph** with blocking relationships between them. This means there is always a **frontier** of tickets which are ready to be grabbed.

Communication to and from subagents should be sparse. Communicate primarily through **context pointers**: to the spec, tickets, research notes, and previous commits. Don't duplicate information already available via pointers.

**Implementer subagents** should be run in the background where possible for maximum concurrency.

## Steps

1. Read the spec and tickets to understand the task graph.

2. (optional) Use an **exploration subagent** to conduct any exploration required by the tickets - relevant codebase files or external documentation. Ensure the exploration subagent can save files - it should save its markdown notes in a directory outside the repo, accessible by all future subagents. This lets **implementer subagents** focus on implementation rather than exploration.

3. Create the integration branch.
   If the issue tracker closes work through PRs, or the user asks for one, open a draft PR after the first merge in step 5 (a branch with no commits ahead of main can't open one), marked as closing the spec and tickets.
   Immediately after creating the draft PR, complete the initial PR review checkpoint below.

4. Use **implementer subagents** to implement each ticket, each in its own worktree on its own branch. Each implementer subagent:
   - confirms its worktree is based on the integration branch before starting, and resets onto it if not;
   - calls the Skill tool with `tdd` to build the ticket;
   - merges the integration branch tip into its own branch before reporting done

5. Once an **implementer subagent** completes, merge its work to the integration branch with a **merger subagent**.

6. If this changes the **frontier** of available tickets, kick off more **implementer subagents** to work on the new tickets. This allows for maximum concurrency.

7. Once all tickets are complete, call the Skill tool with `code-review` on the integration branch. Fix all issues raised by the code review in a single **implementer subagent**.

8. If a draft PR exists, after the final code-review fixes, repeat the PR review checkpoint below before marking it ready for review.
   Otherwise, resolve each ticket the way the issue tracker closes work, and report the integration branch.

9. Clean up all **implementer subagent** worktrees.

## PR review checkpoint

At each checkpoint, refresh the complete ticket set associated with the spec and each ticket's current tracker status, following tracker closure policy.

Confirm the PR head is the integration branch tip being reviewed, then record the PR URL, integration branch, and base and head commit SHAs.

For every ticket, verify inclusion from commits reachable at the integration/PR head or other inspectable evidence, never from closure status or worker reports.

Publish the checkpoint in the PR description or review handoff, not only a private file, with separate all-closed and all-included yes/no/unknown answers, total/closed/open/unknown and included/missing/unverified counts, a complete per-ticket ledger of tracker status, inclusion status, and evidence, and missing or unverified work or blockers.

Label the initial draft checkpoint partial whenever the all-included answer is not yes.

Load the generic model-invoked `plannotator` skill and use its documented PR code-review route for the actual PR URL: call the `plannotator` tool when available; otherwise run `plannotator review <PR_URL> --json`.
When using the CLI, classify the review outcome only by `decision`, never by exit-code success or message substrings.

Handle feedback and publish the Plannotator code-review outcome in the checkpoint against the reviewed base and head SHAs; refresh after feedback fixes as needed to obtain current approval.

The recorded outcome remains historical evidence for its snapshot, and approval may be reused only for the exact reviewed base/head; if either SHA changes, refresh the review before final readiness.

Before final readiness, require verified inclusion and acceptance-criteria completion for every ticket, addressed blocking feedback, and approval of the exact current base/head snapshot.

If review startup fails, is dismissed, returns no decision or feedback, or lacks approval for the current SHAs, leave the PR draft and report the blocker.

Ticket closure is independent of inclusion and acceptance: open tickets may remain open until PR merge when tracker policy requires it, and this alone does not block readiness if all ticket work is verified included and accepted.
