---
name: refine
description: Queue continual harness refinement from IPython after a repeated failure, reusable tactic, delegation role, or behavior policy is observed.
---

# Refine

Automatic continual refinement review is enabled by default.
Pi reviews the trajectory after every 25 eligible assistant completions and after successful manual, threshold, or overflow-recovery compaction.
Assistant responses ending in an error or abort do not count toward the interval.
The review gate receives only the final 40,000 characters of the deterministic serialized conversation.
Only an approved review starts a separate refinement pass, which receives only the final 80,000 characters.
Automatic reviews may legitimately reject refinement and make no harness change.

Use this skill to queue an explicit, focused refinement request from the persistent IPython kernel.
The Pi host analyzes the current trajectory and persists only validated, evidence-backed harness edits.

```python
await refine.status()
await refine.run()
await refine.run("Always run the focused regression test before changing the parser")
await refine.run("Promote the review checklist to a global memory", global_=True)
```

Explicit refinement remains available with `/refine` and `await refine.run()`.
Refinement is deferred to a safe host lifecycle boundary so it never mutates the prompt or kernel state mid-cell.
The default scope is the current session.
Use `global_=True` or `/refine --global` only for a durable lesson that should be available in future sessions.
Failed or malformed curator responses do not fall back to saving instructions directly.
