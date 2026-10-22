#!/usr/bin/env python3
"""Read-only all-monitor membership, monochrome-icon and top-strip acceptance.

Run after rollout; this is not screenshot or native mouse-hit-test evidence.
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
    safe = controller.geometry()
    states = controller.inventory(safe)
    bar = query("bar")
    assert bar["height"] == 32 and bar["position"] == "top"
    assert bar["margin"] == 0 and bar["y_offset"] == 0
    assert bar["show_in_fullscreen"] == "off"
    # 2.23 serializes both 'window' and 'on' as on; config test checks the level.
    assert bar["topmost"] == "on"
    if not safe:
        assert bar["hidden"] == "on", "Unsafe native inventory must hide the bar"
        return "PASS: bar hidden without safe displays"
    assert bar["hidden"] == "off"
    displays = {d["arrangement-id"]: d for d in query("displays")}
    panels = {"display-" + str(d["arrangement"]): d for d in safe}
    names = set(bar["items"])
    assert {"cpu", "ram", "battery", "date", "clock", "datetime"} <= names
    assert "volume" not in names
    args, icons = controller.plan_all(states, names)
    wanted = {args[i + 1] for i, value in enumerate(args) if value == "--set"}
    actual = {name for name in names if controller.owned(name)}
    assert actual == wanted, "Membership changed or has not reconciled yet"
    rectangles = {key: [] for key in panels}
    for name in bar["items"]:
        item = query(name)
        if item["geometry"]["drawing"] == "off":
            continue
        # The date/time bracket intentionally surrounds two item rectangles.
        if name == "datetime":
            continue
        if name.startswith(
            tuple(controller.PREFIX + k + "." for k in ("popup", "entry", "group"))
        ):
            continue
        bounds = {
            key: rect
            for key, rect in item["bounding_rects"].items()
            if rect != {"origin": [-9999.0, -9999.0], "size": [1.0, 1.0]}
        }
        expected = (
            {
                key
                for key, panel in panels.items()
                if name.endswith(".d" + str(panel["arrangement"]))
            }
            if controller.owned(name)
            else set(panels)
        )
        assert set(bounds) == expected, "Wrong per-display item association: " + name
        for key, rect in bounds.items():
            panel = panels[key]
            frame = displays[panel["arrangement"]]["frame"]
            x, y = rect["origin"]
            width, height = rect["size"]
            assert y == frame["y"] and height == 32
            assert frame["x"] <= x and x + width <= frame["x"] + frame["w"]
            assert (
                x + width <= frame["x"] + panel["left"] - 8
                or x >= frame["x"] + panel["right"] + 8
            ), "Content crosses safe split"
            rectangles[key].append((x, x + width))
    for rects in rectangles.values():
        rects.sort()
        assert all(a[1] <= b[0] for a, b in zip(rects, rects[1:])), "Horizontal overlap"
    for name, (glyph, font) in icons.items():
        item = query(name)
        icon = item["icon"]
        assert icon["value"] == glyph and icon["drawing"] == "on", name
        assert icon["color"] == controller.TEXT, name
        family, style, size = font.rsplit(":", 2)
        actual_family, actual_style, actual_size = icon["font"].rsplit(":", 2)
        assert (actual_family, actual_style) == (family, style), name
        assert float(actual_size) == float(size), name
        for background in (
            item["geometry"]["background"],
            icon["background"],
            item["label"]["background"],
        ):
            assert background["image"]["drawing"] == "off", name
            assert not background["image"]["value"].startswith("app."), name
    for panel, groups, visible in states:
        for workspace in groups:
            group = query(
                controller.item_id("group", workspace, display=panel["arrangement"])
            )
            expected = (
                controller.ACTIVE if workspace == visible else controller.INACTIVE
            )
            assert group["geometry"]["background"]["color"] == expected, (
                "Stale visible workspace"
            )
    return f"PASS: {len(panels)} safe displays; assigned workspaces, monochrome font/value/color, disabled images, selection and non-overlapping 32pt frames verified"


if __name__ == "__main__":
    deadline = time.monotonic() + 7
    while True:
        try:
            print(check())
            break
        # Reload briefly replaces the bar's IPC state; empty JSON responses
        # are transient only within the same bounded reconciliation deadline.
        except (AssertionError, json.JSONDecodeError):
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.3)
