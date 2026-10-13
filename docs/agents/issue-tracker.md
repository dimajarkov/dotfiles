# Issue tracker: GitHub

Issues and tickets live in GitHub Issues for `dimajarkov/dotfiles`.
Use `gh-axi` for GitHub operations, following its installed skill.

## Conventions

- Publishing a ticket means creating a GitHub issue.
- Read the full issue body, comments, and labels when fetching a ticket.
- Publish approved tickets in dependency order.
- Use GitHub native blocking relationships when available.
- Otherwise, list blocking issue references in the ticket's Blocked by section.
- Use the triage labels defined in `docs/agents/triage-labels.md`.

## Issue kinds

| Kind | GitHub label | Meaning |
| --- | --- | --- |
| spec | spec | Specification describing desired outcomes, requirements, and acceptance |
| ticket | ticket | Implementation slice derived from a spec or plan |

These kind labels are additive to category, triage, readiness, and all other labels.
Kind is independent of readiness, issue closure, blocking dependencies, and acceptance.

Classify new issues with at most one configured kind.
Do not silently retag or retriage existing issues.
If an issue has a conflicting classification, preserve it, defer that issue's classification, and report the conflict for maintainer decision.

When tickets derive from an explicitly identified source spec issue, use GitHub's native sub-issue relationship independently of blocking dependencies.
Do not infer the source spec from a blocker, title, or generic map or parent.
Leave its body, state, and labels unchanged, and do not close it.
Native child attachment is the sole permitted parent-side relationship change.

When kind mappings are absent from a repository's tracker configuration, use the literal defaults `spec` and `ticket`.
Before applying a configured or default kind label, ensure its label definition exists.
If missing, create only that kind definition through tracker-supported tools when authorized in the publishing scope; otherwise report the exact permission or capability blocker and defer publishing rather than omit kind classification.

## Pull requests as a triage surface

**PRs as a request surface: no.**
