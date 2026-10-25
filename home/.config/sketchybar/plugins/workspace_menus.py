#!/usr/bin/env python3
"""Exclusive, display-independent lifecycle for owned workspace popups only."""

import argparse
import ctypes
import json
import math
import re
import subprocess

from workspaces import lock, run


def host_id(name):
    return (
        isinstance(name, str)
        and re.fullmatch(
            r"(?:wsc\.space\.[a-f0-9]{24}(?:\.d[1-9][0-9]*)?|space\.[1-7]|wsc\.overflow(?:\.d[1-9][0-9]*)?)",
            name,
        )
        is not None
    )


def current_point():
    """Read the current cursor in the same CG coordinates as native item bounds."""

    class Point(ctypes.Structure):
        _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]

    cg = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
    cf = ctypes.CDLL(
        "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"
    )
    cg.CGEventCreate.argtypes = [ctypes.c_void_p]
    cg.CGEventCreate.restype = ctypes.c_void_p
    cg.CGEventGetLocation.argtypes = [ctypes.c_void_p]
    cg.CGEventGetLocation.restype = Point
    cf.CFRelease.argtypes = [ctypes.c_void_p]
    cf.CFRelease.restype = None
    event = cg.CGEventCreate(None)
    if not event:
        raise ValueError("unavailable cursor position")
    try:
        point = cg.CGEventGetLocation(event)
        return point.x, point.y
    finally:
        cf.CFRelease(event)


def rectangles(item, display):
    result = []
    for key, rect in item["bounding_rects"].items():
        if display and key != "display-" + display:
            continue
        x, y = rect["origin"]
        width, height = rect["size"]
        if (
            not all(
                type(v) in (int, float) and math.isfinite(v)
                for v in (x, y, width, height)
            )
            or width <= 0
            or height <= 0
        ):
            raise ValueError("invalid menu geometry")
        if (x, y, width, height) != (-9999, -9999, 1, 1):
            result.append((x, y, width, height))
    return result


def number(value):
    if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
        raise ValueError("invalid menu padding")
    return value


class Menus:
    def __init__(self, execute=None, guard=None, position=None):
        self.execute = execute or run
        self.guard = guard or lock
        self.position = position or current_point

    def _query(self, name):
        return json.loads(self.execute(["sketchybar", "--query", name]))

    def _hosts(self):
        items = self._query("bar")["items"]
        if not isinstance(items, list):
            raise ValueError("invalid bar inventory")
        return sorted({name for name in items if host_id(name)})

    def toggle(self, host):
        if not host_id(host):
            raise ValueError("invalid workspace menu host")
        with self.guard("apply.lock"):
            hosts = self._hosts()
            if host not in hosts:
                return
            opened = self._query(host)["popup"]["drawing"] == "on"
            args = ["sketchybar"]
            for name in hosts:
                args.extend(["--set", name, "popup.drawing=off"])
            if not opened:
                args.extend(["--set", host, "popup.drawing=on"])
            self.execute(args)  # One atomic bar batch; no other popup namespaces.

    def close(self):
        with self.guard("apply.lock"):
            hosts = self._hosts()
            if hosts:
                self.execute(
                    [
                        "sketchybar",
                        *[
                            part
                            for name in hosts
                            for part in ("--set", name, "popup.drawing=off")
                        ],
                    ]
                )

    def exit(self, host):
        if not host_id(host):
            return
        with self.guard("apply.lock"):
            item = self._query(host)
            popup = item["popup"]
            if popup["drawing"] != "on":
                return  # Delayed exit from an older menu cannot close another host.
            display = (
                host.rsplit(".d", 1)[1] if re.search(r"\.d[1-9][0-9]*$", host) else None
            )
            regions = rectangles(item, display)
            children = popup["items"]
            if not isinstance(children, list) or not all(
                isinstance(name, str)
                and re.fullmatch(
                    r"wsc\.(?:popup|entry|rename|reset|renameentry|resetentry)\.[a-f0-9]{24}(?:\.d[1-9][0-9]*)?",
                    name,
                )
                for name in children
            ):
                raise ValueError("invalid workspace popup membership")
            if children:
                # Batched queries are one native snapshot/IPC, not one per row.
                raw = self.execute(
                    [
                        "sketchybar",
                        *[part for name in children for part in ("--query", name)],
                    ]
                )
                decoder, offset, bounds = json.JSONDecoder(), 0, []
                for _ in children:
                    offset += len(raw[offset:]) - len(raw[offset:].lstrip())
                    child, offset = decoder.raw_decode(raw, offset)
                    if child["geometry"]["drawing"] != "on":
                        continue
                    background = child["geometry"].get("background", {})
                    left = number(background.get("padding_left", 0))
                    right = number(background.get("padding_right", 0))
                    bounds.extend(
                        (x - left, y, width + left + right, height)
                        for x, y, width, height in rectangles(child, display)
                    )
                if raw[offset:].strip():
                    raise ValueError("unexpected menu query result")
                if bounds:
                    # Version 2.23 popup.c uses one vertical content rectangle,
                    # with border above/below and to the right of the row union.
                    border = number(popup["background"]["border_width"])
                    x = min(r[0] for r in bounds)
                    y = min(r[1] for r in bounds) - border
                    right = max(r[0] + r[2] for r in bounds) + border
                    bottom = max(r[1] + r[3] for r in bounds) + border
                    regions.append((x, y, right - x, bottom - y))
            # Events carry no timestamp or destination. Re-check the live cursor
            # after geometry, so stale global notifications cannot dismiss a newly
            # opened menu or close it while the cursor is within its dropdown.
            px, py = self.position()
            if not all(type(v) in (int, float) and math.isfinite(v) for v in (px, py)):
                raise ValueError("invalid cursor position")
            if not any(
                x <= px <= x + width and y <= py <= y + height
                for x, y, width, height in regions
            ):
                self.execute(["sketchybar", "--set", host, "popup.drawing=off"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("toggle", "close", "exit"))
    parser.add_argument("host", nargs="?", default="")
    args = parser.parse_args()
    try:
        menus = Menus()
        if args.action == "toggle":
            menus.toggle(args.host)
        elif args.action == "exit":
            menus.exit(args.host)
        else:
            menus.close()
    except (
        OSError,
        ValueError,
        KeyError,
        TypeError,
        subprocess.SubprocessError,
        TimeoutError,
    ):
        return 1  # No workspace identities or raw native state in logs.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
