# Hunk review-to-agent workflow

## Goal

Use Hunk, not LazyGit, for the human review surface.
Browse a changeset, select a line or range, press `c` to leave a comment, explicitly submit structured feedback to a coding agent, and inspect the agent's changes in Hunk again.
Keep the human in control of when feedback leaves the review and which agent receives it.

## Approach

Build a small user-owned Hunk extension and a narrow Herdr handoff adapter.
Use Hunk's public extension API and native comment editor instead of duplicating its UI or maintaining a fork.
Use the installed version's bundled skills and types as the implementation authority.
The current upstream documentation describes native visual selection with `v`, commenting with `c`, note-editor save with `Ctrl-S`, and refresh with `r`.
Verify those controls against the pinned release before documenting them as working locally.

## 1. Establish reproducible ownership

- Audit Hunk's executable, known installation directories, and package-manager inventories before installing anything.
- Prefer a pinned declarative Nix package, following this repository's existing packaging patterns.
- Build and test that package without activating unrelated dotfiles changes.
- Do not run a broad `darwin-rebuild switch`, remove another installation, or change shell PATH ownership without separate approval.
- Add the extension and any necessary configuration through Home Manager, preserving existing file contents and unrelated edits.
- Leave LazyGit installed and its configuration unchanged.

## 2. Stay inside Hunk for review and submission

- Preserve Hunk's native line/range selection and `c` note creation.
- Do not introduce a second comment editor or require a redundant review-mode toggle when Hunk already supports the requested behavior.
- Add a discoverable extension command, tentatively `Ctrl-G`, that opens a small review-actions menu.
- Offer export, explicit send-to-agent, and refresh/re-review actions.
- Verify the shortcut is unclaimed and works through Herdr before choosing it permanently.
- Surface errors, empty reviews, unsaved drafts, cancelled submissions, and stale notes without losing comments or blocking normal navigation.
- Use Hunk's authoritative `ctx.review.snapshot()` rather than inferring a line from viewport text.
- Capture and recheck the snapshot's generation and state revision around asynchronous submission work.

## 3. Export a durable review batch

Produce versioned JSON for machines and readable Markdown for humans.
Store feedback outside the public repository in owner-private local state.

Each batch should identify:

- The repository and exact checkout being reviewed.
- The Hunk session or review identity when available.
- The reviewed scope, such as unstaged work, the index, a commit, or a revision comparison.
- The review generation and state revision, creation time, and a stable batch identity.
- The reviewed content identity and relevant immutable Git revisions when available.

Each human comment should preserve:

- Its stable note identity and parent/thread relationship when applicable.
- Its exact text and source.
- The current and previous filename when applicable.
- The old/new-side anchor and line or inclusive range, without inventing unsupported coordinates.
- The relevant original code or diff context for relocation after edits.
- Hunk's active, stale, or orphaned reconciliation status.

Exclude agent-authored notes from actionable human feedback by default.
Never silently discard stale or orphaned human notes.
An empty batch must not invoke an agent.
Preserve exported batches independently of the live Hunk window.

## 4. Hand off explicitly and re-review

- Use Herdr's validated agent surface, with argument-safe subprocess calls rather than shell interpolation.
- Let the human choose an existing compatible agent in the same checkout.
- Confirm the destination before sending and reject missing, ambiguous, replaced, or blocked targets.
- Send a self-contained prompt referencing the immutable feedback batch and its reviewed scope.
- Tell the agent to inspect the original anchors, address each human request, preserve unrelated work, and report addressed and unresolved note identities.
- Do not send feedback automatically when a comment is saved.
- Do not delete human notes or mark them resolved merely because a prompt was delivered.
- Distinguish exported, submitted, failed, and user-reviewed state.
- Guard against accidental duplicate submission, while permitting an explicit resubmission when desired.
- Reload the same Hunk review after changes, retaining notes and their reconciliation status for human re-review.
- Keep live Hunk communication local and use its documented session CLI rather than probing private daemon endpoints.

## Verification

First prove the real keyboard flow in an isolated task-owned Git fixture using the actual pinned Hunk binary.
Cover single-line comments, multi-line selection, old-side/deleted lines, staged and unstaged scopes, new and renamed files, empty feedback, quotes and multiline text, cancelled submission, duplicate submission, stale/reloaded reviews, multiple sessions, and failed or blocked handoff.
Verify that export preserves the note text and actual anchors, then demonstrate submission, an agent-applied fixture change, and successful re-review.
Use automated integration tests for the repeatable behavior and Codex Computer Use for end-user visual/native proof where available.
Do not treat a mocked comment-insertion API as proof that the human `c` editor works.
Run the relevant tests, the repository's declared lint/type checks, and Nix validation.
For new JavaScript or TypeScript tooling, use project-local Oxc and an isolated dependency environment.
Clearly separate verified behavior from any pending human activation or UI proof.

## Boundaries

Work in the existing `/Users/dmitrijarkov/dotfiles` checkout, as requested for the same-tab Codex pane.
Do not create a different workspace, tab, worktree, upstream fork, or separate repository without approval.
Do not commit, push, open a PR, reset, clean, stash, or overwrite unrelated work.
Do not change the intentional Homebrew `zap` cleanup policy.
Do not modify generated files or changelogs manually.
If the pinned release cannot supply a necessary native capability, report the exact gap rather than silently changing the requested workflow.

## Primary references

- [Hunk compact documentation, including keyboard controls](https://hunk.dev/llms-small.txt)
- [Hunk keybinding source](https://github.com/modem-dev/hunk/blob/main/docs/keybindings.md)
- [Hunk extensions](https://hunk.dev/docs/extend/extensions/)
- [Hunk extension API and authoritative snapshots](https://hunk.dev/docs/extend/extension-api/)
- [Reference snapshot-export extension](https://github.com/modem-dev/hunk/tree/main/examples/extensions/review-snapshot-export)
- [Hunk live agent workflow](https://hunk.dev/docs/agents/review-with-an-agent/)
- [Hunk CLI](https://hunk.dev/docs/reference/cli/)
- [Hunk generated review skill](https://hunk.dev/docs/hunk-review-skill.md)
