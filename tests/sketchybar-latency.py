#!/usr/bin/env python3
"""Opt-in live switch-to-highlight timing; restores original visible workspaces.

Changes workspace focus briefly, never moves windows or collects window titles.
"""

import argparse
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
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)


def query(name):
    return json.loads(
        subprocess.check_output(["sketchybar", "--query", name], text=True, timeout=3)
    )


def matches(workspace, display, active):
    item = query(w.header(workspace, display))
    group = query(w.item_id("group", workspace, display=display))
    badge, background = item["icon"], group["geometry"]["background"]
    border = w.YELLOW if active else w.SURFACE
    return (
        badge["color"] == (w.YELLOW if active else w.TEXT)
        and badge["background"]["color"] == ("0x44eed49f" if active else "0x663d3d3d")
        and badge["background"]["border_color"] == border
        and background["color"] == (w.ACTIVE if active else w.INACTIVE)
        and background["border_color"] == border
    )


def switch(workspace):
    subprocess.run(
        [w.AEROSPACE, "workspace", workspace],
        check=True,
        capture_output=True,
        timeout=8,
    )


def wait_ready(states, timeout=8):
    """Bounded pre-switch gate only; timed samples never retry missing items."""
    deadline = time.monotonic() + timeout
    required = {
        name
        for display, groups, _ in states
        for workspace in groups
        for name in (
            w.header(workspace, display["arrangement"]),
            w.item_id("group", workspace, display=display["arrangement"]),
        )
    }
    while True:
        try:
            if required <= set(query("bar")["items"]) and all(
                matches(workspace, display["arrangement"], workspace == visible)
                for display, groups, visible in states
                for workspace in groups
            ):
                return
        except (subprocess.SubprocessError, json.JSONDecodeError, KeyError):
            pass  # only initial reload/IPC readiness, never a timing retry
        if time.monotonic() >= deadline:
            raise AssertionError("Bar membership/selection not ready before timing")
        time.sleep(0.05)


def burst_probe(count, first, second, panel, states, limit):
    # No highlight waits between commands: callbacks and full renders may overlap.
    for index in range(count):
        switch(first if index % 2 == 0 else second)
    target = first if count % 2 == 0 else second
    started = time.monotonic()
    switch(target)
    while not matches(target, panel["arrangement"], True):
        assert time.monotonic() - started < 8, "Burst final selection did not converge"
        time.sleep(0.005)
    elapsed = (time.monotonic() - started) * 1000
    print(
        f"Burst final convergence ({count} alternating switches): {elapsed:.0f}ms",
        flush=True,
    )
    assert elapsed <= limit, "Burst final convergence exceeds target"
    # Keep checking through a complete five-second reconciliation. No stale full
    # snapshot may reactivate the old badge/group, even on another monitor.
    visible = {
        row["workspace"]
        for row in w.query(
            [w.AEROSPACE, "list-workspaces", "--monitor", "all", "--visible", "--json"]
        )
    }
    deadline = time.monotonic() + 6
    scans = 0
    while time.monotonic() < deadline:
        for display, groups, _ in states:
            for workspace in groups:
                assert matches(
                    workspace, display["arrangement"], workspace in visible
                ), f"Selection reverted after burst: {workspace}"
        scans += 1
        time.sleep(0.025)
    print(
        f"PASS: {scans} complete multi-monitor selection scans; no stale reverts over 6s",
        flush=True,
    )


def measure(samples, limit, burst=0):
    original = w.run([w.AEROSPACE, "list-workspaces", "--focused"]).strip()
    states = w.inventory(w.geometry())
    panel, groups, visible = next(state for state in states if len(state[1]) >= 2)
    first = next(ws for ws in groups if ws != visible)
    second = visible
    timings = []
    wait_ready(states)
    try:
        for index in range(samples):
            target = first if index % 2 == 0 else second
            started = time.monotonic()
            switch(target)
            deadline = started + 8
            while True:
                if matches(target, panel["arrangement"], True):
                    break
                if time.monotonic() >= deadline:
                    raise AssertionError("Highlight did not converge within 8 seconds")
                time.sleep(0.005)
            timings.append((time.monotonic() - started) * 1000)
            print(f"Switch {index + 1}: {timings[-1]:.0f}ms", flush=True)
        if burst:
            burst_probe(burst, first, second, panel, states, limit)
    finally:
        for _, _, workspace in states:
            if workspace:
                subprocess.run(
                    [w.AEROSPACE, "workspace", workspace],
                    check=True,
                    capture_output=True,
                    timeout=8,
                )
        subprocess.run(
            [w.AEROSPACE, "workspace", original],
            check=True,
            capture_output=True,
            timeout=8,
        )
    timings.sort()
    p95 = timings[min(len(timings) - 1, int(len(timings) * 0.95))]
    print(
        f"Median: {timings[len(timings) // 2]:.0f}ms; p95: {p95:.0f}ms; target: {limit:.0f}ms"
    )
    assert p95 <= limit, "Workspace highlight latency exceeds target"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=int, default=8)
    parser.add_argument("--max-ms", type=float, default=250)
    parser.add_argument(
        "--burst",
        type=int,
        default=0,
        help="Opt-in alternating rapid switches, then verify no stale reverts over 6s",
    )
    args = parser.parse_args()
    assert args.samples >= 2 and args.max_ms > 0 and args.burst >= 0
    measure(args.samples, args.max_ms, args.burst)
