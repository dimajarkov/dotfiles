# SketchyBar thin right rail research

Research date: 2026-10-20.
Scope: approximately 40-point right rail on the built-in panel, workspace number followed by vertically stacked native application icons.
No production configuration changes, reloads, screenshots, builds, or tests were performed.

## Recommendation

Use ordinary items in this order: workspace 1 number, its application-image items, workspace 2 number, its application-image items, and so on.
Use `position=right height=40` for the bar and `left` for these items, which stacks them downward in vertical mode.
A single item's icon and label remain horizontally composed; changing bar orientation does not create a vertical icon list inside that item.
Use one native image item per distinct application bundle ID per AeroSpace workspace, rather than icon-font text or duplicate icons for every window.
This is a recommendation derived from the layout implementation, not a visually validated configuration. [1][2][3]

Keep the existing built-in-display controller rather than replacing it with a fixed display number or AeroSpace monitor ID.
It maps SketchyBar display arrangement IDs through `CGDisplayIsBuiltin` and hides the bar when the panel is absent.
The current implementation is in `home/.config/sketchybar/plugins/display.sh` and its contract is described in `docs/sketchybar.md`.
The current 88-point bar, focused-app label, date, and horizontal HH:MM clock will not all fit unchanged in 40 points.
Budget the whole rail height as `sum(number rows + application rows + gaps + bottom controls)` and define overflow behavior before assuming every workspace will fit.
Retain an AeroSpace right gap sufficient for the new rail width plus desired outer and window clearance, rather than blindly retaining the existing 110-point reservation.

## Geometry and native images

- `--bar height=40` becomes rail width for `position=left/right`; these are logical points, not physical Retina pixels.
  The vertical layout uses item height for downward progression and centers each item's horizontal content inside the rail. [1][3]
- Native images are directly supported: `background.image=app.com.apple.Safari` or `background.image=app.Safari`.
  Bundle ID is more robust: source resolves it through `NSWorkspace.URLForApplicationWithBundleIdentifier`, then loads the application file icon.
  Name fallback searches running applications by localized name, so it is not equivalent to arbitrary installed-app lookup by name. [2][4]
- Explicitly use `icon.drawing=off label.drawing=off background.drawing=on background.color=0x00000000 background.image.drawing=on` on image-only items.
  An enabled image inside a disabled background neither contributes to item geometry nor renders. [2][5]
- `background.image.scale` multiplies the image's loaded logical size; it does not mean a desired point width.
  There is no documented image `width`, `height`, or `bounds` setter, and `background.height` does not resize or clip an oversized image. [2][4][5]
- Do not assume every app image starts at exactly 32 logical points or that `scale=0.75` always produces 24 points.
  The source proposes a `32 * workspace_get_scale()` NSImage rectangle, obtains a CGImage representation, then divides its pixel dimensions by the square of the maximum attached-screen backing scale before applying the configured image scale.
  This is representation-dependent and uses the maximum screen scale, not the rail display's scale. [4]
- A sensible target is a 22-24-point icon in a 26-28-point row, with a 20-22-point workspace-number row.
  These are design targets requiring rendered verification, not upstream guarantees.
  Start with zero inherited icon/label/image padding and dynamic item width; let the vertical layout center the resulting image content.
- `bar_item_get_height()` returns the maximum of visible text height, alias height, background height, and enabled background-image height.
  Setting `background.height=28` provides a minimum row height, not a cap.
  In vertical mode, item `width=<n>` can override advancement along the vertical rail while content stays tall, causing overlap; avoid using it as a rail-width control. [3][5]
- Item `background.padding_left/right` acts along vertical stacking in the left/right layout, despite its horizontal name.
  `y_offset` changes position and window extents, not the base stacking-height calculation; it is not a substitute for row spacing. [3]
- `--query <item>` exposes the image path/drawing/scale and item bounding rectangles, but image serialization does not expose raw or scaled image bounds.
  Frame queries detect row overflow/overlap; they do not independently prove icon size, centering, smoothing, or appearance. [4][5]

## AeroSpace inventory, subscriptions, ordering

Use AeroSpace window inventory, not SketchyBar Mission Control Space IDs, to associate icons with workspaces.
The upstream CLI supports `list-windows --all --json --format ...` with `%{workspace}`, `%{app-bundle-id}`, and `%{window-id}`.
Select only these fields to avoid collecting window titles, which are part of the default output.
Deduplicate bundle IDs within each workspace and choose a deterministic order explicitly, such as lexical bundle ID order.
Neither the CLI documentation nor the upstream examples promise stable application/window enumeration order. [6][8][9]

The existing `aerospace_workspace_change` custom event follows AeroSpace's official integration pattern: add the event, subscribe a controller, and have `exec-on-workspace-change` trigger it with `FOCUSED_WORKSPACE`.
However, this callback only covers focused-workspace changes, not every window membership change. [7][8]

Use workspace-change, `front_app_switched`, `space_windows_change`, `display_change`, and `system_woke` as refresh hints, with an independent periodic reconciliation fallback.
`front_app_switched` explicitly does not fire when focus moves between two windows of the same application.
`space_windows_change` carries Mission Control space/application information and is not an AeroSpace workspace membership feed.
Moving a background window between AeroSpace workspaces without changing focus can therefore require polling or an explicit trigger attached to the move command.
AeroSpace's `on-focus-changed` and `on-window-detected` callbacks improve responsiveness, but do not constitute a documented complete create/destroy/move event stream. [7][8]

One hidden controller with `drawing=off updates=on` can reconcile all application rows.
Do not leave it at `updates=when_shown`, since a hidden controller must still update.
Reuse existing item names for unchanged workspace/bundle pairs, add missing rows, remove stale rows, then establish the full intended sequence.
Serialize/debounce reconciliations so overlapping shell invocations do not race item creation, removal, and ordering.
Refresh the authoritative focused workspace after asynchronous events rather than assuming callback execution order is a consistency guarantee. [2][7][8]

`--add item`, `--remove <name>` (including regex), `--move <name> before/after <reference>`, and `--reorder <names...>` are documented runtime operations.
`--reorder` only swaps the supplied items within their existing slots; omitting a number anchor or newly appended application row can leave it in the wrong position.
For a complete block order, include every number and application item in the sequence, or move each row relative to a stable predecessor.
For right-positioned items, creation order stacks upward from the bottom; the recommended workspace block uses `left` to avoid reversal.
Batch each reconciliation in one CLI invocation: message handling freezes and unfreezes the manager around command processing, reducing intermediate redraws.
This is redraw batching, not a transactional concurrency guarantee. [2][3][10]

## What upstream examples actually demonstrate

- [omerxx AeroSpace items][9] use ordinary items, a custom workspace event, and AeroSpace click commands.
  Its companion script toggles each workspace background from `FOCUSED_WORKSPACE`.
  This is directly relevant to workspace identity/events, but is not a thin vertical native-image layout.
- [FelixKratz spaces.lua][11] uses a hidden window observer and `space_windows_change` to update app indicators.
  Its app indicators are concatenated `sketchybar-app-font` glyphs for yabai/Mission Control Spaces, not native bundle images or AeroSpace workspaces.
  Reuse the reconciliation concept, not its font mapping, Space IDs, or window-capture popup.
- No inspected upstream configuration establishes an exact 40-point native-icon AeroSpace rail as a known-good recipe.
  The feasibility evidence is the official property API plus the actual vertical layout/image implementation.

## Scoped native visual QA: available route and blocker

The approved route is Codex Computer Use through the Codex harness, not shell screenshot tools, AppleScript capture, browser screenshots, or another desktop application used as a backdrop.
The locally installed Computer Use skill documents `node_repl` with `@oai/sky`, `sky.get_app_state({app})`, app-scoped interactions, and screenshot URLs returned for that app.
It accepts an app name, bundle ID, or full application path and says to retry a failed display-name lookup with the identifier obtained from `list_apps()`.
Its documented API has no PID selector, CGWindowID selector, display selector, or source-side screenshot region/crop parameter. [12]

The earlier `getApp("SketchyBar")` failure is recorded as a scoped-capture blocker in `docs/sketchybar.md`; its exact exception text is not recorded there.
The current local installation resolves to a Nix `bin/sketchybar` executable wrapper, with no `/Applications/SketchyBar.app` present.
Upstream creates native windows directly; an executable process with visible windows is not thereby a discoverable LaunchServices application.
This explains why another display-name spelling is not a reliable remedy, but does not prove that every newer Computer Use runtime will reject it. [13]

**Exact capability gap:** this Pi research session exposes no Codex `node_repl`/Computer Use tool, and the inspected Computer Use API does not document capture of an unregistered executable's specific window or an isolated display rectangle.
Thus no verified route currently captures only SketchyBar-owned pixels under the no-desktop/private-content constraint.
A later Codex session may test documented application-path targeting only if it can establish a genuine task-owned app target without broad capture.
If that cannot be established, request a Computer Use capability for window-ID/PID-owned capture, or a human-supplied cropped image of the rail.
Capturing the desktop first and cropping afterward does not satisfy the constraint.
Do not mark appearance, pixel alignment, or native mouse hit testing as passed based on geometry queries alone.

## Sources

[1]: https://felixkratz.github.io/SketchyBar/config/bar
[2]: https://felixkratz.github.io/SketchyBar/config/items
[3]: https://github.com/FelixKratz/SketchyBar/blob/031cdff653ff80b7d253e1de659088de827d68d1/src/bar.c#L331-L442
[4]: https://github.com/FelixKratz/SketchyBar/blob/031cdff653ff80b7d253e1de659088de827d68d1/src/image.c
[5]: https://github.com/FelixKratz/SketchyBar/blob/031cdff653ff80b7d253e1de659088de827d68d1/src/bar_item.c#L502-L540
[6]: https://github.com/nikitabobko/AeroSpace/blob/74a1bf17e82d70e0a21945ba04bb4f590bf19f83/docs/aerospace-list-windows.adoc
[7]: https://felixkratz.github.io/SketchyBar/config/events
[8]: https://github.com/nikitabobko/AeroSpace/blob/74a1bf17e82d70e0a21945ba04bb4f590bf19f83/docs/guide.adoc#exec-on-workspace-change-callback
[9]: https://github.com/omerxx/dotfiles/blob/97b2213ad0e61c7a036290752e23497920978d55/sketchybar/items/aerospace.sh
[10]: https://github.com/FelixKratz/SketchyBar/blob/031cdff653ff80b7d253e1de659088de827d68d1/src/message.c
[11]: https://github.com/FelixKratz/dotfiles/blob/67ad686ea6d4c29ccd54fdaa42cdf35f37a7219c/.config/sketchybar/items/spaces.lua
[12]: /Users/dmitrijarkov/.codex/.tmp/bundled-marketplaces/openai-bundled/plugins/computer-use/skills/computer-use/SKILL.md
[13]: https://github.com/FelixKratz/SketchyBar/blob/031cdff653ff80b7d253e1de659088de827d68d1/src/window.c

Sources [3]-[5], [10], and [13] are pinned to installed-version tag `v2.23.0`.
Application resolution and proposed icon size are implemented in [workspace.m](https://github.com/FelixKratz/SketchyBar/blob/031cdff653ff80b7d253e1de659088de827d68d1/src/workspace.m#L87-L115).
Background-image enablement/rendering is implemented in [background.c](https://github.com/FelixKratz/SketchyBar/blob/031cdff653ff80b7d253e1de659088de827d68d1/src/background.c#L171-L228).
Local observations are limited to file/documentation inspection and executable-path resolution.
