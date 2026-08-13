# Goal: implement and validate the confirmed Prime-style Pi conversation UI

You own this feature through validated completion.

Do not stop at research, planning, a prototype, partial renderer coverage, passing unit tests alone, or an undeployed worktree.

The goal is complete only when every completion gate below is satisfied, the visual result has received the required human approval, and the authoritative dotfiles configuration has been cut over safely.

## Authoritative context

Repository: `/Users/dmitrijarkov/dotfiles`.

Confirmed scope artifact: `/Users/dmitrijarkov/dotfiles/.lavish/prime-agent-ui-scope-grill.html`.

Research report: `/Users/dmitrijarkov/dotfiles/.lavish/prime-agent-ui-research.md`.

Prime Agent reference revision: `7787f07415d843b9a800f6a4720e0c739bd608e5`.

Installed Pi reference version: 0.84.1 under `/nix/store/klkwpkrr0g3gr521brsdkl2fmdw32jvp-pi-coding-agent-0.84.1`.

Read the final `#contract` section in the HTML artifact first.

That confirmed contract overrides earlier recommendations in the research report wherever they differ.

In particular, this implementation is extension-only and must not patch Pi core.

Read all applicable repository instructions and skills before acting.

The source checkout contains unrelated work, so preserve it exactly.

Follow the required Treehouse and Herdr feature-runtime policy before editing.

If the repository still lacks an authoritative allocator or readiness owner required by that policy, do not edit the busy main checkout or invent fake readiness.

Report the exact missing owner as a hard blocker and keep the goal open rather than claiming completion.

## Product contract

Build a faithful translation of Prime Agent's conversation UI into Pi-native semantics using only public Pi 0.84.1 extension APIs.

Do not import Prime's Python, replace Pi's native tool model with IPython, patch Pi core, depend on private transcript internals, duplicate assistant messages, synthesize an unreliable reasoning recap, or fabricate live token telemetry.

The primary quality target is pixel-perfect WezTerm truecolor behavior in both Pi inline and fullscreen modes.

Other modern terminals and 256-color environments must remain readable and usable.

### Ownership

Consolidate the editor, built-in tool presentation, normal working line, and footer into one tested Prime visual extension with one clear lifecycle owner.

Use one fixed Prime theme as the authoritative color owner.

Remove redundant active system-theme ownership while leaving manually selectable alternate theme files available.

Preserve the independent terminal-tab title integration unless evidence shows a conflict.

Do not change the continual-harness behavior in `prime-parity.ts` except where a narrowly necessary compatibility fix is proven and tested.

### Tool behavior

Override presentation only for exact Pi built-ins whose active source is still built-in.

Preserve every custom, MCP, sandboxed, SSH, audited, or project-owned tool definition and renderer.

Use the exact factory-produced built-in definitions and replace only supported render slots so execution, schemas, constraints, and upstream fixes remain intact.

Successful built-in tools collapse to one physical row.

Use `✓` for success, `✗` for error or abort, a static muted `◇` for queued work, and the synchronized `◇ ◈ ◆ ◈` pulse at 250 ms while running.

Use native global Ctrl+O for expansion.

Running output-producing tools show at most the latest five wrapped visual rows.

Successful completion collapses back to the one-line row.

A failed tool leaves its summary plus at most five wrapped diagnostic tail rows.

Expanded content shows the full result retained by Pi, including existing truncation notices.

Rows omit lower-priority fields from the right as width shrinks.

Implement this success-row contract:

- `read`: `✓ read · path · line range · duration`.
- `write`: `✓ write · path · line count · duration`.
- `edit`: `✓ edit · path · +N -N · duration`.
- `bash`: `✓ bash · meaningful command · exit code · duration`.
- `grep`: `✓ grep · pattern · scope · match count · duration`.
- `find`: `✓ find · glob · scope · path count · duration`.
- `ls`: `✓ ls · path · entry count · duration`.

Read content is hidden while collapsed and syntax-highlighted when expanded.

Written content is available when expanded.

Edit shows a bounded live diff while pending or running, collapses to the `+N -N` row on success, and retains useful diff or diagnostic context on failure.

Bash uses a meaningful, secret-safe command preview rather than blindly exposing raw multiline input.

Search and listing tools expose retained matches, paths, or entries only when expanded.

Timers, animation intervals, subscriptions, and cached components must be reused correctly and disposed on completion, reload, session replacement, and shutdown.

### Assistant, reasoning, and status

Keep Pi's native assistant streaming component and native Ctrl+T reasoning behavior.

Apply Prime's restrained reasoning and Markdown styling without duplicating stream content.

The normal working line uses the diamond pulse, an evidence-based phase label, and elapsed time.

Use labels such as Thinking, Writing, Executing, Waiting, or Working only when supported by observed lifecycle events.

Fall back to Working when phase evidence is ambiguous.

Keep Pi-native retry, compaction, and branch-summary loaders, recolored through the Prime theme.

The custom normal working line must yield cleanly when Pi owns an exceptional loader.

### Editor and footer

Preserve Pi's real editor, cursor, IME, autocomplete, keybindings, and abort behavior.

Retain the Prime filled-surface appearance, but replace brittle assumptions with tested width-safe rendering wherever the public API allows it.

The footer is responsive and two rows at ordinary widths.

Row one prioritizes working directory and Git branch.

Row two prioritizes model, thinking level, cost or subscription marker, context usage, and extension statuses.

Render `footerData.getExtensionStatuses()` so statuses from extensions such as Supabase remain visible.

Define deterministic omission and truncation priorities for narrow terminals.

Install the footer once per session, update state reactively, and dispose subscriptions exactly once.

### Explicit accepted divergences

Exact Prime parity is not required for individually selectable transcript rows, independent expansion domains, Prime's evolving one-line reasoning recap, Prime's retry and compaction component layout, custom or MCP tools with owner-provided renderers, model pickers, session tree, settings, or unrelated overlays.

Do not expand scope into those surfaces unless an observed defect prevents the confirmed conversation UI from working.

## Execution sequence

1. Establish a clean, durably leased feature checkout without touching unrelated main-checkout changes.
2. Reproduce and record the current end-user UI in real Pi before editing, including current tool density and the hidden-extension-status footer defect.
3. Inspect all current visual extensions, Home Manager ownership, Pi extension APIs, built-in tool detail types, renderer tests, and the pinned Prime source paths cited by the research.
4. Write a concrete implementation and test plan mapped to every completion gate.
5. Implement the consolidated extension and theme migration in authoritative dotfiles sources.
6. Add deterministic renderer, lifecycle, width, truncation, and ownership tests.
7. Run repository validation and the no-mistakes validation workflow, adapting it to repository policy and never pushing or opening a PR without explicit authorization.
8. Launch real Pi E2E sessions and capture the required inline and fullscreen evidence.
9. Use Lavish to present before-and-after captures and the acceptance matrix for human visual review.
10. Apply every queued visual correction and repeat the relevant tests and captures until approval is explicit.
11. After approval, perform the atomic Home Manager cutover, verify the active symlinks resolve to the intended generation, reload or restart Pi as required, and run a final live smoke test from the deployed configuration.
12. Record the previous Home Manager generation and exact rollback command without executing rollback.
13. Reinspect Git state so unrelated pre-existing changes are neither overwritten nor included in this feature.

## Completion gates

The feature is complete only when all of these are true:

### Scope and ownership gates

- One authoritative visual extension owns editor, built-in rendering, normal working status, and footer lifecycle.
- One fixed Prime theme owns active colors.
- Redundant active `mac-system-theme` and standalone footer ownership are removed from Home Manager configuration.
- Alternate theme files remain manually available.
- `prime-parity.ts` behavior and terminal-tab title behavior are preserved unless separately proven and documented.
- Non-built-in tool execution ownership is demonstrably unchanged.

### Renderer gates

- All seven Pi built-ins satisfy the confirmed collapsed success-row contract.
- Queued, running, success, error, abort, partial-result, expanded, and narrow-width states are covered.
- Bash live output and failure tails are measured in wrapped visual rows and capped at five.
- Edit live diff, success collapse, and failure context work as specified.
- Long paths, wide Unicode, ANSI sequences, multiline commands, empty outputs, truncated outputs, and secret-like command values render safely.
- Every rendered line stays within the supplied terminal width.
- Ctrl+O and Ctrl+T retain native behavior.

### Lifecycle gates

- Working animation, elapsed time, phase fallback, retries, compaction, reload, new session, resume, fork, abort, and shutdown do not leave stale timers, duplicated widgets, duplicate footers, or contradictory statuses.
- Footer branch and extension-status updates rerender without reinstall churn.
- The editor preserves cursor placement, IME markers, autocomplete, multiline input, scrolling, keybindings, and narrow-width fallback.

### Automated validation gates

- Project formatting and linting pass using the repository-owned toolchain.
- All existing relevant tests pass.
- New tests cover renderer snapshots at representative narrow, normal, and wide widths.
- New tests cover tool source ownership and prove custom or MCP definitions are not replaced.
- New tests cover cleanup and session lifecycle transitions.
- Nix flake checks and dry-run builds required by the repository pass without applying the system configuration prematurely.
- No unrelated pre-existing failure is ignored.

### Real terminal gates

- Real Pi E2E evidence exists for WezTerm inline and fullscreen modes.
- Evidence includes read, write, edit, bash, grep, find, and ls success rows.
- Evidence includes parallel or adjacent tool calls, long streaming assistant text, visible reasoning, Ctrl+O, Ctrl+T, a running bash tail, a failed tool, retry, compaction, long output, narrow width, and extension statuses.
- No obvious flicker, stale cells, viewport jump, horizontal overflow, clipped glyph, broken background fill, or duplicate status remains.
- Graceful smoke tests pass in every available secondary terminal mode or an explicit simulated 256-color environment.
- Human visual review through Lavish explicitly approves the final captures.

### Deployment and safety gates

- The change is atomically deployed through Home Manager only after visual approval.
- Active `~/.pi/agent` links resolve to the intended authoritative files or intended deployed generation.
- A fresh deployed Pi session loads the extension and theme without startup errors.
- The deployed final smoke test passes.
- The previous Home Manager generation and rollback command are reported.
- Git diff contains only intentional feature changes plus approved research or test artifacts.
- No generated changelog is edited.
- No commit, push, or PR occurs without explicit authorization.

## Stop rule

Do not declare completion while any gate is unproven, any visual review correction is pending, the implementation exists only in a worktree, or the deployed configuration has not passed its final smoke test.

When a hard external or policy blocker makes further progress impossible, stop only after preserving evidence and reporting the exact blocked gate, owner, command, and condition needed to resume.

A blocker report is not feature completion.

When all gates pass, report:

- changed authoritative files;
- architecture and accepted divergences;
- automated commands and results;
- E2E scenarios and visual-review approval;
- deployed generation and active-link proof;
- rollback generation and command;
- final Git status and any remaining risk.
