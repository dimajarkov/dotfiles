---
name: hunk-extensions
description: Use when writing, debugging, installing, or customizing Hunk extensions, not for ordinary diff review.
---

# Hunk extensions

Use this skill only for Hunk extension work, not ordinary diff review.

Before acting, run `hunk skill path hunk-extensions` in the current environment.
Read the entire `SKILL.md` at the returned path before working on extensions.
Follow that file as the authoritative instructions for the installed Hunk.
Resolve the path on every invocation so upgrades use the current bundled instructions.
If the command fails or the returned file is unreadable, stop and report the failure.
Do not substitute a repository checkout, copied instructions, or a guessed CLI.
