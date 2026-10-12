# Automatic Hunk review

## Scope

Automatic review belongs to an interactive Pi or Codex session inside Herdr whose working directory is in a Git checkout.
A working directory below the repository root still selects that complete Git worktree.
Sessions outside Git, noninteractive jobs, and sessions outside Herdr do not claim automatic coverage.
Start a separate Git-checkout coding session when moving to another repository.
Installation and native hook approval are documented in [feature-only installation](hunk-turn-review-installation.md).
The user-approved behavior contract is [automatic turn review](plans/hunk-turn-review.md).

## Reviewing a response

The first observed content change opens one owned Hunk pane immediately to the coding session's right without moving keyboard focus.
Before the first response completes, Hunk stays open with a waiting state rather than claiming an unfinished response is completed.
After completion, the default view contains changes observed during that response, including tool use and automatic continuation.
Pi's explicit `all` queue mode retains its normal batching; the resulting review is labeled as an intentional request group instead of pretending one shared response produced separate per-request diffs.
Interrupted and failed responses remain visible with their outcome labels.
A shared checkout can include another writer's changes during the same interval, so this view is not an authorship claim.

Press `Ctrl-G` outside the native comment editor for the human turn-review actions.
Use **Latest / cumulative / pinned review** to deliberately select another immutable view.
Cumulative review starts before the review task's first editing response and excludes changes already present then.
Choose **Start a new review task** explicitly instead of expecting prompt wording to reset its baseline.
The action requires confirmation and refuses to discard drafts or pending notes; an active response must finish before resetting its task.
A new view restores its own comments, not comments transplanted from another snapshot.

The viewer follows newly completed responses only when no unsent comment or active composer protects the current review.
A protected original view stays pinned and announces that a newer review is available.
The native editor retains original anchors and source context.
It does not search nearby lines and silently move a saved comment.

## Comments and submission

Use Hunk's normal selection and comment editor, then `Ctrl-S` to save a human note durably.
Saving and drafting never submit feedback.
Comments are free-form instructions, not an automatic code-edit classification.
A comment can request a change, ask for clarification, or request a handoff document.

Choose **Send review** to submit the saved human revisions explicitly.
The destination is the original native Pi or Codex session, not whichever process currently occupies its pane.
An idle original session can admit feedback immediately.
A busy original session retains pending feedback until an idle boundary without steering or interrupting current work.
A missing or unverified original session retains the batch rather than transferring it to a replacement.

Older feedback includes its immutable original diff and anchor context.
The recipient must inspect current code before acting and ask when the instruction no longer maps clearly.
Existing standing safeguards and unrelated work remain protected.
Submission does not authorize blanket rewriting and does not resolve or delete a native human note.
Editing a submitted note creates another unsent revision while preserving earlier immutable batches.

## Delivery evidence

Use **Status / pending batch history** to inspect the bound native identity, warnings, and retained batches.
A queued receipt establishes admission only, not processing, successful completion, or resolution.
Delivery uncertainty remains visible when a connection fails after submission might have succeeded.
Reconcile against the original queue and history before considering a retry.
No uncertain batch is retried automatically.
If uncertainty remains, an explicit retry must acknowledge the possibility of duplicate instructions.
A batch already known to be admitted is not silently resent.

**Export saved human feedback** creates an immutable local record without requesting delivery.
Drafts and agent-authored notes are not actionable human instructions.
The legacy manual-review export workflow remains documented in [Hunk human review](hunk-review-workflow.md).
Retained manual Hunk windows and their daemon stay separate from the feature-private broker namespace.

## Pane and session lifecycle

A narrow terminal offers **Full-width review tab** with the same comments, selection, and submission functionality.
If no viewer could open, Codex's native warning provides an exact review session ID and an explicit `hunk-turn-review-control tab --session-id <id>` command.
Use `hunk-turn-review-control status --session-id <id>` to inspect its original native identity and checkout before acting.
The workflow does not silently rearrange the workspace or take focus.
Deliberately closing the owned pane opts that native session out of automatic reopening until an explicit reopen action.
Use `hunk-turn-review-control reopen --session-id <id>` to reopen only that bound session's review.
Pi also exposes `/hunk-review-reopen` and `/hunk-review-tab` for those explicit actions.
Exiting the coding session leaves its immutable review available without making another session its recipient.
Resuming the original native session retains the review state and still verifies checkout and runtime identity before admission.

## Storage and failures

Review data stays in owner-private local storage outside repositories.
Eligible content includes tracked files and non-ignored new files, with symlink targets recorded rather than followed outside scope.
Git state is not stashed or committed merely to obtain snapshots.
Active task baselines and pending human feedback remain protected until explicitly discarded or resolved.
Other history has 30-day retention and a storage cap; protected data exceeding the cap warns instead of disappearing.
Configuration rollback preserves durable review data and pending batches.

Capture, layout, or transport failures warn while coding remains available.
A fallback or warning is not evidence that the failed capability worked.
Automatic visibility introduces no mandatory approval gate on commits or completion.
Native visual acceptance currently requires direct human confirmation because the Codex Computer Use harness denies WezTerm access.
