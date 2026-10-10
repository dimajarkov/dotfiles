"""Exercise the real :Glow command in a terminal, including colors and quitting."""

import argparse
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument(
    "--config", type=Path,
    default=Path(__file__).resolve().parents[1] / "home/.config/nvim",
)
parser.add_argument("--glow-bin", type=Path, help="Test a built Glow without installing it")
args = parser.parse_args()
CONFIG = args.config.resolve()
TITLE = b"Glow Color Regression"
ANSI = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]")
# Glow's dark-theme title is yellow (ANSI 228 / RGB ffff87), not the editor's UI.
# Neovim may redraw the entire screen without newlines, so generic color escapes
# from its statusline would give a false positive.
TITLE_COLOR = re.compile(rb"\x1b\[[0-9;:]*38(?:;5;228|;2;255;255;135)(?:[;:][0-9]+)*m")


class Terminal:
    def __init__(self, argv, cwd, env):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(cwd)
            os.execvpe(argv[0], argv, env)
        self.resize(120)

    def resize(self, columns, rows=40):
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))

    def send(self, text):
        os.write(self.fd, text)

    def read(self, seconds):
        output = bytearray()
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if not select.select([self.fd], [], [], 0.05)[0]:
                continue
            try:
                block = os.read(self.fd, 65536)
            except OSError as exc:
                if exc.errno == errno.EIO:
                    break
                raise
            if not block:
                break
            output.extend(block)
            if b"\x1b]11;?" in block:
                self.send(b"\x1b]11;rgb:1010/1010/1010\x1b\\")
            if b"\x1b]10;?" in block:
                self.send(b"\x1b]10;rgb:eeee/eeee/eeee\x1b\\")
            if b"\x1b[6n" in block:
                self.send(b"\x1b[1;1R")
        return bytes(output)

    def close(self):
        try:
            os.kill(self.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        os.close(self.fd)
        os.waitpid(self.pid, 0)


def visible_screen(socket):
    # Inspect the real TUI grid, not just output bytes. A resize may briefly
    # print the title and then erase it, which the old ANSI-only check missed.
    expression = '''luaeval("(function() local rows={} for r=1,vim.o.lines do
        local cells={} for c=1,vim.o.columns do
            cells[#cells+1]=vim.fn.screenstring(r,c)
        end rows[#rows+1]=table.concat(cells) end return table.concat(rows,'\\\\n') end)()")'''
    return subprocess.run(
        ["nvim", "--server", str(socket), "--remote-expr", expression],
        text=True, capture_output=True, check=True, timeout=5,
    ).stdout


def assert_colored_heading(output, label):
    line = next(
        (line for line in re.split(rb"[\r\n]", output) if TITLE in ANSI.sub(b"", line)),
        b"",
    )
    assert line, f"{label}: document did not appear"
    assert TITLE_COLOR.search(line), f"{label}: document heading lacks Glow's title color"
    print(f"PASS: {label} renders the document heading in color")


with tempfile.TemporaryDirectory(prefix="nvim-glow-") as directory:
    root = Path(directory).resolve()
    document = root / "reader's color check.md"
    document.write_text(
        "---\ntitle: FRONTMATTER MUST STAY HIDDEN\n---\n\n"
        "# Glow Color Regression\n\n## A styled heading\n\n"
        "A **bold** phrase with [a link](https://example.com).\n\n"
        "| Question | Answer |\n| --- | --- |\n"
        "| Which theme? | `dark` and colorful |\n"
    )
    settings = root / "settings"
    settings.mkdir()
    # A pager preference must not prevent :Glow from opening the interactive reader.
    (settings / "glow.yml").write_text('style: "dark"\npager: true\nwidth: 120\n')
    result = root / "result.json"
    ready = root / "ready"
    socket = root / "nvim.sock"
    env = {
        **os.environ,
        "TERM": "xterm-256color",
        "COLORTERM": "truecolor",
        "PAGER": "less -R",
        "GLOW_CONFIG_HOME": str(settings),
        "NVIM_GLOW_CONFIG": str(CONFIG),
        "NVIM_GLOW_READY": str(ready),
        "NVIM_GLOW_RESULT": str(result),
    }
    for key in (
        "NO_COLOR", "CLICOLOR", "CLICOLOR_FORCE", "GLOW_PAGER", "GLOW_STYLE",
        "GLAMOUR_STYLE", "GLOW_HIGH_PERFORMANCE_PAGER", "GLOW_ENABLE_GLAMOUR",
    ):
        env.pop(key, None)
    if args.glow_bin:
        tools = root / "bin"
        tools.mkdir()
        (tools / "glow").symlink_to(args.glow_bin.resolve(strict=True))
        env["PATH"] = str(tools) + os.pathsep + env["PATH"]

    standalone = Terminal(["glow"], root, env)
    try:
        standalone.read(1.5)
        standalone.send(b"\r")
        assert_colored_heading(standalone.read(1.5), "standalone Glow")
    finally:
        standalone.close()

    editor = Terminal(
        [
            "nvim", "--listen", str(socket), "-i", "NONE", "-n",
            "--cmd", "lua vim.opt.runtimepath:prepend(vim.env.NVIM_GLOW_CONFIG)",
            "-u", str(CONFIG / "init.lua"), str(document),
            "+lua vim.api.nvim_win_set_cursor(0,{5,0}); "
            "vim.fn.writefile({'ready'},vim.env.NVIM_GLOW_READY)",
        ],
        root,
        env,
    )
    try:
        deadline = time.monotonic() + 10
        while not ready.exists() and time.monotonic() < deadline:
            editor.read(0.1)
        assert ready.exists(), "Neovim did not finish loading its real configuration"
        editor.read(0.2)
        editor.send(b":Glow\r")
        assert_colored_heading(editor.read(2), "Neovim :Glow")
        assert TITLE.decode() in visible_screen(socket), "initial preview is blank"
        # Shrink height as well as width, repeatedly. The former width-only
        # fixture passed even when the actual document disappeared on shrink.
        for columns, rows in ((80, 25), (60, 18), (40, 12), (120, 40), (80, 25)):
            editor.resize(columns, rows)
            output = editor.read(0.7)
            screen = visible_screen(socket)
            assert TITLE.decode() in screen, (
                f"Blank preview after resize to {columns}x{rows}:\n{screen}"
            )
            assert "FRONTMATTER MUST STAY HIDDEN" not in screen, screen
            assert_colored_heading(output, f"Neovim :Glow at {columns}x{rows}")
            print(f"PASS: Neovim :Glow document stays visible at {columns}x{rows}")
        # Resizing also needs to work after leaving terminal-input mode.
        editor.send(b"\x1c\x0e")  # <C-\><C-n>
        editor.read(0.2)
        for columns, rows in ((60, 18), (120, 40), (80, 25)):
            editor.resize(columns, rows)
            editor.read(0.7)
            screen = visible_screen(socket)
            assert TITLE.decode() in screen, (
                f"Blank normal-mode preview at {columns}x{rows}:\n{screen}"
            )
        print("PASS: resizes also preserve the preview in terminal-normal mode")
        editor.send(b"iq")
        editor.read(0.5)
        editor.send(
            b":lua vim.fn.writefile({vim.json.encode({"
            b"path=vim.api.nvim_buf_get_name(0),buftype=vim.bo.buftype,"
            b"cursor=vim.api.nvim_win_get_cursor(0),"
            b"terminal_count=#vim.tbl_filter(function(b) return vim.bo[b].buftype=='terminal' end,"
            b"vim.api.nvim_list_bufs()),error=vim.v.errmsg})},vim.env.NVIM_GLOW_RESULT)\r"
        )
        editor.read(0.5)
        assert result.exists(), "q did not return control to Neovim's command line"
        state = json.loads(result.read_text())
        assert state["path"] == str(document), state
        assert state["buftype"] == "", state
        assert state["cursor"] == [5, 0], state
        assert state["terminal_count"] == 0, state
        assert not state["error"], state
        print("PASS: q restores the original document and cursor without leaking a terminal buffer")
    finally:
        editor.close()
