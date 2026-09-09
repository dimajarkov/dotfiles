"""Launch the full Neovim TUI and assert it matches this Mac's appearance."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import struct
import subprocess
import sys
import tempfile
import termios
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument(
    "--config",
    type=Path,
    default=Path(__file__).resolve().parents[1] / "home/.config/nvim",
)
args = parser.parse_args()
if sys.platform != "darwin":
    raise SystemExit(
        "This TUI smoke test requires macOS; use nvim-appearance.lua elsewhere."
    )

appearance = subprocess.run(
    ["/usr/bin/defaults", "read", "-g", "AppleInterfaceStyle"],
    capture_output=True,
    text=True,
    timeout=5,
)
if appearance.returncode == 0 and appearance.stdout.strip() in ("Dark", "Light"):
    expected = appearance.stdout.strip().lower()
elif appearance.returncode == 1 and (
    "(kCFPreferencesAnyApplication, AppleInterfaceStyle) does not exist"
    in appearance.stderr
):
    expected = "light"
else:
    raise SystemExit("Unable to read macOS appearance")

with tempfile.TemporaryDirectory(prefix="nvim-appearance-") as directory:
    result_path = Path(directory) / "result.json"
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 38, 110, 0, 0))
    process = subprocess.Popen(
        [
            "nvim",
            "-i",
            "NONE",
            "-n",
            "--cmd",
            "lua vim.opt.runtimepath:prepend(vim.env.NVIM_TEST_CONFIG)",
            "-u",
            str(args.config / "init.lua"),
            "+lua vim.defer_fn(function() "
            "vim.fn.writefile({vim.json.encode({background=vim.o.background, "
            "colorscheme=vim.g.colors_name, error=vim.v.errmsg, "
            "normal=vim.api.nvim_get_hl(0,{name='Normal',link=false})})}, "
            "vim.env.NVIM_TEST_RESULT); vim.cmd('qa!') end, 1000)",
        ],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env={
            **os.environ,
            "TERM": "xterm-256color",
            "NVIM_TEST_CONFIG": str(args.config.resolve()),
            "NVIM_TEST_RESULT": str(result_path),
        },
    )
    os.close(slave)
    try:
        deadline = time.monotonic() + 15
        while process.poll() is None and time.monotonic() < deadline:
            if select.select([master], [], [], 0.1)[0]:
                try:
                    os.read(master, 65536)
                except OSError:
                    break
        process.wait(timeout=2)
        assert process.returncode == 0, "Neovim did not exit cleanly"
        result = json.loads(result_path.read_text())
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)

assert not result["error"], result["error"]
print(
    f"macOS={expected} nvim={result['background']} colorscheme={result['colorscheme']}"
)
assert result["background"] == expected, "Neovim does not follow macOS appearance"
assert result["colorscheme"] == ("guts" if expected == "dark" else "rose-pine")


def brightness(color):
    return sum(
        ((color >> shift) & 255) * weight
        for shift, weight in (
            (16, 0.299),
            (8, 0.587),
            (0, 0.114),
        )
    )


normal = result["normal"]
assert (brightness(normal["bg"]) > brightness(normal["fg"])) == (expected == "light")
print("PASS: full Neovim TUI startup and visible palette match macOS")
