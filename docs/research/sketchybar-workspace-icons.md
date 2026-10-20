# SketchyBar workspace application icons

Research date: 2026-10-20.
Scope: a substantially thinner right rail on the built-in display, showing applications in every AeroSpace workspace without collecting window titles.
No production configuration was changed.

## Recommendation

Use native `background.image=app.<bundle-id>` images, one item per distinct application per workspace, arranged vertically beneath a small workspace-number header.
Start visual evaluation around **40-44 points rail width and 20-24 points icons**, rather than shrinking the existing horizontal number-and-label composition into 88 points.
These are proposed design targets, not a verified rendered layout.
Use one serialized, debounced controller that re-queries AeroSpace after events, diffs the resulting workspace/application sets, and batches SketchyBar updates.
Retain a periodic reconciliation because the installed AeroSpace event API does not advertise window-close or window-moved events.

Preserve the existing built-in-display selector in `home/.config/sketchybar/plugins/display.sh`: CoreGraphics determines the built-in display and SketchyBar supplies its arrangement ID.
Keep hiding the rail when that panel is absent, including clamshell mode.
Built-in-only **rendering** must not inadvertently become built-in-only **data collection**: workspace application membership should cover all workspaces, even those assigned to the external monitor.

## Native images and thin vertical layout

- SketchyBar officially accepts `app.<bundle-id>` and `app.<name>` as background images, with `image.scale`, drawing, padding, offsets, border and corner-radius controls.
  Bundle IDs avoid localized application-name matching and eliminate a separately downloaded app-icon font and manually maintained lookup table.
  [Official item/image properties](https://felixkratz.github.io/SketchyBar/config/items).
- In installed SketchyBar 2.23.0, application lookup first calls `NSWorkspace.URLForApplicationWithBundleIdentifier`, then falls back to an exact localized-name match among running applications.
  The image comes from `NSWorkspace.iconForFile`, not a screenshot or window preview.
  An unresolved application returns an image-loading error, so explicitly clear the previous image and show a generic fallback rather than leaving a stale icon.
  [Versioned application lookup](https://github.com/FelixKratz/SketchyBar/blob/v2.23.0/src/workspace.m#L87-L116), [image loading and errors](https://github.com/FelixKratz/SketchyBar/blob/v2.23.0/src/image.c#L39-L125).
- There is a scale control, not an explicit documented image width/height setter.
  The implementation requests a `32 * backingScale` image representation, normalizes its returned raster dimensions using the square of the maximum screen backing scale, then multiplies by `image.scale`.
  Do not assume an example's `scale=0.2` or even `scale=1` guarantees a particular point size on this mixed-display machine.
  Inspect queried image dimensions and item bounds, adjust the scale to the desired point size, and recheck after display changes.
  [Versioned scale handling](https://github.com/FelixKratz/SketchyBar/blob/v2.23.0/src/image.c#L39-L184), [screen scale and image representation](https://github.com/FelixKratz/SketchyBar/blob/v2.23.0/src/workspace.m#L11-L21).
- `position=right` is supported by the bar API.
  In vertical mode, bar `height` becomes rail thickness; left-positioned items stack downward and right-positioned items upward.
  Individual item's icon and label still contribute horizontal content length, while background/image height controls its vertical footprint.
  Use separate header and image items, hide unnecessary text, and set image drawing plus background drawing explicitly.
  [Bar properties](https://felixkratz.github.io/SketchyBar/config/bar), [vertical layout implementation](https://github.com/FelixKratz/SketchyBar/blob/v2.23.0/src/bar.c#L348-L452), [item sizing](https://github.com/FelixKratz/SketchyBar/blob/v2.23.0/src/bar_item.c#L494-L540).

A narrower rail also needs a redesigned footer: the existing horizontal HH:MM, date, volume and battery composition can still determine minimum usable width.
After native visual QA, update the built-in AeroSpace right gap to the measured rail footprint plus desired clearance, not simply the icon width.
Keep external-display gaps unchanged.
Seven workspace headers plus an unbounded number of app rows cannot always fit on a finite screen.
Provide explicit overflow disclosure, such as a count opening a full workspace-app popup, rather than silently dropping applications or widening the rail.
If every icon must remain simultaneously visible, that requirement needs an agreed maximum application count or another layout constraint.

## AeroSpace data and event coverage

Installed versions observed: AeroSpace CLI/server **0.21.3-Beta**, SketchyBar **2.23.0**.
The following read-only snapshot was checked successfully; only the row count and field names were printed, not application identities or window titles:

```sh
aerospace list-windows --all --json \
  --format '%{workspace}%{app-bundle-id}'
```

With `--json`, `--format` selects JSON properties; the result has `workspace` and `app-bundle-id` keys.
Do not parse default output: its default format includes window titles.
Use JSON parsing and argument arrays, not shell splitting or command interpolation of application/workspace strings.
`--all` is intentional here because the rail must track every workspace across monitors.
[Official list-windows documentation](https://nikitabobko.github.io/AeroSpace/commands#list-windows).

Seed workspace entries separately using `list-workspaces --all`, retaining the configured persistent workspaces 1-7 even when no windows exist.
Group windows by workspace and deduplicate bundle IDs within each group; multiple windows of one application should normally produce one app icon, optionally with a count.
An application with windows in several workspaces appears in each relevant group.
A running application with no AeroSpace-managed window has no workspace membership and should not be assigned arbitrarily.
[Workspace enumeration](https://nikitabobko.github.io/AeroSpace/commands#list-workspaces).

`aerospace subscribe` is available in the installed version and streams JSON lines, with initial state on connection.
Its versioned documentation lists `focus-changed`, `focused-monitor-changed`, `focused-workspace-changed`, `mode-changed`, `window-detected`, and `binding-triggered`.
There is **no documented window-closed or window-moved event** in that version.
A new-window event also need not represent the final workspace after all routing callbacks have run, so treat it as invalidation rather than authoritative incremental state.
[Versioned subscribe contract](https://github.com/nikitabobko/AeroSpace/blob/v0.21.3-Beta/docs/aerospace-subscribe.adoc), [current command reference](https://nikitabobko.github.io/AeroSpace/commands#subscribe).

SketchyBar's `space_change` is a Mission Control Space event, not an AeroSpace workspace event.
Its `space_windows_change` reports creation/destruction and app-window counts for a native Space; use it only to invalidate the AeroSpace snapshot, never to assign AeroSpace workspace membership.
`front_app_switched` misses switching between two windows of the same application.
[Official event definitions](https://felixkratz.github.io/SketchyBar/config/events).

### Robust refresh lifecycle

1. On startup/reload, establish one owned AeroSpace subscription and take a full snapshot.
   Reconnect with bounded backoff after AeroSpace exits or restarts, and refresh again after reconnect.
   Ensure SketchyBar reloads do not leak duplicate subscriber processes.
2. Subscribe to AeroSpace focus, focused-workspace, focused-monitor and window-detected changes, then trigger one custom SketchyBar refresh event.
   Preserve the existing `exec-on-workspace-change` bridge as an inexpensive compatible trigger, but do not mistake workspace switching for complete membership coverage.
   [Official workspace-change callback](https://nikitabobko.github.io/AeroSpace/guide#exec-on-workspace-change-callback).
3. Also invalidate on SketchyBar `space_windows_change`, `front_app_switched`, `display_change` and `system_woke`.
   Trigger after repository-owned move commands when feasible; external moves and closure edge cases still require reconciliation.
4. Coalesce bursts, serialize refreshes, and perform a trailing refresh if another invalidation arrives during a query.
   Read the current focused workspace rather than trusting an older queued event payload, then batch only changed item state.
5. Keep the existing 15-second recovery cadence initially, or shorten it if that stale-state bound is unacceptable.
   Pure event-only correctness is not established by the published event contract.
   On snapshot failure, avoid partially replacing membership; expose unavailable state and retry, distinguishing failure from genuinely empty workspaces.

Never log raw event streams or default window listings.
The selected snapshot fields are sufficient for app membership; window IDs are optional if per-window counts or actions are later needed.
No title, screenshot, accessibility dump, browser content, or screen-recording permission is needed for this icon lookup approach.

## First-party configuration inspiration and freshness

- **omerxx**: his [AeroSpace items](https://github.com/omerxx/dotfiles/blob/master/sketchybar/items/aerospace.sh) create clickable workspace items; the [controller](https://github.com/omerxx/dotfiles/blob/master/sketchybar/plugins/aerospacer.sh) highlights the workspace from `FOCUSED_WORKSPACE`.
  This is a useful highlight/click pattern, **not** an implementation of workspace app tracking.
  It contains an absolute personal path and per-item scripts that should not be copied here.
  The latest commit touching his `sketchybar` directory returned by the GitHub commits API was [34cfca3, 2024-11-22](https://github.com/omerxx/dotfiles/commit/34cfca34efde76818721f55e28ef8210a69c885a).
- **FelixKratz, SketchyBar's author**: his [workspace configuration](https://github.com/FelixKratz/dotfiles/blob/master/.config/sketchybar/items/spaces.lua) observes `space_windows_change`, deduplicates apps through the event's app-count map, and maps names to `sketchybar-app-font` glyphs.
  Its native Space items, yabai click actions and `space.<id>` screenshot popup are not suitable substitutes for AeroSpace membership or privacy-preserving app icons.
  Reuse the separation between workspace items and a single observer, not those integrations.
  Latest commit touching his SketchyBar directory returned by the API was [e27673f, 2024-12-13](https://github.com/FelixKratz/dotfiles/commit/e27673f07ff41eb6a4816daabb79b0a5e837a105).

These are author-owned primary configuration sources, but their directory histories do **not** establish active maintenance in 2026.
Prefer the installed-version implementation and official API documentation for compatibility claims; do not present the inspiration configs as recently maintained examples.
