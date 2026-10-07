# Local AI review feedback from LazyGit

Research checked on 2026-10-06 against primary documentation and upstream source.
The locally installed LazyGit version is 0.61.1.
No review tools were installed, no review sessions were launched, and no LazyGit configuration was changed.
The integrations below are documented capabilities or proposed designs, not end-to-end-tested local integrations.

## Conclusion

LazyGit does not currently provide the supported Plannotator-style inline-comment and agent-feedback surface requested here.
An [open upstream feature request, #5632](https://github.com/jesseduffield/lazygit/issues/5632), describes almost exactly this workflow: reviewing AI-generated changes in LazyGit, leaving local line comments, and exporting the feedback to an agent.
The maintainer's replies in that issue discuss the missing diff selection and the difficulty of mapping pager output back to source lines.

Existing terminal reviewers can be launched using a LazyGit custom command and return to LazyGit when they exit.
This keeps LazyGit as the Git interface and avoids a browser, but temporarily replaces its display with another TUI rather than adding annotations inside its existing diff pane.
LazyGit documents this suspension-and-return behavior for `output: terminal` in its [versioned custom-command guide](https://github.com/jesseduffield/lazygit/blob/v0.61.1/docs/Custom_Command_Keybindings.md).

## Existing tools

### tuicr: focused human review and agent-ready export

[tuicr](https://github.com/agavra/tuicr) supports line, range, file, and review comments, plus file/hunk review tracking.
Its README documents `c` for line comments, visual selection for range comments, and `y` to copy a numbered Markdown review with file/line anchors.
It also supports stdout export and a persisted-session CLI for agent/script integrations.
These capabilities closely match the human-comments-to-agent loop without requiring the AI provider to be built into the review tool.
Its documented `tuicr -w` invocation reviews uncommitted changes and could be launched from LazyGit with `output: terminal`.
A LazyGit-to-live-agent handoff would still need explicit wiring; launching the reviewer alone does not automatically deliver feedback to an existing agent conversation.

### Hunk: live collaboration with an agent

[Hunk's agent workflow](https://www.hunk.dev/docs/agents/review-with-an-agent/) documents a live review session accessible through noninteractive `hunk session` commands.
Its [annotation guide](https://www.hunk.dev/docs/agents/comments-and-annotations/) documents human notes with `c`, agent notes anchored to old/new lines or hunks, and `hunk session comment list --repo . --type all` for reading both human and agent notes.
This supports an agent inspecting comments while the reviewer remains in the live terminal session.
The documented `hunk diff` command could be launched from LazyGit as a terminal custom command.
That is a composition of documented commands, not an upstream-documented LazyGit-specific integration.
The live session should remain open when using the session API; do not assume a closed session stays accessible.

### Orbit: an explicitly documented LazyGit integration

[Orbit's README](https://github.com/Hoshock/orbit#lazygit-integration) includes LazyGit custom commands for working-tree, branch, and selected-commit reviews.
It supports line/range/file comments and exports a structured prompt to the clipboard.
It is a distinct review TUI, not an embedded LazyGit annotation plugin.
Its example bindings override existing `o` behavior, so a local implementation should choose bindings deliberately rather than copy them unchanged.

### Lumen: annotation export over stdout

[Lumen's README](https://github.com/jnsahaj/lumen#coding-agent-integrations-) documents selection, hunk, and file annotations, with `s` to exit and return the formatted annotations on stdout.
This provides another agent-feedback transport, but a LazyGit-launched process still needs a bridge to deliver that output to the intended agent session.
Do not rely on another project's comparison table to assess Lumen's annotation capabilities; its own documentation describes them.

## Strictly staying inside LazyGit

A small custom-command bridge could capture comments through LazyGit's own input prompts, save them locally, show pending feedback in a popup, and export an explicitly submitted batch to an agent.
That would be a new integration, not a ready-made native inline-review feature.
The [custom-command guide](https://github.com/jesseduffield/lazygit/blob/v0.61.1/docs/Custom_Command_Keybindings.md) supports prompts, file/commit templates, and popup output.
However, the [0.61.1 custom-command model](https://github.com/jesseduffield/lazygit/blob/v0.61.1/pkg/gui/services/custom_commands/models.go) does not expose a selected diff line or hunk through the documented selection objects.
A robust bridge should therefore use an explicit source-line target or a captured snippet plus the exact reviewed diff snapshot, and reject ambiguous matches.
Comments captured this way would not automatically appear as inline comment bubbles in the existing LazyGit diff pane.
True inline rendering and precise diff-cursor integration require upstream work or a maintained LazyGit code change.

## Recommendation

Try a LazyGit-launched tuicr workflow for human review and structured feedback export, or Hunk when live two-way agent annotations are the priority.
If never switching away from LazyGit's display is a strict requirement, first prototype native comment capture and explicit batch submission, while retaining the inline-rendering limitation.
Keep review feedback separate from source files and commits, retain the reviewed snapshot identity, and send comments only when the human explicitly requests agent changes.
