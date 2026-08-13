# Prime Agent streaming UI research

Research date: 2026-08-13.

Prime Agent source revision: [`7787f07415d843b9a800f6a4720e0c739bd608e5`](https://github.com/PrimeIntellect-ai/prime-agent/tree/7787f07415d843b9a800f6a4720e0c739bd608e5).

Pi version inspected: 0.84.1 from `/nix/store/klkwpkrr0g3gr521brsdkl2fmdw32jvp-pi-coding-agent-0.84.1`.

This report uses Prime Agent and Pi source code as the primary evidence.

## Executive finding

Prime Agent's appearance is not just a color theme.

Its quality comes from a coordinated rendering model:

1. Assistant text, reasoning, tool arguments, and tool results update stable components in place.
2. Tool activity defaults to dense one-line summaries and expands only when detail is requested.
3. Tool results remain attached to the corresponding tool call instead of becoming separate transcript blocks.
4. Rendering requests are coalesced to a 16 ms frame budget.
5. Only changed terminal rows are written, and writes use synchronized-output terminal controls.
6. The Prime palette uses quiet surfaces, muted metadata, restrained success and error colors, and stable status glyphs.

Pi 0.84.1 already provides a strong enough renderer for smooth terminal updates and supports collapsed built-in tool renderers.

A global extension can closely reproduce Prime's tool-call appearance, diamond working animation, editor, theme, and several message surfaces.

A global extension cannot faithfully replace Pi's assistant streaming component, create independent expansion domains, expose per-row transcript focus, or preserve the viewport during every expansion operation.

Exact parity therefore requires a small Pi core patch or new extension APIs.

## Prime Agent's streaming path

Prime normalizes provider streams into text, thinking, and tool-call events in [`packages/ai/src/types.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/7787f07415d843b9a800f6a4720e0c739bd608e5/packages/ai/src/types.ts#L172-L291).

The agent loop converts those provider events into message and tool-execution lifecycle events in [`packages/agent/src/agent-loop.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/7787f07415d843b9a800f6a4720e0c739bd608e5/packages/agent/src/agent-loop.ts#L467-L986).

The interactive mode serializes those events before mutating visible state in [`interactive-mode.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/7787f07415d843b9a800f6a4720e0c739bd608e5/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L5072-L5115).

Its central UI state machine handles assistant updates, streamed tool arguments, partial results, completion, retries, and compaction in [`interactive-mode.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/7787f07415d843b9a800f6a4720e0c739bd608e5/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L5312-L5718).

A growing assistant message is reconciled into one existing `AssistantMessageComponent` rather than appended as new rows.

A growing tool call similarly updates one existing `ToolExecutionComponent` from queued, to running, to done or error.

## Why assistant text streams cleanly

Prime's assistant component keeps stable child components and performs lazy structural reconciliation in [`assistant-message.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/7787f07415d843b9a800f6a4720e0c739bd608e5/packages/coding-agent/src/modes/interactive/components/assistant-message.ts#L27-L367).

When content block structure is unchanged, only the changed Markdown child receives new text.

Prime's Markdown renderer caches completed top-level blocks while deliberately rerendering the mutable final block in [`packages/tui/src/components/markdown.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/7787f07415d843b9a800f6a4720e0c739bd608e5/packages/tui/src/components/markdown.ts#L182-L308).

This avoids reparsing and repainting a long completed response for every new token.

There is no fake typewriter animation.

Provider tokens become visible at provider cadence, bounded by the TUI frame coalescer.

## Tool rows and expansion

Prime's tool component owns queued, running, done, and error state, streamed arguments, streamed result state, renderer reuse, and expansion in [`tool-execution.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/7787f07415d843b9a800f6a4720e0c739bd608e5/packages/coding-agent/src/modes/interactive/components/tool-execution.ts#L70-L520).

Its generic panel is a full-width, padded, subtly filled surface implemented by [`tool-panel.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/7787f07415d843b9a800f6a4720e0c739bd608e5/packages/coding-agent/src/modes/interactive/components/tool-panel.ts#L1-L93).

The generic header follows this shape:

```text
<label> · queued
<label> · ◈ running
<label> · done
<label> · error
```

The primary IPython surface is even denser.

Its collapsed form is one stable physical row containing a status glyph, language, meaningful code preview, input and output line counts, duration, error name, and expansion hint.

The implementation is in [`ipython-cell.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/7787f07415d843b9a800f6a4720e0c739bd608e5/packages/coding-agent/src/modes/interactive/components/ipython-cell.ts#L345-L742).

A representative row is:

```text
✓ python · write src/app.ts · ↑ 4 lines · ↓ 2 lines · 12ms · (Ctrl+O to expand)
```

Expanded mode keeps the same summary row and appends source, output, traceback, diffs, and image metadata beneath it.

Only the latest tool displays the textual expand hint, which keeps repeated activity visually quiet.

Ctrl+O controls the global tool-output expansion state while preserving the viewport in [`interactive-mode.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/7787f07415d843b9a800f6a4720e0c739bd608e5/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L7243-L7303).

Thinking and agent-to-agent messages have separate expansion domains.

## Meaningful one-line summaries

Prime does not blindly display the first source line.

Its preview pipeline removes setup noise, folds whitespace, redacts likely secrets and large blobs, interprets heredocs, simplifies common shell and file operations, scores candidate lines by signal, and caps the result at 64 characters.

The implementation is in [`code-preview.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/7787f07415d843b9a800f6a4720e0c739bd608e5/packages/coding-agent/src/core/tools/code-preview.ts#L1-L442).

Prime's default model-facing surface exposes IPython rather than separate read, grep, edit, and bash tools.

The desired Pi adaptation should keep Pi's native tools and borrow only the summary grammar and visual treatment, as requested.

## Bash and diff details

Prime's model-invoked bash renderer keeps only the last five wrapped visual rows while collapsed, streams at most every 100 ms, and shows elapsed or total duration.

See [`bash.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/7787f07415d843b9a800f6a4720e0c739bd608e5/packages/coding-agent/src/core/tools/bash.ts#L154-L450).

The underlying result is bounded to 2,000 lines or 50 KB in [`truncate.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/7787f07415d843b9a800f6a4720e0c739bd608e5/packages/coding-agent/src/core/tools/truncate.ts#L1-L239).

Prime's edit renderer computes a preview after streamed arguments become complete, then updates the same component when execution settles.

This avoids a large diff disappearing and reappearing.

The edit renderer is in [`edit.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/7787f07415d843b9a800f6a4720e0c739bd608e5/packages/coding-agent/src/core/tools/edit.ts#L194-L493).

The rich diff component supports full-width added and removed rows, absolute line numbers, syntax highlighting, wrapped long lines, and 256-color fallback in [`diff.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/7787f07415d843b9a800f6a4720e0c739bd608e5/packages/coding-agent/src/modes/interactive/components/diff.ts#L5-L293).

## Status and animation

Prime derives Waiting, Thinking, Writing, Writing code, and Executing from stream events in [`agent-activity.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/7787f07415d843b9a800f6a4720e0c739bd608e5/packages/coding-agent/src/modes/interactive/agent-activity.ts#L1-L130).

Running tools share a synchronized diamond pulse:

```text
◇ → ◈ → ◆ → ◈
```

The pulse advances every 250 ms in [`working-icon.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/7787f07415d843b9a800f6a4720e0c739bd608e5/packages/coding-agent/src/modes/interactive/theme/working-icon.ts#L1-L21).

Completed states become static `✓` or `✗`, so status is not color-only.

The activity line combines the working indicator, activity label, elapsed time, and live token direction and count.

## Theme

Prime's exact palette is defined in [`prime.json`](https://github.com/PrimeIntellect-ai/prime-agent/blob/7787f07415d843b9a800f6a4720e0c739bd608e5/packages/coding-agent/src/modes/interactive/theme/prime.json#L1-L92).

Important values include:

- Page background: `#050506`.
- Tool panel: `#0d0d10`.
- General panel: `#151518`.
- Foreground: `#f4f4f5`.
- Muted: `#a1a1aa`.
- Dim: `#71717a`.
- Success: `#7da876`.
- Warning: `#f59e0b`.
- Error: `#d06f82`.
- Primary accent: `#7c6faf`.

The current Pi harness already has a close Pi-compatible copy at `home/.pi/agent/themes/prime.json`.

## Flicker prevention

Prime's TUI coalesces render requests to a minimum 16 ms frame interval in [`packages/tui/src/tui.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/7787f07415d843b9a800f6a4720e0c739bd608e5/packages/tui/src/tui.ts#L632-L674).

The final renderer compares the new frame to the old frame and writes only changed lines in [`packages/tui/src/tui.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/7787f07415d843b9a800f6a4720e0c739bd608e5/packages/tui/src/tui.ts#L1477-L1945).

Writes are wrapped in CSI 2026 synchronized-output controls where supported.

The renderer also has special handling for changes above the viewport, which prevents a late tool result from replaying and flickering the visible transcript.

Dedicated regressions cover expansion viewport preservation and attach-then-stream flicker in [`packages/tui/test/tui-render.test.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/7787f07415d843b9a800f6a4720e0c739bd608e5/packages/tui/test/tui-render.test.ts#L650-L908).

## Pi 0.84.1 feasibility

Pi's built-in `ToolExecutionComponent` already supports partial updates, global expansion, persistent renderer state, renderer component reuse, and per-slot fallback to built-in renderers.

The relevant implementation is `/nix/store/klkwpkrr0g3gr521brsdkl2fmdw32jvp-pi-coding-agent-0.84.1/lib/pi-coding-agent/packages/coding-agent/src/modes/interactive/components/tool-execution.ts`.

A global extension can replace a built-in tool definition with the exact factory-produced definition and override only `renderCall`, `renderResult`, or `renderShell`.

Pi has no rendering-only `registerToolRenderer(name, renderer)` API, so this must be done carefully to avoid stealing execution ownership from project-specific tool overrides.

### Extension-only capabilities

- Prime-style renderers for Pi's read, bash, grep, find, edit, write, and other built-in tools.
- One-line collapsed summaries with native Ctrl+O expansion.
- Partial result and running-state rendering.
- Diamond working animation through `ctx.ui.setWorkingIndicator()`.
- Prime theme, editor, footer, and owned custom-message renderers.
- Native fullscreen transcript search, prompt jumps, page and line navigation.

### Core changes needed for exact parity

- A rendering-only tool override API.
- Assistant and reasoning renderer hooks with stable streaming component reuse.
- Independent expansion domains for tools, thinking, and agent messages.
- Transcript-controller access for per-row selection, focus, scrolling, and viewport-preserving updates.
- Tool-neighbor metadata so only the latest row displays an expansion hint.
- Public activity and live token metrics for the working line.
- A dedicated stable tool-panel theme token.

## Current Pi harness audit

The current visual work is split across several owners:

- `home/.pi/agent/themes/prime.json` supplies a close Prime palette.
- `home/.pi/agent/extensions/prime-style.ts` supplies a filled editor and also selects the theme.
- `home/.pi/agent/extensions/status-line.ts` replaces the footer with a two-row model, cost, path, branch, and context display.
- `home/.pi/agent/extensions/mac-system-theme.ts` redundantly selects Prime and makes its adaptive Catppuccin behavior unreachable while Prime exists.
- `home/.pi/agent/extensions/terminal-status-title.js` supplies a separate terminal-tab activity affordance.
- `home/.pi/agent/extensions/prime-parity.ts` concerns continual harness refinement rather than visual parity.

The active files are Home Manager links into the Nix store.

Implementation should modify the authoritative dotfiles sources and deploy through Home Manager rather than editing `~/.pi/agent` links.

The current checkout already contains substantial unrelated work.

Implementation should therefore use a dedicated Treehouse-leased feature worktree as required by the user's repository workflow.

## Recommended direction

Use a Prime-faithful visual language with Pi-native tool semantics.

Consolidate visual ownership into one tested `prime-style` extension package and one theme.

Implement the high-value extension-compatible surface first, but allow a small, explicit Pi core patch where extension APIs cannot provide the requested interaction quality.

Do not import Prime's Python or replace Pi's tool model with IPython.

Do not fake activity or token metrics that Pi cannot expose reliably.

The remaining product decisions are presented in the associated Lavish scope grill.
