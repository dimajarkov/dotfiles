---
name: treehouse-herdr-feature-runtime
description: Start or hand off a feature from a repository source or main checkout into a durable Treehouse-leased worktree, a new Herdr workspace, a visible full local runtime, and a fresh Prime Agent. Use whenever Dmitri asks to create or start a feature, allocate a worktree, bring up that feature's runtime, or hand a new feature to an agent in Herdr. Also use when repairing this topology; do not allocate when the request is only review or an already healthy feature continuation.
compatibility: Requires treehouse, Herdr with HERDR_ENV=1, prime-agent, Python 3, and a project-owned Treehouse allocator plus runtime reference.
---

# Treehouse and Herdr feature runtime

Turn a source-checkout feature request into one durable checkout and one task-owned terminal workspace.
Treehouse owns reservation, Herdr owns placement, and the project's runtime metadata owns ports, services, and readiness.

## Route project behavior first

Read the nearest repository instructions and project reference for feature worktree creation, full-runtime launch, value-safe readiness, and cleanup.
Use the project's Treehouse-backed allocator rather than composing Git commands.
Pass project commands to `scripts/feature_runtime.py` as JSON string arrays so this skill never caches another repository's app list, ports, env policy, or health predicates.

If the project has no authoritative allocator or readiness command, stop and identify that missing owner.
A path, branch label, live process, or Herdr worktree helper is not an allocation substitute.

## Establish exact caller identity

Require `HERDR_ENV=1` and a named `HERDR_SESSION`.
Read `herdr --skill` and current command help because the installed CLI is authoritative.
Discover the initiating pane from live Herdr state and choose its opaque pane ID only when one live candidate unambiguously matches this agent and the canonical source-checkout cwd.
Pass that ID explicitly as `--caller-pane-id`; inherited Herdr IDs can be stale after pane moves.
Stop when identity is ambiguous.

Inspect Treehouse after allocation and require the exact realpath row to be `leased` with a non-empty lease ID and holder.
`in-use` is process detection only: it disappears with the processes and therefore cannot reserve a checkout for a long-lived runtime.

## Orchestrate

Invoke the bundled helper from this skill directory:

```bash
python3 scripts/feature_runtime.py \
  --caller-pane-id <live-caller-pane-id> \
  --source-checkout <canonical-source-checkout> \
  --feature-slug <kebab-slug> \
  --workspace-label <feature-label> \
  --create-command-json '<project allocator argv JSON>' \
  --runtime-command-json '<project full-runtime argv JSON>' \
  --readiness-command-json '<project readiness argv JSON>' \
  --handoff '<concise feature goal and validation contract>' \
  --agent-name <unique-agent-name> \
  --agent-goal-budget <bounded-budget> \
  --receipt <safe-receipt-path>
```

For an existing exact lease, replace `--create-command-json` with
`--existing-worktree <path> --metadata-path <path>` and pass the recorded
`--workspace-id`, `--expected-lease-id`, and `--expected-lease-holder` when
reusing Herdr topology.

The helper performs the state transitions in order:

1. Validate the explicit caller pane in the exact current named session.
2. Run the project allocator from the source checkout and parse the returned metadata path and worktree path.
3. Prove the exact canonical checkout has a durable Treehouse lease.
4. Create a new Herdr workspace in the same session with the leased checkout as cwd.
5. Name its root tab `feature-agent` and create exactly one `runtime` tab.
6. Start the project full runtime in the runtime tab with the project's visible-log options.
7. Wait for the project-owned readiness command, not a guessed port or process marker.
8. Start a fresh interactive `prime-agent` in the feature-agent tab with explicit leased cwd and bounded handoff goal.
9. Require Herdr to recognize that exact agent pane and foreground cwd, then write a mode-0600 receipt.

Every Herdr workspace, tab, and pane ID comes from command JSON.
A label is only presentation; never select globally by label, sidebar order, branch guess, or path guess.

## Refusal boundaries

Stop without adding competing state when any of these occurs:

- caller session, pane, workspace, or cwd is missing, stale, foreign, or ambiguous;
- the exact Treehouse row is not durably leased with identity and holder;
- allocator output or runtime metadata points at another physical checkout;
- the target workspace has more than one exact `runtime` tab;
- a reusable tab or pane has a foreign cwd or foreground process;
- runtime metadata, listeners, ports, or project readiness report foreign ownership;
- a fresh Prime Agent appears outside the recorded feature-agent pane or leased cwd.

Preserve failure evidence before cleanup.
Report exact conditional cleanup commands from the project reference, but leave the validation workspace, lease, runtime, and agent intact unless Dmitri explicitly authorizes destructive cleanup.

## Done

Report the global and project references used, committed heads, Treehouse path/holder/lease ID, Herdr session/workspace/tab/pane IDs, metadata-derived URLs, readiness receipt, agent identity/cwd, gates, residual risks, and non-executed cleanup commands.
Completion requires the lease, visible runtime, project readiness, and fresh agent to remain healthy at final inspection.
