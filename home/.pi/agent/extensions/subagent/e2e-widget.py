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
import shlex
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
                       SUBAGENT_WIDGET_E2E="1", TERM="xterm-256color", TERM_PROGRAM="ghostty",
                       COLORTERM="truecolor")
    # Intercept the system opener: exercise real hyperlink clicks without launching apps.
    opener = config / "bin"
    opener.mkdir()
    opened = config / "opened.txt"
    (opener / "open").write_text(f"#!/bin/sh\nprintf '%s\\n' \"$@\" >> {shlex.quote(str(opened))}\n")
    (opener / "open").chmod(0o755)
    environment["PATH"] = str(opener) + os.pathsep + environment.get("PATH", "")
    asset = config / "report notes.md"
    asset.write_text("Exact saved agent artifact\n")
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

    def click(label, within=None):
        y = next(i for i, line in enumerate(screen.display) if label in line and (within is None or within in line))
        x = screen.display[y].index(label)
        os.write(master, f"\x1b[<0;{x + 1};{y + 1}M\x1b[<0;{x + 1};{y + 1}m".encode())
        pump()

    def key(data):
        os.write(master, data)
        pump()

    def resize(columns, lines=32):
        screen.resize(lines=lines, columns=columns)
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", lines, columns, 0, 0))
        process.send_signal(signal.SIGWINCH)
        pump()

    try:
        deadline = time.monotonic() + 30
        while "widget-reference" not in "\n".join(screen.display):
            pump(0.2)
            if process.poll() is not None or time.monotonic() > deadline:
                raise AssertionError(f"Pi did not display widget: {capture('startup-failed')}")
        pump(0.3)
        text = capture("active-wide")
        assert "NOT-OUR-CHILD" not in text and "FINISHED-CHILD" in text
        assert "nested-scout" in text and "├" in text and "└" in text
        assert text.index("widget-reference") < text.index("nested-scout"), "Parent stays above descendant"
        assert "● done" in text and "[output]" in text, "Completed agent remains inspectable"
        assert text.index("Subagents") < text.index("Type your next message"), "Widget must be above editor"
        assert text.index("Type your next message") < text.index("↑0 ↓0"), "Footer must stay below editor"
        assert "╭─ Subagents" in text and "╰─" in text, "Widget must have its own rounded panel"
        assert "scope=" not in text and "thinking=" not in text, "Keep technical metadata out of widget"
        assert "! blocked" in text
        if mode == "fullscreen":
            click("widget-reference")
        else:
            command("/subagents widget-reference")
        text = capture("prompt-first")
        assert "PROMPT-FIRST" in text and "Initial delegation prompt" in text
        assert "**literal**" in text, "Prompt is literal, not a reformatted summary"
        key(b"\x1b[F")
        assert "PROMPT-LAST" in capture("prompt-last"), "Entire long prompt is reachable"
        key(b"\x1b[H")
        # Pi dispatches component mouse events only in fullscreen mode.
        key(b"\x1b[<65;60;16M" if mode == "fullscreen" else b"\x1b[6~")
        assert "PROMPT-FIRST" not in capture("prompt-scroll"), "Modal scrolls with wheel or keyboard"
        key(b"\x1b")
        if mode == "fullscreen":
            assert "Type your next message" in capture("prompt-closed"), "Inspection preserves draft"
            click("[output]", within="FINISHED-CHILD")
        else:
            command("/subagent-output FINISHED-CHILD")
        text = capture("output-first")
        assert "OUTPUT-FIRST" in text and "Saved final response" in text
        assert "**literal**" in text and "Report" in text
        if mode == "fullscreen":
            click("Report")
            assert opened.exists() and asset.resolve().as_uri() in opened.read_text(), "Asset opens via system file handler"
            click("Reference")
            assert "https://example.com/subagent-report" in opened.read_text(), "URL opens via system browser"
        else:
            log.flush()
            assert asset.resolve().as_uri().encode() in (config / "terminal.ansi").read_bytes(), "Regular terminal receives asset hyperlink"
        key(b"\x1b[F")
        assert "OUTPUT-LAST" in capture("output-last"), "Entire exact conclusion is reachable"
        resize(60, 12)
        assert "OUTPUT-LAST" in capture("output-small"), "Scrolled output survives terminal resize"
        resize(120)
        key(b"p")
        assert "PROMPT-FIRST" in capture("output-to-prompt"), "Switch from output to original prompt"
        key(b"\x1b")
        command("/subagents")
        text = capture("picker")
        assert "select to inspect" in text and "FINISHED-CHILD" in text and "nested-scout" in text
        key(b"\r")
        assert "PROMPT-FIRST" in capture("picker-selected")
        key(b"\x1b")
        command("/widget-demo completed")
        text = capture("all-done")
        assert "Subagents" in text and "● done" in text and "nested-scout" in text, "Finished work never vanishes"
        assert "working" not in text and "blocked" not in text
        command("/widget-demo history")
        text = capture("active-over-history")
        assert "HISTORY-PARENT" in text and "ACTIVE-SIBLING" in text, "Completed descendants cannot hide active siblings"
        assert "done-history-" not in text and "+4 more" in text, "Descendant history yields to active siblings"
        assert text.index("HISTORY-PARENT") < text.index("ACTIVE-SIBLING"), "Selected rows retain tree order"
        command("/widget-demo many")
        text = capture("many")
        assert "+5 more" in text and "layout-review-7" in text, "Show overflow and prioritize blocked subtrees"
        assert "NOT-OUR-CHILD" not in text
        # Resize the live terminal, not just a renderer function.
        resize(40)
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
        command("/widget-demo empty")
        resize(160, 48)
        log.flush()
        safety_start = (config / "terminal.ansi").stat().st_size
        command("/completion-safety")
        text = capture("completion-collapsed")
        assert "SAFE-NAME wrapped [worker]" in text, "Metadata is safe single-line text"
        key(b"\x0f")
        text = capture("completion-expanded")
        assert "SAFETY-LAST" in text and "safe reference" in text, "Native expanded completion is rendered"
        log.flush()
        safety_bytes = (config / "terminal.ansi").read_bytes()[safety_start:]
        assert b"\x1b]52;" not in safety_bytes, "Completion metadata cannot emit clipboard controls"
        assert b"\x1b]8;;command:" not in safety_bytes, "Reference links cannot bypass protocol allowlist"
        assert b"\x1b]8;;https://example.com/safe-reference" in safety_bytes, "Safe parsed reference links stay clickable"
        assert not opened.exists() or "unsafe-fixture" not in opened.read_text(), "Rendering never opens links"
        print(f"PASS {mode}: tree, retained done states, full prompt/output modals, links, paging, mouse, resize, picker, overflow, clearing, reload, safe completion rendering", flush=True)
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
