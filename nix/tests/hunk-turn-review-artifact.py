"""Public built runtime/review CLI check, with a private home and Git checkout."""

import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time

profile = Path(sys.argv[1]).resolve()
manifest = json.loads((profile / "share/hunk-turn-review-install.json").read_text())
for event in ("Interrupt", "SessionEnd"):
    for group in manifest["hooks"]["hooks"][event]:
        for handler in group["hooks"]:
            assert 1 <= handler["timeout"] <= 3, (event, handler["timeout"])
with tempfile.TemporaryDirectory(prefix="hunk-artifact-") as temporary:
    home = Path(temporary).resolve()
    checkout = home / "checkout"
    checkout.mkdir()
    subprocess.run(["git", "init", "-q", checkout], check=True)
    state = home / "state"
    state.mkdir(mode=0o700)
    sock = state / "runtime.sock"
    env = {
        **os.environ,
        "HOME": str(home),
        "HUNK_TURN_REVIEW_STATE": str(state),
        "HUNK_TURN_REVIEW_SOCKET": str(sock),
    }
    process = subprocess.Popen(
        [profile / "bin/hunk-turn-review-runtime"],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        for attempt in range(100):
            if sock.exists():
                break
            if process.poll() is not None:
                raise RuntimeError(process.communicate()[1].decode())
            time.sleep(0.05)

        def request(method, params):
            with socket.socket(socket.AF_UNIX) as client:
                client.settimeout(10)
                client.connect(str(sock))
                client.sendall(
                    (
                        json.dumps(
                            {
                                "version": 1,
                                "id": "artifact",
                                "method": method,
                                "params": params,
                            }
                        )
                        + "\n"
                    ).encode()
                )
                data = b""
                while b"\n" not in data:
                    chunk = client.recv(65536)
                    if not chunk:
                        raise RuntimeError("Runtime closed without an acknowledgement")
                    data += chunk
                response = json.loads(data)
                if "error" in response:
                    raise RuntimeError(response["error"])
                return response["result"]

        attached = request(
            "session.attach",
            {
                "identity": {
                    "kind": "pi",
                    "nativeId": "artifact-session",
                    "checkout": str(checkout),
                },
                "epoch": "artifact-epoch",
            },
        )
        session = {
            "sessionId": attached["sessionId"],
            "epoch": "artifact-epoch",
            "requestId": "artifact-request",
        }
        request("request.begin", session)
        (checkout / "observed.txt").write_text("packaged runtime observation\n")
        request("request.complete", {**session, "outcome": "completed"})
        env["HUNK_TURN_REVIEW_SESSION_ID"] = attached["sessionId"]
        result = subprocess.run(
            [profile / "bin/hunk-turn-review", "status"],
            cwd=checkout,
            env=env,
            capture_output=True,
            text=True,
            timeout=20,
        )
        assert result.returncode == 0, result.stderr
        assert json.loads(result.stdout)["identity"]["nativeId"] == "artifact-session"
        control = subprocess.run(
            [
                profile / "bin/hunk-turn-review-control",
                "status",
                "--session-id",
                attached["sessionId"],
            ],
            cwd=checkout,
            env=env,
            capture_output=True,
            text=True,
            timeout=20,
        )
        assert control.returncode == 0, control.stderr
        assert json.loads(control.stdout)["identity"]["nativeId"] == "artifact-session"
        print(
            "Built review/control CLIs observed a response and loaded the exact packaged extension/client"
        )
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
