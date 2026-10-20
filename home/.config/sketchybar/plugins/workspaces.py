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

AEROSPACE = "/opt/homebrew/bin/aerospace"
IMAGE_SCALE = 0.6  # Tune against native image bounds on the actual mixed-DPI displays.
ROW_HEIGHT = 24
HEADER_HEIGHT = 22
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
    return PREFIX + kind + "." + digest(json.dumps([workspace, bundle]))


def workspace_key(value):
    return (
        (0, int(value), value)
        if value.isascii() and value.isdecimal()
        else (1, 0, value)
    )


def snapshot():
    spaces = query([AEROSPACE, "list-workspaces", "--all", "--json"])
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
    groups = {str(i): {} for i in range(1, 8)}
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
        apps = groups.setdefault(workspace, {})
        # Lowest window ID is a stable, deterministic click target within an app.
        if bundle not in apps or (app[2], app[1]) < (apps[bundle][2], apps[bundle][1]):
            apps[bundle] = app
    return {
        ws: sorted(groups[ws].values(), key=lambda a: a[0])
        for ws in sorted(groups, key=workspace_key)
    }, focused


def inline_budget():
    # CoreGraphics, like display.sh, identifies the built-in panel rather than
    # confusing AeroSpace monitor IDs with SketchyBar arrangement IDs.
    try:
        displays = run(["sketchybar", "--query", "displays"])
        height = float(
            run(
                [
                    "/usr/bin/osascript",
                    "-l",
                    "JavaScript",
                    "-e",
                    """
ObjC.import("CoreGraphics");
function run(argv) {
  const d = JSON.parse(argv[0]).find(d => $.CGDisplayIsBuiltin(d.DirectDisplayID));
  return d ? d.frame.h : 0;
}""",
                    displays,
                ]
            )
        )
        if height > 0:
            return max(0, min(600, int(height) - 360))
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    return 600


def allocation(groups, budget):
    counts = {ws: 0 for ws in groups}
    # Reserve disclosure rows up front, then distribute remaining rows fairly.
    remaining = max(
        0,
        budget
        - HEADER_HEIGHT * len(groups)
        - ROW_HEIGHT * sum(bool(apps) for apps in groups.values()),
    )
    while remaining >= ROW_HEIGHT:
        changed = False
        for ws, apps in groups.items():
            if counts[ws] < len(apps) and remaining >= ROW_HEIGHT:
                counts[ws] += 1
                remaining -= ROW_HEIGHT
                changed = True
        if not changed:
            break
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
    # New items already have dynamic width. Reapplying width=dynamic queues a
    # native width animation in 2.23, briefly changing vertical row advancement.
    args, desired, order, image_items = [], set(), ["apple"], {}
    counts = allocation(groups, budget)

    def add(name, position, props):
        desired.add(name)
        if name not in existing:
            args.extend(["--add", "item", name, position])
        args.extend(["--set", name, *props])

    for ws, apps in groups.items():
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
                "drawing=on",
                "icon=" + ws,
                "icon.drawing=on",
                "icon.font=SF Pro:Bold:11.0",
                "icon.width=28",
                "icon.align=center",
                "icon.padding_left=0",
                "icon.padding_right=0",
                "label.drawing=off",
                "background.height=22",
                "background.drawing=on",
                "background.padding_left=0",
                "background.padding_right=0",
                "padding_left=0",
                "padding_right=0",
                "background.color=" + (SURFACE if ws == focused else CLEAR),
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
                    + ["label.drawing=off", "click_script=" + focus],
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
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
            args = []
            if not any(owned(name) for name in existing):
                args, _ = plan({str(i): [] for i in range(1, 8)}, "", existing, 600)
                existing.update("space." + str(i) for i in range(1, 8))
            for name in sorted(existing):
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
                popup = name.startswith(PREFIX + "popup.")
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
    ):
        # No application identities, titles, event payloads or snapshots in logs.
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
