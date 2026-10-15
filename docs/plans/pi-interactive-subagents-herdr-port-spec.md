# Port upstream Pi interactive subagents to Herdr

Kind: spec
Status: ready-for-agent

## Problem Statement

Dmitri wants the interactive subagent experience provided by HazAT's Pi extension in his existing Herdr-based terminal environment.
Upstream does not support Herdr, and the previously specified custom subagent architecture adds capabilities and lifecycle requirements he does not want for this replacement.
The Amos tmux-only fork is not the desired behavioral baseline.
Upstream's Anthropic presets and Chrome-CDP visual-testing instructions also conflict with the requested OpenAI models and approved local browser policy.

## Solution

Maintain a personal fork of HazAT's extension that adds Herdr support while preserving upstream tools, workflows, widgets, context modes, interactive takeover, help requests, and completion behavior.
Use Pi children with the requested OpenAI role models at medium thinking.
Adapt visual testing to the approved browser route rather than enabling personal Chrome debugging.
Install an immutable fork revision declaratively through dotfiles and teach the upstream interface through the local subagents skill.
Do not bring forward the larger custom native-Pi/Codex architecture.

The initial upstream reference is commit `c100577ebf7393a11d098ad9810ec6c269dcfc30` of `HazAT/pi-interactive-subagents`.
The intended maintained fork is `dimajarkov/pi-interactive-subagents`.
“Upstream parity” means parity with this pinned baseline, subject only to the explicitly approved Herdr, model, browser-policy, and configuration adaptations.

## User Stories

1. As a Pi user in Herdr, I want to spawn an interactive child without switching terminal multiplexers, so that delegation fits my existing environment.
2. As a parent-session user, I want spawning to return immediately, so that I can continue useful work while a child runs.
3. As a parent-session user, I want several children to execute concurrently, so that independent tasks can proceed in parallel.
4. As a Herdr user, I want child panes created relative to the calling parent, so that another client's focused pane does not determine placement.
5. As a Herdr user, I want background creation to preserve keyboard focus, so that delegation does not interrupt typing.
6. As a child-session user, I want the intended working directory, so that project resources and commands operate in the correct context.
7. As a Herdr user, I want child names and workflow-phase titles on the relevant pane, so that I can identify work without unrelated shared titles changing.
8. As a child-session user, I want to enter the actual native Pi interface through ordinary Herdr navigation, so that I can converse with the running child directly.
9. As a child-session user, I want normal Pi keys, paste, Unicode, and resize behavior, so that interacting with a child feels like interacting with Pi.
10. As a child-session user, I want human input to disable autonomous auto-exit as upstream specifies, so that the child does not disappear during interactive takeover.
11. As a parent-session user, I want the upstream status widget and activity labels, so that I can observe progress without entering each pane.
12. As a parent-session user, I want autonomous stall and recovery notifications with upstream interactive suppression, so that supervision does not create unnecessary parent turns.
13. As a parent agent, I want each child result delivered asynchronously, so that I can incorporate it while retaining my own working context.
14. As a parent-session user, I want expandable completion messages and native session references, so that I can inspect more detail when needed.
15. As a child-session user, I want the upstream child tools widget and toggle, so that I can inspect my available capabilities.
16. As a parent agent, I want turn-level interruption to leave a Pi child session alive, so that interrupted work can continue interactively.
17. As an autonomous child, I want upstream auto-exit and completion handling, so that completed work returns to the parent without a new custom finish protocol.
18. As an interactive child, I want the upstream explicit completion tool, so that I can return a final result when interactive work is finished.
19. As a child needing guidance, I want the upstream help-request tool, so that the parent can receive my question and resume me with an answer.
20. As a parent agent, I want resume to continue an existing native session with upstream options, so that follow-up work retains the child's conversation.
21. As a user, I want standalone, lineage-only, and fork context modes, so that I can choose fresh context, discoverable ancestry, or copied conversation context.
22. As a user, I want `/iterate` to retain its upstream full-context fork behavior, so that quick fixes can be delegated without redesigning the workflow.
23. As a user, I want `/plan` to retain its investigation, interactive planning, execution, and review workflow, so that planning behaves like the upstream product I selected.
24. As a user, I want direct `/subagent` spawning, so that I can initiate delegation without inventing a new command surface.
25. As a parent agent, I want the upstream model-facing tools and schemas, so that documentation and effective delegation behavior agree.
26. As a user, I want planner, scout, worker, reviewer, and visual-tester roles, so that upstream specialist workflows remain available.
27. As a user, I want the planner to use `openai-codex/gpt-6-astra` at medium thinking, so that planning uses my chosen model and effort.
28. As a user, I want the other four roles to use `openai-codex/gpt-6.1-sol` at medium thinking, so that their defaults match my preferences.
29. As a user, I want unavailable requested models reported explicitly without substitution, so that I know which model actually performs the work.
30. As a user, I want all five specialist roles to run Pi, so that the extension remains the upstream Pi-child experience rather than a new multi-harness system.
31. As a user, I want no active Anthropic-backed presets or delegation routes in this configuration, so that the replacement uses my approved provider policy.
32. As a visual-testing user, I want the existing approved browser route and isolation rules, so that visual QA does not expose personal profiles or bypass capability policy.
33. As a visual-testing user, I want actual verified Computer Use capability, so that a model or role label does not falsely imply browser-control access.
34. As a custom-agent author, I want upstream project/global/bundled precedence and hidden-definition behavior, so that local overrides remain predictable.
35. As a custom-agent author, I want upstream tool, skill, model, cwd, interactive, and context options, so that existing agent customization remains useful.
36. As a custom-agent author, I want upstream nested-delegation controls, so that the selected upstream policy is not replaced with an unrelated blanket prohibition.
37. As a multiplexer user, I want existing cmux, tmux, zellij, and WezTerm support retained, so that adding Herdr does not unnecessarily diverge from upstream.
38. As a Herdr user, I want automatic Herdr selection and an explicit backend override, so that backend choice is predictable.
39. As a user, I want backend failures and incomplete launches reported honestly, so that a failed visible child is not silently replaced by another execution mode.
40. As a Herdr user, I want operations and cleanup limited to safely identified extension-owned children, so that unrelated panes or replacement occupants cannot receive input or be closed.
41. As a user, I want protected-close rejection, missing panes, and stale targets surfaced, so that failures do not become silent stranded waits or unsafe retries.
42. As a dotfiles maintainer, I want declarative installation pinned to an immutable fork revision, so that rollout and rollback are reproducible.
43. As a dotfiles maintainer, I want the previous custom extension left disabled and its obsolete skill replaced, so that competing tools and incorrect instructions do not coexist.
44. As a user, I want existing native session history preserved during replacement and rollback, so that changing extensions does not delete my conversations.
45. As a fork maintainer, I want a small Herdr compatibility boundary and deliberate upstream updates, so that upstream fixes remain practical to incorporate.
46. As a user, I want isolated real-terminal and behavioral regression evidence before deployment, so that a static code port is not mistaken for a working interactive product.

## Implementation Decisions

- Fork HazAT directly rather than rebuilding its removed functionality in the Amos fork.
- Preserve the pinned upstream extension's orchestration and session lifecycle instead of substituting the previous custom manager architecture.
- Add Herdr through the existing multiplexer boundary; keep the other backend implementations and explicit backend-selection behavior.
- Select Herdr automatically in Herdr unless an explicit supported-backend override takes precedence.
- Support `PI_SUBAGENT_MUX=herdr`; fail actionably when unavailable and never silently change backends after a failed Herdr operation.
- Use supported installed Herdr interfaces without patching Herdr or modifying its managed integration files.
- Create right splits from the calling parent's pane with explicit cwd and no focus stealing.
- Use caller context, returned opaque handles, and explicit targets rather than focused-pane defaults or predicted identifiers.
- Map pane creation, shell-command submission, turn interruption, terminal reads, pane naming, and protected closure through the Herdr adapter.
- Preserve upstream long-command scripts, shell handling, and readiness configuration unless a supported readiness mechanism replaces them without changing the experience.
- Present child and planning-phase names on relevant panes; do not rename unrelated shared tabs or workspaces.
- Keep ordinary Herdr navigation and native Pi keys; do not add automatic zoom, reserved return keys, global rearrangement, or a new admission policy.
- Report a layout or zoom limitation if creation cannot preserve the promised non-disruptive presentation.
- Keep native session history, upstream activity snapshots, and upstream completion/help/error signals authoritative for their respective purposes.
- Do not use Herdr `idle` or `done` as proof that the assigned child task finished.
- Preserve upstream tools `subagent`, `subagent_interrupt`, `subagents_list`, and `subagent_resume`, together with child-only `caller_ping` and `subagent_done`.
- Preserve upstream commands `/plan`, `/iterate`, and `/subagent`, customization, widgets, context modes, nested-delegation controls, async notifications, and human takeover disabling auto-exit.
- Verify source behavior as well as README claims, including the child completion surface omitted from the README's introductory tool count.
- Configure the planner as `openai-codex/gpt-6-astra` with `medium` thinking.
- Configure reviewer, scout, visual tester, and worker as `openai-codex/gpt-6.1-sol` with `medium` thinking.
- Leave parent global model and reasoning defaults unchanged.
- Treat Pi execution for all five roles as an explicit extension-specific exception to existing native-Codex planning and long-running-work routing.
- Do not activate Anthropic models or presets; account for the bundled `claude-code` definition so it does not expose an active Anthropic delegation route in the local configuration.
- Generic upstream compatibility code need not be removed to enforce local provider policy.
- Adapt visual-tester instructions and skill dependencies to approved browser routing, including Codex Computer Use for end-user visual QA and required profile/account containment.
- Verify that the Pi visual tester can invoke the approved Computer Use route while retaining its Pi conversation and upstream coordination.
- Report an unavailable Computer Use route as a blocker, not permission for personal Chrome debugging, prohibited CDP fallback, or a new general native-Codex backend.
- Keep implementation in a separate personal fork and install an immutable revision through established declarative dotfiles mechanisms.
- Leave the old custom extension disabled; update and activate the replacement subagents skill together with the new extension.
- Check existing extension commands and shortcuts for registration conflicts before deployment.
- Preserve native session archives and unrelated configuration, credentials, project files, and worktrees.
- On startup or targeting failure, retain diagnostics, clean up only safely identified owned resources, and do not guess a moved or replaced target.
- Keep public repositories free of private runtime evidence and credential material.

## Testing Decisions

Prefer one existing high-level seam: the upstream extension's public tools and commands driving real child Pi interfaces through its existing multiplexer boundary.
Use the existing upstream multiplexer-surface and child-lifecycle integration harnesses as prior art rather than introducing a second orchestration test architecture.
Supporting deterministic adapter tests may stub Herdr process execution to exercise error parsing and target selection, but mocked commands alone do not establish end-user parity.

Good tests assert observable behavior, input/output contracts, native session continuity, focus, effective settings, and owned-resource effects rather than private helper names, implementation topology, or incidental command ordering.
Run real-terminal proofs in task-owned disposable Herdr sessions and isolated configuration, not existing user panes or the live extension path.
Use approved OpenAI models for model-backed acceptance tests.

Required behavioral coverage:

- Nonblocking spawn, concurrent parent work, parallel independent children, and independent result delivery.
- Caller-relative right splits, explicit cwd, names, phase titles, command targeting, and preserved keyboard focus.
- Human takeover disabling auto-exit, explicit completion, autonomous completion, errors, help requests, and continuation of the same native session through resume.
- Turn interruption leaving the child alive, with subsequent interactive work and completion still functioning.
- Standalone, lineage-only, and fork modes, including `/iterate` and the complete `/plan` pipeline.
- Effective role models and medium thinking, unavailable-model errors, custom-definition precedence, hidden definitions, tool controls, skills, and nested delegation.
- Parent and child widgets, completion expansion, ordinary typing, Unicode, paste, terminal resize, and native key behavior on the supported terminal stack.
- Backend override and detection, malformed Herdr responses, unavailable backends, partial startup, missing panes, moved/stale targets, replacement occupants, protected-close rejection, and cleanup failures.
- No unrelated pane receives input, focus changes, renaming, or closure during owned-child operations.
- Available existing-backend regressions, with unavailable real-backend evidence disclosed rather than presented as passing.
- Actual approved Computer Use invocation and browser containment for the visual-tester role, including Zen-specific evidence when Zen acceptance is requested.
- Agreement between skill instructions, emitted prompts, registered tools, agent presets, and effective runtime behavior.
- Compatibility with the current installed Pi runtime, typechecking, lint/format checks, and relevant regression suites.
- Declarative pinned installation and rollback without deleting native conversation history or unrelated user work.

Use approved Computer Use for end-user visual and physical-key acceptance rather than treating synthetic terminal input as complete rendered/native proof.
Keep deterministic lifecycle and adapter tests alongside that evidence.

Dmitri confirmed this testing seam before requesting ticket decomposition.

## Out of Scope

- The Amos fork as the implementation foundation.
- The previous custom native-Pi/Codex architecture, native Codex children, and a new multi-harness backend.
- A custom `/subagents` dashboard, compatibility aliases for old custom tools, or parallel orchestration systems.
- Durable controller recovery, master-crash survival, a four-run admission service, private-aside lifecycle, visit holds, custom finish requests, or original-master return shortcuts from the previous specification.
- New concurrency policies, automatic zoom, global layout rearrangement, overflow topology, or the Amos fork's equal-column rebalancing.
- General Herdr changes, personal browser debugging, provider migrations, and unrelated Pi configuration changes.
- Automatic upstream upgrades, deletion of session archives, or worktree cleanup.
- Additional functionality absent from the pinned baseline unless explicitly approved as necessary compatibility work.

## Further Notes

Dmitri confirmed the consolidated product specification after interview decisions Q1-11.
This direction replaces the previous approved custom implementation plan; historical specifications and tickets remain unchanged until separately reconciled.
Do not silently close, relabel, or rewrite those issues as part of publishing this replacement spec.

There are two explicit deployment gates.
The verified local Pi model listing contains the requested `gpt-6-astra` and `gpt-6.1-sol`.
Model availability is established; actual planner execution with medium thinking still requires verification.
Keep the requested planner model and block deployment until its actual execution at medium thinking is verified.
Do not silently substitute another planner model.
The Pi visual-tester role's approved Computer Use route must also be demonstrated; an OpenAI model selection does not itself grant Computer Use.
Neither gate may be weakened to claim deployment readiness.

The `ready-for-agent` status describes specification readiness, not proof that deployment prerequisites already pass.
Document validation results, the deployed immutable revision, known upstream limitations, and rollback instructions.
Report material upstream documentation/source differences or current-runtime incompatibilities separately rather than extending scope silently.

Publishing this spec does not authorize implementation, fork creation, live proofs, deployment, commits, or pushes.
