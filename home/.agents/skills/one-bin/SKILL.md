---
name: one-bin
description: Use for machine-wide software changes, shell PATH or executable-ownership problems, and explicit software-ownership or package-manager migrations. Routine project dependencies and lockfile updates do not need this skill.
compatibility: macOS, Nix, Home Manager, Node.js, and the read-only one-bin CLI bundled with this skill.
---

# One Bin

Choose one authoritative owner for machine-wide software and verify what the user actually runs.
Routine project dependency work follows `~/AGENTS.md` and repository policy without loading this workflow.

## Workflow

1. Read repository instructions and only the applicable references below before changing ownership.
2. For CLI or PATH work, reproduce the user's command and run `one-bin audit exe <command>`.
   Inspect PATH order, canonical paths, versions, and current owners; a missing command is not proof that software is absent.
3. State the selected owner and its evidence; identify affected configuration, data, plugins, dependents, and services.
4. Apply changes through that owner; keep unrelated installations and lockfiles unchanged.
5. For executable changes, verify in a fresh shell: rerun the audit, check `command -v`, real path, version, and a user-facing smoke test.
6. For applications or services, verify normal launch or service health and configuration/data preservation.
7. Report the owner, changed files or lockfiles, verification results, unresolved duplicates, and remaining manual work.

## Guardrails

- Verify a replacement before retiring its old owner; PATH precedence alone does not resolve duplicate ownership.
- Obtain explicit cleanup approval before removing duplicates.
  Data-bearing software or software with unknown dependents also requires explicit removal approval and a verified recovery plan.
- Use verified packages or inspected sources; never pipe network content into a shell or use `sudo` as an ownership shortcut.

## Conditional references

- Nix or global CLI ownership: read [machine-wide tools](references/machine-wide.md).
- macOS application ownership: read [macOS applications](references/macos-apps.md).
- Explicit project-manager migration or conflicting manager evidence: read [project managers](references/project-managers.md).
- Uninstalling software or retiring an owner: read [removal safety](references/removal.md) before removal.

## Read-only audit CLI

`one-bin` never installs or removes software; use `one-bin --help` for available audits.
If its global link is unavailable, run `scripts/one-bin.mjs` from this skill directory instead.
