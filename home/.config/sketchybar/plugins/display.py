#!/usr/bin/env python3
"""Read native built-in safe geometry; never equate the two tools' monitor IDs."""

import json
import math
import subprocess


def normalize(value):
    if value is None:
        return None
    width, origin, top = value["width"], value["origin"], value["top"]
    if not all(math.isfinite(n) for n in (width, origin, top)) or width <= 0 or top < 0:
        raise ValueError("invalid native frame")
    left = right = width / 2
    if top > 0:
        left_area, right_area = value["leftArea"], value["rightArea"]
        for x, w, h in (left_area, right_area):
            if not all(math.isfinite(n) for n in (x, w, h)):
                raise ValueError("invalid auxiliary rectangle")
            if w <= 0 or h < top or x < origin or x + w > origin + width:
                raise ValueError("unavailable auxiliary rectangle")
        left, right = left_area[0] + left_area[1] - origin, right_area[0] - origin
        if left >= right:
            raise ValueError("notched display requires a positive protected gap")
    if not (
        value["arrangement"] > 0 and value["screen"] > 0 and 0 < left <= right < width
    ):
        raise ValueError("invalid display safe geometry")
    return {
        "arrangement": value["arrangement"],
        "screen": value["screen"],
        "left": left,
        "right": right,
        "width": width,
    }


def geometry():
    displays = subprocess.check_output(
        ["sketchybar", "--query", "displays"], text=True, timeout=8
    )
    result = subprocess.check_output(
        [
            "/usr/bin/osascript",
            "-l",
            "JavaScript",
            "-e",
            r"""
ObjC.import("AppKit");
ObjC.import("CoreGraphics");
function run(argv) {
  const displays = JSON.parse(argv[0]);
  const screens = $.NSScreen.screens;
  for (let i = 0; i < screens.count; i++) {
    const s = screens.objectAtIndex(i);
    const id = ObjC.unwrap(s.deviceDescription.objectForKey("NSScreenNumber"));
    const d = displays.find(d => d.DirectDisplayID === id);
    if (!d || !$.CGDisplayIsBuiltin(id)) continue;
    const f = s.frame;
    const top = s.respondsToSelector("safeAreaInsets") ? s.safeAreaInsets.top : 0;
    function area(a) { return [a.origin.x, a.size.width, a.size.height]; }
    return JSON.stringify({arrangement: d["arrangement-id"], screen: i + 1,
      width: f.size.width, origin: f.origin.x, top: top,
      leftArea: top > 0 ? area(s.auxiliaryTopLeftArea) : null,
      rightArea: top > 0 ? area(s.auxiliaryTopRightArea) : null});
  }
  return "null";
}""",
            displays,
        ],
        text=True,
        timeout=8,
    )
    return normalize(json.loads(result))


def reconcile():
    try:
        display = geometry()
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        display = None
    args = ["sketchybar", "--bar", "hidden=on"]
    if display:
        args = [
            "sketchybar",
            "--bar",
            "display=" + str(display["arrangement"]),
            "notch_width=" + str(int(display["right"] - display["left"])),
            "hidden=off",
        ]
    subprocess.run(args, check=True)


if __name__ == "__main__":
    reconcile()
