---
name: rex-review
description: Open a Plannotator TUI review immediately to the right of this coding-agent session in Rex.
disable-model-invocation: true
---

# Rex Review

Open the review on invocation, without a preamble or an agent-authored review.

1. Use the invoking terminal's `REX_BLOCK` as the anchor.
   If it is unset, tell the user to invoke Rex Review from their agent inside Rex.
   Never substitute the focused pane or another session.
2. Run this from the agent session's shell tool:

   ```sh
   plannotator-tui rex review --block "$REX_BLOCK" --placement split
   ```

   This opens the Git worktree of the invoking pane and shows all uncommitted changes, including untracked files, not just that agent's edits.
   If the user specifies a base, commit, or staged/unstaged scope, add the matching `--base REF`, `--commit SHA`, `--staged`, or `--unstaged` option.
   If they explicitly ask for the latest assistant reply rather than code, use `plannotator-tui rex last --block "$REX_BLOCK" --placement split` before emitting a new reply.
3. On success, report that the review opened to the right and return without waiting for feedback.
   On failure, report the launcher error instead of opening a browser, switching panes, or silently choosing a different diff.
