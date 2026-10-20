#!/usr/bin/env python3
"""Read-only live acceptance: workspace membership, native images, and rail geometry.

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
    assert bar["height"] == 40, "Rail must remain 40 points wide"
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
        assert bar["hidden"] == "on", "No built-in panel: rail must be hidden"
        return "PASS: rail hidden without built-in panel"
    assert len(builtin) == 1
    assert bar["hidden"] == "off"
    display = builtin[0]
    key = "display-" + str(display["arrangement-id"])
    frame = display["frame"]
    expected_x = frame["x"] + frame["w"] - bar["margin"] - bar["height"]
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
        if name.startswith(controller.PREFIX + "popup."):
            continue
        bounds = item["bounding_rects"]
        assert list(bounds) == [key], "Visible item on an external display"
        rect = bounds[key]
        x, y = rect["origin"]
        width, height = rect["size"]
        assert x == expected_x and width == 40, "Item is outside the right rail"
        assert frame["y"] <= y and y + height <= frame["y"] + frame["h"], (
            "Item exceeds display height"
        )
        rectangles.append((y, y + height))
    rectangles.sort()
    assert all(a[1] <= b[0] for a, b in zip(rectangles, rectangles[1:])), "Rows overlap"
    fallback_count = 0
    for name, bundle in images.items():
        item = query(name)
        popup = name.startswith(controller.PREFIX + "popup.")
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
    selected = query(controller.header(focused))
    assert selected["geometry"]["background"]["color"] == controller.SURFACE, (
        "Stale workspace selection"
    )
    apps = sum(len(group) for group in groups.values())
    return f"PASS: 40pt built-in-only rail, {len(groups)} workspaces, {apps} distinct workspace-app pairs, {fallback_count} fallbacks; native images and non-overlapping frames verified"


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
