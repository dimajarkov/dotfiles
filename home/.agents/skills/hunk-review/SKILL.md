---
name: hunk-review
description: Use for live Hunk session inspection, navigation, comments, highlights, and interactive diff review.
---

# Hunk review

Use this skill for live-session inspection and interactive diff review in Hunk.

Before acting, run `hunk skill path hunk-review` in the current environment.
Read the entire `SKILL.md` at the returned path before using Hunk.
Follow that file as the authoritative instructions for the installed Hunk.
Resolve the path on every invocation so upgrades use the current bundled instructions.
If the command fails or the returned file is unreadable, stop and report the failure.
Do not substitute a repository checkout, copied instructions, or a guessed CLI.
