#!/usr/bin/env python3
"""Reconcile AeroSpace membership without collecting titles or saving snapshots."""

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shlex
import signal
import stat
import subprocess
import time
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from display import bar_properties, geometry

AEROSPACE = "/opt/homebrew/bin/aerospace"
ROW_HEIGHT = 24
HEADER_WIDTH = 28
APP_WIDTH = 24
MORE_WIDTH = 28
GROUP_GAP = 8
INACTIVE = "0x552e2e2e"
ACTIVE = "0x66787874"
TEXT = "0xffe8e6e1"
MUTED = "0xffa5a5a2"
SURFACE = "0xff444443"
YELLOW = "0xffeed49f"
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


def header(workspace, display=None):
    if display is not None:
        return item_id("space", workspace, display=display)
    return (
        "space." + workspace
        if workspace in map(str, range(1, 8))
        else PREFIX + "space." + digest(workspace)
    )


def item_id(kind, workspace, bundle="", display=None):
    return (
        PREFIX
        + kind
        + "."
        + digest(workspace)[:12]
        + digest(bundle)[:12]
        + (".d" + str(display) if display is not None else "")
    )


def workspace_shortcuts(path=None):
    """Read literal Option-number workspace bindings from the main mode only."""
    path = Path(
        path
        or os.environ.get(
            "SKETCHYBAR_AEROSPACE_CONFIG", Path.home() / ".aerospace.toml"
        )
    )
    try:
        text = path.read_text()
    except (OSError, UnicodeError):
        return {}
    section = re.search(
        r"^\[mode\.main\.binding\]\s*\n(.*?)(?=^\[|\Z)", text, re.MULTILINE | re.DOTALL
    )
    if not section:
        return {}
    bindings = re.findall(
        r"^alt-([0-9])\s*=\s*(['\"])workspace ([^\n]*?)\2\s*(?:#.*)?$",
        section[1],
        re.MULTILINE,
    )
    return {workspace: number for number, _, workspace in bindings}


WORKSPACE_SHORTCUTS = workspace_shortcuts()


def workspace_label(workspace):
    number = WORKSPACE_SHORTCUTS.get(workspace)
    return f"{number} {workspace}" if number and number != workspace else workspace


def workspace_key(value):
    number = WORKSPACE_SHORTCUTS.get(value, value)
    return (
        (0, 10 if number == "0" else int(number), value)
        if number.isascii() and number.isdecimal()
        else (1, 0, value)
    )


def snapshot(display, monitors, windows):
    """One monitor's assigned workspaces (including empty) and visible selection."""
    matches = [
        m["monitor-id"]
        for m in monitors
        if int(m["monitor-appkit-nsscreen-screens-id"]) == display["screen"]
    ]
    if len(matches) != 1:
        raise ValueError("unavailable or ambiguous monitor mapping")
    monitor = matches[0]
    spaces = query([AEROSPACE, "list-workspaces", "--monitor", str(monitor), "--json"])
    focused = run(
        [AEROSPACE, "list-workspaces", "--monitor", str(monitor), "--visible"]
    ).strip()
    return membership(spaces, windows, focused)


def inventory(displays):
    if not displays:
        return []
    monitors = query(
        [
            AEROSPACE,
            "list-monitors",
            "--json",
            "--format",
            "%{monitor-id}%{monitor-appkit-nsscreen-screens-id}",
        ]
    )
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
    states = []
    for display in displays:
        try:
            groups, visible = snapshot(display, monitors, windows)
        except (
            OSError,
            ValueError,
            KeyError,
            TypeError,
            StopIteration,
            subprocess.SubprocessError,
        ):
            groups, visible = {}, ""
        states.append((display, groups, visible))
    return states


def membership(spaces, windows, focused):
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


def inline_budget(display):
    # Both halves remain independent: duplicated status controls occupy the right.
    # Reserve the center split even on unnotched panels, retaining a safe gutter.
    return max(0, int(display["left"]) - 48)


def workspace_badge(workspace):
    return WORKSPACE_SHORTCUTS.get(
        workspace, workspace if workspace.isdecimal() else ""
    )


def workspace_title(workspace):
    return "" if workspace == workspace_badge(workspace) else workspace


def header_width(workspace):
    # Separate fixed-width shortcut badge and conservatively sized name label.
    badge = HEADER_WIDTH if workspace_badge(workspace) else 0
    title = workspace_title(workspace)
    return max(HEADER_WIDTH, badge + (len(title) * 8 + 12 if title else 0))


def group_width(apps, count, workspace=""):
    return (
        header_width(workspace)
        + GROUP_GAP
        + count * APP_WIDTH
        + (MORE_WIDTH if count < len(apps) else 0)
    )


def allocation(groups, budget, focused=""):
    counts = {ws: 0 for ws in groups}
    used = sum(group_width(apps, 0, ws) for ws, apps in groups.items())
    # Fill the focused group first, then the remaining groups in stable order.
    for ws in sorted(groups, key=lambda ws: ws != focused):
        while counts[ws] < len(groups[ws]):
            extra = group_width(groups[ws], counts[ws] + 1, ws) - group_width(
                groups[ws], counts[ws], ws
            )
            if used + extra > budget:
                break
            counts[ws] += 1
            used += extra
    return counts


def command(*args):
    return shlex.join(map(str, args))


APP_FONT = "sketchybar-app-font:Regular:16.0"
FALLBACK_FONT = "Hack Nerd Font:Regular:15.0"
FALLBACK_ICON = "\uf2d0"  # Neutral window outline, never an unrendered ligature.
TERMINAL_NAMES = {
    "terminal",
    "iterm",
    "iterm2",
    "wezterm",
    "herdr",
    "ghostty",
    "kitty",
    "alacritty",
    "warp",
    "rio",
    "hyper",
    "tabby",
}
TERMINAL_BUNDLES = {
    "com.apple.terminal",
    "com.googlecode.iterm2",
    "com.github.wez.wezterm",
    "com.mitchellh.ghostty",
    "net.kovidgoyal.kitty",
    "org.alacritty",
    "dev.warp.warp-stable",
    "com.herdr.app",
    "com.herdr",
    "app.herdr",
}


def load_icon_map():
    """Read only the pinned package's literal table rows; never execute Lua."""
    path = Path(
        os.environ.get(
            "SKETCHYBAR_APP_FONT_MAP",
            str(Path.home() / ".local/share/sketchybar/icon_map.lua"),
        )
    )
    font = Path(
        os.environ.get(
            "SKETCHYBAR_APP_FONT_FILE",
            str(Path.home() / "Library/Fonts/sketchybar-app-font.ttf"),
        )
    )
    try:
        if not font.is_file():
            return {}
        rows = re.findall(
            r'^\s*\[ \[\[(.*?)\]\] \] = "(:[a-z0-9_-]+:)",\s*$',
            path.read_text(),
            re.MULTILINE,
        )
        return dict(rows)
    except (OSError, UnicodeError):
        return {}


ICON_MAP = load_icon_map()


def app_icon(bundle, name):
    if not ICON_MAP:
        return FALLBACK_ICON, FALLBACK_FONT
    if bundle.lower() in TERMINAL_BUNDLES or name.casefold() in TERMINAL_NAMES:
        glyph = ":terminal:"
    elif bundle.lower() == "com.openai.chat" or name.casefold() in {
        "chatgpt",
        "openai",
    }:
        glyph = ":openai:"
    elif bundle.lower() == "com.google.chrome.for.testing" or name in {
        "Google Chrome for Testing",
        "Chrome for Testing",
    }:
        glyph = ":google_chrome:"
    else:
        glyph = ICON_MAP.get(name, ":default:")
    return glyph, APP_FONT


def clear_images():
    # Empty paths clear cached native images in 2.23; "none" is a filename.
    return [
        prefix + suffix
        for prefix in (
            "background.image",
            "icon.background.image",
            "label.background.image",
        )
        for suffix in ("=", ".drawing=off")
    ]


def icon_properties(bundle, name):
    glyph, font = app_icon(bundle, name)
    return clear_images() + [
        "icon=" + glyph,
        "icon.font=" + font,
        "icon.color=" + TEXT,
        "icon.drawing=on",
        "icon.width=24",
        "icon.align=center",
        "icon.background.drawing=off",
    ]


def plan(groups, focused, existing, budget, display=None):
    # Constant widths are set at creation only, avoiding refresh animations.
    def hname(ws):
        return header(ws, display)

    def iname(kind, ws, bundle=""):
        return item_id(kind, ws, bundle, display)

    overflow = (
        PREFIX + "overflow" + (".d" + str(display) if display is not None else "")
    )
    args, desired, order, icons = [], set(), ["apple"], {}
    counts = allocation(groups, budget, focused)
    compact = (
        sum(group_width(apps, counts[ws], ws) for ws, apps in groups.items()) > budget
    )

    def add(name, position, props, width_override=None):
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
                args.extend(
                    [
                        "--set",
                        name,
                        "width="
                        + str(width if width_override is None else width_override),
                    ]
                )
        args.extend(["--set", name, *props])
        if display is not None:
            args.append("display=" + str(display))

    for ws, apps in groups.items():
        start = len(order)
        h = hname(ws)
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
                "icon=" + workspace_badge(ws),
                "icon.drawing=" + ("on" if workspace_badge(ws) else "off"),
                "icon.font=SF Pro:Bold:11.0",
                "icon.width=" + str(HEADER_WIDTH),
                "icon.align=center",
                "icon.padding_left=0",
                "icon.padding_right=0",
                "icon.background.drawing=on",
                "icon.background.height=" + str(ROW_HEIGHT),
                "icon.background.corner_radius=0",
                "icon.background.color="
                + ("0x44eed49f" if ws == focused else "0x663d3d3d"),
                "icon.background.border_width=1",
                "icon.background.border_color="
                + (YELLOW if ws == focused else SURFACE),
                "label=" + workspace_title(ws),
                "label.drawing=" + ("on" if workspace_title(ws) else "off"),
                "label.font=SF Pro:Semibold:11.0",
                "label.color=" + TEXT,
                "label.padding_left=6",
                "label.padding_right=6",
                "background.height=24",
                "background.drawing=on",
                "background.padding_left=0",
                "background.padding_right=0",
                "padding_left=0",
                "padding_right=0",
                "background.color=" + CLEAR,
                "icon.color=" + (YELLOW if ws == focused else TEXT),
                "popup.align=left",
                "popup.height=" + str(ROW_HEIGHT),
                "click_script=" + click,
            ],
            width_override=header_width(ws),
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
            popup_id = iname("popup", ws, bundle)
            add(
                popup_id,
                "popup." + h,
                row
                + icon_properties(bundle, name)
                + [
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
            icons[popup_id] = app_icon(bundle, name)
            if index < counts[ws]:
                app_id = iname("app", ws, bundle)
                add(
                    app_id,
                    "left",
                    row
                    + icon_properties(bundle, name)
                    + [
                        "drawing=" + ("off" if compact else "on"),
                        "label.drawing=off",
                        "click_script=" + focus,
                    ],
                )
                icons[app_id] = app_icon(bundle, name)
                order.append(app_id)
        hidden = len(apps) - counts[ws]
        if hidden:
            disclosure = iname("more", ws)
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
            or (
                name.startswith(
                    (
                        PREFIX + "app." + digest(ws)[:12],
                        PREFIX + "more." + digest(ws)[:12],
                    )
                )
                and (display is None or name.endswith(".d" + str(display)))
            )
        }
        bracket = iname("group", ws)
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
                "background.corner_radius=0",
                "background.border_width=1",
                "background.border_color=" + (YELLOW if ws == focused else SURFACE),
                "background.color=" + (ACTIVE if ws == focused else INACTIVE),
            ]
        )
        # Constant-width items ignore background padding for advancement in 2.23.
        if display is not None:
            args.extend(["--set", bracket, "display=" + str(display)])
        gap = iname("gap", ws)
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
            entry = iname("entry", ws)
            add(
                entry,
                "popup." + overflow,
                [
                    "drawing=on",
                    "icon.drawing=on",
                    "label.drawing=on",
                    "icon=" + WORKSPACE_SHORTCUTS.get(ws, ws),
                    "label=Workspace " + ws,
                    "click_script="
                    + command(AEROSPACE, "workspace", ws)
                    + "; "
                    + command("sketchybar", "--set", overflow, "popup.drawing=off"),
                ],
            )
            for bundle, name, window_id in apps:
                entry = iname("entry", ws, bundle)
                add(
                    entry,
                    "popup." + overflow,
                    icon_properties(bundle, name)
                    + [
                        "drawing=on",
                        "label=" + ws + " · " + name,
                        "label.drawing=on",
                        "click_script="
                        + command(AEROSPACE, "focus", "--window-id", window_id)
                        + "; "
                        + command("sketchybar", "--set", overflow, "popup.drawing=off"),
                    ],
                )
                icons[entry] = app_icon(bundle, name)
    for name in sorted(existing - desired):
        if owned(name) and (display is None or name.endswith(".d" + str(display))):
            args.extend(["--remove", name])
    order.extend(
        iname("popup", ws, app[0]) for ws, apps in groups.items() for app in apps
    )
    order.extend(
        name
        for name in (
            "workspace_controller",
            "display_controller",
            "clock",
            "date",
            "battery",
            "ram",
            "cpu",
        )
        if name in existing
    )
    args.extend(["--reorder", *order])
    return args, icons


def plan_all(states, existing):
    """Merge independent panel plans into one atomic update and global ordering."""
    args, icons, order = [], {}, ["apple"]
    displays = {d["arrangement"] for d, _, _ in states}
    for display, groups, visible in states:
        local, app_icons = plan(
            groups, visible, existing, inline_budget(display), display["arrangement"]
        )
        split = local.index("--reorder")
        args.extend(local[:split])
        order.extend(name for name in local[split + 1 :] if owned(name))
        icons.update(app_icons)
    for name in sorted(existing):
        if owned(name) and not any(name.endswith(".d" + str(d)) for d in displays):
            args.extend(["--remove", name])
    order.extend(
        name
        for name in (
            "workspace_controller",
            "display_controller",
            "clock",
            "date",
            "battery",
            "ram",
            "cpu",
        )
        if name in existing
    )
    args.extend(["--reorder", *order])
    return args, icons


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
        displays = []
        try:
            displays = geometry()
            states = inventory(displays)
        except (
            OSError,
            ValueError,
            KeyError,
            TypeError,
            StopIteration,
            subprocess.SubprocessError,
        ):
            args = bar_properties(displays)
            for name in sorted(existing):
                if owned(name):
                    args.extend(
                        [
                            "--set",
                            name,
                            *clear_images(),
                            "drawing=off",
                            "popup.drawing=off",
                        ]
                    )
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
        args, _ = plan_all(states, existing)
        run(["sketchybar", *bar_properties(displays), *args])


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
