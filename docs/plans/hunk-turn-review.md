# Automatic Hunk turn review

## Approved user contract

This feature standardizes automatic Hunk review for interactive Pi and Codex sessions running inside Herdr in Git checkouts.
The user approved this contract after a design interview and authorized implementation, focused tool changes, final two-axis code review, and committing the work.

### Review boundaries

- Create one persistent Hunk sibling immediately to the right of the owning agent on its first observed content change, without changing keyboard focus.
- Arm observation before work begins so that read-only requests do not create panes and the first write cannot erase the baseline.
- Review the latest completed user-request response by default, including tool calls, retries, and automatic continuations, rather than individual internal assistant/tool cycles.
- Preserve Pi's explicitly selected `all` queue batching and label its resulting response review as an intentional group of requests, retaining every member's provenance rather than inventing separate diffs.
- Publish interrupted and failed responses with explicit outcome labels when they leave changes.
- Offer cumulative task review separately, starting from the state before the task's first editing response and excluding pre-existing edits.
- Start a new cumulative review task only on an explicit action, not an inference from prompt text.
- Include tracked files and non-ignored untracked files, including additions and deletions, while excluding ignored secrets and dependency directories.
- Describe shared-checkout diffs as changes observed during the response, not guaranteed attribution to the owning agent.
- Do not stash, commit, or otherwise mutate Git state merely to obtain a baseline.

### Review interaction

- Reuse the same owned pane across subsequent responses.
- Automatically show the newest completed response when there are no unsent comments.
- Pin the original immutable review once comments exist and visibly announce newer available reviews.
- Never silently reattach old comments to changed lines.
- Keep cumulative, latest, and pinned review selection available explicitly.
- Keep review optional, with no new mandatory approval gate on commits or completion.
- Preserve all review, commenting, and feedback functionality in an explicitly offered full-width review-tab fallback when a right split would be unusable.
- Do not silently rearrange the workspace or steal focus.

### Feedback semantics

- Human comments are free-form instructions whose actual intent may be code changes, clarification, handoff documents, or other requests.
- Saving or drafting comments does not submit them.
- Explicit Send review submits a batch to the original native Pi or Codex session.
- Do not interpret every comment as permission to rewrite code.
- Use native harness delivery APIs, not terminal pasting.
- Bind feedback to original native session identity and canonical checkout, treating pane IDs only as current locations.
- Queue busy-session feedback visibly for the next idle boundary without steering or interrupting ongoing work.
- Preserve pending feedback when safe admission cannot be established and never automatically reassign it to a replacement session.
- Older review feedback remains sendable with its original immutable diff and anchor context.
- The receiving agent must check current code before following an older instruction and ask the user when intent no longer maps clearly.
- Distinguish queue admission from processing and addressing a comment.
- Never mark a note resolved merely because it was submitted.
- Persist batch identity and receipts, show uncertain delivery explicitly, reconcile against queue/history before retry, and require explicit retry if ambiguity remains.
- Never automatically retry an uncertain submission.

### Persistence and lifecycle

- Store review state locally outside Git checkouts in owner-private files and directories.
- Restore saved comments and review state after crashes and resuming the original session.
- Preserve active task baselines and pending comments until explicitly discarded.
- Retain other review history for 30 days with bounded storage and visible warnings.
- Keep the review available after agent exit without binding it to another agent.
- Respect deliberate pane closure as a session-level opt-out until explicitly reopened.
- Handle original-session resume and pane movement without transferring ownership to a replacement native session.
- Warn visibly on integration failures and allow coding to continue.

## Integration invariants

When the first observed edit opens Hunk before any response has completed, the owned review stays alive with an explicit in-progress or waiting state until a completed snapshot is available.
It must not crash, claim an unfinished response is completed, or require the user to relaunch it.
The persistence interface must atomically preserve an entire native human-review checkpoint, including selection and composer state, without manufacturing an actionable note for a draft.
Both harnesses need a discoverable explicit new-review-task action in Hunk or its installed command interface, not only a Pi-only slash command or an internal socket method.
The feedback interface distinguishes an unsaved composer, a saved but unsent human note, a submitted immutable note revision, and an explicitly resolved note.
Submitting feedback does not resolve native notes, but sent notes alone must not permanently prevent the newest completed review from appearing when there are no unsent comments or active composer.
An existing saved human note remains editable after submission, producing a new unsent revision while retaining every previously submitted immutable batch.
Original review IDs and native human note IDs must survive persistence and resume without moving contexts between snapshots.
A native request admission receipt is not evidence of consumption, successful completion, or addressed feedback.
Normal standing safeguards still apply to human instructions, but the integration must not impose a blanket code-edit interpretation or a new categorical commit gate that overrides an explicit human request.

## Approved acceptance environment

The user explicitly approved a separate Herdr 0.9.3 session for acceptance while leaving the existing `handovers` server and every original pane/process untouched.
There is no approval to stop, restart, update, or migrate the original session.
Native Codex hook trust remains a separate native human approval and must not be bypassed in production.

## Implementation constraints

Use supported APIs first and make focused host changes where supported extension surfaces are insufficient.
Herdr owns layout while native harness APIs own feedback admission.
Preserve the machine's declared software owners, unrelated configuration, uncommitted work, and existing integrations.
Do not activate a broader nix-darwin rebuild with its Homebrew zap policy merely to install this feature without separate approval.
Use durable Treehouse leases until the user explicitly declares this job finished.

## Confirmed validation contract

The user confirmed the public test seams: snapshot/review commands, feedback submission, and live Herdr workflows with both Pi and Codex.
The confirmed dotfiles review baseline is 64b1bb942aab321f8c09bfb60f36b90c4d770f4e.
Test-first implementation at these seams is authorized.
Use red-green vertical slices at confirmed public seams, run targeted tests and typechecking regularly, and run the full relevant suites at the end.
Perform separate Standards and Spec reviews against the implementation baseline before final handoff.
Do not claim live acceptance from source inspection or simulated transports.
