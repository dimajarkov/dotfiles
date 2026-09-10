#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyte==0.8.2"]
# ///
"""Exercise the real Pi widget, editor, and footer in an isolated PTY, without inference."""

import codecs
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time

import pyte

HERE = Path(__file__).resolve().parent
EVIDENCE = Path(tempfile.mkdtemp(prefix="subagent-widget-e2e-"))
print(f"Evidence: {EVIDENCE}", flush=True)


def run(mode):
    config = EVIDENCE / mode
    config.mkdir()
    (config / "settings.json").write_text(json.dumps({
        "quietStartup": True,
        "defaultProjectTrust": "never",
        "editorPaddingX": 1,
        "tuiMode": mode,
    }))
    # Allow only shell/locale plumbing, never inherited provider keys or caller identity.
    allowed_environment = {"PATH", "TMPDIR", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE"}
    environment = {key: value for key, value in os.environ.items() if key in allowed_environment}
    environment.update(HOME=str(config), PI_CODING_AGENT_DIR=str(config), PI_OFFLINE="1",
                       SUBAGENT_WIDGET_E2E="1", TERM="xterm-256color", COLORTERM="truecolor")
    master, slave = pty.openpty()
    screen = pyte.Screen(120, 32)
    stream = pyte.Stream(screen)
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 120, 0, 0))
    process = subprocess.Popen([
        "pi", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates",
        "--no-context-files", "--no-approve", "--no-tools",
        "--theme", str(HERE.parent.parent / "themes" / "prime.json"), "--use-theme", "prime",
        "-e", str(HERE.parent / "prime-style.ts"),
        "-e", str(HERE.parent / "status-line.ts"),
        "-e", str(HERE / "test-fixtures" / "widget-demo.ts"),
    ], cwd=config, env=environment, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    log = (config / "terminal.ansi").open("wb")

    def pump(duration=1.3):
        deadline = time.monotonic() + duration
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]:
                data = os.read(master, 65536)
                log.write(data)
                stream.feed(decoder.decode(data))
                # Pi queries the cursor when starting regular mode.
                if b"\x1b[6n" in data:
                    os.write(master, b"\x1b[1;1R")

    def capture(name):
        text = "\n".join(screen.display)
        (config / f"{name}.txt").write_text(text)
        return text

    def command(text):
        os.write(master, b"\x15" + text.encode() + b"\r")
        pump()

    try:
        deadline = time.monotonic() + 30
        while "widget-reference" not in "\n".join(screen.display):
            pump(0.2)
            if process.poll() is not None or time.monotonic() > deadline:
                raise AssertionError(f"Pi did not display widget: {capture('startup-failed')}")
        pump(0.3)
        text = capture("active-wide")
        assert "NOT-OUR-CHILD" not in text and "FINISHED-CHILD" not in text
        assert text.index("Subagents") < text.index("Type your next message"), "Widget must be above editor"
        assert text.index("Type your next message") < text.index("↑0 ↓0"), "Footer must stay below editor"
        assert "╭─ Subagents" in text and "╰─" in text, "Widget must have its own rounded panel"
        assert "scope=" not in text and "thinking=" not in text, "Keep technical metadata out of widget"
        assert "! blocked" in text
        command("/widget-demo many")
        text = capture("many")
        assert "+3 more" in text and "layout-review-7" in text, "Show overflow and prioritize blocked agents"
        assert "NOT-OUR-CHILD" not in text
        # Resize the live terminal, not just a renderer function.
        screen.resize(lines=32, columns=40)
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 40, 0, 0))
        process.send_signal(signal.SIGWINCH)
        pump()
        text = capture("narrow")
        panel = [line for line in screen.display if line.startswith(("╭", "│", "╰"))]
        assert len(panel) == 8, "Panel must stay bounded after resize"
        assert all(line.endswith(("╮", "│", "╯")) for line in panel), "Borders must remain aligned"
        assert "! blocked" in text
        command("/widget-demo empty")
        text = capture("empty")
        assert "Subagents" not in text and "layout-review" not in text, "Empty widget must leave no stale rows"
        assert "↑0 ↓0" in text
        command("/widget-demo active")
        command("/reload")
        text = capture("reloaded")
        assert text.count("Subagents") == 1 and "widget-reference" in text, "Reload must recreate one widget"
        print(f"PASS {mode}: placement, filtering, overflow, resize, clearing, reload", flush=True)
    finally:
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        os.close(master)
        log.close()


for tui_mode in ("fullscreen", "regular"):
    run(tui_mode)
