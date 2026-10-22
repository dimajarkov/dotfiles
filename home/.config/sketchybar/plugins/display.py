#!/usr/bin/env python3
"""Native safe geometry, independently mapped to SketchyBar arrangement IDs."""

import json
import math
import subprocess


def normalize(value):
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
        all(
            type(value[k]) is int and 0 < value[k] < 32
            for k in ("arrangement", "screen")
        )
        and 0 < left <= right < width
        # Fixed status widths total 396pt + 40pt item padding + 16pt gutter.
        # Panels too narrow for the full status group fail closed.
        and width - right >= 452
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
    """Return only independently validated displays; one bad panel cannot hide others."""
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
function run(argv) {
  const displays = JSON.parse(argv[0]);
  const screens = $.NSScreen.screens;
  const result = [];
  for (let i = 0; i < screens.count; i++) {
    const s = screens.objectAtIndex(i);
    const id = ObjC.unwrap(s.deviceDescription.objectForKey("NSScreenNumber"));
    const d = displays.find(d => d.DirectDisplayID === id);
    if (!d) continue;
    try {
      const f = s.frame;
      const top = s.respondsToSelector("safeAreaInsets") ? s.safeAreaInsets.top : 0;
      function area(a) { return [a.origin.x, a.size.width, a.size.height]; }
      result.push({arrangement: d["arrangement-id"], screen: i + 1,
        width: f.size.width, origin: f.origin.x, top: top,
        leftArea: top > 0 ? area(s.auxiliaryTopLeftArea) : null,
        rightArea: top > 0 ? area(s.auxiliaryTopRightArea) : null});
    } catch (_) {} // Fail closed for this panel only.
  }
  return JSON.stringify(result);
}""",
            displays,
        ],
        text=True,
        timeout=8,
    )
    values = json.loads(result)
    if not isinstance(values, list):
        raise ValueError("invalid display inventory")
    valid = []
    for value in values:
        try:
            panel = normalize(value)
        except (ValueError, KeyError, TypeError):
            continue
        valid.append(panel)
    if len({d["arrangement"] for d in valid}) != len(valid) or len(
        {d["screen"] for d in valid}
    ) != len(valid):
        raise ValueError("ambiguous display inventory")
    return sorted(valid, key=lambda d: d["arrangement"])


def bar_properties(displays):
    if not displays:
        return ["--bar", "hidden=on"]
    # SketchyBar applies notch_width only to native built-in panels. Use the
    # largest native protected gap; each panel's workspace budget stays local.
    notch = math.ceil(max(d["right"] - d["left"] for d in displays))
    return [
        "--bar",
        "display=" + ",".join(str(d["arrangement"]) for d in displays),
        "notch_width=" + str(notch),
        "hidden=off",
    ]


def reconcile():
    # The periodic display controller shares the workspace renderer's lock and
    # inventory, so a hotplug cannot interleave bar selection and item assignment.
    from workspaces import render

    render()


if __name__ == "__main__":
    reconcile()
