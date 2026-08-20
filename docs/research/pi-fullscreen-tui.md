# Pi fullscreen TUI research

Research was completed on 2026-08-20 against the installed Pi 0.84.1 snapshot, its tests, the upstream repository, issues, releases, the first-party Pi package gallery, and package source repositories.

## Conclusion

Pi 0.84.1 already provides the exact requested layout and navigation UX in core through its experimental fullscreen TUI, so no third-party extension or package is required.
The [v0.84.0 release](https://github.com/earendil-works/pi/releases/tag/v0.84.0) explicitly introduced a sticky editor, status, widget, and footer dock with an independently scrollable transcript.
The [v0.84.1 release](https://github.com/earendil-works/pi/releases/tag/v0.84.1) retained that core mode and added more fullscreen transcript controls.
Third-party packages named [`pi-fullscreen`](https://pi.dev/packages/pi-fullscreen) and [`@tifan/pi-fixed-editor`](https://www.npmjs.com/package/@tifan/pi-fixed-editor) exist, but they are pre-native render-path workarounds rather than better implementations of the native 0.84.1 feature.
`pi-fullscreen` pins the bottom UI and provides a `/fullscreen` toggle, but it does not provide the native independently scrollable transcript or a jump-to-bottom command.
`@tifan/pi-fixed-editor` is explicitly deprecated for Pi 0.84.1 and directs users to native fullscreen mode.

## Built-in configuration

Start a single run with `pi --tui-mode fullscreen`, where the accepted CLI values are `regular` and `fullscreen` ([installed `args.ts` lines 180-187](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/cli/args.ts#L180-L187)).
Persist the mode in `~/.pi/agent/settings.json` or `.pi/settings.json` with `"tuiMode": "fullscreen"` ([settings documentation](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/docs/settings.md#ui--display)).
The interactive path is `/settings`, then `TUI mode`, then `fullscreen`, and this switch applies immediately while the CLI flag overrides the stored setting at startup ([installed `settings-selector.ts` lines 634-641](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/modes/interactive/components/settings-selector.ts#L634-L641)).
The related `fullscreenScrollbar` setting accepts `auto`, `always`, or `hidden`, and `/settings` labels it `Fullscreen scrollbar` ([installed `settings-selector.ts` lines 649-655](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/modes/interactive/components/settings-selector.ts#L649-L655)).
The related `fullscreenExitOutput` setting accepts `transcript` or `resume-hint` and controls what remains after leaving fullscreen mode ([settings documentation](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/docs/settings.md#ui--display)).

## Transcript controls

The quick jump-to-bottom action is `tui.altScreen.bottom`, its default key is `End`, and invoking it both reaches the end and resumes following new output ([fullscreen keybinding documentation](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/docs/keybindings.md#tui-fullscreen-viewport)).
There is no built-in `/bottom` slash command in 0.84.1, because this capability is exposed as a fullscreen keybinding action.
A custom key can be assigned in `~/.pi/agent/keybindings.json`, for example with `"tui.altScreen.bottom": "ctrl+shift+end"`, and `/reload` applies the edit.
The other exact transcript action names are `tui.altScreen.pageUp`, `tui.altScreen.pageDown`, `tui.altScreen.halfPageUp`, `tui.altScreen.halfPageDown`, `tui.altScreen.lineUp`, `tui.altScreen.lineDown`, `tui.altScreen.previousPrompt`, `tui.altScreen.nextPrompt`, `tui.altScreen.search`, `tui.altScreen.searchNext`, `tui.altScreen.searchPrevious`, `tui.altScreen.searchClose`, and `tui.altScreen.top` ([installed `keybindings.ts` lines 160-209](https://github.com/earendil-works/pi/blob/v0.84.1/packages/tui/src/keybindings.ts#L160-L209)).
`PageUp`, `PageDown`, `Home`, and `End` target the transcript in fullscreen mode, while their `Ctrl` variants continue to target the editor.
Mouse-wheel and two-finger scrolling target the region under the pointer and fall back to the transcript when used over the fixed dock.
Manual upward scrolling disables follow mode, later streamed content does not move the viewport, and `End` restores follow mode ([installed `tui-alt-screen.test.ts` lines 57-134](https://github.com/earendil-works/pi/blob/v0.84.1/packages/tui/test/tui-alt-screen.test.ts#L57-L134)).

## Core architecture

Core selects `TuiAltScreen` only for `tuiMode === "fullscreen"` ([installed `interactive-mode.ts` lines 343-357](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L343-L357)).
Core creates a primary `ScrollView` around the transcript document with `follow: "end"`, then places a non-growing dock below it ([installed `interactive-mode.ts` lines 872-893](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L872-L893)).
That dock contains pending messages, status, widgets above the editor, the editor, widgets below the editor, and the footer.
The TUI test named `keeps an explicit dock fixed while the transcript scrolls` verifies that wheel scrolling changes transcript rows without moving editor or footer rows, and it verifies `scrollToBottom()` returns the transcript to its end ([installed `tui-alt-screen.test.ts` lines 91-134](https://github.com/earendil-works/pi/blob/v0.84.1/packages/tui/test/tui-alt-screen.test.ts#L91-L134)).

## Extension API boundary

`ExtensionAPI`, `ExtensionContext`, and `ctx.ui` do not expose a first-class transcript scrolling method or an action-dispatch method.
The documented `ExtensionUIContext` offers status, widget, footer, header, custom component, editor, and theme controls, but no `scrollToBottom` or transcript viewport control ([installed `types.ts` lines 131-278](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/extensions/types.ts#L131-L278)).
The generic injected `TUI` interface and its `ViewportTUI` subtype expose rendering, focus, overlays, and `setLayoutRoot`, but neither interface exposes scrolling ([installed `tui.ts` lines 286-329](https://github.com/earendil-works/pi/blob/v0.84.1/packages/tui/src/tui.ts#L286-L329)).
The concrete exported `TuiAltScreen` class does have public `scrollBy()`, `scrollToTop()`, and `scrollToBottom()` methods, and the built-in `tui.altScreen.bottom` handler calls the last method ([installed `tui-alt-screen.ts` lines 385-401](https://github.com/earendil-works/pi/blob/v0.84.1/packages/tui/src/tui-alt-screen.ts#L385-L401) and [lines 627-634](https://github.com/earendil-works/pi/blob/v0.84.1/packages/tui/src/tui-alt-screen.ts#L627-L634)).
An extension could technically capture the generic TUI object supplied to a widget, footer, editor, or custom-component factory, feature-detect or downcast it to the exported `TuiAltScreen`, and call `scrollToBottom()`.
That downcast is a low-level, fullscreen-only coupling to the concrete renderer rather than a documented `ctx.ui` capability, and it must tolerate live renderer changes made through `/settings`.
The supported user path in 0.84.1 is therefore the `tui.altScreen.bottom` keybinding action, while programmatic extension scrolling requires the concrete-class escape hatch.

## Harness implementation decision

The harness should persist `"tuiMode": "fullscreen"` in `~/.pi/agent/settings.json` rather than installing a legacy package.
The built-in `End` action remains the lowest-level and most robust way to jump to the transcript end.
A small local `/bottom` command can capture Pi's [stable TUI proxy](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L358-L381) through an invisible widget, feature-detect `scrollToBottom()`, and invoke it only while the live renderer is fullscreen.
This local command should warn and do nothing in regular or non-TUI modes, which contains the unsupported concrete-renderer coupling.
If Pi adds a first-class extension scroll API or built-in `/bottom` command, that API should replace the local escape hatch.

## Third-party package check

The gallery-listed [`pi-fullscreen` 1.0.1](https://pi.dev/packages/pi-fullscreen) clears screen and scrollback, adds filler above the editor to pin the bottom UI, and registers `/fullscreen` to toggle that filler.
Its own compatibility section says it was developed against Pi 0.82 and 0.83 and relies on internal root-render, status-render, and `setClearOnShrink` behavior.
Its [source](https://github.com/puetsua/pi-fullscreen/blob/b499ae41fcffabf53c294e718788040aafdc9ce8/index.ts) contains no transcript scrolling or jump-to-bottom action.
The [`@tifan/pi-fixed-editor` package](https://www.npmjs.com/package/@tifan/pi-fixed-editor) is deprecated for Pi 0.84.1 and newer, freezes support for older versions, and documents migration to `"tuiMode": "fullscreen"`.
Presentation packages such as [pi-powerline-footer](https://pi.dev/packages/pi-powerline-footer) can still customize footer contents, but core should own viewport layout and scrolling.
This package check cannot rule out an unlisted private package or a package published after the research date.

## Limitations

Fullscreen remains explicitly marked experimental in Pi 0.84.1.
Its independent scrolling is available only in fullscreen mode, because regular mode relies on terminal scrollback rather than an application-owned transcript viewport.
Fullscreen owns the alternate-screen viewport and mouse input, so terminal-specific behavior applies, including the documented iTerm2 fast-trackpad workaround and Ghostty native-link modifier requirement ([terminal setup documentation](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/docs/terminal-setup.md#fullscreen-tui-mode)).
The dock remains fixed, but its status and extension-widget rows can consume or shrink within limited terminal height, while the transcript is guaranteed only its configured minimum row in the core layout.

## Installed source map

The installed snapshot root is `/nix/store/klkwpkrr0g3gr521brsdkl2fmdw32jvp-pi-coding-agent-0.84.1/lib/pi-coding-agent`.
The material installed files are `packages/coding-agent/docs/settings.md`, `packages/coding-agent/docs/keybindings.md`, `packages/coding-agent/docs/extensions.md`, `packages/coding-agent/docs/tui.md`, `packages/coding-agent/docs/terminal-setup.md`, `packages/coding-agent/src/modes/interactive/interactive-mode.ts`, `packages/coding-agent/src/core/extensions/types.ts`, `packages/tui/src/tui.ts`, `packages/tui/src/tui-alt-screen.ts`, `packages/tui/src/keybindings.ts`, `packages/tui/test/tui-alt-screen.test.ts`, and `packages/coding-agent/test/interactive-tui.test.ts`.
