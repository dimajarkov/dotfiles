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
    return header_width(workspace) + GROUP_GAP + count * APP_WIDTH


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


def plan(groups, focused, existing, budget, display=None, viewports=None):
    # Constant widths are set at creation only, avoiding refresh animations.
    def hname(ws):
        return header(ws, display)

    def iname(kind, ws, bundle=""):
        return item_id(kind, ws, bundle, display)

    overflow = (
        PREFIX + "overflow" + (".d" + str(display) if display is not None else "")
    )
    args, desired, order, icons = [], set(), ["apple"], {}
    counts = {ws: len(apps) for ws, apps in groups.items()}
    compact = (
        sum(group_width(apps, counts[ws], ws) for ws, apps in groups.items()) > budget
    )

    scrolling = (
        compact
        and display is not None
        and all(header_width(ws) <= budget - 2 * MORE_WIDTH for ws in groups)
    )
    viewport = {
        "rows": [],
        "budget": budget - 2 * MORE_WIDTH,
        "start": 0,
        "selected": "",
    }
    if scrolling:
        if viewports is not None:
            viewports[str(display)] = viewport

    def scroll_script(action="scroll"):
        return command(sys.executable, Path(__file__).resolve(), action, str(display))

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
        if scrolling and position == "left":
            args.extend(
                [
                    "--set",
                    name,
                    "script=" + scroll_script(),
                    "--subscribe",
                    name,
                    "mouse.scrolled",
                ]
            )

    if scrolling:
        for direction, glyph in (("prev", "‹"), ("next", "›")):
            name = PREFIX + direction + ".d" + str(display)
            add(
                name,
                "left",
                [
                    "drawing=on",
                    "icon=" + glyph,
                    "icon.color=" + TEXT,
                    "icon.width=28",
                    "icon.align=center",
                    "label.drawing=off",
                    "padding_left=0",
                    "padding_right=0",
                    "background.padding_left=0",
                    "background.padding_right=0",
                    "click_script=" + scroll_script(direction),
                ],
                MORE_WIDTH,
            )
            if direction == "prev":
                order.append(name)

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
        for bundle, name, window_id in apps:
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
        if scrolling:
            for member in members:
                width = header_width(ws) if member == h else APP_WIDTH
                key = digest(ws)[:12] if member == h else digest(member)[:12]
                viewport["rows"].append([key, width, [member, bracket]])
            viewport["rows"].append([digest(gap)[:12], GROUP_GAP, [gap]])
    if scrolling:
        order.append(PREFIX + "next.d" + str(display))
        args.extend(viewport_args({str(display): viewport}, {digest(focused)[:12]}))
    if compact and not scrolling and budget >= MORE_WIDTH:
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


def plan_all(states, existing, viewports=None):
    """Merge independent panel plans into one atomic update and global ordering."""
    args, icons, order = [], {}, ["apple"]
    displays = {d["arrangement"] for d, _, _ in states}
    for display, groups, visible in states:
        local, app_icons = plan(
            groups,
            visible,
            existing,
            inline_budget(display),
            display["arrangement"],
            viewports,
        )
        if viewports is not None and str(display["arrangement"]) in viewports:
            viewports[str(display["arrangement"])]["screen"] = display.get(
                "identity", display["screen"]
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
                time.sleep(0.005)
        yield fd
    finally:
        if fd is not None:
            os.close(fd)
        os.close(directory)


def selection_item(name):
    return (
        re.fullmatch(r"wsc\.(space|group)\.([a-f0-9]{12})[a-f0-9]{12}\.d[0-9]+", name)
        if isinstance(name, str)
        else None
    )


def load_topology():
    """Only validated hashed badge/bracket IDs; no apps, titles or selection."""
    with lock("topology.lock") as fd:
        data = os.read(fd, 65537)
    if len(data) > 65536:
        return None
    try:
        names = json.loads(data)
    except (ValueError, UnicodeError):
        return None
    if not isinstance(names, list) or not all(selection_item(name) for name in names):
        return None
    return set(names)


def save_topology(names):
    # None invalidates the topology at reload; an empty list is a valid empty bar.
    data = json.dumps(
        sorted({name for name in names if selection_item(name)})
        if names is not None
        else None
    ).encode()
    with lock("topology.lock") as fd:
        os.write(fd, data)
        os.ftruncate(fd, len(data))


def viewport_rows(panel):
    """Contiguous header/icon slots; arrows are reserved outside this budget."""
    rows, used = [], 0
    for row in panel["rows"][panel["start"] :]:
        if used + row[1] > panel["budget"]:
            break
        rows.append(row)
        used += row[1]
    return rows


def viewport_args(panels, visible, step=None):
    args = []
    for display, panel in panels.items():
        rows = panel["rows"]
        selected = next((row[0] for row in rows if row[0] in visible), "")
        # Duplicate focus notifications and periodic inventory must not undo browsing.
        if selected != panel["selected"]:
            panel["selected"] = selected
            if selected and selected not in {row[0] for row in viewport_rows(panel)}:
                panel["start"] = next(
                    i for i, row in enumerate(rows) if row[0] == selected
                )
        last = len(rows) - 1
        while last > 0 and all(
            name.startswith(PREFIX + "gap.") for name in rows[last][2]
        ):
            last -= 1
        if step and step[0] == display:
            target = max(0, min(last, panel["start"] + step[1]))
            while 0 < target < last and all(
                name.startswith(PREFIX + "gap.") for name in rows[target][2]
            ):
                target += step[1]
            panel["start"] = target
        shown = {row[0] for row in viewport_rows(panel)}
        drawn = {name for key, _, names in rows if key in shown for name in names}
        for name in sorted({name for _, _, names in rows for name in names}):
            args.extend(
                ["--set", name, "drawing=" + ("on" if name in drawn else "off")]
            )
            if name.startswith(PREFIX + "space.") and name not in drawn:
                args.append("popup.drawing=off")
        for direction, available in (
            ("prev", panel["start"] > 0),
            ("next", rows[last][0] not in shown),
        ):
            args.extend(
                [
                    "--set",
                    PREFIX + direction + ".d" + display,
                    "icon.color=" + (TEXT if available else MUTED),
                ]
            )
    return args


def load_viewports():
    """Opaque IDs, widths and browse offsets only, in the existing private cache."""
    with lock("viewport.lock") as fd:
        data = os.read(fd, 262145)
    if len(data) > 262144:
        return {}
    try:
        panels = json.loads(data)
        if not isinstance(panels, dict):
            return {}
        for display, panel in panels.items():
            if not re.fullmatch(r"[1-9][0-9]*", display):
                return {}
            if set(panel) != {"rows", "budget", "start", "selected", "screen"}:
                return {}
            if any(type(panel[k]) is not int for k in ("budget", "start", "screen")):
                return {}
            rows = panel["rows"]
            if (
                not isinstance(rows, list)
                or not rows
                or not 0 <= panel["start"] < len(rows)
            ):
                return {}
            if not 1 <= panel["budget"] <= 100000 or panel["screen"] < 1:
                return {}
            if not re.fullmatch(r"(?:[a-f0-9]{12})?", panel["selected"]):
                return {}
            for key, width, names in rows:
                if (
                    not re.fullmatch(r"[a-f0-9]{12}", key)
                    or type(width) is not int
                    or not 0 < width <= panel["budget"]
                ):
                    return {}
                if not isinstance(names, list) or not names:
                    return {}
                if not all(
                    isinstance(name, str)
                    and re.fullmatch(
                        r"wsc\.(?:space|group|app|gap)\.[a-f0-9]{24}\.d" + display, name
                    )
                    for name in names
                ):
                    return {}
        return panels
    except (ValueError, TypeError, KeyError):
        return {}


def save_viewports(panels):
    data = json.dumps(panels).encode()
    with lock("viewport.lock") as fd:
        os.write(fd, data)
        os.ftruncate(fd, len(data))


def scroll(display, action="scroll"):
    if display is None:
        return
    # SketchyBar's positive wheel delta means up/left, toward earlier tabs.
    delta = (
        -float(os.environ.get("SCROLL_DELTA", "0"))
        if action == "scroll"
        else (1 if action == "next" else -1)
    )
    if not delta:
        return
    with lock("apply.lock"):
        panels = load_viewports()
        if str(display) not in panels:
            return
        # No AeroSpace command: browsing never changes workspace selection.
        visible = {panel["selected"] for panel in panels.values()}
        args = viewport_args(panels, visible, (str(display), 1 if delta > 0 else -1))
        if args:
            run(["sketchybar", *args])
            save_viewports(panels)


def invalidate():
    with lock("apply.lock"):
        save_topology(None)
        save_viewports({})


def selection_args(names, viewports=None):
    """Resolve current visibility, never a delayed event/inventory focus snapshot.

    AeroSpace workspace IDs are globally unique. Their hashes in the live bar's
    display-local names let us update all visible monitors without native geometry
    or an app inventory. Caller holds apply.lock across this query and the write.
    """
    visible = {
        digest(row["workspace"])[:12]
        for row in query(
            [AEROSPACE, "list-workspaces", "--monitor", "all", "--visible", "--json"]
        )
    }
    args = []
    for name in sorted(names):
        match = selection_item(name)
        if not match:
            continue
        kind, workspace = match.groups()
        active = workspace in visible
        props = (
            [
                "icon.background.color=" + ("0x44eed49f" if active else "0x663d3d3d"),
                "icon.background.border_color=" + (YELLOW if active else SURFACE),
                "icon.color=" + (YELLOW if active else TEXT),
            ]
            if kind == "space"
            else [
                "background.color=" + (ACTIVE if active else INACTIVE),
                "background.border_color=" + (YELLOW if active else SURFACE),
            ]
        )
        args.extend(["--set", name, *props])
    if viewports is None:
        viewports = load_viewports()
        args.extend(viewport_args(viewports, visible))
        if viewports:
            save_viewports(viewports)
    else:
        args.extend(viewport_args(viewports, visible))
    return args


def selection_generation(fd, bump=False):
    """A notification counter only: never persist workspace/app state."""
    os.lseek(fd, 0, os.SEEK_SET)
    generation = int(os.read(fd, 64) or b"0")
    if bump:
        generation += 1
        os.lseek(fd, 0, os.SEEK_SET)
        os.write(fd, str(generation).encode())
        os.ftruncate(fd, os.lseek(fd, 0, os.SEEK_CUR))
    return generation


def select():
    # Many native/front-app/subscription callbacks can describe one switch.
    # Elect one worker, not one queued current-state query per callback. The
    # generation check and worker handoff share a tiny notification lock, so a
    # notification arriving during an in-flight query/write cannot be dropped.
    with contextlib.ExitStack() as worker:
        with lock("selection-notify.lock") as fd:
            generation = selection_generation(fd, bump=True)
            try:
                worker.enter_context(lock("selection-worker.lock", wait=False))
            except TimeoutError:
                return  # elected worker will observe our newer generation
        while True:
            # No render lock, debounce, geometry, inventory or event snapshots.
            with lock("apply.lock"):
                names = load_topology()
                cached = names is not None
                if not cached:
                    names = query(["sketchybar", "--query", "bar"])["items"]
                args = selection_args(names)
                try:
                    if args:
                        run(["sketchybar", *args])
                except subprocess.SubprocessError:
                    save_topology(None)  # next notification rediscovers live IDs
                    save_viewports({})
                    raise
                if not cached:
                    save_topology(names)
            with lock("selection-notify.lock") as fd:
                latest = selection_generation(fd)
                if latest == generation:
                    # Release election while still excluding notifications: the
                    # next caller either wakes us or becomes the next worker.
                    worker.close()
                    return
                generation = latest


def render():
    # A running structural pass already reconciles everything; never queue copies.
    try:
        with lock("render.lock", wait=False):
            reconcile()
    except TimeoutError:
        pass


def reconcile():
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
            with lock("apply.lock"):
                run(["sketchybar", *args])
                save_topology([])
                save_viewports({})
        return
    viewports = {}
    args, _ = plan_all(states, existing, viewports)
    names = {args[i + 1] for i, arg in enumerate(args) if arg == "--set"}
    # Inventory/geometry run outside this short lock. Override their stale
    # colors in the same atomic batch, so a slow render cannot revert focus.
    with lock("apply.lock"):
        previous = load_viewports() if viewports else {}
        for panel, viewport in viewports.items():
            old = previous.get(panel, {})
            if old.get("screen") == viewport.get("screen"):
                viewport["start"] = min(old.get("start", 0), len(viewport["rows"]) - 1)
                viewport["selected"] = old.get("selected", "")
        selection = selection_args(names, viewports)
        run(["sketchybar", *bar_properties(displays), *args, *selection])
        save_topology(names)
        save_viewports(viewports)


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
                    pending = b""
                    while not stopped and child.poll() is None:
                        if selector.select(0.05):
                            data = os.read(child.stdout.fileno(), 65536)
                            if not data:
                                break
                            pending += data
                            lines = pending.split(b"\n")
                            pending = lines.pop()
                            # Event contents are invalidations, never selection
                            # snapshots. Drain a burst in one current-state query.
                            if lines:
                                try:
                                    select()
                                except (
                                    OSError,
                                    ValueError,
                                    KeyError,
                                    TypeError,
                                    subprocess.SubprocessError,
                                    TimeoutError,
                                ):
                                    pass  # periodic reconciliation recovers
                            for line in lines:
                                with contextlib.suppress(ValueError, UnicodeError):
                                    event = json.loads(line)
                                    if (
                                        isinstance(event, dict)
                                        and event.get("_event") == "window-detected"
                                    ):
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
    parser.add_argument(
        "action",
        choices=("render", "watch", "select", "invalidate", "scroll", "prev", "next"),
    )
    parser.add_argument("display", nargs="?", type=int)
    args = parser.parse_args()
    try:
        if args.action in {"scroll", "prev", "next"}:
            scroll(args.display, args.action)
        else:
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
