# SketchyBar

SketchyBar is owned by Nix through `programs.sketchybar` in `home.nix`, including its user LaunchAgent.
Do not install a second copy with Homebrew.
The writable configuration lives in `home/.config/sketchybar`, linked at `~/.config/sketchybar`.

## Appearance and interaction

The translucent Catppuccin Macchiato palette and light clock capsule retain the existing theme.
Compact rounded workspace groups use the bracket/background approach from [FelixKratz's example](https://github.com/FelixKratz/dotfiles/blob/master/.config/sketchybar/items/spaces.lua), adapted to AeroSpace and native app icons rather than Mission Control IDs or icon-font mappings.
The bar itself is flush, not floating.
It uses the existing Hack Nerd Font and macOS SF Pro fonts, without downloading a separate icon font or compiling helpers.

- A 32-point horizontal bar occupies the native top strip on the built-in display only, with zero margin, offset or outer rounding.
- Left: System Settings button, then compact rounded groups containing a workspace number and native application icons.
  Inactive groups have subtle backgrounds; the active built-in workspace gets a tinted background and bright outline.
- Only AeroSpace workspaces assigned to the built-in screen are inventoried, including empty workspaces.
  Multiple windows of an application produce one icon per workspace, while an application present in several workspaces appears in each relevant group.
- Workspace numbers activate that workspace; application icons focus one of its windows.
  Right-click a workspace for its complete application-name/icon popup.
  When the inline list exceeds its width budget, a `+N` disclosure opens that same complete list rather than silently dropping apps.
  The active workspace gets first priority for inline icons; other groups retain stable ordering.
  If even the compact groups cannot fit, one `+N` workspace disclosure provides every workspace and app in a complete native-icon popup.
  An unavailable native icon gets a `?` fallback without affecting other apps.
- Clock, date, battery percentage and an icon-only sound control sit on the right, retaining Calendar and Sound Settings actions.
- The center notch is empty. Native `NSScreen.auxiliaryTopLeftArea`/`auxiliaryTopRightArea` determine its protected edges; non-notched panels reserve the center split.
  Workspace widths are bounded by the usable left area, with a safety gutter, fixed-size inline slots and explicit inter-group spacers.
  Geometry-query failure hides workspace content rather than assuming the current laptop's dimensions.
- AeroSpace subscription events update membership and focus, with a five-second recovery reconciliation for missing close/move events.
- A single serialized renderer reconciles the complete membership snapshot without collecting window titles.
- Native CoreGraphics detection selects the built-in panel using SketchyBar's own arrangement ID.
  AeroSpace is mapped separately through its `monitor-appkit-nsscreen-screens-id` into the native `NSScreen.screens` order, then queried with its own monitor ID.
  Neither the two tools' display IDs nor names are assumed interchangeable.
- Display changes, wake and a 30-second reconciliation refresh that selection, including recovery after transient native-query failures.
  Native auxiliary rectangles are validated before coordinate conversion; unavailable notch geometry hides the bar rather than removing camera protection.
  The bar stays hidden if no built-in display is available, including clamshell mode.
- AeroSpace's obsolete 54-point built-in right reservation is removed: right margin is the normal 20 points, with existing top/bottom margins unchanged.
  The Samsung ultrawide has no bar and retains its existing margins.
- `show_in_fullscreen=off` hides the bar in native fullscreen.
- `topmost=window` deliberately uses the floating-window level below the native menu's level, so the on-demand native menu takes precedence when revealed.
  Do not change this to `topmost=on` (status-window level), or `off` (which moves a top bar below a visible menu).
- AeroSpace retains its existing `start-at-login = false` setting.
  SketchyBar starts independently at login and recovers its highlights when AeroSpace becomes available.

## Apply and reload

The normal declarative installation is `./rebuild.sh` after reviewing the repository's Homebrew cleanup warning.
Editing the linked shell configuration only needs:

```sh
sketchybar --reload
aerospace reload-config
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
python3 tests/sketchybar-live.py
python3 tests/sketchybar-stability.py
nix build .#checks.aarch64-darwin.sketchybar-configuration
```

Service logs are under `~/Library/Logs/sketchybar/`.
The additional `org.nix-community.home.sketchybar-aerospace` LaunchAgent owns one reconnecting AeroSpace event subscription, independently of bar reloads.
Python is supplied through SketchyBar's Nix wrapper and the watcher uses the same declared interpreter.
Plugins use native power/audio queries and AeroSpace, without requiring application automation, location access, yabai or screen recording.
Application icons come from macOS bundle metadata, not screenshots or downloaded icon fonts.
If AeroSpace is stopped, selection is cleared and workspace state is marked unavailable until a complete snapshot succeeds.

Design sources and sizing/event limitations are recorded in [workspace icon research](research/sketchybar-workspace-icons.md) and [thin rail research](research/sketchybar-thin-rail.md).
The synthetic suites cover membership deduplication, moves/removals, ordering, overflow disclosure, missing-icon isolation, safe quoting, unavailable-state recovery, and subscription lifecycle.
The read-only live check compares built-in-only AeroSpace membership with rendered native-image items, verifies selection, and checks flush 32-point horizontal frames, notch exclusion and non-overlap (excluding intentional bracket backgrounds).
The temporal stability probe repeats eight unchanged refreshes while sampling all workspace header positions (or the compact overflow), temporarily suspending and then restoring the controller's automatic updates.
Do not run the live suites against the old rail before rollout; the stability probe mutates controller updates and renders the new configuration.
Do not repeatedly send item `width` settings: SketchyBar 2.23 queues width animations even for `dynamic`.
Fixed horizontal widths are assigned only at item creation. Explicit spacer items provide group gaps because constant-width items ignore background padding when advancing.
Reload and subscription-disconnect checks also verify one owned watcher and successful reconnection.
These checks are separate from rendered visual acceptance.
SketchyBar 2.23.0 serializes even vertical positions as `top`; the live test therefore checks actual item rectangles, not just the serialized position.

Window-level evidence: installed-version [bar_manager.c](https://github.com/FelixKratz/SketchyBar/blob/031cdff653ff80b7d253e1de659088de827d68d1/src/bar_manager.c#L293-L305) maps `window` to `kCGFloatingWindowLevel` rather than `kCGStatusWindowLevel` and gates native fullscreen visibility at space type 4.
[bar.c](https://github.com/FelixKratz/SketchyBar/blob/031cdff653ff80b7d253e1de659088de827d68d1/src/bar.c#L465-L522) offsets the top bar below a visible menu only when topmost is false.
A read-only `CGWindowLevelForKey` query on the target macOS returned floating=3, main menu=24, status=25.
Thus `window` preserves flush geometry while allowing the higher-level native menu to cover it; no private menu-visibility polling or desktop capture is used.
The tradeoff is that the revealed menu covers the bar rather than reflowing it. Actual menu reveal, fullscreen transitions, clicks and appearance remain rollout/human acceptance checks, not synthetic-test claims.
Mouse hit testing and rendered appearance still need human confirmation because this session has no active Codex Computer Use capability for scoped native capture.
