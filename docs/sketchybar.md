# SketchyBar

SketchyBar is owned by Nix through `programs.sketchybar` in `home.nix`, including its user LaunchAgent.
Do not install a second copy with Homebrew.
The writable configuration lives in `home/.config/sketchybar`, linked at `~/.config/sketchybar`.

## Appearance and interaction

The translucent Catppuccin Macchiato palette, rounded bar, workspace pills and light clock capsule take inspiration from [omerxx's configuration](https://github.com/omerxx/dotfiles/tree/master/sketchybar).
This is an adaptation for our AeroSpace setup, not a copy of his machine-specific paths or yabai dependencies.
It uses the existing Hack Nerd Font and macOS SF Pro fonts, without downloading a separate icon font or compiling helpers.

- A 40-point vertical rail sits on the right edge of the built-in Retina display only.
- Top: System Settings button, then workspace numbers with native application icons stacked beneath each workspace.
- Every AeroSpace workspace is inventoried, including workspaces assigned to the ultrawide.
  Multiple windows of an application produce one icon per workspace, while an application present in several workspaces appears in each relevant group.
- Workspace numbers activate that workspace; application icons focus one of its windows.
  Right-click a workspace for its complete application-name/icon popup.
  When the inline list exceeds its height budget, a `+N` disclosure opens that same complete list rather than silently dropping apps.
  An unavailable native icon gets a `?` fallback without affecting other apps.
- Compact clock, date, battery percentage and an icon-only sound control sit at the bottom.
- AeroSpace subscription events update membership and focus, with a five-second recovery reconciliation for missing close/move events.
- A single serialized renderer reconciles the complete membership snapshot without collecting window titles.
- Native CoreGraphics detection selects the built-in panel using SketchyBar's own arrangement ID, independently of AeroSpace's monitor numbering.
- Display changes and wake refresh that selection; the bar stays hidden if no built-in display is available, including clamshell mode.
- AeroSpace reserves a 54-point right gap on the built-in panel and retains its previous top gap.
  The Samsung ultrawide has no bar and retains its existing margins.
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
The read-only live check compares AeroSpace membership with the rendered native-image items, verifies the focused workspace, and checks built-in-only right-edge geometry without overlapping frames.
The temporal stability probe repeats eight unchanged refreshes while sampling live header positions, temporarily suspending and then restoring the workspace controller's automatic updates.
It reproduced periodic movement before the fix and now verifies stable positions across refreshes.
Do not repeatedly send item `width=dynamic`: SketchyBar 2.23 queues a width animation even for this setting, temporarily changing vertical row advancement.
New items already default to dynamic width; `background.height` controls row height.
Reload and subscription-disconnect checks also verify one owned watcher and successful reconnection.
These checks are separate from rendered visual acceptance.
SketchyBar 2.23.0 incorrectly serializes vertical positions as `top` in `--query bar`; item bounding rectangles provide the actual placement evidence.
Mouse hit testing and rendered appearance still need human confirmation because Codex Computer Use could not target SketchyBar for scoped native capture.
