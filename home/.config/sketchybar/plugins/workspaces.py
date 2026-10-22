#!/usr/bin/env python3
"""Reconcile AeroSpace membership without collecting titles or saving snapshots."""

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import selectors
import shlex
import signal
import stat
import subprocess
import time
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from display import geometry

AEROSPACE = "/opt/homebrew/bin/aerospace"
IMAGE_SCALE = 0.6  # Tune against native image bounds on the actual mixed-DPI displays.
ROW_HEIGHT = 24
HEADER_WIDTH = 28
APP_WIDTH = 24
MORE_WIDTH = 28
GROUP_GAP = 8
INACTIVE = "0x55363a4f"
ACTIVE = "0x665b466b"
TEXT = "0xffcad3f5"
MUTED = "0xff939ab7"
SURFACE = "0xff494d64"
RED = "0xffed8796"
CLEAR = "0x00000000"
PREFIX = "wsc."
EVENTS = (
    "focus-changed",
    "focused-workspace-changed",
    "focused-monitor-changed",
    "window-detected",
    "binding-triggered",
)


def run(args):
    return subprocess.run(
        args, capture_output=True, text=True, timeout=8, check=True
    ).stdout


def query(args):
    return json.loads(run(args))


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()[:24]


def header(workspace):
    return (
        "space." + workspace
        if workspace in map(str, range(1, 8))
        else PREFIX + "space." + digest(workspace)
    )


def item_id(kind, workspace, bundle=""):
    return PREFIX + kind + "." + digest(workspace)[:12] + digest(bundle)[:12]


def workspace_key(value):
    return (
        (0, int(value), value)
        if value.isascii() and value.isdecimal()
        else (1, 0, value)
    )


def snapshot():
    display = geometry()
    if not display:
        return {}, ""
    monitors = query(
        [
            AEROSPACE,
            "list-monitors",
            "--json",
            "--format",
            "%{monitor-id}%{monitor-appkit-nsscreen-screens-id}",
        ]
    )
    monitor = next(
        m["monitor-id"]
        for m in monitors
        if int(m["monitor-appkit-nsscreen-screens-id"]) == display["screen"]
    )
    spaces = query([AEROSPACE, "list-workspaces", "--monitor", str(monitor), "--json"])
    windows = query(
        [
            AEROSPACE,
            "list-windows",
            "--all",
            "--json",
            "--format",
            "%{workspace}%{app-bundle-id}%{app-name}%{window-id}",
        ]
    )
    focused = run([AEROSPACE, "list-workspaces", "--focused"]).strip()
    if not isinstance(spaces, list) or not isinstance(windows, list) or not focused:
        raise ValueError("unavailable snapshot")
    groups = {}
    for row in spaces:
        workspace = row["workspace"]
        if not isinstance(workspace, str) or not workspace:
            raise ValueError("invalid workspace")
        groups.setdefault(workspace, {})
    for row in windows:
        workspace, bundle, name = (
            row[k] for k in ("workspace", "app-bundle-id", "app-name")
        )
        window_id = row["window-id"]
        if (
            not all(isinstance(v, str) and v for v in (workspace, bundle, name))
            or isinstance(window_id, bool)
            or not str(window_id).isascii()
            or not str(window_id).isdecimal()
            or int(window_id) <= 0
        ):
            raise ValueError("invalid window")
        app = (bundle, name, int(window_id))
        if workspace not in groups:
            continue
        apps = groups[workspace]
        # Lowest window ID is a stable, deterministic click target within an app.
        if bundle not in apps or (app[2], app[1]) < (apps[bundle][2], apps[bundle][1]):
            apps[bundle] = app
    return {
        ws: sorted(groups[ws].values(), key=lambda a: a[0])
        for ws in sorted(groups, key=workspace_key)
    }, focused


def inline_budget():
    try:
        display = geometry()
        # Apple button (24 + inherited 8 padding), outer padding and a safe gutter.
        return max(0, int(display["left"]) - 48) if display else 0
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        return 0  # Fail closed: stale geometry must never put content in the notch.


def group_width(apps, count):
    return (
        HEADER_WIDTH
        + GROUP_GAP
        + count * APP_WIDTH
        + (MORE_WIDTH if count < len(apps) else 0)
    )


def allocation(groups, budget, focused=""):
    counts = {ws: 0 for ws in groups}
    used = sum(group_width(apps, 0) for apps in groups.values())
    # Fill the focused group first, then the remaining groups in stable order.
    for ws in sorted(groups, key=lambda ws: ws != focused):
        while counts[ws] < len(groups[ws]):
            extra = group_width(groups[ws], counts[ws] + 1) - group_width(
                groups[ws], counts[ws]
            )
            if used + extra > budget:
                break
            counts[ws] += 1
            used += extra
    return counts


def command(*args):
    return shlex.join(map(str, args))


def image_properties(bundle, prefix="background.image"):
    # Empty paths clear an image in 2.23; the string "none" is treated as a file.
    return [
        prefix + "=",
        prefix + "=app." + bundle,
        prefix + ".scale=" + str(IMAGE_SCALE),
        prefix + ".drawing=on",
    ]


def plan(groups, focused, existing, budget):
    # Constant widths are set at creation only, avoiding refresh animations.
    args, desired, order, image_items = [], set(), ["apple"], {}
    counts = allocation(groups, budget, focused)
    compact = sum(group_width(apps, counts[ws]) for ws, apps in groups.items()) > budget

    def add(name, position, props):
        desired.add(name)
        if name not in existing:
            args.extend(["--add", "item", name, position])
            if position == "left":
                width = (
                    APP_WIDTH
                    if name.startswith(PREFIX + "app.")
                    else GROUP_GAP
                    if name.startswith(PREFIX + "gap.")
                    else HEADER_WIDTH
                )
                args.extend(["--set", name, "width=" + str(width)])
        args.extend(["--set", name, *props])

    for ws, apps in groups.items():
        start = len(order)
        h = header(ws)
        toggle = command("sketchybar", "--set", h, "popup.drawing=toggle")
        click = (
            'if [ "$BUTTON" = right ]; then '
            + toggle
            + "; else "
            + command(AEROSPACE, "workspace", ws)
            + "; fi"
        )
        add(
            h,
            "left",
            [
                "drawing=" + ("off" if compact else "on"),
                "icon=" + ws,
                "icon.drawing=on",
                "icon.font=SF Pro:Bold:11.0",
                "icon.width=28",
                "icon.align=center",
                "icon.padding_left=0",
                "icon.padding_right=0",
                "label.drawing=off",
                "background.height=24",
                "background.drawing=on",
                "background.padding_left=0",
                "background.padding_right=0",
                "padding_left=0",
                "padding_right=0",
                "background.color=" + CLEAR,
                "icon.color=" + (RED if ws == focused else TEXT),
                "popup.align=left",
                "popup.height=" + str(ROW_HEIGHT),
                "click_script=" + click,
            ],
        )
        order.append(h)
        for index, (bundle, name, window_id) in enumerate(apps):
            row = [
                "background.height=" + str(ROW_HEIGHT),
                "background.color=" + CLEAR,
                "background.drawing=on",
                "background.padding_left=0",
                "background.padding_right=0",
                "padding_left=0",
                "padding_right=0",
                "icon.drawing=off",
                "icon.padding_left=0",
                "icon.padding_right=0",
                "drawing=on",
            ]
            focus = command(AEROSPACE, "focus", "--window-id", window_id)
            popup_id = item_id("popup", ws, bundle)
            add(
                popup_id,
                "popup." + h,
                row
                + image_properties(bundle, "icon.background.image")
                + [
                    "background.image=",
                    "icon.drawing=on",
                    "icon=",
                    "icon.width=24",
                    "icon.background.drawing=on",
                    "icon.background.color=" + CLEAR,
                    "label.padding_left=6",
                    "label.padding_right=8",
                    "label.drawing=on",
                    "label=" + name,
                    "label.color=" + TEXT,
                    "label.font=SF Pro:Regular:12.0",
                    "click_script="
                    + focus
                    + "; "
                    + command("sketchybar", "--set", h, "popup.drawing=off"),
                ],
            )
            image_items[popup_id] = bundle
            if index < counts[ws]:
                app_id = item_id("app", ws, bundle)
                add(
                    app_id,
                    "left",
                    row
                    + image_properties(bundle)
                    + [
                        "drawing=" + ("off" if compact else "on"),
                        "label.drawing=off",
                        "click_script=" + focus,
                    ],
                )
                image_items[app_id] = bundle
                order.append(app_id)
        hidden = len(apps) - counts[ws]
        if hidden:
            disclosure = item_id("more", ws)
            add(
                disclosure,
                "left",
                [
                    "drawing=" + ("off" if compact else "on"),
                    "icon=+" + str(hidden),
                    "icon.drawing=on",
                    "icon.font=SF Pro:Bold:11.0",
                    "icon.color=" + TEXT,
                    "icon.width=28",
                    "icon.align=center",
                    "icon.padding_left=0",
                    "icon.padding_right=0",
                    "label.drawing=off",
                    "background.height=" + str(ROW_HEIGHT),
                    "background.color=" + CLEAR,
                    "background.drawing=on",
                    "background.padding_left=0",
                    "background.padding_right=0",
                    "padding_left=0",
                    "padding_right=0",
                    "click_script=" + toggle,
                ],
            )
            order.append(disclosure)
        # Bracket membership is captured at creation, not a live regex binding.
        # Rebuild only when inline membership changes; unchanged refreshes keep
        # the background window and every constant-width item untouched.
        members = order[start:]
        previous = {
            name
            for name in existing
            if name == h
            or name.startswith(
                (PREFIX + "app." + digest(ws)[:12], PREFIX + "more." + digest(ws)[:12])
            )
        }
        bracket = item_id("group", ws)
        desired.add(bracket)
        rebuild = bracket in existing and previous != set(members)
        if rebuild:
            args.extend(["--remove", bracket])
        if bracket not in existing or rebuild:
            args.extend(["--add", "bracket", bracket, *members])
        args.extend(
            [
                "--set",
                bracket,
                "drawing=" + ("off" if compact else "on"),
                "background.drawing=on",
                "background.height=24",
                "background.corner_radius=7",
                "background.border_width=1",
                "background.border_color=" + (RED if ws == focused else SURFACE),
                "background.color=" + (ACTIVE if ws == focused else INACTIVE),
            ]
        )
        # Constant-width items ignore background padding for advancement in 2.23.
        gap = item_id("gap", ws)
        add(
            gap,
            "left",
            [
                "drawing=" + ("off" if compact else "on"),
                "icon.drawing=off",
                "label.drawing=off",
                "background.drawing=off",
                "background.padding_left=0",
                "background.padding_right=0",
            ],
        )
        order.append(gap)
    if compact and budget >= MORE_WIDTH:
        # Unusually narrow panels / many workspace IDs: keep every workspace and
        # application reachable in one complete popup rather than cross the notch.
        overflow = PREFIX + "overflow"
        add(
            overflow,
            "left",
            [
                "drawing=on",
                "icon=+" + str(len(groups)),
                "icon.width=28",
                "label.drawing=off",
                "popup.align=left",
                "click_script="
                + command("sketchybar", "--set", overflow, "popup.drawing=toggle"),
            ],
        )
        order.append(overflow)
        for ws, apps in groups.items():
            entry = item_id("entry", ws)
            add(
                entry,
                "popup." + overflow,
                [
                    "drawing=on",
                    "icon.drawing=on",
                    "label.drawing=on",
                    "icon=" + ws,
                    "label=Workspace " + ws,
                    "click_script="
                    + command(AEROSPACE, "workspace", ws)
                    + "; "
                    + command("sketchybar", "--set", overflow, "popup.drawing=off"),
                ],
            )
            for bundle, name, window_id in apps:
                entry = item_id("entry", ws, bundle)
                add(
                    entry,
                    "popup." + overflow,
                    image_properties(bundle, "icon.background.image")
                    + [
                        "drawing=on",
                        "icon=",
                        "icon.width=24",
                        "icon.drawing=on",
                        "icon.background.drawing=on",
                        "label=" + ws + " · " + name,
                        "label.drawing=on",
                        "click_script="
                        + command(AEROSPACE, "focus", "--window-id", window_id)
                        + "; "
                        + command("sketchybar", "--set", overflow, "popup.drawing=off"),
                    ],
                )
                image_items[entry] = bundle
    for name in sorted(existing - desired):
        if owned(name):
            args.extend(["--remove", name])
    order.extend(
        item_id("popup", ws, app[0]) for ws, apps in groups.items() for app in apps
    )
    order.extend(
        name
        for name in (
            "workspace_controller",
            "display_controller",
            "clock",
            "date",
            "battery",
            "volume",
        )
        if name in existing
    )
    args.extend(["--reorder", *order])
    return args, image_items


def owned(name):
    return name.startswith(PREFIX) or name in {"space." + str(i) for i in range(1, 8)}


@contextlib.contextmanager
def lock(name, wait=True):
    # Open directory and lock relative to its descriptor: never follow symlinks.
    cache = Path.home() / ".cache"
    cache.mkdir(mode=0o700, exist_ok=True)
    parent = os.open(cache, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            os.mkdir("sketchybar-workspaces", mode=0o700, dir_fd=parent)
        except FileExistsError:
            pass
        directory = os.open(
            "sketchybar-workspaces",
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
            dir_fd=parent,
        )
    finally:
        os.close(parent)
    fd = None
    try:
        info = os.fstat(directory)
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise PermissionError("controller cache must be owner-private")
        fd = os.open(
            name, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600, dir_fd=directory
        )
        info = os.fstat(fd)
        if (
            info.st_uid != os.getuid()
            or not stat.S_ISREG(info.st_mode)
            or info.st_nlink != 1
            or stat.S_IMODE(info.st_mode) != 0o600
        ):
            raise PermissionError("unsafe controller lock")
        deadline = time.monotonic() + (10 if wait else 0)
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError("controller busy")
                time.sleep(0.05)
        yield
    finally:
        if fd is not None:
            os.close(fd)
        os.close(directory)


def render():
    with lock("render.lock"):
        existing = set(query(["sketchybar", "--query", "bar"])["items"])
        try:
            groups, focused = snapshot()
        except (
            OSError,
            ValueError,
            KeyError,
            TypeError,
            StopIteration,
            subprocess.SubprocessError,
        ):
            args = []
            for name in sorted(existing):
                if owned(name):
                    args.extend(["--set", name, "drawing=off"])
                if name.startswith(PREFIX + "space.") or name in {
                    "space." + str(i) for i in range(1, 8)
                }:
                    args.extend(
                        [
                            "--set",
                            name,
                            "background.color=" + CLEAR,
                            "icon.color=" + MUTED,
                            "popup.drawing=off",
                            "drawing=off",
                        ]
                    )
            if args:
                run(["sketchybar", *args])
            return
        args, images = plan(groups, focused, existing, inline_budget())
        try:
            run(["sketchybar", *args])
        except subprocess.CalledProcessError:
            # Isolate lookup failures on the error path only: one missing app
            # must not replace every other application's native image.
            fallback = []
            for name, bundle in images.items():
                popup = not name.startswith(PREFIX + "app.")
                prefix = "icon.background.image" if popup else "background.image"
                try:
                    run(
                        [
                            "sketchybar",
                            "--set",
                            name,
                            *image_properties(bundle, prefix),
                            "icon.drawing=" + ("on" if popup else "off"),
                        ]
                    )
                except subprocess.CalledProcessError:
                    fallback.extend(
                        [
                            "--set",
                            name,
                            prefix + "=",
                            prefix + ".drawing=off",
                            "icon=?",
                            "icon.drawing=on",
                            "icon.color=" + MUTED,
                        ]
                    )
            if fallback:
                run(["sketchybar", *fallback])


def trigger():
    try:
        run(["sketchybar", "--trigger", "aerospace_state_change"])
    except (OSError, subprocess.SubprocessError):
        pass


def watch():
    with lock("watch.lock", wait=False):
        stopped = False

        def stop(_signum, _frame):
            nonlocal stopped
            stopped = True

        for sig in (signal.SIGTERM, signal.SIGINT):
            signal.signal(sig, stop)
        backoff = 0.5
        while not stopped:
            child = None
            started = time.monotonic()
            try:
                child = subprocess.Popen(
                    [AEROSPACE, "subscribe", *EVENTS],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                )
                trigger()  # Initial state and reconnect invalidation.
                with selectors.DefaultSelector() as selector:
                    selector.register(child.stdout, selectors.EVENT_READ)
                    last_trigger = time.monotonic()
                    dirty_at = None
                    while not stopped and child.poll() is None:
                        if selector.select(0.1):
                            data = os.read(child.stdout.fileno(), 65536)
                            if not data:
                                break
                            dirty_at = time.monotonic()
                        now = time.monotonic()
                        if now - last_trigger >= 5 or (
                            dirty_at is not None
                            and (now - dirty_at >= 0.2 or now - last_trigger >= 1)
                        ):
                            trigger()
                            last_trigger = now
                            dirty_at = None
            except (OSError, subprocess.SubprocessError):
                pass
            finally:
                if child is not None:
                    if child.poll() is None:
                        child.terminate()
                    try:
                        child.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait()
                    child.stdout.close()
                trigger()  # Trailing refresh even on disconnect.
            if time.monotonic() - started > 10:
                backoff = 0.5
            deadline = time.monotonic() + backoff
            while not stopped and time.monotonic() < deadline:
                time.sleep(0.1)
            backoff = min(5, backoff * 2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("render", "watch"))
    args = parser.parse_args()
    try:
        globals()[args.action]()
    except (
        OSError,
        ValueError,
        KeyError,
        TypeError,
        subprocess.SubprocessError,
        TimeoutError,
        StopIteration,
    ):
        # No application identities, titles, event payloads or snapshots in logs.
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
