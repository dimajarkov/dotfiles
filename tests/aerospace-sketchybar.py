#!/usr/bin/env python3
"""Check tiled-window clearance without capturing pixels or window titles."""

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tomllib
import unittest

ROOT = Path(__file__).resolve().parents[1]


class GapTests(unittest.TestCase):
    def test_external_top_reserves_bar_and_gutter(self):
        config = tomllib.loads((ROOT / "home/.aerospace.toml").read_text())
        top = config["gaps"]["outer"]["top"]
        self.assertIsInstance(top, list)
        self.assertGreaterEqual(top[-1], 42)

    def test_builtin_retains_native_notch_strip(self):
        config = tomllib.loads((ROOT / "home/.aerospace.toml").read_text())
        top = config["gaps"]["outer"]["top"]
        self.assertIsInstance(top, list)
        self.assertEqual(top[0], {"monitor": {"^Built-in Retina Display$": 10}})


def live():
    source = ROOT / "home/.config/sketchybar/plugins/workspaces.py"
    spec = importlib.util.spec_from_file_location("workspaces", source)
    controller = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(controller)
    panels = controller.geometry()
    frames = {
        d["arrangement-id"]: d["frame"]
        for d in controller.query(["sketchybar", "--query", "displays"])
    }
    monitors = controller.query(
        [
            controller.AEROSPACE,
            "list-monitors",
            "--json",
            "--format",
            "%{monitor-id}%{monitor-appkit-nsscreen-screens-id}",
        ]
    )
    # Read geometry only. Never request window names or screenshots.
    script = """ObjC.import("CoreGraphics");
const a=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1,0)));
JSON.stringify(a.filter(w=>w.kCGWindowLayer===0).map(w=>({id:w.kCGWindowNumber,bounds:w.kCGWindowBounds})));"""
    raw = subprocess.check_output(
        ["/usr/bin/osascript", "-l", "JavaScript", "-e", script], text=True, timeout=10
    )
    bounds = {w["id"]: w["bounds"] for w in json.loads(raw)}
    height = controller.query(["sketchybar", "--query", "bar"])["height"]
    checked = 0
    for panel in panels:
        monitor = next(
            m["monitor-id"]
            for m in monitors
            if int(m["monitor-appkit-nsscreen-screens-id"]) == panel["screen"]
        )
        windows = controller.query(
            [
                controller.AEROSPACE,
                "list-windows",
                "--monitor",
                str(monitor),
                "--workspace",
                "visible",
                "--json",
                "--format",
                "%{window-id}%{window-layout}",
            ]
        )
        frame = frames[panel["arrangement"]]
        for window in windows:
            if window["window-layout"] not in {
                "h_tiles",
                "v_tiles",
                "h_accordion",
                "v_accordion",
            }:
                continue
            rect = bounds.get(window["window-id"])
            if rect is None:
                raise AssertionError("Visible tiled window missing native geometry")
            assert rect["Y"] >= frame["y"] + height, "Tiled window overlaps SketchyBar"
            checked += 1
    assert checked, "No visible tiled windows available to verify"
    print(
        f"PASS: {checked} visible tiled windows clear SketchyBar on {len(panels)} displays"
    )


if __name__ == "__main__":
    if sys.argv[1:] == ["--live"]:
        live()
    else:
        unittest.main()
