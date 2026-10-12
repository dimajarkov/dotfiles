"""Public Codex launch orchestration with an isolated native-binary adapter."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

launcher = Path(
    os.environ.get(
        "HUNK_REVIEW_TEST_LAUNCHER",
        Path(__file__).resolve().parents[1] / "runtime/hunk-turn-review-codex.py",
    )
)
with tempfile.TemporaryDirectory(prefix="htr-codex-", dir="/tmp") as directory:
    home = Path(directory).resolve()
    state = home / "state"
    state.mkdir(mode=0o700)
    checkout = home / "checkout"
    checkout.mkdir()
    subprocess.run(["git", "init", "-q", checkout], check=True)
    native = home / "native"
    native.write_text(
        "#!" + sys.executable + "\n"
        "import os,sys,socket,time,json\n"
        "from pathlib import Path\n"
        "if sys.argv[1:2]==['app-server']:\n"
        " if os.environ.get('FAIL_LISTENER')=='1':sys.exit(1)\n"
        " address=sys.argv[3];assert address==os.environ['HUNK_TURN_REVIEW_CODEX_ENDPOINT']\n"
        " s=socket.socket(socket.AF_UNIX);s.bind(address[7:]);s.listen()\n"
        " Path(os.environ['NATIVE_RECEIPT']).write_text(json.dumps({'endpoint':address,'pid':os.getpid()}))\n"
        " while True:time.sleep(1)\n"
        "elif sys.argv[1:2]==['--remote'] and 'HUNK_TURN_REVIEW_CODEX_ENDPOINT' in os.environ:\n"
        " assert sys.argv[2]==os.environ['HUNK_TURN_REVIEW_CODEX_ENDPOINT']\n"
        " assert sys.argv[3:]==json.loads(os.environ['NATIVE_EXPECTED_ARGV']), (sys.argv[3:], json.loads(os.environ['NATIVE_EXPECTED_ARGV']))\n"
        " print('native TUI attached')\n"
        "else:\n"
        " assert sys.argv[1:]==json.loads(os.environ['NATIVE_EXPECTED_ARGV'])\n"
        " print('native direct fallback')\n"
    )
    native.chmod(0o755)
    env = {
        **os.environ,
        "HOME": str(home),
        "HERDR_ENV": "1",
        "HUNK_TURN_REVIEW_STATE": str(state),
        "NATIVE_RECEIPT": str(home / "native-receipt.json"),
        "NATIVE_EXPECTED_ARGV": '["--sandbox","workspace-write","--ask-for-approval","on-request","Explain this checkout"]',
    }
    command = [
        sys.executable,
        launcher,
        "--binary",
        native,
        "--",
        "--full-auto",
        "Explain this checkout",
    ]
    result = subprocess.run(
        command, cwd=checkout, env=env, capture_output=True, text=True, timeout=20
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "native TUI attached"
    result = subprocess.run(
        command,
        cwd=checkout,
        env={**env, "FAIL_LISTENER": "1"},
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "native direct fallback"
    assert "Hunk turn review" in result.stderr
    for arguments, cwd in [
        (["--profile", "review", "Explain this checkout"], checkout),
        ([f"--cd={checkout}", "Explain this checkout"], home),
    ]:
        result = subprocess.run(
            [*command[: command.index("--") + 1], *arguments],
            cwd=cwd,
            env={**env, "NATIVE_EXPECTED_ARGV": json.dumps(arguments)},
            capture_output=True,
            text=True,
            timeout=20,
        )
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip() == "native TUI attached", result.stdout
    arguments = [
        "--full-auto",
        "-s",
        "read-only",
        "-a",
        "never",
        "Explain this checkout",
    ]
    expected = [
        "-s",
        "read-only",
        "-a",
        "never",
        "Explain this checkout",
    ]
    result = subprocess.run(
        [*command[: command.index("--") + 1], *arguments],
        cwd=checkout,
        env={**env, "NATIVE_EXPECTED_ARGV": json.dumps(expected)},
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "native TUI attached", result.stdout
    cases = [
        (
            ["--full-auto", "--sandbox=read-only", "Explain this checkout"],
            [
                "--ask-for-approval",
                "on-request",
                "--sandbox=read-only",
                "Explain this checkout",
            ],
        ),
        (
            ["--full-auto", "--ask-for-approval=never", "Explain this checkout"],
            [
                "--sandbox",
                "workspace-write",
                "--ask-for-approval=never",
                "Explain this checkout",
            ],
        ),
        (
            ["--profile", "--full-auto", "Explain this checkout"],
            ["--profile", "--full-auto", "Explain this checkout"],
        ),
        (
            ["--config", "--full-auto", "Explain this checkout"],
            ["--config", "--full-auto", "Explain this checkout"],
        ),
        (["--", "--full-auto"], ["--", "--full-auto"]),
    ]
    for arguments, expected in cases:
        result = subprocess.run(
            [*command[: command.index("--") + 1], *arguments],
            cwd=checkout,
            env={**env, "NATIVE_EXPECTED_ARGV": json.dumps(expected)},
            capture_output=True,
            text=True,
            timeout=20,
        )
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip() == "native TUI attached", result.stdout
    bypass_cases = [
        (
            ["--full-auto", "exec", "echo", "safe"],
            [
                "--sandbox",
                "workspace-write",
                "--ask-for-approval",
                "on-request",
                "exec",
                "echo",
                "safe",
            ],
        ),
        (
            [
                "--full-auto",
                "--remote",
                "https://codex.example",
                "Explain this checkout",
            ],
            [
                "--sandbox",
                "workspace-write",
                "--ask-for-approval",
                "on-request",
                "--remote",
                "https://codex.example",
                "Explain this checkout",
            ],
        ),
        (["exec", "echo", "safe"], ["exec", "echo", "safe"]),
        (
            ["--remote", "https://codex.example", "--profile", "review"],
            ["--remote", "https://codex.example", "--profile", "review"],
        ),
    ]
    for arguments, expected in bypass_cases:
        result = subprocess.run(
            [*command[: command.index("--") + 1], *arguments],
            cwd=checkout,
            env={**env, "NATIVE_EXPECTED_ARGV": json.dumps(expected)},
            capture_output=True,
            text=True,
            timeout=20,
        )
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip() == "native direct fallback", result.stdout
    print(
        "Codex launcher translates deprecated full-auto while preserving native launch routes"
    )
