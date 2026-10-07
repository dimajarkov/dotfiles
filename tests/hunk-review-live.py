#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyte==0.8.2"]
# ///
"""Explicit live proof against an existing task-related Herdr agent, never a new agent.

Requires a user-authorized destination and the task-owned live.txt fixture.
The native Hunk menu sends the actual immutable batch through the production adapter.
"""
import argparse
import json
import os
from pathlib import Path
import socket
import tempfile
import time

import importlib.util

_spec = importlib.util.spec_from_file_location("hunk_review_workflow", Path(__file__).with_name("hunk-review-workflow.py"))
_harness = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_harness)
Hunk, ROOT, command = _harness.Hunk, _harness.ROOT, _harness.command


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--hunk", required=True)
    parser.add_argument("--target", required=True, help="Existing related Herdr pane ID")
    parser.add_argument("--evidence", help="New owner-private task evidence directory")
    options = parser.parse_args()
    assert os.environ.get("HERDR_ENV") == "1"
    evidence = Path(options.evidence or tempfile.mkdtemp(prefix="hunk-live-proof.")).resolve()
    evidence.mkdir(mode=0o700, parents=True, exist_ok=True)
    for name in ("config", "runtime", "state"):
        (evidence / name).mkdir(mode=0o700)
    fixture_path = "tests/fixtures/hunk-review/live.txt"
    fixture = ROOT / fixture_path
    assert fixture.read_text().startswith("first = 10\n"), "Fixture must start with the unaddressed request"
    socket_probe = socket.socket()
    socket_probe.bind(("127.0.0.1", 0))
    port = socket_probe.getsockname()[1]
    socket_probe.close()
    hunk = Hunk(options.hunk, ROOT, evidence, ["diff", "--", fixture_path], port)
    herdr_env = dict(os.environ)
    original_fixture = fixture.read_text()

    def addressed_report(agent, note_id):
        session = agent.get("agent_session", {})
        if agent["agent"] == "pi" and session.get("agent") == "pi" and session.get("kind") == "path":
            # The public Herdr surface attests this exact receiving session path.
            # Terminal snapshots can remain scrolled to older output; inspect only
            # the matching assistant response, without navigating the user's pane.
            path = Path(session["value"])
            assert path.is_absolute() and path.stat().st_uid == os.getuid()
            for line in reversed(path.read_text().splitlines()):
                row = json.loads(line)
                message = row.get("message", {})
                if message.get("role") != "assistant":
                    continue
                blocks = message.get("content", [])
                text = "\n".join(block.get("text", "") for block in blocks if isinstance(block, dict))
                if note_id in text:
                    return {"source": "Herdr-attested Pi session", "path": str(path),
                            "timestamp": row.get("timestamp"), "text": text}
            return None
        text = command(["/opt/homebrew/bin/herdr", "agent", "read", options.target, "--source", "recent-unwrapped", "--lines", "80", "--session", os.environ["HERDR_SESSION"]], ROOT, herdr_env)
        return {"source": "Herdr terminal snapshot", "text": text} if note_id in text else None

    def choose_target():
        hunk.actions(1)
        hunk.wait_text("Choose existing agent")
        agents = json.loads(command(["/opt/homebrew/bin/herdr", "agent", "list", "--session", os.environ["HERDR_SESSION"]], ROOT, herdr_env))["result"]["agents"]
        targets = [a for a in agents if a["agent"] in ("pi", "codex") and a["agent_status"] in ("idle", "done")
                   and a.get("agent_session") and Path(a["cwd"]).resolve() == ROOT
                   and Path(a.get("foreground_cwd", "/")).resolve() == ROOT
                   and a["pane_id"] != os.environ["HERDR_PANE_ID"]]
        matches = [i for i, agent in enumerate(targets) if agent["pane_id"] == options.target]
        assert len(matches) == 1, "Requested destination is missing or ambiguous"
        for _ in range(matches[0]):
            hunk.key("\x1b[B")
        hunk.key("\r")

    try:
        note = hunk.note(fixture_path, "new", 1,
                         "For this authorized task-owned handoff proof, change ONLY tests/fixtures/hunk-review/live.txt: first = 10 becomes first = 11.\n"
                         "Preserve every other line and file, run a direct content check, and report this note ID as addressed.\n"
                         "Do not run the wider implementation workflow or start any agent, pane, tab, or rebuild.")
        choose_target()
        hunk.wait_text("Send human feedback?")
        hunk.key("\x1b")
        assert not (evidence / "state/deliveries").exists(), "Cancelled confirmation must not deliver"
        choose_target()
        hunk.wait_text("Send human feedback?")
        hunk.cli("comment", "add", hunk.session_id, "--file", fixture_path, "--new-line", "1", "--summary", "Revision-guard test context, not a human request")
        hunk.key("\r", "Review changed while preparing feedback")
        assert not (evidence / "state/deliveries").exists(), "A state revision change must prevent delivery"
        choose_target()
        hunk.wait_text("Send human feedback?")
        hunk.cli("reload", hunk.session_id, "--", "diff", "--", fixture_path)
        hunk.read(0.5)
        assert not (evidence / "state/deliveries").exists(), "Reload must cancel the pending send"
        choose_target()
        hunk.wait_text("Send human feedback?")
        hunk.key("\r")
        receipt_deadline = time.monotonic() + 20
        while time.monotonic() < receipt_deadline:
            hunk.read(0.1)
            if list((evidence / "state/deliveries").glob("*/*-result.json")):
                break
        receipts = list((evidence / "state/deliveries").glob("*/*-result.json"))
        assert len(receipts) == 1 and json.loads(receipts[0].read_text())["state"] == "accepted"
        hunk.wait_text("Herdr accepted batch")
        print(json.dumps({"stage": "submitted", "target": options.target, "note": note["noteId"], "evidence": str(evidence)}), flush=True)
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            agent = json.loads(command(["/opt/homebrew/bin/herdr", "agent", "get", options.target, "--session", os.environ["HERDR_SESSION"]], ROOT, herdr_env))["result"]["agent"]
            if fixture.read_text().startswith("first = 11\n") and agent["agent_status"] in ("idle", "done"):
                report = addressed_report(agent, note["noteId"])
                if report is not None:
                    break
            hunk.read(0.5)
        else:
            raise AssertionError("Agent did not address the fixture and settle within 180s; do not automatically resend")
        assert fixture.read_text() == original_fixture.replace("first = 10\n", "first = 11\n", 1), "Only the requested fixture line may change"
        (evidence / "agent-report.json").write_text(json.dumps(report, indent=2) + "\n")
        assert note["noteId"] in report["text"], "Agent must report the addressed note identity"
        # The live review has not refreshed yet: repeated send detects the same content.
        choose_target()
        hunk.wait_text("Explicitly resubmit this feedback?")
        hunk.key("\x1b")
        assert len(list((evidence / "state/deliveries").glob("*/*-result.json"))) == 1
        hunk.key("r")
        hunk.read(0.7)
        batch = hunk.export()
        assert batch["notes"][0]["id"] == note["noteId"]
        assert "first = 11" in batch["files"][0]["patch"]
        assert "first = 10" in batch["notes"][0]["original"]["patch"]
        (evidence / "re-review.json").write_text(json.dumps(batch, indent=2) + "\n")
        print(json.dumps({"result": "passed", "target": options.target, "evidence": str(evidence), "note": note["noteId"],
                          "loop": ["native v/c/Ctrl-S", "immutable export", "cancelled confirmation", "real revision change rejects send", "generation change cancels send", "Herdr prompt accepted",
                                   "agent fixture edit", "agent addressed-ID report", "duplicate confirmation cancelled", "native r re-review retaining notes"]}, indent=2), flush=True)
    finally:
        hunk.close("live-loop")


if __name__ == "__main__":
    main()
