#!/bin/bash
set -eu

# AeroSpace's monitor IDs and SketchyBar's arrangement IDs are not interchangeable.
# CoreGraphics identifies the built-in panel even after display rearrangement/hotplug.
displays=$(sketchybar --query displays)
builtin=$(/usr/bin/osascript -l JavaScript -e '
ObjC.import("CoreGraphics");
function run(argv) {
  return JSON.parse(argv[0])
    .filter(d => $.CGDisplayIsBuiltin(d.DirectDisplayID))
    .map(d => d["arrangement-id"])
    .join(",");
}' "$displays") || builtin=""

if [[ "$builtin" =~ ^[1-9][0-9]*$ ]]; then
  sketchybar --bar display="$builtin" hidden=off
else
  # In clamshell mode (or on query failure), never fall back to the ultrawide.
  sketchybar --bar hidden=on
fi
