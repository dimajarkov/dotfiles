#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyte==0.8.2"]
# ///
"""Isolated public PTY snapshot proof, not live Herdr/native harness acceptance."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shlex
import socket
import subprocess
import tempfile
import time
import threading
import uuid

ROOT = Path(__file__).resolve().parents[5]
parser = argparse.ArgumentParser()
host = parser.add_mutually_exclusive_group(required=True)
host.add_argument("--hunk-source")
host.add_argument("--hunk-binary")
args = parser.parse_args()
evidence = Path(tempfile.mkdtemp(prefix="hunk-turn-pty.", dir="/tmp")).resolve()
fixture = evidence / "fixture"
fixture.mkdir(mode=0o700)
state = evidence / "backend"
state.mkdir(mode=0o700)
runtime_socket = state / "runtime.sock"
for name in ("config", "runtime", "state"):
    (evidence / name).mkdir(mode=0o700)
env = dict(os.environ)
for name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "HERDR_ENV", "HERDR_SESSION", "HERDR_PANE_ID"):
    env.pop(name, None)
subprocess.run(["git", "init", "-q", str(fixture)], env=env, check=True)
(fixture / "review.txt").write_text("first = 1\n")
subprocess.run(["git", "-C", str(fixture), "add", "."], env=env, check=True)
subprocess.run(["bun", "build", str(ROOT / "home/.local/share/hunk-turn-review/src/runtime.ts"), "--target=node", "--outfile", str(evidence / "runtime.mjs")], env=env, check=True, capture_output=True)
runtime = subprocess.Popen(["node", str(evidence / "runtime.mjs"), "--state", str(state), "--socket", str(runtime_socket)], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
client = ROOT / "home/.local/share/hunk-turn-review/client.mjs"

def request(method, params):
    return json.loads(subprocess.check_output(["node", "--input-type=module", "-e", "import {pathToFileURL} from 'node:url'; const {createClient}=await import(pathToFileURL(process.argv[1])); console.log(JSON.stringify(await createClient({socket:process.argv[2]}).request(process.argv[3],JSON.parse(process.argv[4]))));", str(client), str(runtime_socket), method, json.dumps(params)], env=env, text=True))

hunk = None
receiver = None
admissions = []
def wait_checkpoint(review_id, predicate):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        saved = request("review.checkpoint.read", {"sessionId": attached["sessionId"], "reviewId": review_id})
        if saved["checkpoint"] and predicate(saved["checkpoint"]):
            return saved["checkpoint"]
        if hunk:
            hunk.read(0.05)
    raise AssertionError("Native checkpoint was not durable")
def turn_actions(down):
    hunk.key("\x07", "Human turn-review actions")
    for _ in range(down):
        hunk.key("\x1b[B")
    hunk.key("\r")
def switch(selection_index):
    turn_actions(2)
    hunk.wait_text("Explicit immutable review selection")
    for _ in range(selection_index):
        hunk.key("\x1b[B")
    hunk.key("\r", "Switch to")
    hunk.key("\r")
try:
    for _ in range(200):
        if runtime_socket.exists():
            break
        time.sleep(0.01)
    epoch = str(uuid.uuid4())
    attached = request("session.attach", {"identity": {"kind": "codex", "nativeId": str(uuid.uuid4()), "checkout": str(fixture)}, "epoch": epoch})
    bound = {"sessionId": attached["sessionId"], "epoch": epoch}
    request("request.begin", {**bound, "requestId": "snapshot-pty"})
    (fixture / "review.txt").write_text("first = 10\n")
    os.environ["HUNK_TURN_REVIEW_SOCKET"] = str(runtime_socket)
    os.environ["HUNK_TURN_REVIEW_SESSION_ID"] = attached["sessionId"]
    spec = importlib.util.spec_from_file_location("existing_public_pty", ROOT / "tests/hunk-review-workflow.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    wrapper = evidence / "hunk-source"
    executable = (
        [str(Path(args.hunk_binary).resolve())]
        if args.hunk_binary
        else [subprocess.check_output(["which", "bun"], text=True).strip(), str(Path(args.hunk_source).resolve() / "packages/hunk/src/main.tsx")]
    )
    # Generic command discovery requires leading extension flags; the shared
    # legacy PTY helper appends flags for built-ins, so adapt this launch only.
    wrapper.write_text('#!/bin/sh\nif [ "$1" = turn-review ]; then\n  exec ' + shlex.join([*executable, "--extension", str(ROOT / "home/.config/hunk/extensions/human-review"), "turn-review"]) + '\nfi\nexec ' + shlex.join(executable) + ' "$@"\n')
    wrapper.chmod(0o700)
    free = socket.socket()
    free.bind(("127.0.0.1", 0))
    port = free.getsockname()[1]
    free.close()
    hunk = module.Hunk.__new__(module.Hunk)
    try:
        hunk.__init__(str(wrapper), fixture, evidence, ["turn-review"], port)
    except Exception:
        (evidence / "startup-failure.ansi").write_bytes(hunk.output)
        print("PTY startup evidence:", evidence)
        print(hunk.output.decode("utf8", errors="replace")[-6000:])
        raise
    sessions = hunk.cli("list")["sessions"]
    own = next(row for row in sessions if row["sessionId"] == hunk.session_id)
    assert own["repoRoot"] == str(fixture), own
    assert own["sourceLabel"] == str(fixture), own
    assert own["title"] == "Waiting for first completed response", own
    assert "first = 10" not in "\n".join(hunk.screen.display)
    (evidence / "waiting-screen.txt").write_text("\n".join(hunk.screen.display) + "\n")
    reviewed = request("request.complete", {**bound, "requestId": "snapshot-pty", "outcome": "completed"})
    (fixture / "review.txt").write_text("later checkout = 99\n")
    hunk.wait_text("first = 10")
    own = next(row for row in hunk.cli("list")["sessions"] if row["sessionId"] == hunk.session_id)
    assert reviewed["reviewId"] in own["title"], own
    assert "later checkout = 99" not in "\n".join(hunk.screen.display)
    hunk.key("\x07", "Human turn-review actions")
    hunk.key("\x1b")
    saved = hunk.note("review.txt", "new", 1, "Explain this and prepare a handoff; do not edit yet")
    request("request.begin", {**bound, "requestId": "newer-pty"})
    (fixture / "review.txt").write_text("newer turn = 100\n")
    request("request.complete", {**bound, "requestId": "newer-pty", "outcome": "completed"})
    hunk.wait_text("Newer review available")
    current = next(row for row in hunk.cli("list")["sessions"] if row["sessionId"] == hunk.session_id)
    assert reviewed["reviewId"] in current["title"], current
    comments = hunk.cli("comment", "list", hunk.session_id, "--type", "user")["comments"]
    native = next(row for row in comments if row.get("noteId") == saved["noteId"] and row.get("editable"))
    assert native == saved, comments
    assert native["body"] == "Explain this and prepare a handoff; do not edit yet", comments
    original = wait_checkpoint(reviewed["reviewId"], lambda cp: len(cp["notes"]) == 1 and cp["draft"] is None)
    assert original["notes"][0]["id"] == saved["noteId"]
    assert request("review.status", {"sessionId": attached["sessionId"]})["notes"][0]["id"] == saved["noteId"]
    # Persist and crash with an active native edit composer. No sendable second note.
    hunk.key("E", "Edit note")
    hunk.key("\x1b[200~ and explain the tradeoff\x1b[201~")
    drafted = wait_checkpoint(reviewed["reviewId"], lambda cp: cp["draft"] and "tradeoff" in cp["draft"]["body"])
    assert len(request("review.status", {"sessionId": attached["sessionId"]})["notes"]) == 1
    hunk.process.kill()
    hunk.process.wait(timeout=5)
    os.close(hunk.master)
    (evidence / "crash.ansi").write_bytes(hunk.output)
    hunk = module.Hunk(str(wrapper), fixture, evidence, ["turn-review"], port)
    hunk.wait_text("tradeoff")
    # Save the restored edit using the native acknowledgement path.
    hunk.key("\x13", "Your note")
    edited = wait_checkpoint(reviewed["reviewId"], lambda cp: cp["draft"] is None and "tradeoff" in cp["notes"][0]["summary"])
    assert edited["notes"][0]["id"] == saved["noteId"]
    assert edited["notes"][0]["provenance"] == original["notes"][0]["provenance"]
    # An explicit switch durably leaves old notes behind and restores only the target.
    switch(0)
    hunk.wait_text("newer turn = 100")
    assert hunk.cli("comment", "list", hunk.session_id, "--type", "user")["comments"] == []
    switch(2)
    hunk.wait_text("tradeoff")
    assert hunk.cli("comment", "list", hunk.session_id, "--type", "user")["comments"][0]["noteId"] == saved["noteId"]
    # Only native admission is a simulated external boundary in this supporting proof.
    # Persistence, host factory, native editor, runtime and client are the real implementations.
    receiver_path = state / "receiver.sock"
    receiver = socket.socket(socket.AF_UNIX)
    receiver.bind(str(receiver_path))
    receiver_path.chmod(0o600)
    receiver.listen()
    original_identity = attached["identity"]
    def receive():
        while True:
            try:
                connection, _ = receiver.accept()
            except OSError:
                return
            with connection:
                data = b""
                while b"\n" not in data:
                    part = connection.recv(65536)
                    if not part:
                        break
                    data += part
                if not data:
                    continue
                incoming = json.loads(data)
                valid = incoming["params"]["identity"] == original_identity and incoming["params"]["epoch"] == epoch
                result = {"state": "blocked", "ready": False}
                if valid:
                    result = {"ready": True} if incoming["method"] == "admission.check" else {"state": "queued"}
                    if incoming["method"] == "admission.enqueue":
                        admissions.append(incoming["params"])
                connection.sendall((json.dumps({"version": 1, "id": incoming["id"], "result": result}) + "\n").encode())
    threading.Thread(target=receive, daemon=True).start()
    request("session.attach", {"identity": original_identity, "epoch": epoch, "receiver": {"socket": str(receiver_path)}})
    turn_actions(1)
    hunk.wait_text("Send review to original native session?")
    hunk.key("\r")
    deadline = time.monotonic() + 10
    while not admissions and time.monotonic() < deadline:
        hunk.read(0.1)
    assert len(admissions) == 1
    first_batch = admissions[0]["batch"]
    assert first_batch["notes"][0]["text"] == edited["notes"][0]["summary"]
    assert first_batch["reviews"][0]["id"] == reviewed["reviewId"]
    assert first_batch["identity"] == original_identity
    assert request("review.checkpoint.read", {"sessionId": attached["sessionId"], "reviewId": reviewed["reviewId"]})["checkpoint"]["notes"][0]["status"] == "open"
    # Before another completion, admitted open notes must allow automatic following.
    hunk.wait_text("newer turn = 100")
    assert hunk.cli("comment", "list", hunk.session_id, "--type", "user")["comments"] == []
    request("request.complete", {**bound, "requestId": first_batch["id"], "outcome": "completed"})
    # Explicitly revisit the old immutable review and edit the admitted native ID.
    request("review.pin", {"sessionId": attached["sessionId"], "reviewId": reviewed["reviewId"]})
    hunk.wait_text("tradeoff")
    hunk.key("E", "Edit note")
    hunk.key("\x1b[200~ and add a diagram\x1b[201~")
    hunk.key("\x13", "Your note")
    revised = wait_checkpoint(reviewed["reviewId"], lambda cp: cp["draft"] is None and "diagram" in cp["notes"][0]["summary"])
    assert revised["notes"][0]["id"] == saved["noteId"]
    inventory = request("review.status", {"sessionId": attached["sessionId"]})
    assert any(n["state"] == "draft" and "diagram" in n["text"] for n in inventory["notes"])
    assert any(n["state"] == "submitted" and n["text"] == first_batch["notes"][0]["text"] for n in inventory["notes"])
    assert admissions[0]["batch"] == first_batch
    (evidence / "restored-checkpoint.json").write_text(json.dumps(revised, indent=2) + "\n")
    hunk.close("owned-integration")
    hunk = None
    os.environ.pop("HUNK_TURN_REVIEW_SOCKET", None)
    os.environ.pop("HUNK_TURN_REVIEW_SESSION_ID", None)
    hunk = module.Hunk(str(wrapper), fixture, evidence, ["diff"], port)
    hunk.note("review.txt", "new", 1, "Explicit legacy manual feedback")
    exported = hunk.export()
    assert exported["notes"][0]["summary"] == "Explicit legacy manual feedback"
    hunk.actions(1)
    hunk.wait_text("Safe Send review requires")
    assert len(admissions) == 1
    print(json.dumps({"evidence": str(evidence), "immutableReview": reviewed["reviewId"], "proof": "actual core socket and API29 Hunk PTY: waiting, native durable save, crash composer restoration, review isolation, send, admitted open-note automatic following, editable submitted native ID, manual export and delivery refusal; native admission transport is simulated"}, indent=2))
finally:
    if hunk:
        if hunk.process.poll() is None:
            hunk.close("turn-review")
        else:
            os.close(hunk.master)
    if receiver:
        receiver.close()
    runtime.terminate()
    runtime.wait(timeout=10)
