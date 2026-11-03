"""Click real Glow references through an isolated Herdr TUI and verify new panes.

Run: python3 tests/nvim-glow-herdr.py
Requires the installed Herdr, Neovim, Glow, and the user's Neovim plugins.
"""

import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import struct
import subprocess
import tempfile
import termios
import time
import uuid

CONFIG = Path(__file__).resolve().parents[1] / "home/.config/nvim"
SESSION = "glow-test-" + uuid.uuid4().hex[:10]
ENV = {k: v for k, v in os.environ.items() if not k.startswith("HERDR_")}
ENV.update(TERM="xterm-256color", COLORTERM="truecolor")
OUTPUT = bytearray()


def cli(*args):
    result = subprocess.run(
        ["herdr", "--session", SESSION, *args],
        env=ENV,
        text=True,
        capture_output=True,
        timeout=10,
        check=True,
    )
    if args[:2] == ("pane", "read"):
        return result.stdout
    return json.loads(result.stdout)["result"] if result.stdout.strip() else {}


def wait_for(read, predicate, label):
    deadline = time.monotonic() + 15
    state = None
    while time.monotonic() < deadline:
        drain(0.05)
        state = read()
        if predicate(state):
            return state
    raise AssertionError(f"Timed out: {label}: {state}")


def drain(seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if select.select([fd], [], [], 0.02)[0]:
            try:
                data = os.read(fd, 65536)
            except OSError as exc:
                if exc.errno == errno.EIO:
                    return
                raise
            OUTPUT.extend(data)
            if b"\x1b[6n" in data:
                os.write(fd, b"\x1b[1;1R")
            if b"\x1b]11;?" in data:
                os.write(fd, b"\x1b]11;rgb:1010/1010/1010\x1b\\")
            if b"\x1b]10;?" in data:
                os.write(fd, b"\x1b]10;rgb:eeee/eeee/eeee\x1b\\")


def expression(expr):
    return subprocess.run(
        ["nvim", "--server", str(socket), "--remote-expr", expr],
        text=True,
        capture_output=True,
        check=True,
        timeout=5,
    ).stdout.rstrip("\n")


def screen():
    return expression("""luaeval("(function() local rows={} for r=1,vim.o.lines do
        local cells={} for c=1,vim.o.columns do cells[#cells+1]=vim.fn.screenstring(r,c) end
        rows[#rows+1]=table.concat(cells) end return table.concat(rows,'\\\\n') end)()")""")


def panes():
    return cli("pane", "list")["panes"]


def read(pane):
    return cli("pane", "read", pane, "--source", "visible")


def editor_command(pane, command):
    cli("pane", "send-keys", pane, ":")
    cli("pane", "send-text", pane, command)
    cli("pane", "send-keys", pane, "enter")


with tempfile.TemporaryDirectory(prefix="glow-herdr-", dir="/tmp") as directory:
    root = Path(directory).resolve()
    config = root / "config"
    config.mkdir()
    (config / "nvim").symlink_to(CONFIG)
    (config / "herdr").mkdir()
    (config / "herdr/config.toml").write_text("onboarding = false\n")
    (root / "child.md").write_text(
        "# Child Preview\n\nOpened from the original Glow preview.\n"
    )
    (root / "sample.lua").write_text("-- Code target\n\nprint('hello')\n")
    (root / "reader's notes.md").write_text("# Spaced Filename\n")
    long_path = "nested-" * 23 + "/wrapped.md"
    (root / long_path).parent.mkdir()
    (root / long_path).write_text("# Wrapped Reference\n")
    source = root / "source.md"
    source.write_text(
        "# Source Preview\n\n`child.md`\n\n`sample.lua:3`\n\n"
        "`missing.md`\n\n`reader's notes.md`\n\n"
        + f"`{long_path}`\n\n"
        + "\n\n".join(f"Filler paragraph {i}" for i in range(60))
        + "\n\nBottom reference: `child.md`\n"
    )
    socket = root / "source.sock"
    ENV["XDG_CONFIG_HOME"] = str(config)
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(root)
        os.execvpe("herdr", ["herdr", "--session", SESSION], ENV)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 42, 160, 0, 0))
    try:
        drain(2)
        try:
            original = panes()[0]["pane_id"]
        except subprocess.CalledProcessError as exc:
            raise AssertionError(
                f"{exc.stderr}\n{OUTPUT.decode(errors='replace')}"
            ) from exc
        cli(
            "pane",
            "run",
            original,
            f"nvim --listen {socket} -i NONE -n +Glow -- {source}",
        )
        wait_for(lambda: socket.exists(), bool, "source Neovim starts")
        wait_for(
            screen,
            lambda s: "Source Preview" in s and "child.md" in s,
            "source Glow renders",
        )
        assert len(panes()) == 1

        def click(label):
            drain(0.2)
            rows = screen().splitlines()
            row = next(i for i, text in enumerate(rows, 1) if label in text)
            column = rows[row - 1].index(label) + 2
            # The source pane fills the sole content area; derive its offset
            # from the actual rendered Herdr terminal, not assumed sidebar size.
            # Herdr's pane rect is content-relative; locate the pane via its
            # source editor's screen dimensions and the fixed outer TUI grid.
            layout = cli("pane", "layout", "--pane", original)["layout"]
            area = layout["area"]
            rect = next(p["rect"] for p in layout["panes"] if p["pane_id"] == original)
            x = 160 - area["width"] + rect["x"] + column
            y = 1 + rect["y"] + row
            os.write(fd, f"\x1b[<0;{x};{y}M".encode())
            drain(0.1)
            os.write(fd, f"\x1b[<0;{x};{y}m".encode())
            drain(0.5)

        def open_target(label, heading):
            click(label)
            created = wait_for(
                panes, lambda ps: len(ps) == 2, f"click {label} splits Herdr"
            )
            new = next(p["pane_id"] for p in created if p["pane_id"] != original)
            wait_for(
                lambda: read(new),
                lambda s: heading in str(s),
                f"{label} opens in new pane",
            )
            layout = cli("pane", "layout", "--pane", original)["layout"]
            rects = {p["pane_id"]: p["rect"] for p in layout["panes"]}
            assert rects[new]["x"] > rects[original]["x"], layout
            assert "source.md" in screen() and expression("&buftype") == "terminal", (
                "original preview was replaced"
            )
            print(f"PASS: click {label} opens {heading} in a right-hand Herdr pane")
            return new

        cli("pane", "zoom", original, "--on")
        child = open_target("child.md", "Child Preview")
        assert not cli("pane", "layout", "--pane", original)["layout"]["zoomed"], (
            "new split must be visible"
        )
        # q must return to the referenced Markdown document, not a picker.
        cli("pane", "send-keys", child, "q")
        drain(0.3)
        result = root / "child-state.json"
        editor_command(
            child,
            "lua vim.fn.writefile({vim.json.encode({path=vim.api.nvim_buf_get_name(0),"
            "buftype=vim.bo.buftype})}," + repr(str(result)) + ")",
        )
        wait_for(lambda: result.exists(), bool, "child q restores editor")
        state = json.loads(result.read_text())
        assert state == {"path": str(root / "child.md"), "buftype": ""}, state
        cli("pane", "close", child)
        wait_for(panes, lambda ps: len(ps) == 1, "child closes")
        click("missing.md")
        drain(0.5)
        assert len(panes()) == 1, "missing file created an empty pane"
        print("PASS: missing file does not create a pane")
        child = open_target("reader's notes.md", "Spaced Filename")
        cli("pane", "close", child)
        wait_for(panes, lambda ps: len(ps) == 1, "spaced child closes")
        cli("pane", "send-keys", original, "ctrl+\\", "ctrl+n")
        assert expression("mode(1)") == "nt", (
            "terminal-normal click test must not run in terminal-input mode"
        )
        child = open_target("wrapped.md", "Wrapped Reference")
        cli("pane", "close", child)
        wait_for(panes, lambda ps: len(ps) == 1, "wrapped child closes")
        child = open_target("sample.lua:3", "hello")
        result = root / "code-state.json"
        editor_command(
            child,
            "lua vim.fn.writefile({vim.json.encode({path=vim.api.nvim_buf_get_name(0),"
            "buftype=vim.bo.buftype,line=vim.fn.line('.')})},"
            + repr(str(result))
            + ")",
        )
        wait_for(lambda: result.exists(), bool, "code editor state")
        state = json.loads(result.read_text())
        assert state == {"path": str(root / "sample.lua"), "buftype": "", "line": 3}, (
            state
        )
        print("PASS: code references open in the editor at the requested line")
        cli("pane", "close", child)
        wait_for(panes, lambda ps: len(ps) == 1, "code child closes")
        cli("pane", "send-keys", original, "i", "G")
        wait_for(
            screen,
            lambda s: "Bottom reference" in s,
            "source Glow scrolls to the bottom",
        )
        child = open_target("child.md", "Child Preview")
        print("PASS: reference clicks still work after scrolling the document")
    finally:
        # This unique named session and all its panes belong exclusively to this test.
        try:
            subprocess.run(
                ["herdr", "session", "stop", SESSION, "--json"],
                env=ENV,
                capture_output=True,
                timeout=10,
                check=True,
            )
        finally:
            os.close(fd)
            os.waitpid(pid, 0)
