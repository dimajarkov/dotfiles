#!/usr/bin/env python3
"""Read-only live acceptance: membership, native images, flush top-strip geometry.

This is not screenshot or native mouse-hit-test evidence.
"""

import importlib.util
import json
from pathlib import Path
import subprocess
import time

SOURCE = (
    Path(__file__).resolve().parents[1]
    / "home/.config/sketchybar/plugins/workspaces.py"
)
spec = importlib.util.spec_from_file_location("workspaces", SOURCE)
controller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controller)


def query(name):
    return json.loads(
        subprocess.check_output(["sketchybar", "--query", name], text=True)
    )


def check():
    groups, focused = controller.snapshot()
    bar = query("bar")
    assert bar["height"] == 32, "Top strip must remain 32 points high"
    assert bar["position"] == "top"
    assert bar["margin"] == 0 and bar["y_offset"] == 0
    assert bar["show_in_fullscreen"] == "off"
    assert bar["topmost"] == "on", "Use floating-window level, not status-window level"
    displays = query("displays")
    builtin = json.loads(
        subprocess.check_output(
            [
                "/usr/bin/osascript",
                "-l",
                "JavaScript",
                "-e",
                'ObjC.import("CoreGraphics"); function run(a) { return JSON.stringify(JSON.parse(a[0]).filter(d => $.CGDisplayIsBuiltin(d.DirectDisplayID))); }',
                json.dumps(displays),
            ],
            text=True,
        )
    )
    if not builtin:
        assert bar["hidden"] == "on", "No built-in panel: bar must be hidden"
        return "PASS: top strip hidden without built-in panel"
    assert len(builtin) == 1
    assert bar["hidden"] == "off"
    display = builtin[0]
    key = "display-" + str(display["arrangement-id"])
    frame = display["frame"]
    safe = controller.geometry()
    left_edge = frame["x"] + safe["left"] - 8
    right_edge = frame["x"] + safe["right"] + 8
    names = set(bar["items"])
    args, images = controller.plan(groups, focused, names, controller.inline_budget())
    wanted = {args[i + 1] for i, value in enumerate(args) if value == "--set"}
    actual = {name for name in names if controller.owned(name)}
    assert actual == wanted, "Membership changed or has not reconciled yet"
    rectangles = []
    for name in bar["items"]:
        item = query(name)
        if item["geometry"]["drawing"] == "off":
            continue
        if name.startswith(
            (
                controller.PREFIX + "popup.",
                controller.PREFIX + "entry.",
                controller.PREFIX + "group.",
            )
        ):
            continue
        # SketchyBar retains a 1pt offscreen sentinel for excluded displays.
        # Those windows are not visible content on the external monitor.
        bounds = {
            display: rect
            for display, rect in item["bounding_rects"].items()
            if rect != {"origin": [-9999.0, -9999.0], "size": [1.0, 1.0]}
        }
        assert list(bounds) == [key], "Visible item on an external display"
        rect = bounds[key]
        x, y = rect["origin"]
        width, height = rect["size"]
        assert y == frame["y"] and height == 32, "Item is outside the native top strip"
        assert frame["x"] <= x and x + width <= frame["x"] + frame["w"]
        assert x + width <= left_edge or x >= right_edge, (
            "Content overlaps protected notch"
        )
        rectangles.append((x, x + width))
    rectangles.sort()
    assert all(a[1] <= b[0] for a, b in zip(rectangles, rectangles[1:])), (
        "Horizontal items overlap"
    )
    fallback_count = 0
    for name, bundle in images.items():
        item = query(name)
        popup = not name.startswith(controller.PREFIX + "app.")
        image = (
            item["icon"]["background"]["image"]
            if popup
            else item["geometry"]["background"]["image"]
        )
        if item["icon"]["value"] == "?":
            assert image["drawing"] == "off", "Fallback retained a stale image"
            fallback_count += 1
        else:
            assert image["value"] == "app." + bundle and image["drawing"] == "on", (
                "Missing or incorrect native icon"
            )
    for workspace in groups:
        group = query(controller.item_id("group", workspace))
        expected = controller.ACTIVE if workspace == focused else controller.INACTIVE
        assert group["geometry"]["background"]["color"] == expected, (
            "Stale workspace selection"
        )
    apps = sum(len(group) for group in groups.values())
    return f"PASS: 32pt flush built-in-only top strip, {len(groups)} workspaces, {apps} distinct workspace-app pairs, {fallback_count} fallbacks; native images and non-overlapping frames verified"


if __name__ == "__main__":
    deadline = time.monotonic() + 7
    while True:
        try:
            print(check())
            break
        except AssertionError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.3)
