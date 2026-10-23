# SketchyBar

SketchyBar is owned by Nix through `programs.sketchybar` in `home.nix`, including its user LaunchAgent.
Do not install a second copy with Homebrew.
The writable configuration lives in `home/.config/sketchybar`, linked at `~/.config/sketchybar`.

## Appearance and interaction

A translucent neutral graphite palette complements the monochrome charcoal desktop wallpaper.
The date and time use coordinated dark styling rather than a bright clock capsule.
Compact square-cornered workspace groups use the bracket/background approach from [FelixKratz's example](https://github.com/FelixKratz/dotfiles/blob/master/.config/sketchybar/items/spaces.lua), adapted to AeroSpace and monochrome app-font glyphs rather than Mission Control IDs.
The bar itself is flush, not floating.
It uses the Nix-pinned SketchyBar app font for monochrome logos, with the existing Hack Nerd Font for fallback symbols and macOS SF Pro for text.
No custom helpers are compiled.

- A 32-point horizontal bar occupies the native top strip on every connected display with validated native geometry, with zero margin, offset or outer rounding. External-only clamshell mode is supported.
- Left: System Settings button, then compact square-cornered workspace groups and recognizable monochrome application logos in the bar's muted light text color.
  Each shortcut number has its own small filled, outlined badge beside the workspace name, and workspaces sort in shortcut order.
  Numeric-only workspaces show just the badge, without repeating their name.
  All bar components, workspace outlines, badges, date/time backgrounds and popups have sharp corners.
  Labels are derived from the literal Option-number workspace bindings in AeroSpace's main mode; click actions continue to use the actual workspace name.
  Inactive groups have subtle backgrounds; each monitor's visible workspace gets a tinted background and bright outline, independently of keyboard focus on another monitor.
- Each screen shows only its own assigned AeroSpace workspaces, including empty workspaces.
  Multiple windows of an application produce one icon per workspace, while an application present in several workspaces appears in each relevant group.
- Workspace numbers activate that workspace; application icons focus one of its windows.
  Right-click a workspace for its complete application-name/icon popup.
  Every application's real monochrome glyph stays in the inline strip; application icons are never replaced by `+N` counters.
  When the combined workspace-and-application strip exceeds a panel's safe width, left/right arrows and wheel scrolling over its items browse a display-local horizontal viewport without selecting another workspace.
  Individual header/icon slots scroll, so even one workspace containing more apps than the viewport remains fully reachable.
  A real workspace selection change brings that workspace's header back into view; duplicate focus notifications and periodic refreshes preserve manual browsing.
  Right-click application popups remain complete, independently of the viewport.
  Only when the panel cannot fit even its widest workspace header plus both arrows does one `+N` workspace disclosure provide every workspace and app in a complete monochrome-icon popup.
  Terminals (including WezTerm and Herdr) share a generic terminal shape; ChatGPT uses the OpenAI logo.
  Other apps use the pinned app-name map with a neutral default logo. Missing map/font files degrade to a generic Hack Nerd Font window glyph, never raw ligature text or native app images.
- System Settings, CPU/RAM percentages, battery icon and percentage, and coordinated date/time controls repeat on every bar.
  Audio controls are omitted.
  Status controls have fixed widths to bound the right-side footprint and retain the Calendar actions.
  CPU is aggregate whole-machine busy percentage sampled every 15 seconds, not summed per-process CPU.
  RAM is active, wired and physical compressor pages as a percentage of physical memory; it is not an exact Activity Monitor total.
  Logical compressed pages are not counted again, and inactive/cache pages are not added to this measure.
  Unavailable telemetry shows `--` rather than a misleading zero.
  Charging adds a bolt alongside the battery icon; date/time show weekday, day, month and a 24-hour clock.
- The center notch is empty. Native `NSScreen.auxiliaryTopLeftArea`/`auxiliaryTopRightArea` determine its protected edges; non-notched panels reserve the center split.
  Workspace widths are bounded by the usable left area, with a safety gutter, fixed-size inline slots and explicit inter-group spacers.
  Left-side budgets are computed independently for each panel. Native panels too narrow for the bounded status controls are excluded rather than allowing overlap.
  Geometry validation failure excludes only the affected display; complete native-query failure hides all bars rather than assuming the current laptop's dimensions.
- Focus has a separate color-and-viewport lane: the native workspace-change callback works even before the watcher subscribes; subscription focus events apply immediately, without debounce, geometry, window inventory or the structural render lock. Both query current visible workspaces across all monitors, rather than trusting old event payloads. Validated hashed badge/bracket IDs scope the updates; badge background/border/icon and group background/border change in one batch, with drawing-only viewport updates when needed and no width, order or geometry writes. Successful structural applies save only those opaque topology IDs in the owner-private cache, removing the bar-inventory IPC query from steady-state selection. Reload invalidates that cache; missing/malformed topology falls back to live bar IDs, and successful structural removal/hotplug replaces it. A failed selection write invalidates it for rediscovery on the next notification.
- One non-queuing structural renderer reconciles membership every five seconds and on structural events, without collecting window titles. Window-detected bursts use a 200ms quiet period (one-second cap); focus events never request a full inventory. A short shared apply lock covers current-selection queries and atomic writes only. Full renders override their old snapshot colors with current visibility under that same lock, preventing stale selection reverts. Duplicate native/front-app/subscription notifications elect one selection worker rather than queueing IPC passes. A counter-only notification file records changes during an in-flight query/write; the worker drains the latest generation and releases its election under the notification lock, avoiding a lost final wakeup. No app inventory, names, titles or raw selection snapshots are cached.
  The same owner-private lock cache holds a validated viewport manifest containing only opaque item/hash IDs, fixed widths, native panel identity, browse offsets and the last visible header's opaque hash.
  The hash detects actual selection changes without undoing manual scrolling on duplicate notifications; removed panels are discarded and replacement display identities reset their browse offsets.
- Native `NSScreenNumber`/SketchyBar `DirectDisplayID` identity maps each panel to SketchyBar's arrangement ID.
  AeroSpace is mapped separately through its `monitor-appkit-nsscreen-screens-id` into the native `NSScreen.screens` order, then queried with its own monitor ID.
  Neither the two tools' display IDs nor names are assumed interchangeable. Workspace items, brackets and popups have display-local IDs and explicit display associations; shared applications or workspace names cannot duplicate groups across panels.
- Display changes, wake and a 30-second reconciliation refresh display geometry, including recovery after transient native-query failures. Display and workspace controllers use the same non-queuing structural renderer and one native inventory per pass, preventing interleaved panel item assignment.
  Native auxiliary rectangles are validated before coordinate conversion; unavailable notch geometry excludes that panel rather than removing camera protection.
  Removed or rearranged displays have their stale items removed; remaining external panels stay available without a built-in screen. Missing/ambiguous AeroSpace mapping clears workspace content only on the affected panel.
- AeroSpace reserves a 42-point top gap on external monitors: the 32-point bar plus 10 points of breathing room.
  The built-in display retains its 10-point top gap because its native camera strip already reserves the bar height.
  Bottom margins remain 10 points; horizontal margins retain their existing monitor-specific settings.
  These gaps protect tiled windows, not manually positioned floating windows or native fullscreen apps.
- `show_in_fullscreen=off` hides the bar in native fullscreen.
- `topmost=window` deliberately uses the floating-window level below the native menu's level, so the on-demand native menu takes precedence when revealed.
  Do not change this to `topmost=on` (status-window level), or `off` (which moves a top bar below a visible menu).
- AeroSpace retains its existing `start-at-login = false` setting.
  SketchyBar starts independently at login and recovers its highlights when AeroSpace becomes available.

## Apply and reload

The normal declarative installation is `./rebuild.sh` after reviewing the repository's Homebrew cleanup warning.
Workspace logos additionally require the flake-pinned `sketchybar-app-font` package (2.0.60 in the current lock).
Home Manager owns both `~/Library/Fonts/sketchybar-app-font.ttf` and `~/.local/share/sketchybar/icon_map.lua` from that same package, outside the linked configuration directory.
Activate these declarations before reloading; a configuration-only reload does not install the font/map.
For a targeted rollout without a system switch, use the evaluated Home Manager sources for these two declarations, without copying fonts from another package manager or version.
The current scoped rollout links both files to the pinned package and retains that package through `~/.local/state/nix/gcroots/sketchybar-app-font` until normal Home Manager activation owns it.
CoreText user-scope registration made the font family available without restarting applications.
Restart SketchyBar after first font activation if CoreText has not discovered the family yet.
Synthetic tests use `SKETCHYBAR_APP_FONT_MAP` and `SKETCHYBAR_APP_FONT_FILE` paths supplied by the Nix check, without relying on installed system fonts.

After dependencies are activated, editing the linked shell configuration only needs:

```sh
sketchybar --reload
aerospace reload-config
# The subscription process is independent of bar reloads: restart after code updates.
launchctl kickstart -k "gui/$(id -u)/org.nix-community.home.sketchybar-aerospace"
```

For the initial installation on this machine, only the Nix package, configuration link and evaluated Home Manager LaunchAgent were applied.
No system switch or Homebrew cleanup was run.
The package is currently rooted in the user's existing Nix profile as `finalPackage`, using this flake's `darwinConfigurations.mac.config.home-manager.users.dmitrijarkov.programs.sketchybar.finalPackage` output.
A normal rebuild also supplies the same package through Home Manager.
Do not remove the profile entry until the rebuilt package is available and that cleanup has been explicitly approved.

## Verification and troubleshooting

```sh
sketchybar --version
sketchybar --query bar
launchctl print "gui/$(id -u)/org.nix-community.home.sketchybar"
python3 tests/sketchybar.py
python3 tests/sketchybar-workspaces.py
python3 tests/sketchybar-metrics.py
python3 tests/sketchybar-live.py
python3 tests/sketchybar-stability.py
# Opt-in only: switches desktops temporarily, then restores all visible workspaces.
python3 tests/sketchybar-latency.py --samples 6
python3 tests/sketchybar-latency.py --samples 6 --burst 12
python3.11 tests/aerospace-sketchybar.py
python3.11 tests/aerospace-sketchybar.py --live
nix build .#checks.aarch64-darwin.sketchybar-configuration
```

Service logs are under `~/Library/Logs/sketchybar/`.
The additional `org.nix-community.home.sketchybar-aerospace` LaunchAgent owns one reconnecting AeroSpace event subscription, independently of bar reloads.
Python is supplied through SketchyBar's Nix wrapper and the watcher uses the same declared interpreter.
Plugins use native power/system-load queries and AeroSpace, without requiring application automation, location access, yabai or screen recording.
The optional AeroSpace live check reads only visible tiled-window IDs, layouts and CoreGraphics bounds to verify top-bar clearance; it does not collect window titles or pixels.
Application logos are ligature strings in the Nix-owned app font, colored explicitly with `TEXT` for inline items and both popup forms. The controller reads the package's Lua mapping as literal data, never executes Lua, and clears stale image properties on every app refresh. No per-icon subprocesses or native-image fallbacks are used.
If AeroSpace is stopped, selection is cleared and workspace state is marked unavailable until a complete snapshot succeeds.

Design sources and sizing/event limitations are recorded in [workspace icon research](research/sketchybar-workspace-icons.md) and [thin rail research](research/sketchybar-thin-rail.md).
The synthetic suites cover membership deduplication, moves/removals, ordering, overflow disclosure, monochrome logos, terminal/OpenAI overrides, missing-map/font fallback, stale-image migration, safe quoting, unavailable-state recovery, and subscription lifecycle. Multi-panel cases cover independent AeroSpace/AppKit/SketchyBar IDs, empty groups, per-panel visible selection/budgets, scoped popups/brackets, external-only operation, rearrangement and isolated geometry failure/recovery.
After rollout, the read-only live check compares each monitor's assigned AeroSpace membership with rendered glyph items (font, value, color and disabled native images), verifies visible-workspace selection and exact display associations, and checks flush 32-point horizontal frames, notch exclusion and non-overlap (excluding intentional bracket backgrounds).
The temporal stability probe repeats eight unchanged refreshes while sampling every monitor's currently drawn workspace/icon strip (or its ultra-narrow overflow), preserving manual browse offsets while temporarily suspending and then restoring the controller's automatic updates.
Do not run the updated live suites against the built-in-only configuration before rollout; the stability probe mutates controller updates and renders the new configuration. The read-only check will correctly reject the old single-panel configuration.
Do not repeatedly send item `width` settings: SketchyBar 2.23 queues width animations even for `dynamic`.
Fixed horizontal widths are assigned only at item creation. Explicit spacer items provide group gaps because constant-width items ignore background padding when advancing.
Reload and subscription-disconnect checks also verify one owned watcher and successful reconnection.
The opt-in latency probe measures command-to-all-highlight-properties convergence, targeting p95 ≤250ms; this is an acceptance target, not a verified timing claim. `--burst 12` alternates switches without highlight waits, then checks final convergence and every monitor's active/inactive badge/group colors for six seconds (including periodic reconciliation). A bounded readiness gate waits for membership and selection after reload before the first switch; timed samples never retry missing items or hide slow results. Odd/even burst lengths both time an actual final switch. Both probes restore the original visible workspaces and focused workspace even on failure. The flake lints the latency probe but never runs it automatically. Synthetic regressions cover the inventory-free focus lane, delayed callback payloads, rapid alternation, a paused stale full render, non-queuing structural passes and immediate subscription focus handling.
These checks are separate from rendered visual acceptance.
SketchyBar 2.23.0 serializes even vertical positions as `top`; the live test therefore checks actual item rectangles, not just the serialized position.

Window-level evidence: installed-version [bar_manager.c](https://github.com/FelixKratz/SketchyBar/blob/031cdff653ff80b7d253e1de659088de827d68d1/src/bar_manager.c#L293-L305) maps `window` to `kCGFloatingWindowLevel` rather than `kCGStatusWindowLevel` and gates native fullscreen visibility at space type 4.
[bar.c](https://github.com/FelixKratz/SketchyBar/blob/031cdff653ff80b7d253e1de659088de827d68d1/src/bar.c#L465-L522) offsets the top bar below a visible menu only when topmost is false.
A read-only `CGWindowLevelForKey` query on the target macOS returned floating=3, main menu=24, status=25.
Thus `window` preserves flush geometry while allowing the higher-level native menu to cover it; no private menu-visibility polling or desktop capture is used.
The tradeoff is that the revealed menu covers the bar rather than reflowing it. Actual menu reveal, fullscreen transitions, clicks and appearance remain rollout/human acceptance checks, not synthetic-test claims.
Mouse hit testing and rendered appearance still need human confirmation because this session has no active Codex Computer Use capability for scoped native capture.
