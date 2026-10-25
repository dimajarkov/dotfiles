#!/usr/bin/env python3
"""Bounded native telemetry, without third-party packages.

CPU is aggregate host busy ticks / all host ticks over a short sample (0–100%).
RAM is (active + wired + compressor physical pages) / hw.memsize. Inactive,
free, speculative and purgeable/cache pages are not added; compressed logical
pages are never added to their physical compressor storage a second time.
"""

import ctypes
import math
import re
import subprocess
import time

TEXT = "0xffe8e6e1"
GREEN = "0xffa6da95"
AMBER = "0xffeed49f"
RED = "0xffed8796"


def run(args):
    return subprocess.check_output(args, text=True, timeout=3)


def cpu_ticks():
    lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
    lib.mach_host_self.restype = ctypes.c_uint
    lib.host_statistics.argtypes = [
        ctypes.c_uint,
        ctypes.c_int,
        ctypes.POINTER(ctypes.c_uint),
        ctypes.POINTER(ctypes.c_uint),
    ]
    ticks = (ctypes.c_uint * 4)()
    count = ctypes.c_uint(4)
    if (
        lib.host_statistics(lib.mach_host_self(), 3, ticks, ctypes.byref(count))
        or count.value != 4
    ):
        raise ValueError("host CPU counters unavailable")
    return tuple(ticks)  # user, system, idle, nice; aggregated across all cores


def cpu_percent(before, after):
    if len(before) != 4 or len(after) != 4:
        raise ValueError("invalid CPU counters")
    delta = [(b - a) % (2**32) for a, b in zip(before, after)]
    total = sum(delta)
    if total <= 0:
        raise ValueError("invalid CPU sample")
    return 100 * (total - delta[2]) / total


def ram_percent(sample, physical):
    header = re.search(r"page size of (\d+) bytes", sample)
    if not header or physical <= 0:
        raise ValueError("invalid physical memory")
    pages = {}
    for name in ("Pages active", "Pages wired down", "Pages occupied by compressor"):
        match = re.search(r"^" + name + r":\s*(\d+)\.", sample, re.MULTILINE)
        if not match:
            raise ValueError("missing VM counter")
        pages[name] = int(match[1])
    used = sum(pages.values()) * int(header[1])
    if used > physical or int(header[1]) <= 0:
        raise ValueError("inconsistent VM counters")
    return 100 * used / physical


def percentage(value):
    if not math.isfinite(value) or not 0 <= value <= 100:
        raise ValueError("invalid percentage")
    return f"{value:.0f}%"


def cpu_color(value):
    # Match the displayed rounded percentage at the threshold boundaries.
    displayed = int(percentage(value)[:-1])
    return RED if displayed >= 90 else AMBER if displayed >= 70 else GREEN


def memory_pressure_color(sample):
    # XNU exports dispatch pressure flags here, not its internal 0-based enum.
    # Unknown/unavailable telemetry stays neutral rather than claiming health.
    return {"1": GREEN, "2": AMBER, "4": RED}.get(sample.strip(), TEXT)


def battery_properties(sample):
    match = re.search(r"InternalBattery[^\n]*?\s(\d+)%;", sample)
    if not match:
        return (
            ["drawing=on", "icon=", "label=--"]
            if "InternalBattery" in sample
            else ["drawing=off"]
        )
    value = int(match[1])
    if value > 100:
        return ["drawing=on", "icon=", "label=--"]
    icon = "" if value <= 20 else "" if value <= 50 else ""
    charging = "charging;" in sample and "discharging;" not in sample
    return [
        "drawing=on",
        "icon=" + icon + ("" if charging else ""),
        "icon.color=" + TEXT,
        "label.color=" + TEXT,
        f"label={value}%",
    ]


def main(name):
    if name == "battery":
        try:
            props = battery_properties(run(["/usr/bin/pmset", "-g", "batt"]))
        except (OSError, ValueError, subprocess.SubprocessError):
            props = ["drawing=on", "icon=", "label=--"]
        subprocess.run(
            ["sketchybar", "--set", "battery", *props], timeout=3, check=True
        )
        return
    cpu = ram = "--"
    cpu_tint = ram_tint = TEXT
    try:
        before = cpu_ticks()
        time.sleep(0.2)
        value = cpu_percent(before, cpu_ticks())
        cpu = percentage(value)
        cpu_tint = cpu_color(value)
    except (OSError, ValueError, AttributeError):
        pass
    try:
        ram = percentage(
            ram_percent(
                run(["/usr/bin/vm_stat"]),
                int(run(["/usr/sbin/sysctl", "-n", "hw.memsize"])),
            )
        )
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    if ram != "--":
        try:
            ram_tint = memory_pressure_color(
                run(["/usr/sbin/sysctl", "-n", "kern.memorystatus_vm_pressure_level"])
            )
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
    subprocess.run(
        [
            "sketchybar",
            "--set",
            "cpu",
            "label=" + cpu,
            "label.color=" + cpu_tint,
            "--set",
            "ram",
            "label=" + ram,
            "label.color=" + ram_tint,
        ],
        timeout=3,
        check=True,
    )


if __name__ == "__main__":
    import sys

    main(sys.argv[1] if len(sys.argv) > 1 else "metrics")
