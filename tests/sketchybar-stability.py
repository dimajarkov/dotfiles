#!/usr/bin/env python3
"""Live temporal regression: unchanged workspace refreshes must not move headers.

Temporarily suspends only the bar's workspace controller, then restores it.
No workspace, window, application, or focus is changed.
"""

import concurrent.futures
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


def state():
    return controller.inventory(controller.geometry())


def measure(refreshes=8):
    names = []
    # Measure the currently browsed strip, not an assumed all-workspaces layout.
    # This deliberately does not reset the viewport or select a workspace.
    bar = controller.query(["sketchybar", "--query", "bar"])
    for name in bar["items"]:
        if not name.startswith(
            tuple(
                "wsc." + kind + "."
                for kind in ("space", "app", "gap", "prev", "next", "overflow")
            )
        ):
            continue
        item = controller.query(["sketchybar", "--query", name])
        if item["geometry"]["drawing"] == "on":
            names.append(name)
    assert names, "No safe workspace items: temporal probe is not applicable"
    frames = set()
    samples = 0

    def refresh():
        for _ in range(refreshes):
            controller.render()

    with concurrent.futures.ThreadPoolExecutor() as pool:
        future = pool.submit(refresh)
        started = time.monotonic()
        while not future.done() or time.monotonic() - started < 2:
            positions = {}
            for name in names:
                output = subprocess.check_output(
                    ["sketchybar", "--query", name], text=True
                )
                assert output.strip(), "Workspace item disappeared"
                positions[name] = json.loads(output)["bounding_rects"]
            frames.add(json.dumps(positions, sort_keys=True))
            samples += 1
        future.result()
    return frames, samples


if __name__ == "__main__":
    original = json.loads(
        subprocess.check_output(
            ["sketchybar", "--query", "workspace_controller"],
            text=True,
        )
    )["scripting"]["updates"]
    subprocess.run(
        ["sketchybar", "--set", "workspace_controller", "updates=off"], check=True
    )
    try:
        before = state()
        frames, samples = measure()
        assert before == state(), (
            "Inconclusive: membership, focus or safe display width changed during the probe"
        )
        print(
            f"{samples} temporal samples across 8 refreshes: {len(frames)} distinct horizontal workspace layouts"
        )
        assert len(frames) == 1, "JITTER: unchanged refreshes moved workspace headers"
        print("PASS: repeated unchanged refreshes keep workspace geometry stable")
    finally:
        subprocess.run(
            ["sketchybar", "--set", "workspace_controller", "updates=" + original],
            check=True,
        )
        controller.render()
