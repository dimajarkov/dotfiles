#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyte==0.8.2"]
# ///
"""Real pinned Hunk PTY proof. All notes are written through v/c/Ctrl-S.

Uses only the public authenticated session CLI for inspection/navigation/reload.
Creates an isolated Git fixture and private evidence directory, never the real index.
"""
import argparse
import codecs
import concurrent.futures
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import socket
import struct
import subprocess
import tempfile
import termios
import time
import pyte


ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "home/.config/hunk/extensions/human-review"


def command(args, cwd, env):
    try:
        return subprocess.check_output(args, cwd=cwd, env=env, text=True, stderr=subprocess.PIPE)
    except subprocess.CalledProcessError as error:
        raise RuntimeError(error.stderr) from error


class Hunk:
    def __init__(self, binary, fixture, evidence, args, port, autoload=False):
        self.binary = binary
        self.fixture = fixture
        self.evidence = evidence
        self.env = dict(os.environ, TERM="xterm-256color", HUNK_DISABLE_UPDATE_NOTICE="1",
                        HUNK_MCP_PORT=str(port), XDG_CONFIG_HOME=str(evidence / "config"),
                        XDG_RUNTIME_DIR=str(evidence / "runtime"),
                        HUNK_HUMAN_REVIEW_STATE_DIRECTORY=str(evidence / "state"))
        self.master, slave = pty.openpty()
        self.screen = pyte.Screen(120, 40)
        self.stream = pyte.Stream(self.screen)
        self.decoder = codecs.getincrementaldecoder("utf8")("replace")
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        argv = list(args)
        location = argv.index("--") if "--" in argv else len(argv)
        extra = ["--mode", "unified"]
        if autoload:
            config_dir = evidence / "config/hunk"
            config_dir.mkdir(mode=0o700, parents=True)
            (config_dir / "config.toml").symlink_to(ROOT / "home/.config/hunk/config.toml")
        else:
            extra += ["--extension", str(EXTENSION)]
        argv[location:location] = extra
        self.process = subprocess.Popen([binary, *argv],
                                        cwd=fixture, env=self.env, stdin=slave, stdout=slave, stderr=slave,
                                        start_new_session=True)
        os.close(slave)
        self.output = b""
        self.session_id = None
        self.wait_text("File  View")
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                sessions = self.cli("list")["sessions"]
                matches = [s for s in sessions if s["pid"] == self.process.pid]
                if len(matches) == 1:
                    self.session_id = matches[0]["sessionId"]
                    break
            except RuntimeError:
                pass
            self.read(0.2)
        if not self.session_id:
            self.process.terminate()
            self.process.wait(timeout=5)
            os.close(self.master)
            (self.evidence / "startup-failure.ansi").write_bytes(self.output)
            raise AssertionError("Pinned Hunk did not register its authenticated session: " + str(self.evidence))

    def read(self, duration=0.3):
        end = time.monotonic() + duration
        while time.monotonic() < end:
            if select.select([self.master], [], [], min(0.05, max(0, end - time.monotonic())))[0]:
                try:
                    data = os.read(self.master, 262144)
                except OSError:
                    break
                self.output += data
                self.stream.feed(self.decoder.decode(data))
                # Answer only terminal capability discovery, not any review input.
                if b"\x1b[c" in data:
                    os.write(self.master, b"\x1b[?1;2c")
        return self.output.decode("utf8", errors="replace")

    def wait_text(self, text, since=0, timeout=10):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.read(0.1)
            if text in "\n".join(self.screen.display):
                (self.evidence / "screen.txt").write_text("\n".join(self.screen.display) + "\n")
                return
            assert self.process.poll() is None, "Hunk exited before " + text
        (self.evidence / "failure.ansi").write_bytes(self.output)
        raise AssertionError("Hunk did not render: " + text)

    def key(self, key, expected=None):
        before = len(self.output.decode("utf8", errors="replace"))
        os.write(self.master, key.encode())
        if expected:
            self.wait_text(expected, since=before)
        else:
            self.read()

    def cli(self, *args):
        argv = list(args)
        argv.insert(argv.index("--") if "--" in argv else len(argv), "--json")
        # A producer must keep rendering while its authenticated CLI request is
        # pending. Draining the PTY avoids backpressure deadlocking the renderer.
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
            pending = executor.submit(command, [self.binary, "session", *argv], self.fixture, self.env)
            while not pending.done():
                self.read(0.05)
            return json.loads(pending.result())

    def note(self, file, side, line, text, range_length=1):
        self.cli("navigate", self.session_id, "--file", file, "--" + side + "-line", str(line))
        self.read()
        self.key("v")
        for _ in range(range_length - 1):
            self.key("j")
        self.key("c", "Draft note")
        # Bracketed paste is the native note editor's multiline input path.
        self.key("\x1b[200~" + text + "\x1b[201~")
        self.key("\x13", "Your note")
        notes = self.cli("comment", "list", self.session_id, "--type", "user")["comments"]
        assert notes[-1]["body"] == text, notes[-1]
        assert notes[-1][side + "Range"] == [line, line + range_length - 1], notes[-1]
        return notes[-1]

    def actions(self, down=0):
        self.key("\x07", "Human review actions")
        for _ in range(down):
            self.key("\x1b[B")
        self.key("\r")

    def export(self):
        before = set((self.evidence / "state/batches").glob("*/feedback.json"))
        self.actions()
        self.wait_text("Exported")
        self.read()
        after = set((self.evidence / "state/batches").glob("*/feedback.json"))
        paths = after - before
        assert len(paths) == 1, (paths, self.output[-2000:])
        return json.loads(next(iter(paths)).read_text())

    def close(self, label):
        self.key("\x1b")
        self.key("q")
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=5)
        os.close(self.master)
        (self.evidence / (label + ".ansi")).write_bytes(self.output)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--hunk", required=True)
    parser.add_argument("--evidence")
    options = parser.parse_args()
    evidence = Path(options.evidence or tempfile.mkdtemp(prefix="hunk-review-proof." )).resolve()
    evidence.mkdir(mode=0o700, parents=True, exist_ok=True)
    fixture = evidence / "fixture"
    fixture.mkdir()
    env = dict(os.environ)
    for name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
        env.pop(name, None)
    git = lambda *args: command(["git", *args], fixture, env)
    git("init", "-q")
    git("config", "user.name", "Task-owned Hunk fixture")
    git("config", "user.email", "fixture@invalid")
    (fixture / "review.txt").write_text("first = 1\nremove = 2\nthird = 3\nfourth = 4\n")
    (fixture / "rename.txt").write_text("rename = 1\nkeep = 10\nkeep = 20\nkeep = 30\nkeep = 40\n")
    git("add", ".")
    git("commit", "-qm", "Task-owned fixture baseline")
    (fixture / "review.txt").write_text("first = 10\nthird = 30\nfourth = 40\nextra = 5\n")
    git("mv", "rename.txt", "renamed.txt")
    (fixture / "renamed.txt").write_text("rename = 2\nkeep = 10\nkeep = 20\nkeep = 30\nkeep = 40\n")
    git("add", "renamed.txt")
    (fixture / "new quote's file.txt").write_text("new = 1\n")
    git("add", "new quote's file.txt")
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    for name in ("config", "runtime", "state"):
        (evidence / name).mkdir(mode=0o700)
    hunk = Hunk(options.hunk, fixture, evidence, ["diff"], port, autoload=True)
    try:
        hunk.actions()
        hunk.wait_text("No saved human feedback")
        assert not (evidence / "state/batches").exists(), "Empty feedback must not export or send"
        hunk.actions(1)
        hunk.wait_text("No saved human feedback")
        hunk.cli("navigate", hunk.session_id, "--file", "review.txt", "--new-line", "1")
        hunk.key("c", "Draft note")
        hunk.key("\x07")
        assert "Human review actions" not in "\n".join(hunk.screen.display), "Note editor must own Ctrl-G"
        hunk.key("\x1b")
        records = [hunk.note("review.txt", "new", 1, "Use first = 11.")]
        records.append(hunk.note("review.txt", "new", 2, 'Change "third" and fourth.\nPreserve `extra`.', 2))
        records.append(hunk.note("review.txt", "old", 2, "Explain this deletion."))
        records.append(hunk.note("review.txt", "old", 2, "Inspect both old-side lines.", 2))
        hunk.cli("comment", "add", hunk.session_id, "--file", "review.txt", "--new-line", "1", "--summary", "Agent context only")
        batch = hunk.export()
        assert len(batch["notes"]) == 4
        assert len(batch["contextOnlyNotes"]) == 1
        assert all(note["source"] == "user" for note in batch["notes"])
        assert {note["summary"] for note in batch["notes"]} == {note["body"] for note in records}
        assert batch["notes"][1]["anchor"]["newRange"] == [2, 3]
        assert batch["notes"][2]["anchor"]["oldRange"] == [2, 2]
        assert batch["notes"][3]["anchor"]["oldRange"] == [2, 3]
        assert all(note["originalContextAvailable"] for note in batch["notes"])
        assert all(note["original"]["patch"] for note in batch["notes"])
        (evidence / "native-batch.json").write_text(json.dumps(batch, indent=2) + "\n")
        # Cancel in the native actions menu; no handoff attempt should exist.
        hunk.key("\x07", "Human review actions")
        hunk.key("\x1b")
        assert not (evidence / "state/deliveries").exists()
        # Same-review refresh retains IDs and original context after code changes.
        (fixture / "review.txt").write_text("first = 11\nthird = 31\nfourth = 41\nextra = 5\n")
        hunk.key("r")
        hunk.read(0.5)
        refreshed = hunk.export()
        assert {n["id"] for n in refreshed["notes"]} == set(batch["actionableIds"])
        assert refreshed["review"]["generation"] != batch["review"]["generation"]
        assert refreshed["notes"][0]["original"] == batch["notes"][0]["original"]
        assert not refreshed["scope"]["launchArgsAreCurrent"]
        # Removed files retain orphaned saved notes with original context.
        (fixture / "review.txt").write_text("first = 1\nremove = 2\nthird = 3\nfourth = 4\n")
        (fixture / "other.txt").write_text("Other review content.\n")
        hunk.key("r")
        hunk.read(0.5)
        orphaned = hunk.export()
        assert len(orphaned["notes"]) == 4
        assert all(n["file"] is None and not n["filePresentInReview"] for n in orphaned["notes"])
        # The actual v0.23.0 host leaves these statuses active. Preserve its value
        # and record absence separately; do not invent an orphaned resolution.
        assert all(n["resolution"] == "active" for n in orphaned["notes"])
        assert not orphaned["session"]["registrationCurrent"]
        assert all(n["originalContextAvailable"] for n in orphaned["notes"])
        (evidence / "orphaned-batch.json").write_text(json.dumps(orphaned, indent=2) + "\n")
    finally:
        hunk.close("unstaged")
    staged = Hunk(options.hunk, fixture, evidence, ["diff", "--staged"], port)
    try:
        staged.note("new quote's file.txt", "new", 1, "Check the new file's contents.")
        staged.note("renamed.txt", "new", 1, "Check this renamed file's changed value.")
        batch = staged.export()
        paths = {f["path"]: f for f in batch["files"]}
        assert paths["renamed.txt"]["previousPath"] == "rename.txt"
        assert paths["new quote's file.txt"]["changeKind"] == "new"
        assert "staged" in batch["scope"]["title"].lower()
        (evidence / "staged-batch.json").write_text(json.dumps(batch, indent=2) + "\n")
    finally:
        staged.close("staged")
    # An argument-level Herdr simulation tests asynchronous UI completion after
    # a real public-CLI reload. This is separate from the real live-agent proof.
    fake_binary = evidence / "fake-herdr"
    agent = {"agent": "codex", "agent_status": "idle", "pane_id": "test:p2", "terminal_id": "test-terminal",
             "cwd": str(fixture.resolve()), "foreground_cwd": str(fixture.resolve()),
             "agent_session": {"agent": "codex", "kind": "id", "source": "herdr:codex", "value": "simulated-agent"}}
    fake_binary.write_text("#!/usr/bin/env python3\nimport json,os,sys\nfrom pathlib import Path\n"
                           + "agent=" + repr(agent) + "\n"
                           + "args=sys.argv[1:]\n"
                           + "if args[:2]==['session','list']: result={'sessions':[{'name':os.environ['HERDR_SESSION'],'running':True,'socket_path':os.environ['HERDR_SOCKET_PATH']}]}\n"
                           + "elif args[:2]==['agent','list']: result={'result':{'agents':[agent]}}\n"
                           + "elif args[:2]==['agent','get']: result={'result':{'agent':agent}}\n"
                           + "elif args[:2]==['agent','prompt']:\n Path(" + repr(str(evidence / "simulated-prompt.txt")) + ").write_text(args[3]); result={'result':{'type':'agent_prompted'}}\n"
                           + "else: raise SystemExit('unsupported test command')\nprint(json.dumps(result))\n")
    fake_binary.chmod(0o700)
    simulated_environment = {
        "HERDR_BIN_PATH": str(fake_binary),
        "HERDR_ENV": "1",
        "HERDR_SESSION": "hunk-review-fixture",
        "HERDR_SOCKET_PATH": str(evidence / "fake-config/herdr/sessions/hunk-review-fixture/herdr.sock"),
        "HERDR_PANE_ID": "simulated-sender",
    }
    previous_environment = {name: os.environ.get(name) for name in simulated_environment}
    os.environ.update(simulated_environment)
    simulated = None
    try:
        simulated = Hunk(options.hunk, fixture, evidence, ["diff"], port)
        simulated.note("other.txt", "new", 1, "Simulated adapter UI acknowledgement test.")
        simulated.cli("reload", simulated.session_id, "--", "diff")
        simulated.read(0.5)
        simulated.actions(1)
        simulated.wait_text("Choose existing agent")
        simulated.key("\r", "Send human feedback?")
        simulated.key("\r", "Herdr accepted batch")
        assert (evidence / "simulated-prompt.txt").exists()
        (evidence / "accepted-screen.txt").write_text("\n".join(simulated.screen.display) + "\n")
    finally:
        if simulated:
            simulated.close("simulated-delivery-ui")
        for name, value in previous_environment.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
    # A newly launched window must attest itself before its first export,
    # so a native refresh can retain a missing-file note without inventing identity.
    cold = Hunk(options.hunk, fixture, evidence, ["diff"], port)
    try:
        note = cold.note("other.txt", "new", 1, "Retain this note before its first export.")
        (fixture / "other.txt").unlink()
        (fixture / "next.txt").write_text("Next review content.\n")
        cold.key("r")
        cold.read(0.5)
        batch = cold.export()
        assert [n["id"] for n in batch["notes"]] == [note["noteId"]]
        assert not batch["notes"][0]["filePresentInReview"]
        assert batch["notes"][0]["originalContextAvailable"]
        assert batch["notes"][0]["originalFileAssociationAvailable"]
        assert batch["repository"]["checkout"] == str(fixture.resolve())
        (evidence / "first-export-missing-file.json").write_text(json.dumps(batch, indent=2) + "\n")
    finally:
        cold.close("first-export-missing-file")
    # Review immutable fixture commits while two native windows share one
    # checkout and daemon. Export must attest its own process and exact scope.
    base = git("rev-parse", "HEAD").strip()
    (fixture / "review.txt").write_text("first = 12\nremove = 2\nthird = 3\nfourth = 4\n")
    git("add", "review.txt")
    git("commit", "-qm", "Task-owned fixture comparison", "--", "review.txt")
    head = git("rev-parse", "HEAD").strip()
    commit_review = Hunk(options.hunk, fixture, evidence, ["show", base], port)
    comparison_review = None
    try:
        commit_note = commit_review.note("review.txt", "new", 1, "Inspect this immutable commit.")
        comparison_review = Hunk(options.hunk, fixture, evidence, ["diff", base, head], port)
        comparison_note = comparison_review.note("review.txt", "new", 1, "Inspect these immutable comparison endpoints.")
        sessions = comparison_review.cli("list")["sessions"]
        assert {commit_review.process.pid, comparison_review.process.pid}.issubset({s["pid"] for s in sessions})
        commit_batch = commit_review.export()
        comparison_batch = comparison_review.export()
        assert commit_batch["session"]["id"] != comparison_batch["session"]["id"]
        assert commit_batch["session"]["pid"] == commit_review.process.pid
        assert comparison_batch["session"]["pid"] == comparison_review.process.pid
        assert [n["id"] for n in commit_batch["notes"]] == [commit_note["noteId"]]
        assert [n["id"] for n in comparison_batch["notes"]] == [comparison_note["noteId"]]
        assert commit_batch["scope"]["review"]["kind"] == "commit"
        assert commit_batch["scope"]["review"]["revision"] == base
        assert commit_batch["repository"]["observedHead"] == head
        assert comparison_batch["scope"]["review"]["kind"] == "comparison"
        assert comparison_batch["scope"]["review"]["base"] == base
        assert comparison_batch["scope"]["review"]["head"] == head
        assert any(c["revision"] == head for c in comparison_batch["scope"]["review"]["commits"])
        assert "first = 1" in next(f for f in commit_batch["files"] if f["path"] == "review.txt")["patch"]
        assert "first = 12" in next(f for f in comparison_batch["files"] if f["path"] == "review.txt")["patch"]
        (evidence / "commit-batch.json").write_text(json.dumps(commit_batch, indent=2) + "\n")
        (evidence / "comparison-batch.json").write_text(json.dumps(comparison_batch, indent=2) + "\n")
    finally:
        if comparison_review:
            comparison_review.close("comparison")
        commit_review.close("commit")
    for path in (evidence / "state").rglob("*"):
        assert (path.stat().st_mode & 0o077) == 0, path
    print(json.dumps({"result": "passed", "hunk": options.hunk, "evidence": str(evidence),
                      "nativeNotes": 10, "cases": ["empty", "single", "range", "old/deletion", "quotes/multiline",
                      "agent exclusion", "menu cancellation", "same-review refresh", "missing-file note preservation",
                      "staged", "new", "renamed", "private durable export", "simulated delivery UI after public CLI reload",
                      "missing-file first export after native refresh", "user config symlink extension loading",
                      "old-side range", "commit scope", "immutable revision comparison", "multiple same-checkout Hunk sessions"],
                      "upstreamGaps": ["Missing-file notes retain active resolution", "Missing-file reload rejects broker registration"]}, indent=2))


if __name__ == "__main__":
    main()
