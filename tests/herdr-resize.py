"""Exercise resize keys through a disposable real Herdr TUI.

Run: python3 tests/herdr-resize.py [path/to/herdr]
"""

import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import time
import uuid

BINARY = str(Path(shutil.which(sys.argv[1] if len(sys.argv) > 1 else "herdr")).resolve())
CONFIG = Path(__file__).resolve().parents[1] / "home/.config/herdr/config.toml"
SESSION = "resize-test-" + uuid.uuid4().hex[:10]
ENV = {k: v for k, v in os.environ.items() if not k.startswith("HERDR_")}
ENV.update(TERM="xterm-256color", COLORTERM="truecolor")


def cli(*args):
    result = subprocess.run(
        [BINARY, "--session", SESSION, *args], env=ENV,
        text=True, capture_output=True, timeout=10, check=True,
    )
    return json.loads(result.stdout)["result"] if result.stdout.strip() else {}


def drain(seconds=0.2):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if select.select([fd], [], [], 0.02)[0]:
            try:
                data = os.read(fd, 65536)
            except OSError as exc:
                if exc.errno == errno.EIO:
                    return
                raise
            for query, reply in (
                (b"\x1b[6n", b"\x1b[1;1R"),
                (b"\x1b]11;?", b"\x1b]11;rgb:1010/1010/1010\x1b\\"),
                (b"\x1b]10;?", b"\x1b]10;rgb:eeee/eeee/eeee\x1b\\"),
            ):
                if query in data:
                    os.write(fd, reply)


def send(keys):
    os.write(fd, keys)
    drain()


def size(pane, dimension):
    layout = cli("pane", "layout", "--pane", pane)["layout"]
    return next(p["rect"][dimension] for p in layout["panes"] if p["pane_id"] == pane)


with tempfile.TemporaryDirectory(prefix="herdr-resize-") as directory:
    ENV["HERDR_CONFIG_PATH"] = str(Path(directory) / "config.toml")
    # Keep the real key configuration; disable notification and network side effects.
    text = CONFIG.read_text().split("[ui]")[0]
    Path(ENV["HERDR_CONFIG_PATH"]).write_text(
        text + '\n[ui]\nsidebar_start_collapsed = true\n'
        '[update]\nversion_check = false\nmanifest_check = false\n'
    )
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(directory)
        os.execvpe(BINARY, [BINARY, "--session", SESSION], ENV)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 42, 160, 0, 0))
    try:
        drain(2)
        original = cli("pane", "list")["panes"][0]["pane_id"]
        for direction, dimension, keys in (
            ("right", "width", ((b"l", -1), (b";", 1))),
            ("down", "height", ((b"j", 1), (b"k", -1))),
        ):
            sibling = cli("pane", "split", original, "--direction", direction,
                          "--cwd", directory, "--no-focus")["pane"]["pane_id"]
            drain()
            send(b"\tr")
            for key, sign in keys:
                before = size(original, dimension)
                send(key)
                after = size(original, dimension)
                assert (after - before) * sign > 0, (
                    f"resize {key.decode()}: expected {'increase' if sign > 0 else 'decrease'} "
                    f"in {dimension}, got {before} -> {after}; "
                    f"layout={cli('pane', 'layout', '--pane', original)}"
                )
                print(f"PASS: resize {key.decode()}: {dimension} {before} -> {after}")
            send(b"\r")
            cli("pane", "close", sibling)
    finally:
        # Only the unique session and quiet synthetic shells created above are owned.
        subprocess.run([BINARY, "session", "stop", SESSION, "--json"],
                       env=ENV, capture_output=True, timeout=10, check=True)
        drain()
        os.close(fd)
        os.waitpid(pid, 0)
