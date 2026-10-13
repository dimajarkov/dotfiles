---
name: to-tickets
description: Break a plan, spec, or the current conversation into a set of tracer-bullet tickets, each declaring its blocking edges, published to the configured tracker (edges as text in one file per ticket locally, or native blocking links on a real tracker).
disable-model-invocation: true
---

# To Tickets

Break a plan, spec, or conversation into a set of **tickets**: tracer-bullet vertical slices, each declaring the tickets that **block** it.
A ticket kind means an implementation slice derived from a spec or plan and is independent of triage state and readiness.

The issue tracker should have been configured.
Read issue-kind mappings and tracker publishing rules from `docs/agents/issue-tracker.md`, plus triage-role mappings from `docs/agents/triage-labels.md` when present.
If the tracker is not configured, tell the user to run `/setup-matt-pocock-skills`.
When no issue-kind mapping is recorded, use literal defaults `spec` and `ticket` without rerunning setup.
When no triage-role mapping is present, use the default `ready-for-agent` role.

## Process

### 1. Gather context

Work from whatever is already in the conversation context.
If the user passes a reference (a spec path, an issue number or URL) as an argument, fetch it and read its full body and comments.
Treat an issue as the source spec only when that specific spec issue is explicitly identified.
Do not infer it from a blocker, title, or generic parent or map.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state of the code. Ticket titles and descriptions should use the project's domain glossary vocabulary, and respect ADRs in the area you're touching.

Look for opportunities to prefactor the code to make the implementation easier. "Make the change easy, then make the easy change."

### 3. Draft vertical slices

Break the work into **tracer bullet** tickets.

<vertical-slice-rules>

- Each slice cuts a narrow but COMPLETE path through every layer (schema, API, UI, tests): vertical, NOT a horizontal slice of one layer
- A completed slice is demoable or verifiable on its own
- Each slice is sized to fit in a single fresh context window
- Any prefactoring should be done first

</vertical-slice-rules>

Give each ticket its **blocking edges**: the other tickets that must complete before it can start. A ticket with no blockers can start immediately.

**Wide refactors are the exception to vertical slicing.** A **wide refactor** is one mechanical change (rename a column, retype a shared symbol) whose **blast radius** fans across the whole codebase, so a single edit breaks thousands of call sites at once and no vertical slice can land green. Don't force it into a tracer bullet; sequence it as **expand–contract**. First expand: add the new form beside the old so nothing breaks. Then migrate the call sites over in batches sized by blast radius (per package, per directory), each batch its own ticket blocked by the expand, keeping CI green batch to batch because the old form still exists. Finally contract: delete the old form once no caller remains, in a ticket blocked by every migrate batch. When even the batches can't stay green alone, keep the sequence but let them share an integration branch that all block a final integrate-and-verify ticket; green is promised only there.

### 4. Quiz the user

Present the proposed breakdown as a numbered list. For each ticket, show:

- **Title**: short descriptive name
- **Blocked by**: which other tickets (if any) must complete first
- **What it delivers**: the end-to-end behaviour this ticket makes work

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the blocking edges correct: does each ticket only depend on tickets that genuinely gate it?
- Should any tickets be merged or split further?

Iterate until the user approves the breakdown.

### 5. Publish the tickets to the configured tracker

Use the issue-kind mapping read from `docs/agents/issue-tracker.md`, or the literal defaults `spec` and `ticket` when no mapping is recorded.
For each published ticket, apply exactly one configured `ticket` kind additively alongside the configured `ready-for-agent` triage role (default `ready-for-agent`).
Preserve all existing labels on label-based trackers.
If a target issue has a conflicting kind, leave its kind labels unchanged, defer that issue's classification, and report the conflict for maintainer decision.
On label-based trackers, ensure the selected configured or default kind-label definition exists before publishing.
If it is missing, create only that definition with tracker-supported tools when authorized in the publishing scope; otherwise report the exact permission or capability blocker and defer publishing rather than omit kind classification.

Publish the approved tickets.
**How** depends on the tracker `/setup-matt-pocock-skills` configured; the tickets are the same either way, only the shape of the blocking edges changes:

- **Local files** → write one file per ticket under `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01` in dependency order (blockers first).
  Each file's "Blocked by" lists the numbers/titles it depends on.
  Use the per-ticket file template below: one ticket per file, never a single combined file.
  Include the configured `Kind: ticket` value and preserve the separate configured `Status: ready-for-agent` value, along with existing numbering and dependency conventions.
- **A real issue tracker (GitHub, Linear, …)** → publish one issue per ticket in dependency order (blockers first) so each ticket's blocking edges can reference real identifiers.
  Use native blocking relationships where supported; otherwise set each ticket's "Blocked by" to its blocking issues.

Work the **frontier**: any ticket whose blockers are all done.
For a purely linear chain that means top to bottom.

When an explicitly identified source spec issue exists, attach each ticket as its native child where the tracker supports that hierarchy, independently of blocking edges.
Do not infer the source spec from a blocker, title, or generic parent or map.
Leave the source spec's body, state, and labels unchanged, and do not close it.
Native child attachment is the sole permitted parent-side relationship change.
If issue creation succeeds but native child attachment fails, report partial publication with the issue ID and retain it for an attachment-only retry instead of claiming success or recreating the issue.

<local-ticket-template>

# <NN>: <Ticket title>

**What to build:** the end-to-end behaviour this ticket makes work, from the user's perspective, not a layer-by-layer implementation list.

**Blocked by:** the numbers/titles of the tickets that gate this one, or "None (can start immediately)".

Kind: ticket

**Status:** ready-for-agent

- [ ] Acceptance criterion 1
- [ ] Acceptance criterion 2

</local-ticket-template>

<issue-template>

## Parent

A reference to the explicitly identified source spec issue, if one exists.
Do not use a blocker or generic parent or map.
This reference does not replace a native parent/child relationship where supported.

## What to build

The end-to-end behaviour this ticket makes work, from the user's perspective, not layer-by-layer implementation.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2

## Blocked by

- A reference to each blocking ticket, or "None (can start immediately)".

</issue-template>

In either form, avoid specific file paths or code snippets: they go stale fast. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it and note briefly that it came from a prototype. Trim to the decision-rich parts, not a working demo, just the important bits.
